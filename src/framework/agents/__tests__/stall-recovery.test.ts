import { describe, it, expect, vi } from 'vitest';

import {
  runWithStallRecovery,
  STALL_MAX_ATTEMPTS,
  STALL_RETRY_BUDGET_MS,
} from '../stall-recovery.js';
import {
  markProviderStall,
  providerStallInfo,
  DISPATCH_ABORT_NAME,
  classifyError,
  type ProviderStallInfo,
} from '../../../error-taxonomy.js';
import type { AgentResult } from '../../runner.js';

/**
 * A turn was lost outright when a provider sent HTTP 200 headers in 607 ms and
 * then nothing at all: no assistant message, no history row, the request simply
 * gone. These cover the loop that re-issues it.
 *
 * Real timers, like every other timeout suite here, with the backoff schedule
 * injected so the wait is 1 ms rather than the real ~1 s then ~3 s. Asserting
 * that three attempts happen should not also mean asserting how long a person
 * waits between them — and at the real schedule two of these blow vitest's 5 s
 * per-test default on their own.
 *
 * KNOWN GAP, recorded rather than covered by a test that would pass for the
 * wrong reason: nothing here pins that the backoff timer is NOT `unref()`ed.
 * Unref'd, a process with nothing else ref'd exits mid-backoff and abandons the
 * turn — the exact failure this module prevents, one layer up. It shipped that
 * way and was caught by smoke-testing the built output, because under vitest the
 * runner always holds the loop open, as would a mounted REPL or a connected MCP
 * child. Reproducing it needs a child process with an otherwise-empty event
 * loop, which would mean a test depending on `dist/` or paying a `tsx` spawn.
 * The reasoning lives on `sleep` in the module instead.
 */

const OK = { text: 'done', steps: [], finishReason: 'stop' } as unknown as AgentResult;

function stall(info: Partial<ProviderStallInfo> = {}): Error {
  return markProviderStall(new Error('Provider timed out — no response headers within 90s.'), {
    phase: 'headers',
    producedOutput: false,
    ...info,
  });
}

describe('runWithStallRecovery', () => {
  it('passes a successful attempt straight through, costing nothing', async () => {
    const attempt = vi.fn(async () => OK);
    await expect(runWithStallRecovery(attempt)).resolves.toBe(OK);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('re-issues a stall that produced nothing, and returns the recovered result', async () => {
    const attempt = vi
      .fn<[number | undefined], Promise<AgentResult>>()
      .mockRejectedValueOnce(stall())
      .mockResolvedValueOnce(OK);

    await expect(runWithStallRecovery(attempt, { backoffMs: [1] })).resolves.toBe(OK);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('gives the first attempt the configured budget and retries a shorter one', async () => {
    // Three full-length attempts is a six-minute spinner, which is a worse
    // product than the bug. Attempt 1 is still asking "is this legitimately
    // slow?"; attempts 2+ already know the connection misbehaved once.
    const attempt = vi
      .fn<[number | undefined], Promise<AgentResult>>()
      .mockRejectedValueOnce(stall())
      .mockResolvedValueOnce(OK);

    await runWithStallRecovery(attempt, { backoffMs: [1] });
    expect(attempt.mock.calls[0][0]).toBeUndefined();
    expect(attempt.mock.calls[1][0]).toBe(STALL_RETRY_BUDGET_MS);
  });

  it('does NOT retry a stall that already produced output', async () => {
    // `OutputSink` is append-only with no reset, so re-running a dispatch that
    // already emitted a `text-delta` prints a second copy beside the first and
    // the user watches the answer stutter.
    const err = stall({ phase: 'stream', producedOutput: true });
    const attempt = vi.fn(async () => {
      throw err;
    });

    await expect(runWithStallRecovery(attempt)).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not touch an error that is not a stall', async () => {
    // Every existing error path has to behave exactly as it did — this loop
    // recovers one specific transport failure, it is not a general retry.
    const err = new Error('rate limit exceeded');
    const attempt = vi.fn(async () => {
      throw err;
    });

    await expect(runWithStallRecovery(attempt)).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when the user has cancelled', async () => {
    // Esc must beat recovery, or pressing it buys a three-attempt wait.
    const ac = new AbortController();
    const attempt = vi.fn(async () => {
      ac.abort();
      throw stall();
    });

    await expect(runWithStallRecovery(attempt, { abortSignal: ac.signal })).rejects.toThrow(
      /timed out/,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('announces after the last attempt, in a form the error panel will classify', async () => {
    const attempt = vi.fn(async () => {
      throw stall();
    });

    const err = await runWithStallRecovery(attempt, { backoffMs: [1, 1] }).catch(
      (e: unknown) => e as Error,
    );

    expect(attempt).toHaveBeenCalledTimes(STALL_MAX_ATTEMPTS);
    expect(err.message).toMatch(/did not recover/);
    expect(err.message).toMatch(new RegExp(`tried ${STALL_MAX_ATTEMPTS} times`));
    // "timed out" is load-bearing, not stylistic: `formatAgentError` runs
    // `classifyError` on this message to pick the panel title and the
    // `playbook.user` hint, so the category comes for free.
    expect(classifyError({ message: err.message }).category).toBe('timeout');
    // The underlying detail survives, so the log still says which guard fired.
    expect(err.message).toMatch(/no response headers/);
  });

  it('keeps the original error name, so the dispatch boundaries still unwind', async () => {
    // A mid-stream stall arrives as `DispatchAbortError`, which the five child
    // -dispatch boundaries read to unwind rather than hand the model a stall
    // message dressed as a successful tool result. Minting a plain `Error`
    // here would silently change that for every sub-agent and wrapper.
    const inner = stall({ phase: 'stream' });
    inner.name = DISPATCH_ABORT_NAME;
    const attempt = vi.fn(async () => {
      throw inner;
    });

    const err = await runWithStallRecovery(attempt, { backoffMs: [1, 1] }).catch(
      (e: unknown) => e as Error,
    );

    expect(err.name).toBe(DISPATCH_ABORT_NAME);
    expect(err.cause).toBe(inner);
    // Still reachable through `cause`, which is how the brand survives every
    // layer of AI SDK rewrapping in the first place.
    expect(providerStallInfo(err)).toEqual({ phase: 'stream', producedOutput: false });
  });
});
