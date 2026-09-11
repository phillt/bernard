/**
 * @module framework/agents/stall-recovery
 *
 * Re-issues a dispatch whose provider went quiet, instead of losing the turn.
 *
 * The failure this exists for, from a real session: HTTP 200 headers in 607 ms,
 * then zero bytes for 90 s, `stepsCompleted: 0`. The turn was discarded whole —
 * no assistant message, no history row, the user's request simply gone. A stall
 * is transient by nature and Bernard treated it as fatal.
 *
 * ## Why the loop is here and not in the runner
 *
 * `AgentSpec`'s own docstring: *"The runner is intentionally policy-free: retry
 * loops, plan enforcement, critic dispatch, and post-processing all live in the
 * caller."* The runner reports facts — which guard fired, and whether anything
 * reached the sink — and this module decides what to do about them.
 *
 * Its call site matters as much as its layer. It wraps the single `runAgent`
 * call at the end of `innerIterate`, where `system` and `messages` are already
 * materialised, so a retry re-sends byte-identical input: no context
 * re-assembly, no risk of attempt 2 quietly asking a different question, and
 * `recordDispatchContext` (which runs before the call) records once for all
 * attempts — correct, since the context really is the same each time.
 *
 * ## Why retries get a shorter clock
 *
 * Three attempts at the full budget is a six-minute spinner, which is a worse
 * product than the bug. Attempt 1 keeps the configured budget, because it is
 * still asking "is this legitimately slow?". Attempts 2 and 3 already know the
 * connection misbehaved once, and {@link STALL_RETRY_BUDGET_MS} clears the
 * worst legitimate time-to-first-byte ever measured here (27.4 s across 1,230
 * requests — the same measurement `providers/stall-guard.ts` is sized from).
 * That bounds the worst case near two and a half minutes rather than six.
 *
 * The budget only ever SHORTENS: both the transport guards and the runner's
 * watchdog take `min(configured, override)`, so an off switch stays off.
 *
 * ## Why there is no progress indicator
 *
 * Retries are silent; only exhaustion announces. `src/framework/**` has no
 * imports from `ui/` and `StreamEvent` is fixed at
 * `text-delta | tool-call | tool-result`, so there is no seam for a
 * framework-side transient status event — adding a `notice` kind is the
 * narrowest way to get one, and is a separate change.
 */
import { debugLog } from '../../logger.js';
import {
  DISPATCH_ABORT_NAME,
  providerStallInfo,
  type ProviderStallInfo,
} from '../../error-taxonomy.js';
import type { AgentResult } from '../runner.js';

/** Total attempts, including the first. */
export const STALL_MAX_ATTEMPTS = 3;

/**
 * Liveness budget for attempts 2..N, in ms.
 *
 * Above the 27.4 s worst legitimate TTFB measured across 1,230 instrumented
 * requests, so a retry that is merely slow still succeeds; far below the 90 s
 * first-attempt budget, so three attempts stay inside a wait a person will sit
 * through.
 */
export const STALL_RETRY_BUDGET_MS = 30_000;

/**
 * Backoff before attempts 2 and 3.
 *
 * Deliberately small. The failure already cost a 90–120 s budget before we got
 * here, so the connection has had its pause; a longer sleep would only add to a
 * wait the user is already staring at. Jittered because every Bernard process
 * on a machine hitting one provider would otherwise retry in lockstep.
 */
export const BACKOFF_MS: readonly number[] = [1_000, 3_000];
const JITTER = 0.3;

function backoffFor(schedule: readonly number[], attempt: number): number {
  const base = schedule[Math.min(attempt - 1, schedule.length - 1)] ?? 0;
  return Math.round(base * (1 + (Math.random() * 2 - 1) * JITTER));
}

/**
 * Sleep that ends early if `signal` aborts. Never rejects.
 *
 * Deliberately NOT `unref()`ed, which is the opposite of every other timer in
 * this change and of `inbox/watcher.ts`. Those are background pollers and
 * liveness guards: if the process has nothing else to do, there is nothing left
 * to poll or to guard, so letting it exit is correct. This one is FOREGROUND
 * work — a turn the user asked for, mid-recovery. Unref'd, a process with
 * nothing else ref'd exits during the backoff and abandons the turn silently,
 * which is the failure this module exists to prevent, reintroduced one layer up.
 * Found by smoke-testing the built output, where a bare script really does have
 * nothing else ref'd; a mounted REPL or a connected MCP child would have hidden
 * it. Bounded by {@link BACKOFF_MS}, so it holds the loop for seconds at most.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Is this stall safe to re-issue?
 *
 * `producedOutput` is the whole test, and it is a fact about the SINK rather
 * than about the error. `OutputSink` is append-only — there is deliberately no
 * reset, since the framework layer is not allowed to know what a consumer
 * buffers — so re-running a dispatch that already emitted a `text-delta` prints
 * a second copy beside the first and the user watches the answer stutter.
 *
 * It is not a narrow carve-out. A provider that goes quiet usually does so
 * before saying anything, which is exactly the observed incident. It also
 * carries the accounting: with no step finished, no hook ran, so there is no
 * usage row a retry could double-count.
 */
