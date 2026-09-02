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
    timings: { mcpConnectMs: 12, totalMs: 34 },
    stepLimitHit: false,
  }),
);

const mockSpecialistExists = vi.hoisted(() => vi.fn().mockReturnValue(true));

vi.mock('../apps/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../apps/dispatch.js')>();
  return { ...actual, dispatchAction: mockDispatchAction };
});

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

describe('scriptRun', () => {
  useTempHome('bernard-script');
  let stdout: string[];
  let stderr: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  async function load() {
    vi.resetModules();
    const paths = await import('../paths.js');
    const mod = await import('./run.js');
    return { ...mod, APPS_DIR: paths.APPS_DIR };
  }

  function writeApp(appsDir: string, body: unknown = VALID_APP, name = 'demo'): void {
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(path.join(appsDir, `${name}.json`), JSON.stringify(body));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = [];
    stderr = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdout.push(String(c));
      return true;
    }) as never;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    }) as never;
    mockDispatchAction.mockResolvedValue({
      ok: true,
      formatted: { status: 'ok', result: 'the answer' },
      env: {},
      startedAt: '2026-01-01T00:00:00.000Z',
      timings: { mcpConnectMs: 12, totalMs: 34 },
      stepLimitHit: false,
    });
    mockSpecialistExists.mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  /** The contract: stdout parses as exactly one JSON object. */
  function soleStdoutObject(): Record<string, unknown> {
    const text = stdout.join('');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]);
  }

  it('exits 0 and emits one JSON object on success', async () => {
    const m = await load();
    writeApp(m.APPS_DIR);
    const code = await m.scriptRun({ app: 'demo', action: 'ask', argsJson: '{"q":"hi"}' });
    expect(code).toBe(0);
    const out = soleStdoutObject();
    expect(out.ok).toBe(true);
    expect(out.result).toBe('the answer');
    expect(out.app).toBe('demo');
  });

  it('exits 2 for an unknown app, and dispatches nothing', async () => {
    const m = await load();
    const code = await m.scriptRun({ app: 'nope', action: 'ask' });
    expect(code).toBe(2);
    expect(soleStdoutObject()).toMatchObject({ ok: false, error: { code: 'unknown_app' } });
    expect(mockDispatchAction).not.toHaveBeenCalled();
  });

  it('exits 2 for an unknown action, and dispatches nothing', async () => {
    const m = await load();
    writeApp(m.APPS_DIR);
    const code = await m.scriptRun({ app: 'demo', action: 'exfiltrate' });
    expect(code).toBe(2);
    expect(soleStdoutObject()).toMatchObject({ ok: false, error: { code: 'unknown_action' } });
    expect(mockDispatchAction).not.toHaveBeenCalled();
  });

  it('exits 2 for args that fail the schema, and dispatches nothing', async () => {
    const m = await load();
    writeApp(m.APPS_DIR);
    const code = await m.scriptRun({ app: 'demo', action: 'ask', argsJson: '{}' });
    expect(code).toBe(2);
    expect(soleStdoutObject()).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    expect(mockDispatchAction).not.toHaveBeenCalled();
  });

  it('exits 2 for unparseable --args', async () => {
    const m = await load();
    writeApp(m.APPS_DIR);
    const code = await m.scriptRun({ app: 'demo', action: 'ask', argsJson: '{not json' });
    expect(code).toBe(2);
    expect(soleStdoutObject()).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
  });

  // A manifest naming a specialist that does not exist is a broken app, not a
  // failed run — and no model call should be billed for it.
  it('exits 2 when the action names a specialist that does not exist', async () => {
    const m = await load();
    writeApp(m.APPS_DIR);
    mockSpecialistExists.mockReturnValue(false);
    const code = await m.scriptRun({ app: 'demo', action: 'ask', argsJson: '{"q":"hi"}' });
    expect(code).toBe(2);
    expect(soleStdoutObject()).toMatchObject({ error: { code: 'unknown_specialist' } });
    expect(mockDispatchAction).not.toHaveBeenCalled();
  });

  it('exits 1 when the dispatch fails', async () => {
    const m = await load();
    writeApp(m.APPS_DIR);
    mockDispatchAction.mockResolvedValue({
      ok: false,
      error: 'model exploded',
      timedOut: false,
      timeoutMs: 60_000,
      env: {},
      startedAt: '2026-01-01T00:00:00.000Z',
      timings: { mcpConnectMs: 5, totalMs: 9 },
    });
    const code = await m.scriptRun({ app: 'demo', action: 'ask', argsJson: '{"q":"hi"}' });
    expect(code).toBe(1);
    expect(soleStdoutObject()).toMatchObject({ ok: false, error: { code: 'run_failed' } });
  });

  it('exits 1 and reports the timeout category when the wall clock fires', async () => {
    const m = await load();
    writeApp(m.APPS_DIR);
    mockDispatchAction.mockResolvedValue({
      ok: false,
      error: 'Aborted',
      timedOut: true,
      timeoutMs: 50,
      env: {},
      startedAt: '2026-01-01T00:00:00.000Z',
      timings: { mcpConnectMs: 5, totalMs: 60 },
    });
    const code = await m.scriptRun({ app: 'demo', action: 'ask', argsJson: '{"q":"hi"}' });
    expect(code).toBe(1);
    expect(soleStdoutObject()).toMatchObject({
      error: { code: 'timeout', category: 'timeout' },
    });
  });

  // A wrapper that parsed but reported `status: 'error'` is a failed run, not a
  // success with a sad payload.
  it('exits 1 when the wrapper reports status:error', async () => {
    const m = await load();
    writeApp(m.APPS_DIR);
    mockDispatchAction.mockResolvedValue({
      ok: true,
      formatted: { status: 'error', error: 'could not reach the page' },
      env: {},
      startedAt: '2026-01-01T00:00:00.000Z',
      timings: { mcpConnectMs: 1, totalMs: 2 },
      stepLimitHit: false,
    });
    const code = await m.scriptRun({ app: 'demo', action: 'ask', argsJson: '{"q":"hi"}' });
    expect(code).toBe(1);
    expect(soleStdoutObject()).toMatchObject({ ok: false, error: { code: 'run_failed' } });
  });

  // The whole reason for the stdout guard: a tool writing to stdout mid-run
  // would otherwise corrupt the one thing a calling program parses.
  it('keeps stdout to one object even when the dispatch writes to stdout', async () => {
    const m = await load();
    writeApp(m.APPS_DIR);
    mockDispatchAction.mockImplementation(async () => {
      process.stdout.write('  ~ profile web_search — recorded error (unknown)\n');
      return {
        ok: true,
        formatted: { status: 'ok', result: 'the answer' },
        env: {},
        startedAt: '2026-01-01T00:00:00.000Z',
        timings: { mcpConnectMs: 1, totalMs: 2 },
        stepLimitHit: false,
      };
    });
    const code = await m.scriptRun({ app: 'demo', action: 'ask', argsJson: '{"q":"hi"}' });
    expect(code).toBe(0);
    expect(soleStdoutObject().ok).toBe(true);
    expect(stderr.join('')).toContain('recorded error');
  });

  it('writes an invocation record naming the arg KEYS but never their values', async () => {
    const m = await load();
    writeApp(m.APPS_DIR);
    await m.scriptRun({ app: 'demo', action: 'ask', argsJson: '{"q":"a-secret-value"}' });
    const paths = await import('../paths.js');
    const log = fs.readFileSync(paths.SCRIPT_LOG_FILE, 'utf-8');
    expect(log).toContain('"q"');
    expect(log).not.toContain('a-secret-value');
  });
});

describe('effectiveTimeoutMs', () => {
  it("uses the action's own clock when no flag is given", async () => {
    const { effectiveTimeoutMs } = await import('./run.js');
    expect(effectiveTimeoutMs(60_000, undefined)).toBe(60_000);
  });

  it('lets the flag shorten the clock', async () => {
    const { effectiveTimeoutMs } = await import('./run.js');
    expect(effectiveTimeoutMs(60_000, 5_000)).toBe(5_000);
  });

  // A caller must not be able to buy itself more wall clock than the manifest
  // grants — the budget is a property of the app, not of who is calling it.
  it('never lets the flag extend the clock', async () => {
    const { effectiveTimeoutMs } = await import('./run.js');
    expect(effectiveTimeoutMs(60_000, 600_000)).toBe(60_000);
  });

  it('falls back to the default ceiling when the action declares none', async () => {
    const { effectiveTimeoutMs } = await import('./run.js');
    expect(effectiveTimeoutMs(undefined, undefined)).toBe(5 * 60_000);
    expect(effectiveTimeoutMs(undefined, 1_000)).toBe(1_000);
  });
});
