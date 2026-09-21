import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../__tests__/temp-home.js';

/**
 * A deferred `import()` that fails to LOAD must not escape `invokeAction`.
 *
 * `invokeAction`'s docstring promises it never throws, and both halves of
 * telling anybody about a failure — the invocation log row and the notice put
 * in front of a running REPL — hang off its single `fail()` path. The two
 * `await import(...)` calls sat outside every try, so a load failure skipped
 * all of it.
 *
 * Not hypothetical: a nine-day-old applet host answered every button with a
 * bare `500` and `The requested module './paths.js' does not provide an
 * export named 'WORKSPACE_MAX_AGE_MS'`, while `bernard app logs` showed
 * nothing but successes and no session was ever told. See `src/build-stamp.ts`
 * for why the load fails — this file is only about what happens when it does.
 *
 * Its own file rather than a case in `invoke.test.ts` because the failure has
 * to be injected at MODULE level: that file mocks `./dispatch.js` with a
 * working factory for every test in it, and a call-time rejection is a
 * different code path from a link-time one.
 */
describe('invokeAction when a deferred import cannot be loaded', () => {
  useTempHome('bernard-invoke-load');

  const APP = {
    schemaVersion: 1,
    id: 'demo',
    name: 'Demo',
    actions: {
      ask: {
        instructions: 'Answer.',
        specialistId: 'web-wrapper',
        args: { q: { type: 'string', required: true } },
        toolAllowlist: ['web_search'],
        timeoutMs: 60_000,
      },
    },
  };

  /** The real shape: a link error, which is what a stale module cache yields. */
  const LINK_ERROR = "The requested module './paths.js' does not provide an export named 'X'";

  async function loadWithBrokenDispatch() {
    vi.resetModules();
    vi.doMock('./dispatch.js', () => {
      throw new Error(LINK_ERROR);
    });
    vi.doMock('../specialists.js', () => ({
      SpecialistStore: vi.fn(() => ({
        get: vi.fn().mockReturnValue({ id: 'web-wrapper', targetTools: ['web_search'] }),
      })),
    }));
    vi.doMock('../logger.js', () => ({ debugLog: vi.fn(), isDebugEnabled: () => false }));
    const paths = await import('../paths.js');
    fs.mkdirSync(paths.APPS_DIR, { recursive: true });
    fs.writeFileSync(path.join(paths.APPS_DIR, 'demo.json'), JSON.stringify(APP));
    const mod = await import('./invoke.js');
    return { ...mod, SCRIPT_LOG_FILE: paths.SCRIPT_LOG_FILE };
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it('resolves to a failure envelope rather than rejecting', async () => {
    const m = await loadWithBrokenDispatch();
    // `resolves`, not a try/catch: the contract is that the promise SETTLES.
    // With the guard removed this line is what fails, and it fails as an
    // unhandled rejection rather than a wrong value.
    const res = await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    // `run_failed`, so the caller gets exit 1 ("retry might help") — which is
    // true of a stale process — and so `fail()` classifies it and therefore
    // notifies. A request-shaped code would be both a lie and silent.
    expect(res.error.code).toBe('run_failed');
    expect(res.error.message).toContain('./dispatch.js');
    // The remedy, named. The caller is a browser button with nobody to ask.
    expect(res.error.message).toMatch(/rebuilt or upgraded/i);
  });

  it('writes the diagnosis to the invocation log', async () => {
    // `bernard app logs` is the door somebody actually opens, and during the
    // real incident it showed three successes and no sign of three dead
    // clicks — because this row was never written at all.
    const m = await loadWithBrokenDispatch();
    await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
    const rows = fs
      .readFileSync(m.SCRIPT_LOG_FILE, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = rows[rows.length - 1];
    expect(last.ok).toBe(false);
    expect(last.errorCode).toBe('run_failed');
    expect(String(last.errorMessage)).toContain('./dispatch.js');
  });

  it('puts a notice in front of a running session', async () => {
    const m = await loadWithBrokenDispatch();
    const registry = await import('../inbox/registry.js');
    const send = await import('../inbox/send.js');
    send.resetSendDedupe();
    registry.registerSession({ sessionId: 'listener' });

    await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });

    const inbox = registry.listLiveSessions()[0].inboxDir;
    const delivered = fs.readdirSync(inbox).filter((n) => n.endsWith('.json'));
    expect(delivered).toHaveLength(1);
    const msg = JSON.parse(fs.readFileSync(path.join(inbox, delivered[0]), 'utf-8')) as {
      text: string;
      hint?: string;
    };
    // Names the applet, so a user with several open knows which one died.
    expect(msg.text).toContain('demo');
    expect(msg.hint).toContain('bernard app logs');
    registry.unregisterSession('listener');
  });

  it('covers the tool-dispatch arm too, which is the same hazard one branch over', async () => {
    // `{kind:'tool'}` actions reach `./tool-dispatch.js` through a second
    // unguarded import. Fixing only the arm that broke is how half a defect
    // ships — this arm is the LESS watched one, since it is what an applet
    // uses to run a tool with no model at all.
    vi.resetModules();
    vi.doMock('./tool-dispatch.js', () => {
      throw new Error(LINK_ERROR);
    });
    vi.doMock('../logger.js', () => ({ debugLog: vi.fn(), isDebugEnabled: () => false }));
    const paths = await import('../paths.js');
    fs.mkdirSync(paths.APPS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(paths.APPS_DIR, 'tooly.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'tooly',
        name: 'Tooly',
        actions: {
          read: {
            dispatch: { kind: 'tool', tool: 'file_read_lines', args: { path: '$.p' } },
            args: { p: { type: 'string', required: true } },
          },
        },
      }),
    );
    const mod = await import('./invoke.js');
    const res = await mod.invokeAction({ appId: 'tooly', action: 'read', args: { p: '/tmp/x' } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.message).toContain('./tool-dispatch.js');
  });
});
