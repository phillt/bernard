import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('./tool-wrapper-run.js', () => ({
  dispatchToolWrapper: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  debugLog: vi.fn(),
}));

// ── Deferred imports ──────────────────────────────────────────────────────────

import {
  buildShimInput,
  formatWrappedResult,
  wrapToolWithSpecialist,
  applyShimRouting,
  DEFAULT_SHIM_ROUTING,
} from './wrap-with-specialist.js';

const { dispatchToolWrapper } = await import('./tool-wrapper-run.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBaseTool(executeImpl: (...args: any[]) => any) {
  return {
    description: 'base tool',
    parameters: {},
    execute: vi.fn(executeImpl),
  };
}

function makeDeps(overrides: Record<string, any> = {}) {
  return {
    config: {} as any,
    options: {} as any,
    memoryStore: {} as any,
    specialistStore: {
      get: vi.fn(),
    } as any,
    correctionStore: { enqueue: vi.fn() } as any,
    ...overrides,
  };
}

// ── buildShimInput ────────────────────────────────────────────────────────────

describe('buildShimInput', () => {
  it('embeds the tool name and JSON-formatted args verbatim', () => {
    const input = buildShimInput('shell', { command: 'ls -la' });
    expect(input).toContain('`shell`');
    expect(input).toContain('"command": "ls -la"');
  });

  it('falls back to String(args) when args cannot be JSON-serialised', () => {
    const circular: any = {};
    circular.self = circular;
    const input = buildShimInput('shell', circular);
    expect(input).toContain('`shell`');
    // Just confirm it didn't throw and the description is present.
    expect(input).toContain('Execute this tool call');
  });

  it('mentions that only `result` and `error` cross back to the parent', () => {
    const input = buildShimInput('shell', { command: 'pwd' });
    expect(input).toMatch(/result|error/i);
  });
});

// ── formatWrappedResult ───────────────────────────────────────────────────────

describe('formatWrappedResult', () => {
  it('returns the raw string `result` on success', () => {
    expect(formatWrappedResult({ status: 'ok', result: 'hello' })).toBe('hello');
  });

  it('JSON-stringifies non-string `result` on success', () => {
    expect(formatWrappedResult({ status: 'ok', result: { a: 1 } })).toBe('{"a":1}');
  });

  it('prefixes with "Error (<code>):" when an error code is present', () => {
    const out = formatWrappedResult({
      status: 'error',
      result: 'command failed',
      error: 'exit_code_1',
    });
    expect(out).toBe('Error (exit_code_1): command failed');
  });

  it('prefixes with "Error:" when no error code is present', () => {
    const out = formatWrappedResult({
      status: 'error',
      result: 'opaque failure',
    });
    expect(out).toBe('Error: opaque failure');
  });

  it('JSON-stringifies a non-string error body', () => {
    const out = formatWrappedResult({
      status: 'error',
      result: { reason: 'bad' },
      error: 'parse_failed',
    });
    expect(out).toBe('Error (parse_failed): {"reason":"bad"}');
  });
});

// ── wrapToolWithSpecialist ────────────────────────────────────────────────────

