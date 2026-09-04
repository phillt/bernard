import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../__tests__/temp-home.js';

const mockDispatchAction = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    formatted: { status: 'ok', result: 'the answer' },
    env: {},
    startedAt: '2026-01-01T00:00:00.000Z',
    timings: { mcpConnectMs: 7, totalMs: 12 },
    stepLimitHit: false,
  }),
);
// Returns the RECORD now, not a boolean: the invocation log records the
// post-intersection tool set, which needs the specialist's `targetTools`.
const mockSpecialistGet = vi.hoisted(() =>
  vi.fn().mockReturnValue({ id: 'web-wrapper', targetTools: ['web_search', 'web_read'] }),
);

vi.mock('./dispatch.js', () => ({ dispatchAction: mockDispatchAction }));
vi.mock('../specialists.js', () => ({
  SpecialistStore: vi.fn(() => ({ get: mockSpecialistGet })),
}));
vi.mock('../logger.js', () => ({ debugLog: vi.fn(), isDebugEnabled: () => false }));

const VALID_APP = {
  schemaVersion: 1,
  id: 'demo',
  name: 'Demo',
  actions: {
    ask: {
      instructions: 'Answer the question.',
      specialistId: 'web-wrapper',
      args: { q: { type: 'string', required: true } },
      toolAllowlist: ['web_search'],
      timeoutMs: 60_000,
    },
  },
};

