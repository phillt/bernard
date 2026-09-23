/**
 * One dispatch of a bundled applet pass — the styler, the reviewer, the
 * driver, a planner stage — and the two rules every one of them carries.
 *
 * Four modules had each written this skeleton by hand and the rules were
 * restated four times: `skipCorrectionEnqueue` (these are bundled
 * `tool-wrapper` records, exactly the shape `dispatchToolWrapper` enqueues a
 * correction candidate for, and `permissionsFor` grants bundled records
 * `canAppendExamples: true`, so a pass that lost a pool slot really could
 * teach a shipped specialist a lesson about a call-shape it never got wrong);
 * and the signal riding per CALL rather than per construction, because the
 * tool is built once a turn while the signal belongs to the invocation, and
 * without it an Esc mid-create leaves a paid sub-agent run completing with
 * its output discarded.
 *
 * It does not catch. A planner stage lets a cancellation unwind the whole
 * pipeline, where the styler and the reviewer must not take a create down —
 * so what to do with a throw is each caller's, and {@link passFailureReason}
 * is the one wording of it.
 */
import { dispatchToolWrapper } from './tool-wrapper-run.js';
import type { DispatchToolWrapperArgs } from './tool-wrapper-run.js';
import { isDispatchCancellation } from '../error-taxonomy.js';
import type { AgentContext } from '../framework/context.js';

export type PassOutcome =
  | { ok: true; result: unknown }
  /**
   * `reason` leads with the taxonomy-ish code (`pool_exhausted`,
   * `no_api_key`, `step_limit`), which is what a reader acts on; `result` is
   * still carried because a pass can report a failure OF THE APPLET while
   * having done its job — the reviewer's verdict lives there.
   */
  | { ok: false; reason: string; result?: unknown };

export async function runAppletPass(
  ctx: AgentContext,
  args: Omit<DispatchToolWrapperArgs, 'skipCorrectionEnqueue' | 'abortSignal'> & {
    signal?: AbortSignal;
  },
): Promise<PassOutcome> {
  const { signal, ...rest } = args;
  const wrapped = await dispatchToolWrapper(
    { ...rest, skipCorrectionEnqueue: true, ...(signal ? { abortSignal: signal } : {}) },
    ctx,
  );
  if (wrapped.status === 'ok') return { ok: true, result: wrapped.result };
  return {
    ok: false,
    reason: wrapped.error ?? String(wrapped.result ?? 'unknown'),
    ...(wrapped.result !== undefined ? { result: wrapped.result } : {}),
  };
}

/** A cancelled turn is not a pass failure and is named as what it is. */
export function passFailureReason(err: unknown): string {
  if (isDispatchCancellation(err)) return 'cancelled';
  return err instanceof Error ? err.message : String(err);
}
