import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createShellTool } from './shell.js';
import { _resetOffers } from '../timeout-offer.js';
import type { ToolOptions } from './types.js';

/**
 * The shell timeout end to end (#477), against a real `sleep`.
 *
 * A real child rather than a mocked `spawnSync`, because the two facts under test
 * are both things only the real call produces: that a kill arrives as
 * `proc.error` with `ETIMEDOUT`, and that `spawnSync` has already filled
 * `stdout`/`stderr` with whatever the child printed first — which the predecessor
 * discarded by throwing `proc.error` before reading them.
 */

vi.mock('../profiles.js', () => ({ saveActiveSettings: vi.fn() }));

// Budgets are deliberately tiny: these are real children, so every millisecond
// here is wall clock in the shared suite. `sleep 1` is simply longer than any
// budget below, and `spawnSync` kills at the budget rather than waiting it out.
const SLOW = 'echo starting; sleep 1';

function opts(over: Partial<ToolOptions> = {}): ToolOptions {
  return {
    shellTimeout: 120,
    confirmDangerous: async () => true,
    ...over,
  } as ToolOptions;
}

beforeEach(() => {
  _resetOffers();
  vi.clearAllMocks();
});

describe('a timed-out command', () => {
  it('reports a timeout, not an exec_failed full of ETIMEDOUT', async () => {
    // `spawnSync /bin/sh ETIMEDOUT` named neither the command nor the budget, and
    // classified as a generic `exec_failed` — so the model's playbook said "do not
    // blindly retry" with no path to "raise the budget".
    const tool = createShellTool(opts());
    const res = await tool.execute({ command: SLOW }, {} as never);
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.error.type).toBe('timeout');
    expect(res.error.message).toContain('sleep 1');
    expect(res.error.message).toContain('120 ms');
  });

  it('keeps the output the command produced before the kill', async () => {
    const tool = createShellTool(opts());
    const res = await tool.execute({ command: SLOW }, {} as never);
    if (res.status !== 'error') throw new Error('expected a timeout');
    expect(res.error.message).toContain('starting');
  });

  it('asks nothing when there is nobody to ask', async () => {
    // Headless — cron and `bernard script` omit `askUser`. The improved message
    // still lands; the offer is simply skipped. Asserted by the absence of a hang
    // and the presence of the message.
    const tool = createShellTool(opts({ askUser: undefined }));
    const res = await tool.execute({ command: SLOW }, {} as never);
    expect(res.status).toBe('error');
  });
});

describe('the offer', () => {
  const LABELS = {
    once: 'Retry once with a 300ms timeout',
    session: 'Retry, and use 300ms for the rest of this session',
    profile: 'Retry, and save 300ms via /options shell-timeout',
    decline: 'Leave it — report the timeout',
  } as const;

  async function answer(label: string, extra: Partial<ToolOptions> = {}) {
    const raiseShellTimeout = vi.fn();
    const askUser = vi.fn(async () => ({ answers: [label] }));
    const tool = createShellTool(
      opts({ shellTimeout: 150, askUser: askUser as never, raiseShellTimeout, ...extra }),
    );
    const res = await tool.execute({ command: SLOW }, {} as never);
    const { saveActiveSettings } = await import('../profiles.js');
    return { res, askUser, raiseShellTimeout, saveActiveSettings };
  }

  // One table for the scope ladder: the four rows differ only in the label the
  // user picks and which of the two side effects should fire.
  it.each([
    // label        bumps  persists
    [LABELS.once, false, false],
    [LABELS.session, true, false],
    [LABELS.profile, true, true],
    [LABELS.decline, false, false],
    // Esc, and an answer matching no row: both fail closed.
    ['something nobody offered', false, false],
  ] as const)('%s → bump %s, persist %s', async (label, bumps, persists) => {
    const { raiseShellTimeout, saveActiveSettings } = await answer(label);
    expect(raiseShellTimeout).toHaveBeenCalledTimes(bumps ? 1 : 0);
    if (bumps) expect(raiseShellTimeout).toHaveBeenCalledWith(300);
    expect(saveActiveSettings).toHaveBeenCalledTimes(persists ? 1 : 0);
    if (persists) expect(saveActiveSettings).toHaveBeenCalledWith({ shellTimeout: 300 });
  });

  it('always reports the timeout — it never re-runs the command itself', async () => {
    // **Deliberate.** A tool that retries inside its own `execute` is invisible to
    // `augmentTools`: `recordOutcome` fires once per execute, so a successful retry
    // records a SUCCESS and the timeout is never counted — #366's blindness, for
    // timeouts. It also makes #459's `durationMs` span two spawns plus the human's
    // think time. So the model re-runs it, and each attempt is recorded once.
    const { res } = await answer(LABELS.session);
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.error.type).toBe('timeout');
    // And the message has to say the budget moved, or the model has no reason to
    // try again.
    expect(res.error.message).toContain('Run the same command again');
    expect(res.error.message).toContain('300ms');
  });

  it('says nothing about re-running when nothing was raised', async () => {
    const { res } = await answer(LABELS.decline);
    if (res.status !== 'error') throw new Error('expected a timeout');
    expect(res.error.message).not.toContain('Run the same command again');
  });

  it('treats a cancelled prompt as a decline', async () => {
    const askUser = vi.fn(async () => ({ cancelled: true, answered: [] }));
    const raiseShellTimeout = vi.fn();
    const tool = createShellTool(opts({ askUser: askUser as never, raiseShellTimeout }));
    const res = await tool.execute({ command: SLOW }, {} as never);
    expect(res.status).toBe('error');
    expect(raiseShellTimeout).not.toHaveBeenCalled();
  });

  it('survives a prompt channel that throws', async () => {
    const askUser = vi.fn(async () => {
      throw new Error('overlay gone');
    });
    const tool = createShellTool(opts({ askUser: askUser as never }));
    const res = await tool.execute({ command: SLOW }, {} as never);
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.error.type).toBe('timeout');
  });

  it('asks at most once per session', async () => {
    const askUser = vi.fn(async () => ({ answers: [LABELS.decline] }));
    const tool = createShellTool(opts({ askUser: askUser as never }));
    for (let i = 0; i < 3; i++) await tool.execute({ command: SLOW }, {} as never);
    expect(askUser).toHaveBeenCalledTimes(1);
  });

  it('reads the budget through getShellTimeout when one is supplied', async () => {
    // The live reader. `shellTimeout` alone is a snapshot that `/options`, a
    // profile switch and `raiseShellTimeout` all leave stale.
    const tool = createShellTool(opts({ shellTimeout: 99_000, getShellTimeout: () => 120 }));
    const res = await tool.execute({ command: SLOW }, {} as never);
    if (res.status !== 'error') throw new Error('expected a timeout');
    expect(res.error.message).toContain('120 ms');
  });
});