function recoverable(info: ProviderStallInfo): boolean {
  return !info.producedOutput;
}

export interface StallRecoveryOpts {
  /** The caller's cancellation. Esc must beat recovery. */
  abortSignal?: AbortSignal;
  /** Identifies the dispatch in the debug log. */
  definitionId?: string;
  /**
   * Backoff schedule, defaulting to {@link BACKOFF_MS}.
   *
   * Injectable for the same reason `stallGuardedFetch` takes its budget and its
   * base `fetch`: the alternative is a suite that really sleeps four seconds per
   * exhaustion case. Nothing in production passes it — the default is the
   * policy, and a test asserting three attempts should not also be asserting how
   * long a person waits between them.
   */
  backoffMs?: readonly number[];
}

/**
 * Runs `attempt`, re-issuing it on a recoverable provider stall.
 *
 * `attempt` receives the liveness ceiling for this try — `undefined` on the
 * first, {@link STALL_RETRY_BUDGET_MS} after — and is expected to pass it
 * through as `AgentSpec.stallTimeoutMs`.
 */
export async function runWithStallRecovery(
  attempt: (stallTimeoutMs: number | undefined) => Promise<AgentResult>,
  opts: StallRecoveryOpts = {},
): Promise<AgentResult> {
  const startedAt = Date.now();
  let lastErr: unknown;

  for (let n = 1; n <= STALL_MAX_ATTEMPTS; n++) {
    try {
      return await attempt(n === 1 ? undefined : STALL_RETRY_BUDGET_MS);
    } catch (err) {
      lastErr = err;
      const info = providerStallInfo(err);

      // Anything that is not a stall is someone else's failure to classify —
      // rethrow untouched so every existing error path behaves as it did.
      if (!info) throw err;
      // The user cancelled. Rethrowing preserves Esc's meaning: `App.tsx`
      // renders nothing when the turn's controller is aborted.
      if (opts.abortSignal?.aborted) throw err;
      if (!recoverable(info)) {
        debugLog('stall:recovery:declined', {
          definitionId: opts.definitionId,
          phase: info.phase,
          reason: 'output-already-emitted',
        });
        throw err;
      }
      if (n === STALL_MAX_ATTEMPTS) break;

      const waitMs = backoffFor(opts.backoffMs ?? BACKOFF_MS, n);
      debugLog('stall:recovery:retry', {
        definitionId: opts.definitionId,
        phase: info.phase,
        attempt: n,
        of: STALL_MAX_ATTEMPTS,
        backoffMs: waitMs,
        nextBudgetMs: STALL_RETRY_BUDGET_MS,
      });
      await sleep(waitMs, opts.abortSignal);
      if (opts.abortSignal?.aborted) throw err;
    }
  }

  throw exhausted(lastErr, Date.now() - startedAt, opts.definitionId);
}

/**
 * The announcement.
 *
 * Reaches the user as `<ErrorPanel>`, committed at turn end by `runAgentTurn`'s
 * `finally`. The substring `timed out` is load-bearing rather than stylistic:
 * `formatAgentError` runs `classifyError` on this message to pick the panel
 * title and the `playbook.user` hint, so the `timeout` category comes for free
 * and no new vocabulary is needed anywhere.
 *
 * The original error's NAME is carried over deliberately. A mid-stream stall
 * arrives as {@link DISPATCH_ABORT_NAME}, which the five dispatch boundaries
 * read to unwind rather than hand the model a stall message dressed as a
 * successful tool result; minting a fresh `Error` would silently change that
 * for every sub-agent, wrapper and delegate. Attaching the original as `cause`
 * also keeps the brand reachable, since `providerStallInfo` walks the chain.
 */
function exhausted(lastErr: unknown, elapsedMs: number, definitionId?: string): Error {
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const seconds = Math.round(elapsedMs / 1000);
  debugLog('stall:recovery:exhausted', {
    definitionId,
    attempts: STALL_MAX_ATTEMPTS,
    elapsedMs,
  });
  const err = new Error(
    `Provider timed out and did not recover — tried ${STALL_MAX_ATTEMPTS} times ` +
      `over ${seconds}s. ${detail}`,
    { cause: lastErr },
  );
  if (lastErr instanceof Error && lastErr.name === DISPATCH_ABORT_NAME) {
    err.name = DISPATCH_ABORT_NAME;
  }
  return err;
}
