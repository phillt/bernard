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
const mockSpecialistExists = vi.hoisted(() => vi.fn().mockReturnValue(true));

vi.mock('./dispatch.js', () => ({ dispatchAction: mockDispatchAction }));
vi.mock('../specialists.js', () => ({
  SpecialistStore: vi.fn(() => ({ exists: mockSpecialistExists })),
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
    mockSpecialistExists.mockReturnValue(true);
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
    mockSpecialistExists.mockReturnValue(false);
    const res = await m.invokeAction({ appId: 'demo', action: 'ask', args: { q: 'hi' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unknown_specialist');
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
});