describe('invokeAction', () => {
  useTempHome('bernard-invoke');
  let appsDir: string;

  async function load() {
    vi.resetModules();
    const paths = await import('../paths.js');
    const mod = await import('./invoke.js');
    appsDir = paths.APPS_DIR;
    return { ...mod, SCRIPT_LOG_FILE: paths.SCRIPT_LOG_FILE };
  }

  function writeApp(body: unknown = VALID_APP, name = 'demo'): void {
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(path.join(appsDir, `${name}.json`), JSON.stringify(body));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecialistGet.mockReturnValue({
      id: 'web-wrapper',
      targetTools: ['web_search', 'web_read'],
    });
    mockDispatchAction.mockResolvedValue({
      ok: true,
      formatted: { status: 'ok', result: 'the answer' },
      env: {},
      startedAt: '2026-01-01T00:00:00.000Z',
      timings: { mcpConnectMs: 7, totalMs: 12 },
      stepLimitHit: false,
    });
  });

  it('returns a result object rather than an exit code', async () => {
    const m = await load();
    writeApp();
    const res = await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toBe('the answer');
      expect(res.app).toBe('demo');
      expect(res.meta.mcpConnectMs).toBe(7);
    }
  });

  /**
   * The whole reason this module exists. `scriptRun` wraps its dispatch in
   * `withStdoutRedirectedToStderr`, which monkey-patches `process.stdout.write`
   * PROCESS-GLOBALLY — safe for a one-shot command, and unsafe for a server
   * where two invocations overlap. The shared core must touch neither.
   */
  it('writes nothing to stdout and never patches process.stdout.write', async () => {
    const m = await load();
    writeApp();
    const before = process.stdout.write;
    const wrote: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      wrote.push(String(c));
      return true;
    });
    try {
      await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
      expect(wrote).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(process.stdout.write).toBe(before);
  });

  it('defaults its log to a no-op rather than a process stream', async () => {
    const m = await load();
    writeApp();
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });
    try {
      // The dispatch is what would normally log; assert we passed it something
      // inert rather than a stream.
      await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
      const passedLog = mockDispatchAction.mock.calls[0][0].log;
      expect(passedLog).toBeTypeOf('function');
      passedLog('chatter');
      expect(stderr.join('')).not.toContain('chatter');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports an unknown action as a request-shaped failure, dispatching nothing', async () => {
    const m = await load();
    writeApp();
    const res = await m.invokeAction({ appId: 'demo', action: 'nope', args: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unknown_action');
    expect(mockDispatchAction).not.toHaveBeenCalled();
  });

  it('reports a missing specialist without billing a model call', async () => {
    const m = await load();
    writeApp();
    mockSpecialistGet.mockReturnValue(null);
    const res = await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unknown_specialist');
    expect(mockDispatchAction).not.toHaveBeenCalled();
  });

  /**
   * The binding check is INVERTED relative to the `specialist_run` /
   * `tool_wrapper_run` refusals — it permits the matching pair and refuses
   * everyone else. That asymmetry is the whole point of the field and the one
   * place it is easy to write backwards, so the PERMIT case is tested first.
   */
  it('permits a bound specialist invoked through its own action', async () => {
    const m = await load();
    writeApp();
    mockSpecialistGet.mockReturnValue({
      id: 'web-wrapper',
      targetTools: ['web_search'],
      boundTo: { appId: 'demo', action: 'ask' },
    });
    const res = await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
    expect(res.ok).toBe(true);
    expect(mockDispatchAction).toHaveBeenCalled();
  });

  /**
   * A pre-existing hole this closes. An applet action dispatches through
   * `runHeadless`, not `dispatchToolWrapper`, so the `disabled` refusal that
   * guards `specialist_run` and `tool_wrapper_run` never covered it — a
   * specialist the user disabled in `/specialists` kept running behind every
   * applet button. Sharing one `invocationRefusal` brought it here.
   */
  it('refuses a disabled specialist, which applet dispatch never checked', async () => {
    const m = await load();
    writeApp();
    mockSpecialistGet.mockReturnValue({
      id: 'web-wrapper',
      targetTools: ['web_search'],
      disabled: true,
    });
    const res = await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('specialist_unavailable');
    expect(mockDispatchAction).not.toHaveBeenCalled();
  });

  it('refuses a bound specialist reached from another action', async () => {
    const m = await load();
    writeApp();
    mockSpecialistGet.mockReturnValue({
      id: 'web-wrapper',
      targetTools: ['web_search'],
      boundTo: { appId: 'other', action: 'elsewhere' },
    });
    const res = await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
    expect(res.ok).toBe(false);
    // Not `unknown_specialist` — the record exists, and saying it is missing
    // would send an integrator looking for the wrong bug.
    if (!res.ok) expect(res.error.code).toBe('specialist_not_bound');
    expect(mockDispatchAction).not.toHaveBeenCalled();
  });

  it('classifies a timeout, and only a failure that actually ran', async () => {
    const m = await load();
    writeApp();
    mockDispatchAction.mockResolvedValue({
      ok: false,
      error: 'Aborted',
      timedOut: true,
      timeoutMs: 50,
      env: {},
      startedAt: '2026-01-01T00:00:00.000Z',
      timings: { mcpConnectMs: 1, totalMs: 60 },
    });
    const res = await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('timeout');
      expect(res.error.category).toBe('timeout');
    }

    // A request-shaped failure gets no taxonomy category — classifying
    // "No such app" yields `unknown`, noise dressed as a diagnosis.
    const bad = await m.invokeAction({ appId: 'nope', action: 'ask', args: {} });
    if (!bad.ok) expect(bad.error.category).toBeUndefined();
  });

  /**
   * `capabilityId` is the column #420 fills. It exists now, always `null`, so
   * correlating mint with invoke is a value change rather than a schema
   * migration (R9).
   */
  it('records the capability id it was given, and null when direct', async () => {
    const m = await load();
    writeApp();
    await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
    await m.invokeAction({
      appId: 'demo',
      action: 'ask',
      args: { q: 'hi' },
      capabilityId: 'cap-abc',
    });
    const rows = fs
      .readFileSync(m.SCRIPT_LOG_FILE, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows[0].capabilityId).toBeNull();
    expect(rows[1].capabilityId).toBe('cap-abc');
  });

  it('logs arg KEYS but never their values', async () => {
    const m = await load();
    writeApp();
    await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'a-secret-value' } });
    const log = fs.readFileSync(m.SCRIPT_LOG_FILE, 'utf-8');
    expect(log).toContain('"q"');
    expect(log).not.toContain('a-secret-value');
  });

  /**
   * The failure message is the whole point of #461 — without it a real failure
   * read back as `run_failed`/`unknown` — but it cannot be stored blindly.
   *
   * An `invalid_args` message is `formatZodError` over the CALLER's arguments,
   * and zod echoes the value it rejected, so storing it verbatim would put
   * caller data in the log on exactly the path where the caller supplied it.
   */
  it('records the failure message, and withholds the one that would echo an argument', async () => {
    const m = await load();
    // An enum arg, because zod names the received value only when it has a
    // set of expected ones to contrast it against.
    writeApp({
      ...VALID_APP,
      actions: {
        ask: {
          ...VALID_APP.actions.ask,
          args: {
            q: { type: 'string', required: true },
            depth: { type: 'enum', values: ['quick', 'thorough'] },
          },
        },
      },
    });
    await m.invokeAction({
      appId: 'demo',
      action: 'ask',
      args: { q: 'fine', depth: 'hunter2-the-secret' },
    });
    const log = fs.readFileSync(m.SCRIPT_LOG_FILE, 'utf-8');
    expect(log).not.toContain('hunter2-the-secret');
    // Still diagnosable: which field failed is the question being asked, and a
    // field name is a key, which this log already carries.
    expect(log).toContain('depth');
    expect(log).toContain('values withheld');
  });

  it('records a run failure message in full', async () => {
    const m = await load();
    writeApp();
    await m.invokeAction({ appId: 'nope', action: 'ask', args: {} });
    const rows = fs
      .readFileSync(m.SCRIPT_LOG_FILE, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { errorMessage?: string });
    // Bernard's own words about its own state — not caller data.
    expect(rows[0].errorMessage).toContain('nope');
  });
});