describe('wrapToolWithSpecialist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the base tool unchanged when execute is missing', () => {
    const noExec = { description: 'no exec' } as any;
    const deps = makeDeps();
    const wrapped = wrapToolWithSpecialist(noExec, 'shell', 'shell-wrapper', deps);
    expect(wrapped).toBe(noExec);
  });

  it('falls through to baseExecute when the specialist is missing', async () => {
    const base = makeBaseTool(async () => 'raw output');
    const deps = makeDeps();
    deps.specialistStore.get.mockReturnValue(undefined);

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', deps);
    const result = await wrapped.execute({ command: 'ls' }, { abortSignal: undefined });

    expect(result).toBe('raw output');
    expect(base.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(dispatchToolWrapper)).not.toHaveBeenCalled();
  });

  it('falls through to baseExecute when the specialist has wrong kind', async () => {
    const base = makeBaseTool(async () => 'raw output');
    const deps = makeDeps();
    deps.specialistStore.get.mockReturnValue({ name: 'persona', kind: 'persona' });

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', deps);
    const result = await wrapped.execute({ command: 'ls' }, { abortSignal: undefined });

    expect(result).toBe('raw output');
    expect(vi.mocked(dispatchToolWrapper)).not.toHaveBeenCalled();
  });

  it('dispatches to the wrapper specialist when present, returning only result on ok', async () => {
    const base = makeBaseTool(async () => 'should not run');
    const deps = makeDeps();
    deps.specialistStore.get.mockReturnValue({ name: 'Shell Wrapper', kind: 'tool-wrapper' });
    vi.mocked(dispatchToolWrapper).mockResolvedValue({
      status: 'ok',
      result: 'wrapper output',
      reasoning: ['this should be stripped'],
    });

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', deps);
    const result = await wrapped.execute({ command: 'ls' }, { abortSignal: undefined });

    expect(result).toBe('wrapper output');
    expect(base.execute).not.toHaveBeenCalled();
    expect(vi.mocked(dispatchToolWrapper)).toHaveBeenCalledOnce();

    const call = vi.mocked(dispatchToolWrapper).mock.calls[0][0];
    expect(call.specialistId).toBe('shell-wrapper');
    expect(call.input).toContain('`shell`');
    expect(call.input).toContain('"command": "ls"');
    expect(call.runLabel).toBe('[shim] shell → Shell Wrapper');
  });

  it('formats wrapper errors as "Error (code): body" without exposing reasoning', async () => {
    const base = makeBaseTool(async () => 'should not run');
    const deps = makeDeps();
    deps.specialistStore.get.mockReturnValue({ name: 'Shell Wrapper', kind: 'tool-wrapper' });
    vi.mocked(dispatchToolWrapper).mockResolvedValue({
      status: 'error',
      result: 'permission denied',
      error: 'exit_code_1',
      reasoning: ['should not leak'],
    });

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', deps);
    const result = await wrapped.execute({ command: 'cat /etc/shadow' }, { abortSignal: undefined });

    expect(result).toBe('Error (exit_code_1): permission denied');
    expect(String(result)).not.toContain('should not leak');
  });

  it('falls back to baseExecute when dispatch itself throws', async () => {
    const base = makeBaseTool(async () => 'raw fallback');
    const deps = makeDeps();
    deps.specialistStore.get.mockReturnValue({ name: 'Shell Wrapper', kind: 'tool-wrapper' });
    vi.mocked(dispatchToolWrapper).mockRejectedValue(new Error('dispatch crashed'));

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', deps);
    const result = await wrapped.execute({ command: 'ls' }, { abortSignal: undefined });

    expect(result).toBe('raw fallback');
    expect(base.execute).toHaveBeenCalledOnce();
  });

  it('forwards abortSignal from execOptions to dispatchToolWrapper', async () => {
    const base = makeBaseTool(async () => 'unused');
    const deps = makeDeps();
    deps.specialistStore.get.mockReturnValue({ name: 'Shell Wrapper', kind: 'tool-wrapper' });
    vi.mocked(dispatchToolWrapper).mockResolvedValue({
      status: 'ok',
      result: 'ok',
    });

    const ac = new AbortController();
    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', deps);
    await wrapped.execute({ command: 'ls' }, { abortSignal: ac.signal });

    const call = vi.mocked(dispatchToolWrapper).mock.calls[0][0];
    expect(call.abortSignal).toBe(ac.signal);
  });

  it('preserves the base tool description and parameters (model sees same schema)', () => {
    const base = {
      description: 'Run a shell command',
      parameters: { foo: 'bar' },
      execute: vi.fn(),
    } as any;
    const deps = makeDeps();
    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', deps);
    expect(wrapped.description).toBe('Run a shell command');
    expect(wrapped.parameters).toEqual({ foo: 'bar' });
  });
});

// ── applyShimRouting ──────────────────────────────────────────────────────────

describe('applyShimRouting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only wraps tools present in both routing table and tool set', () => {
    const shell = makeBaseTool(async () => 'shell ran');
    const web = makeBaseTool(async () => 'web ran');
    const tools = { shell, web_read: web };

    const deps = makeDeps();
    deps.specialistStore.get.mockReturnValue(undefined);

    const out = applyShimRouting(tools, deps, { shell: 'shell-wrapper', missing: 'never' });
    expect(out.shell).not.toBe(shell);
    expect(out.web_read).toBe(web);
    expect((out as any).missing).toBeUndefined();
  });

  it('uses DEFAULT_SHIM_ROUTING when no routing arg is provided', () => {
    const shell = makeBaseTool(async () => 'shell');
    const file_read_lines = makeBaseTool(async () => 'read');
    const file_edit_lines = makeBaseTool(async () => 'edit');
    const web_read = makeBaseTool(async () => 'web');
    const tools = { shell, file_read_lines, file_edit_lines, web_read };

    const deps = makeDeps();
    const out = applyShimRouting(tools, deps);

    // All four DEFAULT_SHIM_ROUTING tools should have been wrapped (new ref).
    for (const name of Object.keys(DEFAULT_SHIM_ROUTING)) {
      expect(out[name]).not.toBe(tools[name as keyof typeof tools]);
    }
  });

  it('returns a new object — does not mutate the input', () => {
    const shell = makeBaseTool(async () => 'shell');
    const tools = { shell };
    const deps = makeDeps();
    const out = applyShimRouting(tools, deps, { shell: 'shell-wrapper' });
    expect(out).not.toBe(tools);
    expect(tools.shell).toBe(shell);
  });
});
