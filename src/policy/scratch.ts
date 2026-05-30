import { debugLog } from '../logger.js';
import { tokenize } from '../specialist-matcher.js';
import type { PolicyDecision, SubPolicy } from './types.js';

type Scratch = NonNullable<PolicyDecision['scratch']>;

/**
 * Matches explicit user markers that should clear all scratch unconditionally.
 * Word-boundary anchored so e.g. "newtask" won't trigger and "fix the unrelated
 * test" won't either (requires "unrelated" to stand alone). `/CLEAR` is special
 * since it lacks word characters on the left.
 */
const EXPLICIT_CLEAR_RE =
  /(^|\s)(\/CLEAR|new\s+task|new\s+plan|different\s+(?:thing|topic)|unrelated|switching\s+topics?|ignore\s+previous)\b/i;

/** Bernard prefixes user messages with `[timestamp]\nTask: ...` (see timestampUserMessage). */
const TASK_PREFIX_RE = /^\s*(?:\[[^\]]+\]\s*)?Task:/i;

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
 * by `Agent.processInput` via `getLastUserText()`.
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
  const similarity = jaccard(tokenize(userInput), tokenize(previousUserInput));
  if (similarity < threshold) {
    return { resetAll: true, deletePlanKey: true, reason: 'subject-change' };
  }
  if (TASK_PREFIX_RE.test(userInput)) {
    return { resetAll: false, deletePlanKey: true, reason: 'new-task-marker' };
  }
  return { resetAll: false, deletePlanKey: false, reason: 'same-task' };
}
