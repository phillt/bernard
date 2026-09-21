import { dispatchToolWrapper } from './tool-wrapper-run.js';
import { isDispatchCancellation } from '../error-taxonomy.js';
import { debugLog } from '../logger.js';
import type { AgentContext } from '../framework/context.js';

/**
 * Routing the review pass, so a built applet is a reviewed applet.
 *
 * `applet-reviewer` is bundled, has been since #425, and until now had **no
 * code wiring at all**. `create` calls the styler through
 * `applet-styling.ts`; nothing called the reviewer. It ran only when the main
 * agent happened to choose to, which means "everybody approved it" was
 * weaker than it sounded — sometimes nobody did.
 *
 * ## After the open, not before it
 *
 * The styler runs BEFORE `openedNote` because styling after the open would
 * show the scaffold and make the user refresh. Review is the opposite: it
 * changes nothing, so making the browser wait on it buys nothing and costs
 * the seconds the applet could already have been on screen. The applet
 * appears, and the verdict follows it.
 *
 * ## It reports; it does not revise
 *
 * A critic that edits is a second author, and an author whose changes nobody
 * reviewed. The findings go back in the create's result so the main agent —
 * which has the plan, the page and the user in front of it — decides what to
 * do. That is also what keeps this one dispatch rather than a loop with a
 * budget and a termination argument.
 *
 * Everything else about the shape is `applet-styling.ts`'s, for the reasons
 * that module states at length: the ctx-taking half lives here and is built
 * per turn in `framework/agents/main.ts`, `applet.ts` takes a plain callback
 * and never imports `AgentContext`, and the split is the recursion guard for
 * free — the registry a dispatched specialist gets comes from `createTools`,
 * which is ctx-free, so the `applet` tool the reviewer holds has no reviewer
 * of its own.
 */

export type ReviewOutcome =
  | { reviewed: true; summary: string }
  | { reviewed: false; reason: string };

export interface ReviewTarget {
  id: string;
  name: string;
  actions: string[];
}

export type AppletReviewer = (target: ReviewTarget, signal?: AbortSignal) => Promise<ReviewOutcome>;

export const REVIEWER_SPECIALIST_ID = 'applet-reviewer';

/** What the reviewer is asked. Deliberately short: its prompt is the method. */
export function buildReviewBrief(target: ReviewTarget): string {
  return [
    `Review the applet "${target.name}" (id: ${target.id}).`,
    '',
    target.actions.length > 0
      ? `Actions to exercise: ${target.actions.join(', ')}.`
      : 'It declares no actions, so there is nothing to invoke — review the source and the transport only.',
    '',
    'It was just built, so this is the first time anybody has looked at it.',
  ].join('\n');
}

export function makeAppletReviewer(ctx: AgentContext): AppletReviewer {
  return async (target, signal) => {
    try {
      const wrapped = await dispatchToolWrapper(
        {
          specialistId: REVIEWER_SPECIALIST_ID,
          input: buildReviewBrief(target),
          runLabel: `[review] ${target.name}`,
          // A review that lost a pool slot is not a call-shape mistake, and
          // `permissionsFor` grants bundled records `canAppendExamples: true`
          // — so the correction queue really can reach and teach this record.
          skipCorrectionEnqueue: true,
          ...(signal ? { abortSignal: signal } : {}),
        },
        ctx,
      );
      if (wrapped.status === 'ok') {
        return {
          reviewed: true,
          summary:
            typeof wrapped.result === 'string' ? wrapped.result.trim() : summarize(wrapped.result),
        };
      }
      return { reviewed: false, reason: wrapped.error ?? String(wrapped.result ?? 'unknown') };
    } catch (err) {
      // A cancelled turn is not a review failure, and must not take the
      // create down either — the applet is already written and already open.
      const reason = isDispatchCancellation(err)
        ? 'cancelled'
        : err instanceof Error
          ? err.message
          : String(err);
      debugLog('applet:review:error', { appId: target.id, reason });
      return { reviewed: false, reason };
    }
  };
}

/**
 * The structured verdict, as one line.
 *
 * The reviewer declares `structuredOutput`, so `result` is an object. What a
 * create's result has room for is the headline: how many actions passed, and
 * whether anything blocking was found. The full report stays in the reasoning
 * log, and `bernard app logs` is the door onto it.
 */
function summarize(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as {
    checked?: Array<{ verdict?: string }>;
    findings?: Array<{ severity?: string; detail?: string }>;
    planMismatches?: unknown[];
  };
  const parts: string[] = [];
  const checked = Array.isArray(r.checked) ? r.checked : [];
  if (checked.length > 0) {
    const passed = checked.filter((c) => c.verdict === 'pass').length;
    parts.push(`${passed}/${checked.length} action(s) ran`);
  }
  const blocking = (Array.isArray(r.findings) ? r.findings : []).filter(
    (f) => f.severity === 'blocking' || f.severity === 'high',
  );
  if (blocking.length > 0) {
    parts.push(
      `${blocking.length} to fix: ${blocking
        .map((f) => f.detail)
        .filter(Boolean)
        .join('; ')}`,
    );
  }
  const mismatches = Array.isArray(r.planMismatches) ? r.planMismatches.length : 0;
  // Called out separately from the other findings: a page that disagrees with
  // its own design is the failure this pipeline was rebuilt to catch, and it
  // reads as a nit if it is folded in with the rest.
  if (mismatches > 0) parts.push(`${mismatches} place(s) where it disagrees with its plan`);
  return parts.join('. ');
}
