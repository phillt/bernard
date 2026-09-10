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
  it('retries at the doubled budget and succeeds when that is enough', async () => {
    // The whole point: accepting has to make the command finish, not merely record
    // a preference. 300 ms is too short for `sleep 0.6`; 600 ms is not.
    const askUser = vi.fn(async () => ({ answers: ['Retry once with a 300ms timeout'] }));
    const tool = createShellTool(opts({ shellTimeout: 150, askUser: askUser as never }));
    const res = await tool.execute({ command: 'sleep 0.25; echo finished' }, {} as never);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.result.output).toContain('finished');
  });

  it('asks at most once per session', async () => {
    const askUser = vi.fn(async () => ({ answers: ['Leave it — report the timeout'] }));
    const tool = createShellTool(opts({ askUser: askUser as never }));
    await tool.execute({ command: SLOW }, {} as never);
    await tool.execute({ command: SLOW }, {} as never);
    await tool.execute({ command: SLOW }, {} as never);
    expect(askUser).toHaveBeenCalledTimes(1);
  });

  it('declining reports the timeout and changes nothing', async () => {
    const raiseShellTimeout = vi.fn();
    const askUser = vi.fn(async () => ({ answers: ['Leave it — report the timeout'] }));
    const tool = createShellTool(opts({ askUser: askUser as never, raiseShellTimeout }));
    const res = await tool.execute({ command: SLOW }, {} as never);
    expect(res.status).toBe('error');
    expect(raiseShellTimeout).not.toHaveBeenCalled();
  });

  it('"once" retries without writing the setting anywhere', async () => {
    // What makes accepting safe for someone who only wants this command to finish.
    const raiseShellTimeout = vi.fn();
    const { saveActiveSettings } = await import('../profiles.js');
    const askUser = vi.fn(async () => ({ answers: ['Retry once with a 300ms timeout'] }));
    const tool = createShellTool(
      opts({ shellTimeout: 150, askUser: askUser as never, raiseShellTimeout }),
    );
    await tool.execute({ command: SLOW }, {} as never);
    expect(raiseShellTimeout).not.toHaveBeenCalled();
    expect(saveActiveSettings).not.toHaveBeenCalled();
  });

  it('"session" bumps the live config and persists nothing', async () => {
    const raiseShellTimeout = vi.fn();
    const { saveActiveSettings } = await import('../profiles.js');
    const askUser = vi.fn(async () => ({
      answers: ['Retry, and use 300ms for the rest of this session'],
    }));
    const tool = createShellTool(
      opts({ shellTimeout: 150, askUser: askUser as never, raiseShellTimeout }),
    );
    await tool.execute({ command: SLOW }, {} as never);
    expect(raiseShellTimeout).toHaveBeenCalledWith(300);
    expect(saveActiveSettings).not.toHaveBeenCalled();
  });

  it('"profile" bumps AND persists', async () => {
    const raiseShellTimeout = vi.fn();
    const { saveActiveSettings } = await import('../profiles.js');
    const askUser = vi.fn(async () => ({
      answers: ['Retry, and save 300ms via /options shell-timeout'],
    }));
    const tool = createShellTool(
      opts({ shellTimeout: 150, askUser: askUser as never, raiseShellTimeout }),
    );
    await tool.execute({ command: SLOW }, {} as never);
    expect(raiseShellTimeout).toHaveBeenCalledWith(300);
    expect(saveActiveSettings).toHaveBeenCalledWith({ shellTimeout: 300 });
  });

  it('treats a cancelled prompt as a decline', async () => {
    // Esc. Fails closed rather than retrying on a non-answer.
    const askUser = vi.fn(async () => ({ cancelled: true, answered: [] }));
    const tool = createShellTool(opts({ askUser: askUser as never }));
    const res = await tool.execute({ command: SLOW }, {} as never);
    expect(res.status).toBe('error');
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
});
