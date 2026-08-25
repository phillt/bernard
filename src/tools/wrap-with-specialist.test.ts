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

/**
 * Minimal `AgentContext` stand-in (#316). The shim reads only
 * `ctx.stores.specialists`; everything else is forwarded verbatim to the
 * mocked `dispatchToolWrapper`, so an inert shape suffices.
 */
function makeCtx(overrides: Record<string, any> = {}) {
  return {
    config: {} as any,
    toolOptions: {} as any,
    stores: {
      memory: {} as any,
      specialists: { get: vi.fn() },
      correction: { enqueue: vi.fn() },
    },
    mcp: { tools: {}, serverNames: [], serverTools: {} },
    ...overrides,
  } as any;
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

  it('preserves a structured `result` object on success (does not JSON-stringify)', () => {
    const obj = { output: 'hi', is_error: false };
    const out = formatWrappedResult({ status: 'ok', result: obj }, 'shell');
    expect(out).toEqual(obj);
    // Same reference — passed through as-is so detectToolError sees native shape.
    expect(out).toBe(obj);
  });

  it('maps shell errors into native `{ output, is_error: true }` shape', () => {
    const out = formatWrappedResult(
      { status: 'error', result: 'command failed', error: 'exit_code_1' },
      'shell',
    );
    expect(out).toEqual({
      output: 'Error (exit_code_1): command failed',
      is_error: true,
    });
  });

  it('maps file_read_lines errors into native `{ error }` shape', () => {
    const out = formatWrappedResult(
      { status: 'error', result: 'no such file', error: 'enoent' },
      'file_read_lines',
    );
    expect(out).toEqual({ error: 'Error (enoent): no such file' });
  });

  it('maps file_edit_lines and file_write errors into native `{ error }` shape', () => {
    const editOut = formatWrappedResult(
      { status: 'error', result: 'range invalid' },
      'file_edit_lines',
    );
    expect(editOut).toEqual({ error: 'Error: range invalid' });
    const writeOut = formatWrappedResult(
      { status: 'error', result: 'permission denied', error: 'eperm' },
      'file_write',
    );
    expect(writeOut).toEqual({ error: 'Error (eperm): permission denied' });
  });

  it('returns an `Error (...): ...` string for web_* / generic tools on error', () => {
    const web = formatWrappedResult(
      { status: 'error', result: '404 not found', error: 'http_404' },
      'web_read',
    );
    expect(web).toBe('Error (http_404): 404 not found');

    const generic = formatWrappedResult({
      status: 'error',
      result: 'opaque failure',
    });
    expect(generic).toBe('Error: opaque failure');
  });

  it('JSON-stringifies a non-string error body inside the error message', () => {
    const out = formatWrappedResult(
      { status: 'error', result: { reason: 'bad' }, error: 'parse_failed' },
      'web_read',
    );
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
    const ctx = makeCtx();
    const wrapped = wrapToolWithSpecialist(noExec, 'shell', 'shell-wrapper', ctx);
    expect(wrapped).toBe(noExec);
  });

  it('falls through to baseExecute when the specialist is missing', async () => {
    const base = makeBaseTool(async () => 'raw output');
    const ctx = makeCtx();
    ctx.stores.specialists.get.mockReturnValue(undefined);

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', ctx);
    const result = await wrapped.execute({ command: 'ls' }, { abortSignal: undefined });

    expect(result).toBe('raw output');
    expect(base.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(dispatchToolWrapper)).not.toHaveBeenCalled();
  });

  it('falls through to baseExecute when the specialist has wrong kind', async () => {
    const base = makeBaseTool(async () => 'raw output');
    const ctx = makeCtx();
    ctx.stores.specialists.get.mockReturnValue({ name: 'persona', kind: 'persona' });

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', ctx);
    const result = await wrapped.execute({ command: 'ls' }, { abortSignal: undefined });

    expect(result).toBe('raw output');
    expect(vi.mocked(dispatchToolWrapper)).not.toHaveBeenCalled();
  });

  it('dispatches to the wrapper specialist when present, returning only result on ok', async () => {
    const base = makeBaseTool(async () => 'should not run');
    const ctx = makeCtx();
    ctx.stores.specialists.get.mockReturnValue({ name: 'Shell Wrapper', kind: 'tool-wrapper' });
    vi.mocked(dispatchToolWrapper).mockResolvedValue({
      status: 'ok',
      result: 'wrapper output',
      reasoning: ['this should be stripped'],
    });

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', ctx);
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

  it('maps wrapper errors to the native shell error shape without exposing reasoning', async () => {
    const base = makeBaseTool(async () => 'should not run');
    const ctx = makeCtx();
    ctx.stores.specialists.get.mockReturnValue({ name: 'Shell Wrapper', kind: 'tool-wrapper' });
    vi.mocked(dispatchToolWrapper).mockResolvedValue({
      status: 'error',
      result: 'permission denied',
      error: 'exit_code_1',
      reasoning: ['should not leak'],
    });

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', ctx);
    const result = await wrapped.execute(
      { command: 'cat /etc/shadow' },
      { abortSignal: undefined },
    );

    // The shim prepends a taxonomy hint `[failure: <category>] ...` to the
    // error so the model sees a category + recovery playbook on the next turn.
    expect(result).toMatchObject({ is_error: true });
    const output = (result as { output: string }).output;
    expect(output).toContain('Error (');
    expect(output).toContain('exit_code_1');
    expect(output).toContain('permission denied');
    expect(output).toContain('[failure:');
    expect(JSON.stringify(result)).not.toContain('should not leak');
  });

  it('preserves a structured shell success result so detectToolError sees native shape', async () => {
    const base = makeBaseTool(async () => 'should not run');
    const ctx = makeCtx();
    ctx.stores.specialists.get.mockReturnValue({ name: 'Shell Wrapper', kind: 'tool-wrapper' });
    vi.mocked(dispatchToolWrapper).mockResolvedValue({
      status: 'ok',
      result: { output: 'file1\nfile2', is_error: false },
    });

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', ctx);
    const result = await wrapped.execute({ command: 'ls' }, { abortSignal: undefined });

    expect(result).toEqual({ output: 'file1\nfile2', is_error: false });
  });

  it('falls back to baseExecute when dispatch itself throws', async () => {
    const base = makeBaseTool(async () => 'raw fallback');
    const ctx = makeCtx();
    ctx.stores.specialists.get.mockReturnValue({ name: 'Shell Wrapper', kind: 'tool-wrapper' });
    vi.mocked(dispatchToolWrapper).mockRejectedValue(new Error('dispatch crashed'));

    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', ctx);
    const result = await wrapped.execute({ command: 'ls' }, { abortSignal: undefined });

    expect(result).toBe('raw fallback');
    expect(base.execute).toHaveBeenCalledOnce();
  });

  it('forwards abortSignal from execOptions to dispatchToolWrapper', async () => {
    const base = makeBaseTool(async () => 'unused');
    const ctx = makeCtx();
    ctx.stores.specialists.get.mockReturnValue({ name: 'Shell Wrapper', kind: 'tool-wrapper' });
    vi.mocked(dispatchToolWrapper).mockResolvedValue({
      status: 'ok',
      result: 'ok',
    });

    const ac = new AbortController();
    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', ctx);
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
    const ctx = makeCtx();
    const wrapped = wrapToolWithSpecialist(base, 'shell', 'shell-wrapper', ctx);
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

    const ctx = makeCtx();
    ctx.stores.specialists.get.mockReturnValue(undefined);

    const out = applyShimRouting(tools, ctx, { shell: 'shell-wrapper', missing: 'never' });
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

    const ctx = makeCtx();
    const out = applyShimRouting(tools, ctx);

    // All four DEFAULT_SHIM_ROUTING tools should have been wrapped (new ref).
    for (const name of Object.keys(DEFAULT_SHIM_ROUTING)) {
      expect(out[name]).not.toBe(tools[name as keyof typeof tools]);
    }
  });

  it('returns a new object — does not mutate the input', () => {
    const shell = makeBaseTool(async () => 'shell');
    const tools = { shell };
    const ctx = makeCtx();
    const out = applyShimRouting(tools, ctx, { shell: 'shell-wrapper' });
    expect(out).not.toBe(tools);
    expect(tools.shell).toBe(shell);
  });
});
