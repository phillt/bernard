import { debugLog } from '../logger.js';
import { tokenize } from '../specialist-matcher.js';
import type { PolicyDecision, SubPolicy } from './types.js';

type Scratch = NonNullable<PolicyDecision['scratch']>;

/**
 * Matches explicit user markers that should clear all scratch unconditionally.
 * Anchored to the start of the message (allowing Bernard's optional
 * `[timestamp]` and `Task:` wrapper prefixes) so phrases buried mid-sentence —
 * e.g. "show me the new task list", "fix the unrelated test", "this is for a
 * new plan", "ignore previous edits to foo.ts" — do NOT trigger a wipe. The
 * standalone "unrelated" and "ignore previous" alternatives were dropped:
 * both produced ambiguous matches even at message start ("ignore previous
 * edits" reads as a scoped operation, not a session reset).
 */
const EXPLICIT_CLEAR_RE =
  /^\s*(?:\[[^\]]+\]\s*)?(?:Task:\s*)?(\/CLEAR|new\s+task|new\s+plan|different\s+(?:thing|topic)|switching\s+topics?)\b/i;

/** Bernard prefixes user messages with `[timestamp]\nTask: ...` (see timestampUserMessage). */
const TASK_PREFIX_RE = /^\s*(?:\[[^\]]+\]\s*)?Task:/i;

/**
 * Below this many content tokens (after stop-word filtering) the user input is
 * treated as a short acknowledgement / continuation ("ok continue", "yes do it",
 * "and then?") and the Jaccard subject-change check is skipped — Jaccard would
 * otherwise return ~0 against any substantive prior turn and falsely wipe.
 */
const MIN_TOKENS_FOR_SUBJECT_CHECK = 3;

/**
 * Jaccard similarity over tokenized user inputs. Stop-words and pure numbers
 * are dropped by `tokenize`, so short follow-ups like "and also do Y" still
 * score reasonably against the prior turn's content tokens.
 */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect++;
  const unionSize = setA.size + setB.size - intersect;
  return unionSize === 0 ? 0 : intersect / unionSize;
}

/**
 * Heuristic scratch-lifecycle policy (#169). Always wipes the per-turn
 * PlanStore. Decides per turn whether to also:
 *   - delete the `plan` scratch key only (conservative "new task entry"), or
 *   - clear all scratch (subject change / explicit marker / first turn).
 *
 * Pure function over `PolicyInput`. State (previous user input) is threaded in
 * by `Agent.processInput` via `extractRecentUserTexts(this.history, 1)[0]`.
 */
export const scratchPolicy: SubPolicy<Scratch> = (input) => {
  const { userInput, previousUserInput, config } = input;
  const result = decide(userInput, previousUserInput, config.scratchSubjectThreshold);
  debugLog('scratch:reset', {
    resetAll: result.resetAll,
    deletePlanKey: result.deletePlanKey,
    reason: result.reason,
  });
  return { ...result, resetPlanOnly: true };
};

function decide(
  userInput: string,
  previousUserInput: string | undefined,
  threshold: number,
): { resetAll: boolean; deletePlanKey: boolean; reason: string } {
  if (previousUserInput === undefined) {
    return { resetAll: true, deletePlanKey: true, reason: 'first-turn' };
  }
  if (EXPLICIT_CLEAR_RE.test(userInput)) {
    return { resetAll: true, deletePlanKey: true, reason: 'explicit-marker' };
  }
  const currentTokens = tokenize(userInput);
  if (currentTokens.length >= MIN_TOKENS_FOR_SUBJECT_CHECK) {
    const similarity = jaccard(currentTokens, tokenize(previousUserInput));
    if (similarity < threshold) {
      return { resetAll: true, deletePlanKey: true, reason: 'subject-change' };
    }
  }
  if (TASK_PREFIX_RE.test(userInput)) {
    return { resetAll: false, deletePlanKey: true, reason: 'new-task-marker' };
  }
  return { resetAll: false, deletePlanKey: false, reason: 'same-task' };
}
