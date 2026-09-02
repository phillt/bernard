import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { augmentTools } from './augment.js';
import { attachMeta, toolToAISDK } from '../framework/tools/adapter.js';
import { ok, err, type BernardTool } from '../framework/tools/types.js';
import { clearCache as clearResultCache } from '../framework/tools/result-cache.js';
import { ProvenanceStore } from '../provenance.js';

vi.mock('../tool-profiles.js', () => ({
  classifyShellCommand: vi.fn((cmd: string) => {
    if (cmd.startsWith('git ')) return 'git';
    if (cmd.startsWith('gh ')) return 'gh';
    return 'general';
  }),
  detectToolError: vi.fn(() => ({ isError: false })),
}));

vi.mock('../logger.js', () => ({
  debugLog: vi.fn(),
}));

vi.mock('../output.js', () => ({
  printInfo: vi.fn(),
}));

const { classifyShellCommand, detectToolError } = await import('../tool-profiles.js');
const { debugLog } = await import('../logger.js');
const { printInfo } = await import('../output.js');

function createMockStore() {
  return {
    get: vi.fn(),
    getOrCreate: vi.fn(),
    save: vi.fn(),
    recordBadExample: vi.fn(),
    recordGoodExample: vi.fn(),
    recordSuccess: vi.fn(),
    patchLastBadWithFix: vi.fn(),
    list: vi.fn(() => []),
  };
}

/**
 * Error snippet the taxonomy classifies as correctable (`exec_failed`) — only
 * works in a shell context per PR #189 review (F6). Used for shell.* tests.
 */
const CORRECTABLE_ERROR = 'command failed with exit code 1: syntax error';

/**
 * Error snippet the taxonomy classifies as `invalid_args` — correctable
 * regardless of toolName. Used for non-shell augment tests.
 */
const NONSHELL_CORRECTABLE_ERROR = 'invalid tool arguments: missing required field "url"';

describe('augmentTools', () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createMockStore();
    vi.mocked(detectToolError).mockReturnValue({ isError: false });
  });

  describe('basic wrapping', () => {
    it('preserves tool properties (description, parameters, etc.)', () => {
      const originalExecute = vi.fn(async () => 'result');
      const tools = {
        myTool: {
          description: 'A test tool',
          parameters: { type: 'object', properties: {} },
          execute: originalExecute,
        },
      };

      const augmented = augmentTools(tools, store);

      expect(augmented.myTool.description).toBe('A test tool');
      expect(augmented.myTool.parameters).toEqual({ type: 'object', properties: {} });
      expect(typeof augmented.myTool.execute).toBe('function');
    });

    it('tools without execute are passed through unchanged', () => {
      const toolWithoutExecute = { description: 'no execute', parameters: {} };
      const tools = { noExec: toolWithoutExecute };

      const augmented = augmentTools(tools, store);

      expect(augmented.noExec).toBe(toolWithoutExecute);
    });

    it('null tools are passed through unchanged', () => {
      const tools = { nullTool: null };

      const augmented = augmentTools(tools as any, store);

      expect(augmented.nullTool).toBeNull();
    });

    it('undefined tools are passed through unchanged', () => {
      const tools = { undefinedTool: undefined };

      const augmented = augmentTools(tools as any, store);

      expect(augmented.undefinedTool).toBeUndefined();
    });

    it('wrapped execute returns the same result as original', async () => {
      const expectedResult = { output: 'hello', is_error: false };
      const originalExecute = vi.fn(async () => expectedResult);
      const tools = { myTool: { execute: originalExecute } };

      const augmented = augmentTools(tools, store);
      const result = await augmented.myTool.execute({ command: 'echo hello' }, {});

      expect(result).toBe(expectedResult);
    });

    it('wrapped execute passes args and execOptions through to original', async () => {
      const originalExecute = vi.fn(async () => 'result');
      const tools = { myTool: { execute: originalExecute } };
      const args = { command: 'ls -la' };
      const execOptions = { toolCallId: 'abc123' };

      const augmented = augmentTools(tools, store);
      await augmented.myTool.execute(args, execOptions);

      expect(originalExecute).toHaveBeenCalledWith(args, execOptions);
    });
  });

  describe('error recording', () => {
    it('when tool returns a correctable error, recordBadExample is called with profileKey, args, snippet, category', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: CORRECTABLE_ERROR });

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'error', is_error: true })) },
      };
      const args = { command: 'cat /root/secret' };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute(args, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledWith(
        'shell.general',
        JSON.stringify(args),
        CORRECTABLE_ERROR,
        'exec_failed',
      );
    });

    it('shell git commands get shell.git profile key', async () => {
      vi.mocked(detectToolError).mockReturnValue({
        isError: true,
        snippet: CORRECTABLE_ERROR,
      });

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'error', is_error: true })) },
      };
      const args = { command: 'git status' };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute(args, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledWith(
        'shell.git',
        expect.any(String),
        CORRECTABLE_ERROR,
        'exec_failed',
      );
    });

    it('shell gh commands get shell.gh profile key', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: CORRECTABLE_ERROR });

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'error', is_error: true })) },
      };
      const args = { command: 'gh pr list' };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute(args, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledWith(
        'shell.gh',
        expect.any(String),
        CORRECTABLE_ERROR,
        'exec_failed',
      );
    });

    it('shell general commands get shell.general profile key', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: CORRECTABLE_ERROR });

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'error', is_error: true })) },
      };
      const args = { command: 'unknown-command --flag' };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute(args, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledWith(
        'shell.general',
        expect.any(String),
        CORRECTABLE_ERROR,
        'exec_failed',
      );
    });

    it('MCP tools (name contains __) get mcp. prefix as profile key', async () => {
      vi.mocked(detectToolError).mockReturnValue({
        isError: true,
        snippet: NONSHELL_CORRECTABLE_ERROR,
      });

      const tools = {
        myServer__myTool: { execute: vi.fn(async () => ({ error: 'err' })) },
      };

      const augmented = augmentTools(tools, store);
      await augmented['myServer__myTool'].execute({ input: 'test' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledWith(
        'mcp.myServer__myTool',
        expect.any(String),
        NONSHELL_CORRECTABLE_ERROR,
        'invalid_args',
      );
    });

    it('non-shell non-MCP tools use their name as-is for profile key', async () => {
      vi.mocked(detectToolError).mockReturnValue({
        isError: true,
        snippet: NONSHELL_CORRECTABLE_ERROR,
      });

      const tools = { web_read: { execute: vi.fn(async () => ({ error: 'err' })) } };

      const augmented = augmentTools(tools, store);
      await augmented.web_read.execute({ url: 'https://example.com' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledWith(
        'web_read',
        expect.any(String),
        NONSHELL_CORRECTABLE_ERROR,
        'invalid_args',
      );
    });

    it('printInfo is called with error message for user visibility', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: CORRECTABLE_ERROR });

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'error', is_error: true })) },
      };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute({ command: 'bad-cmd' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(printInfo).toHaveBeenCalledWith(expect.stringContaining('recorded error'));
    });

    it('non-correctable errors (HTTP 404, rate_limit, parse_failed) are NOT recorded', async () => {
      vi.mocked(detectToolError).mockReturnValue({
        isError: true,
        snippet: 'web_read failed: HTTP 404 Not Found for https://example.com',
      });

      const tools = { web_read: { execute: vi.fn(async () => ({ error: 'err' })) } };

      const augmented = augmentTools(tools, store);
      await augmented.web_read.execute({ url: 'https://example.com' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).not.toHaveBeenCalled();
    });
  });

  describe('fix patching', () => {
    it('when tool succeeds and last bad example has "(awaiting successful retry)", patchLastBadWithFix is called', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: false });
      store.get.mockReturnValue({
        badExamples: [
          {
            args: '{"command":"old-cmd"}',
            errorSnippet: 'error',
            fix: '(awaiting successful retry)',
          },
        ],
      });

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'success', is_error: false })) },
      };
      const args = { command: 'git status' };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute(args, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.patchLastBadWithFix).toHaveBeenCalledWith('shell.git', JSON.stringify(args));
    });

    it('when tool succeeds and last bad example has a real fix (not awaiting), patchLastBadWithFix is NOT called', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: false });
      store.get.mockReturnValue({
        badExamples: [
          { args: '{"command":"old-cmd"}', errorSnippet: 'error', fix: 'Use git init first' },
        ],
      });

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'success', is_error: false })) },
      };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute({ command: 'git status' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.patchLastBadWithFix).not.toHaveBeenCalled();
    });

    it('when tool succeeds and no bad examples, patchLastBadWithFix is NOT called', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: false });
      store.get.mockReturnValue({ badExamples: [] });

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'success', is_error: false })) },
      };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute({ command: 'git status' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.patchLastBadWithFix).not.toHaveBeenCalled();
    });

    it('when tool succeeds and profile does not exist, patchLastBadWithFix is NOT called', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: false });
      store.get.mockReturnValue(undefined);

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'success', is_error: false })) },
      };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute({ command: 'git status' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.patchLastBadWithFix).not.toHaveBeenCalled();
    });

    it('printInfo is called with fix message for user visibility', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: false });
      store.get.mockReturnValue({
        badExamples: [
          { args: '{"command":"old"}', errorSnippet: 'error', fix: '(awaiting successful retry)' },
        ],
      });

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'success', is_error: false })) },
      };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute({ command: 'git status' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(printInfo).toHaveBeenCalledWith(expect.stringContaining('learned fix'));
    });
  });

  describe('error propagation', () => {
    it('when original execute throws, the error is re-thrown', async () => {
      const thrownError = new Error('network failure');
      const tools = {
        myTool: {
          execute: vi.fn(async () => {
            throw thrownError;
          }),
        },
      };

      const augmented = augmentTools(tools, store);

      await expect(augmented.myTool.execute({}, {})).rejects.toThrow('network failure');
    });

    it('when original execute throws, recordBadExample is not called', async () => {
      const tools = {
        myTool: {
          execute: vi.fn(async () => {
            throw new Error('infrastructure error');
          }),
        },
      };

      const augmented = augmentTools(tools, store);

      try {
        await augmented.myTool.execute({}, {});
      } catch {
        // expected
      }
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).not.toHaveBeenCalled();
    });

    it('when original execute throws, debugLog is called with the error message', async () => {
      const tools = {
        myTool: {
          execute: vi.fn(async () => {
            throw new Error('something broke');
          }),
        },
      };

      const augmented = augmentTools(tools, store);

      try {
        await augmented.myTool.execute({}, {});
      } catch {
        // expected
      }

      expect(debugLog).toHaveBeenCalledWith('augment:myTool:threw', 'something broke');
    });

    it('when original execute throws a non-Error, its string form is logged', async () => {
      const tools = {
        myTool: {
          execute: vi.fn(async () => {
            throw 'string error value';
          }),
        },
      };

      const augmented = augmentTools(tools, store);

      try {
        await augmented.myTool.execute({}, {});
      } catch {
        // expected
      }

      expect(debugLog).toHaveBeenCalledWith('augment:myTool:threw', 'string error value');
    });
  });

  describe('recording isolation', () => {
    it('recording errors in setImmediate callback do not propagate', async () => {
      vi.mocked(detectToolError).mockImplementation(() => {
        throw new Error('detectToolError exploded');
      });

      const tools = { myTool: { execute: vi.fn(async () => 'ok') } };

      const augmented = augmentTools(tools, store);

      // Should not throw even though detectToolError throws inside setImmediate
      const result = await augmented.myTool.execute({}, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(result).toBe('ok');
    });

    it('recording happens asynchronously — result is returned before recording', async () => {
      const callOrder: string[] = [];

      vi.mocked(detectToolError).mockImplementation(() => {
        callOrder.push('detectToolError');
        return { isError: false };
      });

      const tools = {
        myTool: {
          execute: vi.fn(async () => {
            callOrder.push('execute-returned');
            return 'result';
          }),
        },
      };

      const augmented = augmentTools(tools, store);
      const result = await augmented.myTool.execute({}, {});

      // Recording has not fired yet — setImmediate hasn't run
      expect(callOrder).toEqual(['execute-returned']);
      expect(result).toBe('result');

      // After flushing the event loop, detectToolError should have been called
      await new Promise((resolve) => setImmediate(resolve));
      expect(callOrder).toEqual(['execute-returned', 'detectToolError']);
    });

    it('printInfo is called inside setImmediate (not during augmentTools setup)', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: CORRECTABLE_ERROR });

      const tools = { myTool: { execute: vi.fn(async () => 'result') } };

      vi.mocked(printInfo).mockClear();
      augmentTools(tools, store);

      // printInfo should NOT have been called during augmentTools setup
      expect(printInfo).not.toHaveBeenCalled();
    });

    it('store.recordBadExample is not called synchronously — only after setImmediate', async () => {
      vi.mocked(detectToolError).mockReturnValue({
        isError: true,
        snippet: NONSHELL_CORRECTABLE_ERROR,
      });

      const tools = { myTool: { execute: vi.fn(async () => 'result') } };
      const augmented = augmentTools(tools, store);

      await augmented.myTool.execute({}, {});

      // Before flushing: not yet called
      expect(store.recordBadExample).not.toHaveBeenCalled();

      await new Promise((resolve) => setImmediate(resolve));

      // After flushing: called
      expect(store.recordBadExample).toHaveBeenCalled();
    });
  });

  describe('resolveProfileKey edge cases', () => {
    it('shell tool with non-string command falls back to tool name', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: CORRECTABLE_ERROR });

      const tools = { shell: { execute: vi.fn(async () => 'result') } };
      // Pass args where command is not a string
      const augmented = augmentTools(tools, store);
      await augmented.shell.execute({ command: 42 }, {});
      await new Promise((resolve) => setImmediate(resolve));

      // With non-string command, resolveProfileKey returns 'shell' (the tool name)
      expect(store.recordBadExample).toHaveBeenCalledWith(
        'shell',
        expect.any(String),
        CORRECTABLE_ERROR,
        'exec_failed',
      );
    });

    it('shell tool with no args object falls back to tool name', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: CORRECTABLE_ERROR });

      const tools = { shell: { execute: vi.fn(async () => 'result') } };
      const augmented = augmentTools(tools, store);
      await augmented.shell.execute(null, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledWith(
        'shell',
        expect.any(String),
        CORRECTABLE_ERROR,
        'exec_failed',
      );
    });

    it('tool name with __ uses mcp. prefix regardless of shell classification', async () => {
      vi.mocked(detectToolError).mockReturnValue({
        isError: true,
        snippet: NONSHELL_CORRECTABLE_ERROR,
      });

      const tools = {
        server__shell: { execute: vi.fn(async () => 'result') },
      };
      const augmented = augmentTools(tools, store);
      await augmented['server__shell'].execute({ command: 'git status' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      // __ check runs before shell classification
      expect(store.recordBadExample).toHaveBeenCalledWith(
        'mcp.server__shell',
        expect.any(String),
        NONSHELL_CORRECTABLE_ERROR,
        'invalid_args',
      );
    });
  });

  describe('safeSerialize', () => {
    it('args are serialized and truncated to 300 chars when very long', async () => {
      vi.mocked(detectToolError).mockReturnValue({
        isError: true,
        snippet: NONSHELL_CORRECTABLE_ERROR,
      });

      const longValue = 'x'.repeat(400);
      const tools = { myTool: { execute: vi.fn(async () => 'result') } };
      const augmented = augmentTools(tools, store);
      await augmented.myTool.execute({ key: longValue }, {});
      await new Promise((resolve) => setImmediate(resolve));

      const calledArgs = store.recordBadExample.mock.calls[0][1] as string;
      expect(calledArgs.length).toBeLessThanOrEqual(300);
    });

    it('non-serializable args fall back to String()', async () => {
      vi.mocked(detectToolError).mockReturnValue({
        isError: true,
        snippet: NONSHELL_CORRECTABLE_ERROR,
      });

      // Create a circular reference to cause JSON.stringify to throw
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      const tools = { myTool: { execute: vi.fn(async () => 'result') } };
      const augmented = augmentTools(tools, store);

      // Should not throw
      await augmented.myTool.execute(circular, {});
      await new Promise((resolve) => setImmediate(resolve));

      const calledArgs = store.recordBadExample.mock.calls[0][1] as string;
      expect(typeof calledArgs).toBe('string');
      expect(calledArgs.length).toBeLessThanOrEqual(300);
    });
  });

  describe('envelope-aware path (migrated BernardTools)', () => {
    function makeBernardTool(opts: {
      name: string;
      result: 'ok' | 'error';
      message?: string;
    }): BernardTool<{ x: number }, { val: number }> {
      return {
        meta: { name: opts.name, kind: 'read' },
        description: opts.name,
        parameters: z.object({ x: z.number() }),
        execute: async () =>
          opts.result === 'ok'
            ? ok({ val: 1 })
            : err({ type: 'exec_failed', message: opts.message ?? 'boom', snippet: 'boom-snip' }),
        serializeForModel: (r) => (r.status === 'ok' ? r.result : `Error: ${r.error.message}`),
      };
    }

    it('records error envelope WITHOUT calling detectToolError heuristic', async () => {
      const aisdk = toolToAISDK(
        makeBernardTool({ name: 'demo', result: 'error', message: NONSHELL_CORRECTABLE_ERROR }),
      );
      const augmented = augmentTools({ demo: aisdk }, store);
      await augmented.demo.execute({ x: 1 }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledTimes(1);
      // Heuristic detector must not be consulted for migrated tools.
      expect(detectToolError).not.toHaveBeenCalled();
    });

    it('records nothing on ok envelope', async () => {
      const aisdk = toolToAISDK(makeBernardTool({ name: 'demo', result: 'ok' }));
      const augmented = augmentTools({ demo: aisdk }, store);
      await augmented.demo.execute({ x: 1 }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).not.toHaveBeenCalled();
      expect(detectToolError).not.toHaveBeenCalled();
    });

    it('returns the model-facing serialized form, not the raw envelope', async () => {
      const aisdk = toolToAISDK(
        makeBernardTool({ name: 'demo', result: 'error', message: 'oops' }),
      );
      const augmented = augmentTools({ demo: aisdk }, store);
      const out = await augmented.demo.execute({ x: 1 }, {});
      expect(out).toBe('Error: oops');
    });

    it('patches the most recent unfixed bad example on success (envelope path)', async () => {
      store.get.mockReturnValue({
        badExamples: [{ args: '{"x":2}', errorSnippet: 'old', fix: '(awaiting successful retry)' }],
      });
      const aisdk = toolToAISDK(makeBernardTool({ name: 'demo', result: 'ok' }));
      const augmented = augmentTools({ demo: aisdk }, store);
      await augmented.demo.execute({ x: 1 }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.patchLastBadWithFix).toHaveBeenCalledWith('demo', JSON.stringify({ x: 1 }));
    });
  });

  describe('confirmation gate (#144)', () => {
    function makeLegacyToolWithMeta(
      kind: 'read' | 'write' | 'dangerous',
      sideEffect: 'none' | 'local' | 'external-api' = 'local',
    ) {
      const execute = vi.fn(async () => ({ output: 'done', is_error: false }));
      const t: any = { execute, description: 't', parameters: {} };
      attachMeta(t, { name: 't', kind, deterministic: false, sideEffect, cacheable: false });
      return { t, execute };
    }

    it('no confirmAction wired → executes without prompting', async () => {
      const { t, execute } = makeLegacyToolWithMeta('dangerous');
      const augmented = augmentTools({ t }, { profileStore: store, confirmThreshold: 'high' });
      await augmented.t.execute({}, {});
      expect(execute).toHaveBeenCalled();
    });

    it('confirmAction wired without explicit threshold → defaults to high (cron contract)', async () => {
      // Cron (#144) wires `confirmAction: (i) => i.risk !== 'high'` but has no
      // policyDecision, so the threshold flows through as undefined. Without
      // the default-to-high fallback the gate short-circuits and the auto-deny
      // callback never fires.
      const { t: highT, execute: highExec } = makeLegacyToolWithMeta('dangerous');
      const { t: medT, execute: medExec } = makeLegacyToolWithMeta('write', 'local');
      const confirmAction = vi.fn(async (input: { risk: string }) => input.risk !== 'high');
      const augmented = augmentTools({ highT, medT }, { profileStore: store, confirmAction });
      await augmented.medT.execute({}, {});
      expect(confirmAction).not.toHaveBeenCalled();
      expect(medExec).toHaveBeenCalled();
      const r = await augmented.highT.execute({}, {});
      expect(confirmAction).toHaveBeenCalledWith(
        expect.objectContaining({ risk: 'high' }),
        undefined,
      );
      expect(highExec).not.toHaveBeenCalled();
      expect(r).toEqual({ output: 'Action cancelled by user.', is_error: true });
    });

    it('high-risk tool with threshold=high → prompts; allowed → executes', async () => {
      const { t, execute } = makeLegacyToolWithMeta('dangerous');
      const confirmAction = vi.fn(async () => true);
      const augmented = augmentTools(
        { t },
        { profileStore: store, confirmThreshold: 'high', confirmAction },
      );
      const r = await augmented.t.execute({ x: 1 }, {});
      expect(confirmAction).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 't', risk: 'high' }),
        undefined,
      );
      expect(execute).toHaveBeenCalled();
      expect(r).toEqual({ output: 'done', is_error: false });
    });

    it('high-risk tool with threshold=high → denied → returns cancelled, execute NOT called', async () => {
      const { t, execute } = makeLegacyToolWithMeta('dangerous');
      const confirmAction = vi.fn(async () => false);
      const augmented = augmentTools(
        { t },
        { profileStore: store, confirmThreshold: 'high', confirmAction },
      );
      const r = await augmented.t.execute({}, {});
      expect(execute).not.toHaveBeenCalled();
      expect(r).toEqual({ output: 'Action cancelled by user.', is_error: true });
    });

    it('medium-risk tool with threshold=high → NOT prompted', async () => {
      const { t, execute } = makeLegacyToolWithMeta('write', 'local');
      const confirmAction = vi.fn(async () => false);
      const augmented = augmentTools(
        { t },
        { profileStore: store, confirmThreshold: 'high', confirmAction },
      );
      await augmented.t.execute({}, {});
      expect(confirmAction).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
    });

    it('medium-risk tool with threshold=medium → prompts', async () => {
      const { t, execute } = makeLegacyToolWithMeta('write', 'local');
      const confirmAction = vi.fn(async () => true);
      const augmented = augmentTools(
        { t },
        { profileStore: store, confirmThreshold: 'medium', confirmAction },
      );
      await augmented.t.execute({}, {});
      expect(confirmAction).toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
    });

    it('low-risk tool with threshold=medium → NOT prompted', async () => {
      const { t, execute } = makeLegacyToolWithMeta('read');
      const confirmAction = vi.fn(async () => false);
      const augmented = augmentTools(
        { t },
        { profileStore: store, confirmThreshold: 'medium', confirmAction },
      );
      await augmented.t.execute({}, {});
      expect(confirmAction).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
    });

    it('threshold=never → never prompts', async () => {
      const { t, execute } = makeLegacyToolWithMeta('dangerous');
      const confirmAction = vi.fn(async () => false);
      const augmented = augmentTools(
        { t },
        { profileStore: store, confirmThreshold: 'never', confirmAction },
      );
      await augmented.t.execute({}, {});
      expect(confirmAction).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
    });

    it('envelope-aware path: deny returns serialized cancelled envelope', async () => {
      const source: BernardTool<{ x: number }, { val: number }> = {
        meta: {
          name: 'demo',
          kind: 'dangerous',
          deterministic: false,
          sideEffect: 'local',
          cacheable: false,
        },
        description: 'demo',
        parameters: z.object({ x: z.number() }),
        execute: vi.fn(async () => ok({ val: 1 })) as any,
        serializeForModel: (r) =>
          r.status === 'ok' ? `ok:${r.result.val}` : `err:${r.error.type}:${r.error.message}`,
      };
      const aisdk = toolToAISDK(source);
      const confirmAction = vi.fn(async () => false);
      const augmented = augmentTools(
        { demo: aisdk },
        { profileStore: store, confirmThreshold: 'high', confirmAction },
      );
      const out = await augmented.demo.execute({ x: 1 }, {});
      expect(confirmAction).toHaveBeenCalled();
      expect(source.execute).not.toHaveBeenCalled();
      expect(out).toBe('err:cancelled:Action cancelled by user.');
    });

    it('confirmAction throws → fails closed (denied)', async () => {
      const { t, execute } = makeLegacyToolWithMeta('dangerous');
      const confirmAction = vi.fn(async () => {
        throw new Error('boom');
      });
      const augmented = augmentTools(
        { t },
        { profileStore: store, confirmThreshold: 'high', confirmAction },
      );
      const r = await augmented.t.execute({}, {});
      expect(execute).not.toHaveBeenCalled();
      expect(r).toEqual({ output: 'Action cancelled by user.', is_error: true });
    });

    it('forwards abortSignal from execOptions into confirmAction', async () => {
      const { t } = makeLegacyToolWithMeta('dangerous');
      const confirmAction = vi.fn(async () => true);
      const augmented = augmentTools(
        { t },
        { profileStore: store, confirmThreshold: 'high', confirmAction },
      );
      const controller = new AbortController();
      await augmented.t.execute({}, { abortSignal: controller.signal });
      expect(confirmAction).toHaveBeenCalledWith(expect.any(Object), controller.signal);
    });

    it('tool without meta defaults to medium-risk', async () => {
      const execute = vi.fn(async () => 'ok');
      const t: any = { execute, description: '', parameters: {} };
      const confirmAction = vi.fn(async () => true);
      const augmented = augmentTools(
        { t },
        { profileStore: store, confirmThreshold: 'medium', confirmAction },
      );
      await augmented.t.execute({}, {});
      expect(confirmAction).toHaveBeenCalledWith(
        expect.objectContaining({ risk: 'medium' }),
        undefined,
      );
    });

    it('legacy backward-compat: passing a ToolProfileStore directly still works', async () => {
      const tools = { myTool: { execute: vi.fn(async () => 'ok') } };
      const augmented = augmentTools(tools, store);
      const r = await augmented.myTool.execute({}, {});
      expect(r).toBe('ok');
    });
  });

  describe('read-only block gate (#179)', () => {
    function makeLegacyToolWithMeta(
      kind: 'read' | 'write' | 'dangerous' | 'inert',
      sideEffect: 'none' | 'local' | 'external-api' = 'local',
    ) {
      const execute = vi.fn(async () => ({ output: 'done', is_error: false }));
      const t: any = { execute, description: 't', parameters: {} };
      attachMeta(t, { name: 't', kind, deterministic: false, sideEffect, cacheable: false });
      return { t, execute };
    }

    const DENIED = {
      output:
        'Action denied — read-only mode. Ask the user to allow this tool or switch toolMode to write.',
      is_error: true,
    };

    it('default toolMode (write) → block gate never fires even on dangerous tools', async () => {
      const { t, execute } = makeLegacyToolWithMeta('dangerous');
      const blockAction = vi.fn(async () => 'allow-once' as const);
      const augmented = augmentTools({ t }, { profileStore: store, blockAction });
      await augmented.t.execute({}, {});
      expect(blockAction).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
    });

    it('read-only + write tool + allow-once → tool runs; second call re-prompts', async () => {
      const { t, execute } = makeLegacyToolWithMeta('write', 'local');
      const blockAction = vi.fn(async () => 'allow-once' as const);
      const augmented = augmentTools(
        { t },
        { profileStore: store, toolMode: 'read-only', blockAction },
      );
      await augmented.t.execute({}, {});
      await augmented.t.execute({}, {});
      expect(blockAction).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('read-only + allow-tool-for-session → first call prompts, second skips, other tool still prompts', async () => {
      const { t: alpha, execute: alphaExec } = makeLegacyToolWithMeta('write', 'local');
      const { t: beta, execute: betaExec } = makeLegacyToolWithMeta('write', 'local');
      const blockAction = vi.fn(async () => 'allow-tool-for-session' as const);
      const augmented = augmentTools(
        { alpha, beta },
        { profileStore: store, toolMode: 'read-only', blockAction },
      );
      await augmented.alpha.execute({}, {});
      await augmented.alpha.execute({}, {});
      await augmented.beta.execute({}, {});
      // alpha prompts once (then allowlisted), beta prompts once.
      expect(blockAction).toHaveBeenCalledTimes(2);
      expect(alphaExec).toHaveBeenCalledTimes(2);
      expect(betaExec).toHaveBeenCalledTimes(1);
    });

    it('read-only + deny → returns DENIED result, execute NOT called', async () => {
      const { t, execute } = makeLegacyToolWithMeta('dangerous');
      const blockAction = vi.fn(async () => 'deny' as const);
      const augmented = augmentTools(
        { t },
        { profileStore: store, toolMode: 'read-only', blockAction },
      );
      const r = await augmented.t.execute({}, {});
      expect(execute).not.toHaveBeenCalled();
      expect(r).toEqual(DENIED);
    });

    it('read-only + read tool → block gate skipped', async () => {
      const { t, execute } = makeLegacyToolWithMeta('read');
      const blockAction = vi.fn(async () => 'deny' as const);
      const augmented = augmentTools(
        { t },
        { profileStore: store, toolMode: 'read-only', blockAction },
      );
      await augmented.t.execute({}, {});
      expect(blockAction).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
    });

    it('read-only + missing blockAction + write tool → fails closed (denied)', async () => {
      const { t, execute } = makeLegacyToolWithMeta('write', 'local');
      const augmented = augmentTools({ t }, { profileStore: store, toolMode: 'read-only' });
      const r = await augmented.t.execute({}, {});
      expect(execute).not.toHaveBeenCalled();
      expect(r).toEqual(DENIED);
    });

    it('block gate runs BEFORE confirm gate (allow-once still hits confirm prompt)', async () => {
      const { t, execute } = makeLegacyToolWithMeta('dangerous');
      const order: string[] = [];
      const blockAction = vi.fn(async () => {
        order.push('block');
        return 'allow-once' as const;
      });
      const confirmAction = vi.fn(async () => {
        order.push('confirm');
        return false;
      });
      const augmented = augmentTools(
        { t },
        {
          profileStore: store,
          toolMode: 'read-only',
          blockAction,
          confirmThreshold: 'high',
          confirmAction,
        },
      );
      const r = await augmented.t.execute({}, {});
      expect(order).toEqual(['block', 'confirm']);
      expect(execute).not.toHaveBeenCalled();
      // Distinct cancellation message — confirm-cancel, not denied.
      expect(r).toEqual({ output: 'Action cancelled by user.', is_error: true });
    });

    it('envelope-aware path: deny returns serialized denied envelope (distinct error type)', async () => {
      const source: BernardTool<{ x: number }, { val: number }> = {
        meta: {
          name: 'demo',
          kind: 'write',
          deterministic: false,
          sideEffect: 'local',
          cacheable: false,
        },
        description: 'demo',
        parameters: z.object({ x: z.number() }),
        execute: vi.fn(async () => ok({ val: 1 })) as any,
        serializeForModel: (r) =>
          r.status === 'ok' ? `ok:${r.result.val}` : `err:${r.error.type}:${r.error.message}`,
      };
      const aisdk = toolToAISDK(source);
      const blockAction = vi.fn(async () => 'deny' as const);
      const augmented = augmentTools(
        { demo: aisdk },
        { profileStore: store, toolMode: 'read-only', blockAction },
      );
      const out = await augmented.demo.execute({ x: 1 }, {});
      expect(blockAction).toHaveBeenCalled();
      expect(source.execute).not.toHaveBeenCalled();
      // Distinct error type 'denied' (not 'cancelled') so envelope consumers
      // can tell read-only denial apart from confirm-gate cancel without
      // parsing the message text.
      expect(out).toBe(
        'err:denied:Action denied — read-only mode. Ask the user to allow this tool or switch toolMode to write.',
      );
    });

    it('blockAction throws → fails closed (denied)', async () => {
      const { t, execute } = makeLegacyToolWithMeta('write', 'local');
      const blockAction = vi.fn(async () => {
        throw new Error('boom');
      });
      const augmented = augmentTools(
        { t },
        { profileStore: store, toolMode: 'read-only', blockAction },
      );
      const r = await augmented.t.execute({}, {});
      expect(execute).not.toHaveBeenCalled();
      expect(r).toEqual(DENIED);
    });

    it('forwards abortSignal from execOptions into blockAction', async () => {
      const { t } = makeLegacyToolWithMeta('write', 'local');
      const blockAction = vi.fn(async () => 'allow-once' as const);
      const augmented = augmentTools(
        { t },
        { profileStore: store, toolMode: 'read-only', blockAction },
      );
      const controller = new AbortController();
      await augmented.t.execute({}, { abortSignal: controller.signal });
      expect(blockAction).toHaveBeenCalledWith(expect.any(Object), controller.signal);
    });

    it('missing meta → block gate falls through (allowed)', async () => {
      const execute = vi.fn(async () => 'ok');
      const t: any = { execute, description: '', parameters: {} };
      const blockAction = vi.fn(async () => 'deny' as const);
      const augmented = augmentTools(
        { t },
        { profileStore: store, toolMode: 'read-only', blockAction },
      );
      await augmented.t.execute({}, {});
      expect(blockAction).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
    });

    it('shared sessionToolAllowlist survives across augmentTools invocations', async () => {
      // Simulates the REPL's per-process-lifetime allowlist: one Set, two
      // separate augmentTools calls (the second models a sub-agent or a
      // tool-wrapper dispatch with its own runDefinition).
      const shared = new Set<string>();
      const { t: t1, execute: e1 } = makeLegacyToolWithMeta('write', 'local');
      const { t: t2, execute: e2 } = makeLegacyToolWithMeta('write', 'local');
      const blockAction = vi.fn(async () => 'allow-tool-for-session' as const);
      const outerAug = augmentTools(
        { t: t1 },
        {
          profileStore: store,
          toolMode: 'read-only',
          blockAction,
          sessionToolAllowlist: shared,
        },
      );
      await outerAug.t.execute({}, {});
      expect(blockAction).toHaveBeenCalledTimes(1);
      expect(e1).toHaveBeenCalledTimes(1);
      // Simulate a nested augmentTools call (sub-agent / wrapper). Same
      // toolName should now bypass the block gate via the shared set.
      const innerAug = augmentTools(
        { t: t2 },
        {
          profileStore: store,
          toolMode: 'read-only',
          blockAction,
          sessionToolAllowlist: shared,
        },
      );
      await innerAug.t.execute({}, {});
      expect(blockAction).toHaveBeenCalledTimes(1);
      expect(e2).toHaveBeenCalledTimes(1);
    });

    it('isWriteAction predicate bypasses block gate for read-shaped invocations', async () => {
      const execute = vi.fn(async () => ({ output: 'ok', is_error: false }));
      const t: any = { execute, description: 't', parameters: {} };
      attachMeta(t, {
        name: 't',
        kind: 'write',
        deterministic: false,
        sideEffect: 'local',
        cacheable: false,
        isWriteAction: (args: unknown) =>
          (args as { action?: string } | undefined)?.action !== 'read',
      });
      const blockAction = vi.fn(async () => 'deny' as const);
      const augmented = augmentTools(
        { t },
        { profileStore: store, toolMode: 'read-only', blockAction },
      );
      await augmented.t.execute({ action: 'read' }, {});
      expect(blockAction).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
      // Write action still trips the gate.
      const r = await augmented.t.execute({ action: 'write' }, {});
      expect(blockAction).toHaveBeenCalledTimes(1);
      expect(r).toEqual(DENIED);
    });
  });

  describe('write-scope gate (#340)', () => {
    const workspace = path.join(os.tmpdir(), 'bernard-scope-test', 'ws');

    /** `file_write`-shaped: a write tool taking a `path` argument. */
    function makeWriteTool(name: string) {
      const execute = vi.fn(async () => ({ ok: true }));
      const t: any = { execute, description: 't', parameters: {} };
      attachMeta(t, {
        name,
        kind: 'write',
        deterministic: false,
        sideEffect: 'local',
        cacheable: false,
      });
      return { t, execute };
    }

    it('no scope configured → no restriction (the interactive default)', async () => {
      const { t, execute } = makeWriteTool('file_write');
      const augmented = augmentTools({ file_write: t }, { profileStore: store });
      await augmented.file_write.execute({ path: '/etc/passwd' }, {});
      expect(execute).toHaveBeenCalled();
    });

    it('allows a write inside the workspace', async () => {
      const { t, execute } = makeWriteTool('file_write');
      const augmented = augmentTools(
        { file_write: t },
        { profileStore: store, getWriteScope: () => ({ workspace }) },
      );
      await augmented.file_write.execute({ path: path.join(workspace, 'a.txt') }, {});
      expect(execute).toHaveBeenCalled();
    });

    it('refuses a write outside it, without invoking the tool', async () => {
      const { t, execute } = makeWriteTool('file_write');
      const augmented = augmentTools(
        { file_write: t },
        { profileStore: store, getWriteScope: () => ({ workspace }) },
      );
      const out = await augmented.file_write.execute({ path: '/etc/passwd' }, {});
      expect(execute).not.toHaveBeenCalled();
      expect(String(out)).toContain('refused');
    });

    // The caller is generated code with no operator watching, so a bare
    // refusal gets retried against the same path forever.
    it('names the workspace in the refusal it hands the model', async () => {
      const { t } = makeWriteTool('file_write');
      const augmented = augmentTools(
        { file_write: t },
        { profileStore: store, getWriteScope: () => ({ workspace }) },
      );
      const out = await augmented.file_write.execute({ path: '/etc/passwd' }, {});
      expect(String(out)).toContain(workspace);
    });

    it('honours an explicit grant', async () => {
      const { t, execute } = makeWriteTool('file_edit_lines');
      const granted = path.join(os.tmpdir(), 'bernard-scope-test', 'granted');
      const augmented = augmentTools(
        { file_edit_lines: t },
        { profileStore: store, getWriteScope: () => ({ workspace, grants: [granted] }) },
      );
      await augmented.file_edit_lines.execute({ path: path.join(granted, 'x.txt') }, {});
      expect(execute).toHaveBeenCalled();
    });

    // This gate bounds writes, not reads — read scoping is a separate decision.
    it('does not gate a read tool, even one taking a path', async () => {
      const { t, execute } = makeWriteTool('file_read_lines');
      const augmented = augmentTools(
        { file_read_lines: t },
        { profileStore: store, getWriteScope: () => ({ workspace }) },
      );
      await augmented.file_read_lines.execute({ path: '/etc/passwd' }, {});
      expect(execute).toHaveBeenCalled();
    });

    // Extracting write targets from an arbitrary command line is not reliably
    // possible, and a containment check that is sometimes wrong is worse than
    // none. `shell` keeps its existing dangerous-command denial instead.
    it('does not gate shell — deliberately out of scope', async () => {
      const { t, execute } = makeWriteTool('shell');
      const augmented = augmentTools(
        { shell: t },
        { profileStore: store, getWriteScope: () => ({ workspace }) },
      );
      await augmented.shell.execute({ command: 'echo hi > /etc/passwd' }, {});
      expect(execute).toHaveBeenCalled();
    });

    it('runs before the block gate, so an out-of-scope write is never prompted', async () => {
      const { t, execute } = makeWriteTool('file_write');
      const blockAction = vi.fn(async () => 'allow-once' as const);
      const augmented = augmentTools(
        { file_write: t },
        {
          profileStore: store,
          toolMode: 'read-only',
          blockAction,
          getWriteScope: () => ({ workspace }),
        },
      );
      await augmented.file_write.execute({ path: '/etc/passwd' }, {});
      expect(blockAction).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('profile permission gate (#212)', () => {
    function makeToolWithMeta(name: string, kind: 'read' | 'write' | 'dangerous' = 'dangerous') {
      const execute = vi.fn(async () => ({ output: 'done', is_error: false }));
      const t: any = { execute, description: name, parameters: {} };
      attachMeta(t, { name, kind, deterministic: false, sideEffect: 'local', cacheable: false });
      return { t, execute };
    }

    it('profile allow grant skips the confirm prompt', async () => {
      const { t, execute } = makeToolWithMeta('t');
      const confirmAction = vi.fn(async () => false);
      const augmented = augmentTools(
        { t },
        {
          profileStore: store,
          confirmThreshold: 'high',
          confirmAction,
          getToolPermissions: () => [{ effect: 'allow', tool: 't', _v: 2 }],
        },
      );
      await augmented.t.execute({}, {});
      expect(confirmAction).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
    });

    it('profile allow grant on shell:<cmd> skips confirm for that command only', async () => {
      const { t: shell, execute } = makeToolWithMeta('shell');
      const confirmAction = vi.fn(async () => false);
      const augmented = augmentTools(
        { shell },
        {
          profileStore: store,
          confirmThreshold: 'high',
          confirmAction,
          getToolPermissions: () => [
            { effect: 'allow', tool: 'shell', specifier: 'touch *', _v: 2 },
          ],
        },
      );
      await augmented.shell.execute({ command: 'touch x' }, {});
      expect(confirmAction).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      // Different (dangerous) command → grant doesn't match / dangerous floor → prompts.
      await augmented.shell.execute({ command: 'rm -rf ./x' }, {});
      expect(confirmAction).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('complex shell commands have no stable key → grant ignored, prompt fires', async () => {
      const { t: shell, execute } = makeToolWithMeta('shell');
      const confirmAction = vi.fn(async () => false);
      const augmented = augmentTools(
        { shell },
        {
          profileStore: store,
          confirmThreshold: 'high',
          confirmAction,
          getToolPermissions: () => [
            { effect: 'allow', tool: 'shell', specifier: 'touch *', _v: 2 },
            { effect: 'allow', tool: 'shell', _v: 2 },
          ],
        },
      );
      await augmented.shell.execute({ command: 'touch x; rm -rf /' }, {});
      expect(confirmAction).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      // The prompt input carries permissionKey: null so the dialog hides
      // the "always allow" option.
      expect(confirmAction).toHaveBeenCalledWith(
        expect.objectContaining({ permissionKey: null }),
        undefined,
      );
    });

    it('profile deny grant cancels without prompting', async () => {
      const { t, execute } = makeToolWithMeta('t');
      const confirmAction = vi.fn(async () => true);
      const augmented = augmentTools(
        { t },
        {
          profileStore: store,
          confirmThreshold: 'high',
          confirmAction,
          getToolPermissions: () => [{ effect: 'deny', tool: 't', _v: 2 }],
        },
      );
      const r = await augmented.t.execute({}, {});
      expect(confirmAction).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(r).toEqual({ output: 'Action cancelled by user.', is_error: true });
    });

    it('profile allow grant bypasses the read-only block gate', async () => {
      const { t, execute } = makeToolWithMeta('t', 'write');
      const blockAction = vi.fn(async () => 'deny' as const);
      const augmented = augmentTools(
        { t },
        {
          profileStore: store,
          toolMode: 'read-only',
          blockAction,
          getToolPermissions: () => [{ effect: 'allow', tool: 't', _v: 2 }],
        },
      );
      await augmented.t.execute({}, {});
      expect(blockAction).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
    });

    it('profile deny grant denies at the block gate without prompting', async () => {
      const { t, execute } = makeToolWithMeta('t', 'write');
      const blockAction = vi.fn(async () => 'allow-once' as const);
      const augmented = augmentTools(
        { t },
        {
          profileStore: store,
          toolMode: 'read-only',
          blockAction,
          getToolPermissions: () => [{ effect: 'deny', tool: 't', _v: 2 }],
        },
      );
      const r = await augmented.t.execute({}, {});
      expect(blockAction).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(r).toEqual({
        output:
          'Action denied — read-only mode. Ask the user to allow this tool or switch toolMode to write.',
        is_error: true,
      });
    });

    it("'allow-tool-for-profile' block outcome proceeds without touching the session allowlist", async () => {
      const { t: shell, execute } = makeToolWithMeta('shell', 'write');
      const sessionToolAllowlist = new Set<string>();
      const blockAction = vi.fn(async () => 'allow-tool-for-profile' as const);
      const augmented = augmentTools(
        { shell },
        {
          profileStore: store,
          toolMode: 'read-only',
          blockAction,
          sessionToolAllowlist,
        },
      );
      await augmented.shell.execute({ command: 'touch x' }, {});
      expect(execute).toHaveBeenCalledTimes(1);
      // Persistence is the UI layer's job; the gate must NOT name-allowlist
      // `shell` (that would over-allow every shell command this session).
      expect(sessionToolAllowlist.size).toBe(0);
    });

    it('no getToolPermissions → both gates behave as before', async () => {
      const { t, execute } = makeToolWithMeta('t');
      const confirmAction = vi.fn(async () => true);
      const augmented = augmentTools(
        { t },
        { profileStore: store, confirmThreshold: 'high', confirmAction },
      );
      await augmented.t.execute({}, {});
      expect(confirmAction).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalled();
    });

    it('confirm prompt input carries the permission key', async () => {
      const { t: shell } = makeToolWithMeta('shell');
      const confirmAction = vi.fn(async () => false);
      const augmented = augmentTools(
        { shell },
        { profileStore: store, confirmThreshold: 'high', confirmAction },
      );
      await augmented.shell.execute({ command: 'touch x' }, {});
      expect(confirmAction).toHaveBeenCalledWith(
        expect.objectContaining({ permissionKey: 'shell:touch' }),
        undefined,
      );
    });
  });

  describe('multiple tools', () => {
    it('augments all tools in the record independently', async () => {
      vi.mocked(detectToolError).mockReturnValue({
        isError: true,
        snippet: NONSHELL_CORRECTABLE_ERROR,
      });

      const tools = {
        tool1: { execute: vi.fn(async () => 'r1'), description: 'Tool 1' },
        tool2: { execute: vi.fn(async () => 'r2'), description: 'Tool 2' },
        tool3: { execute: vi.fn(async () => 'r3'), description: 'Tool 3' },
      };

      const augmented = augmentTools(tools, store);

      expect(Object.keys(augmented)).toEqual(['tool1', 'tool2', 'tool3']);
      expect(typeof augmented.tool1.execute).toBe('function');
      expect(typeof augmented.tool2.execute).toBe('function');
      expect(typeof augmented.tool3.execute).toBe('function');

      // Execute all three
      await augmented.tool1.execute({}, {});
      await augmented.tool2.execute({}, {});
      await augmented.tool3.execute({}, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledTimes(3);
    });

    it('original execute functions remain independent', async () => {
      const exec1 = vi.fn(async () => 'result-1');
      const exec2 = vi.fn(async () => 'result-2');

      const tools = {
        tool1: { execute: exec1 },
        tool2: { execute: exec2 },
      };

      const augmented = augmentTools(tools, store);

      const r1 = await augmented.tool1.execute({ a: 1 }, {});
      const r2 = await augmented.tool2.execute({ b: 2 }, {});

      expect(r1).toBe('result-1');
      expect(r2).toBe('result-2');
      expect(exec1).toHaveBeenCalledWith({ a: 1 }, {});
      expect(exec2).toHaveBeenCalledWith({ b: 2 }, {});
    });
  });

  describe('deterministic tool result cache (#171)', () => {
    function makeCacheableBernardTool(
      execImpl: () => Promise<
        | { status: 'ok'; result: { val: number } }
        | { status: 'error'; error: { type: string; message: string } }
      >,
      opts: { cacheable?: boolean } = {},
    ): BernardTool<{ x: number }, { val: number }> {
      return {
        meta: {
          name: 'cacheable_tool',
          kind: 'read',
          deterministic: true,
          sideEffect: 'none',
          cacheable: opts.cacheable ?? true,
          cacheTtlMs: 0, // indefinite for the test
        },
        description: 'cacheable',
        parameters: z.object({ x: z.number() }),
        execute: execImpl as any,
        serializeForModel: (r) => (r.status === 'ok' ? r.result : `Error: ${r.error.message}`),
      };
    }

    beforeEach(() => {
      clearResultCache();
    });

    it('returns the cached serialized result on second call, skipping execute', async () => {
      const exec = vi.fn(async () => ok({ val: 42 }));
      const aisdk = toolToAISDK(makeCacheableBernardTool(exec));
      const augmented = augmentTools({ cacheable_tool: aisdk }, store);

      const r1 = await augmented.cacheable_tool.execute({ x: 1 }, {});
      const r2 = await augmented.cacheable_tool.execute({ x: 1 }, {});

      expect(r1).toEqual({ val: 42 });
      expect(r2).toEqual({ val: 42 });
      expect(exec).toHaveBeenCalledTimes(1);
    });

    it('different args miss the cache and call execute again', async () => {
      const exec = vi.fn(async (args: { x: number }) => ok({ val: args.x * 10 }));
      const aisdk = toolToAISDK(makeCacheableBernardTool(exec));
      const augmented = augmentTools({ cacheable_tool: aisdk }, store);

      const r1 = await augmented.cacheable_tool.execute({ x: 1 }, {});
      const r2 = await augmented.cacheable_tool.execute({ x: 2 }, {});

      expect(r1).toEqual({ val: 10 });
      expect(r2).toEqual({ val: 20 });
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it('does NOT cache when meta opts out (cacheable: false with side effects)', async () => {
      const exec = vi.fn(async () => ok({ val: 1 }));
      // Genuine opt-out of the cache: deterministic but with sideEffect != 'none'
      // and cacheable: false. isCacheable() rejects this shape so neither the
      // hit nor the store path runs.
      const tool: BernardTool<{ x: number }, { val: number }> = {
        meta: {
          name: 'nope',
          kind: 'read',
          deterministic: true,
          sideEffect: 'local',
          cacheable: false,
        },
        description: 'nope',
        parameters: z.object({ x: z.number() }),
        execute: exec as any,
        serializeForModel: (r) => (r.status === 'ok' ? r.result : 'err'),
      };
      const aisdk = toolToAISDK(tool);
      const augmented = augmentTools({ nope: aisdk }, store);

      await augmented.nope.execute({ x: 1 }, {});
      await augmented.nope.execute({ x: 1 }, {});

      expect(exec).toHaveBeenCalledTimes(2);
    });

    it('cacheEnabled: false bypasses the cache for cacheable tools', async () => {
      const exec = vi.fn(async () => ok({ val: 42 }));
      const aisdk = toolToAISDK(makeCacheableBernardTool(exec));
      const augmented = augmentTools(
        { cacheable_tool: aisdk },
        { profileStore: store, cacheEnabled: false },
      );

      await augmented.cacheable_tool.execute({ x: 1 }, {});
      await augmented.cacheable_tool.execute({ x: 1 }, {});

      expect(exec).toHaveBeenCalledTimes(2);
    });

    it('does NOT cache error envelopes — next call hits execute again', async () => {
      const exec = vi
        .fn()
        .mockResolvedValueOnce(err({ type: 'exec_failed', message: 'boom' }))
        .mockResolvedValueOnce(ok({ val: 99 }));
      const aisdk = toolToAISDK(makeCacheableBernardTool(exec));
      const augmented = augmentTools({ cacheable_tool: aisdk }, store);

      const r1 = await augmented.cacheable_tool.execute({ x: 1 }, {});
      const r2 = await augmented.cacheable_tool.execute({ x: 1 }, {});

      expect(r1).toBe('Error: boom');
      expect(r2).toEqual({ val: 99 });
      expect(exec).toHaveBeenCalledTimes(2);
    });
  });

  describe('evidence pointers (#141)', () => {
    function makeEvidenceBernardTool(opts: {
      name: string;
      result: 'ok' | 'error';
      sensitiveArgs?: string[];
      sensitiveResult?: boolean;
    }): BernardTool<Record<string, unknown>, { val: number }> {
      return {
        meta: {
          name: opts.name,
          kind: 'read',
          ...(opts.sensitiveArgs ? { sensitiveArgs: opts.sensitiveArgs } : {}),
          ...(opts.sensitiveResult ? { sensitiveResult: true } : {}),
        },
        description: opts.name,
        parameters: z.object({}).passthrough(),
        execute: async () =>
          opts.result === 'ok'
            ? ok({ val: 1 })
            : err({ type: 'exec_failed', message: 'boom', snippet: 'boom-snip' }),
        serializeForModel: (r) =>
          r.status === 'ok' ? `model:${r.result.val}` : `Error: ${r.error.message}`,
      };
    }

    /** Standard options enabling evidence registration. */
    const evidenceOn = (provenance: ProvenanceStore) => ({
      profileStore: store,
      provenance,
      evidenceEnabled: true,
    });

    it('envelope path: successful call registers a tool-result source', async () => {
      const provenance = new ProvenanceStore();
      const aisdk = toolToAISDK(makeEvidenceBernardTool({ name: 'demo', result: 'ok' }));
      const augmented = augmentTools({ demo: aisdk }, evidenceOn(provenance));

      await augmented.demo.execute({ x: 42 }, {});

      const items = provenance.list();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('tool-result');
      expect(items[0].label).toContain('demo');
      expect(items[0].label).toContain('42');
      expect(items[0].contentPreview).toContain('model:1');
      expect(items[0].rawRef).toMatch(/^tool:demo:[0-9a-z]+$/);
    });

    it('envelope path: errored call does NOT register evidence', async () => {
      const provenance = new ProvenanceStore();
      const aisdk = toolToAISDK(makeEvidenceBernardTool({ name: 'demo', result: 'error' }));
      const augmented = augmentTools({ demo: aisdk }, evidenceOn(provenance));

      await augmented.demo.execute({ x: 1 }, {});

      expect(provenance.list()).toHaveLength(0);
    });

    it('two identical successful calls dedup to one entry via ProvenanceStore', async () => {
      const provenance = new ProvenanceStore();
      const aisdk = toolToAISDK(makeEvidenceBernardTool({ name: 'demo', result: 'ok' }));
      const augmented = augmentTools({ demo: aisdk }, evidenceOn(provenance));

      await augmented.demo.execute({ x: 1 }, {});
      await augmented.demo.execute({ x: 1 }, {});

      expect(provenance.list()).toHaveLength(1);
    });

    it('two calls whose first 120 args chars match still register as distinct sources (hashed rawRef)', async () => {
      const provenance = new ProvenanceStore();
      const aisdk = toolToAISDK(makeEvidenceBernardTool({ name: 'demo', result: 'ok' }));
      const augmented = augmentTools({ demo: aisdk }, evidenceOn(provenance));

      const sharedPrefix = 'x'.repeat(130);
      await augmented.demo.execute({ path: sharedPrefix + 'a' }, {});
      await augmented.demo.execute({ path: sharedPrefix + 'b' }, {});

      expect(provenance.list()).toHaveLength(2);
    });

    it('sensitiveArgs are redacted in the label/rawRef', async () => {
      const provenance = new ProvenanceStore();
      const aisdk = toolToAISDK(
        makeEvidenceBernardTool({ name: 'demo', result: 'ok', sensitiveArgs: ['apiKey'] }),
      );
      const augmented = augmentTools({ demo: aisdk }, evidenceOn(provenance));

      await augmented.demo.execute({ apiKey: 'sk-very-secret-12345', q: 'hello' }, {});

      const items = provenance.list();
      expect(items).toHaveLength(1);
      expect(items[0].label).not.toContain('sk-very-secret');
      expect(items[0].label).toContain('REDACTED');
    });

    it('sensitiveResult replaces the contentPreview with REDACTED', async () => {
      const provenance = new ProvenanceStore();
      const aisdk = toolToAISDK(
        makeEvidenceBernardTool({ name: 'demo', result: 'ok', sensitiveResult: true }),
      );
      const augmented = augmentTools({ demo: aisdk }, evidenceOn(provenance));

      await augmented.demo.execute({ x: 1 }, {});

      const items = provenance.list();
      expect(items).toHaveLength(1);
      expect(items[0].contentPreview).toBe('[REDACTED]');
      expect(items[0].contentPreview).not.toContain('model:1');
    });

    it('legacy path: successful call registers a tool-result source (synchronous)', async () => {
      const provenance = new ProvenanceStore();
      vi.mocked(detectToolError).mockReturnValue({ isError: false });
      const tools = { legacy_tool: { execute: vi.fn(async () => 'plain string output') } };
      const augmented = augmentTools(tools, evidenceOn(provenance));

      await augmented.legacy_tool.execute({ url: 'https://example.com' }, {});
      // No `await setImmediate` — legacy-path registration is synchronous so
      // it can't race with the next turn's `provenance.clear()`.

      const items = provenance.list();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('tool-result');
      expect(items[0].label).toContain('legacy_tool');
      expect(items[0].contentPreview).toContain('plain string output');
    });

    it('legacy path: result with is_error: true does NOT register evidence', async () => {
      const provenance = new ProvenanceStore();
      const tools = {
        legacy_tool: { execute: vi.fn(async () => ({ output: 'oops', is_error: true })) },
      };
      const augmented = augmentTools(tools, evidenceOn(provenance));

      await augmented.legacy_tool.execute({ x: 1 }, {});

      expect(provenance.list()).toHaveLength(0);
    });

    it('legacy path: result with an `error` field does NOT register evidence', async () => {
      const provenance = new ProvenanceStore();
      const tools = { legacy_tool: { execute: vi.fn(async () => ({ error: 'boom' })) } };
      const augmented = augmentTools(tools, evidenceOn(provenance));

      await augmented.legacy_tool.execute({ x: 1 }, {});

      expect(provenance.list()).toHaveLength(0);
    });

    it('legacy path: a failing MCP result does NOT register evidence (#363)', async () => {
      // The gate used to be `is_error === true || 'error' in result`, so an
      // MCP `CallToolResult` failure registered as a citable source — the
      // agent could cite "WebSocket is not open" as evidence for a claim.
      const provenance = new ProvenanceStore();
      const tools = {
        'open-browser-tab': {
          execute: vi.fn(async () => ({
            content: [{ type: 'text', text: 'WebSocket is not open' }],
            isError: true,
          })),
        },
      };
      const augmented = augmentTools(tools, evidenceOn(provenance));

      await augmented['open-browser-tab'].execute({ url: 'https://example.com' }, {});

      expect(provenance.list()).toHaveLength(0);
    });

    it('legacy path: a healthy MCP result still registers evidence (#363)', async () => {
      const provenance = new ProvenanceStore();
      const tools = {
        'get-list-of-open-tabs': {
          execute: vi.fn(async () => ({
            content: [{ type: 'text', text: 'tab id=22' }],
            isError: false,
          })),
        },
      };
      const augmented = augmentTools(tools, evidenceOn(provenance));

      await augmented['get-list-of-open-tabs'].execute({}, {});

      expect(provenance.list()).toHaveLength(1);
    });

    it('legacy path: `{error: null}` still registers evidence (#363)', async () => {
      // `structured-output`'s `nullableOptional` leaves the key present with
      // `undefined`; the old `'error' in result` test read that as a failure.
      const provenance = new ProvenanceStore();
      const tools = {
        legacy_tool: { execute: vi.fn(async () => ({ status: 'ok', error: null })) },
      };
      const augmented = augmentTools(tools, evidenceOn(provenance));

      await augmented.legacy_tool.execute({ x: 1 }, {});

      expect(provenance.list()).toHaveLength(1);
    });

    it('legacy path: registration survives detectToolError throws (sync — outside the setImmediate catch)', async () => {
      const provenance = new ProvenanceStore();
      vi.mocked(detectToolError).mockImplementation(() => {
        throw new Error('detector blew up');
      });
      const tools = { legacy_tool: { execute: vi.fn(async () => 'plain output') } };
      const augmented = augmentTools(tools, evidenceOn(provenance));

      await augmented.legacy_tool.execute({ x: 1 }, {});

      expect(provenance.list()).toHaveLength(1);
    });

    it('cache hit re-registers evidence (survives cross-turn provenance.clear)', async () => {
      const provenance = new ProvenanceStore();
      // Cacheable BernardTool (deterministic + sideEffect:'none').
      const tool: BernardTool<{ x: number }, { val: number }> = {
        meta: {
          name: 'cacheable',
          kind: 'read',
          deterministic: true,
          sideEffect: 'none',
          cacheable: true,
        },
        description: 'cacheable',
        parameters: z.object({ x: z.number() }),
        execute: vi.fn(async () => ok({ val: 99 })),
        serializeForModel: (r) => (r.status === 'ok' ? `val:${r.result.val}` : 'err'),
      };
      const aisdk = toolToAISDK(tool);
      const augmented = augmentTools({ cacheable: aisdk }, evidenceOn(provenance));

      await augmented.cacheable.execute({ x: 1 }, {});
      expect(provenance.list()).toHaveLength(1);

      provenance.clear();
      await augmented.cacheable.execute({ x: 1 }, {}); // cache hit
      expect(provenance.list()).toHaveLength(1);
    });

    it('evidenceEnabled defaults to false when omitted, even with a store wired', async () => {
      const provenance = new ProvenanceStore();
      const aisdk = toolToAISDK(makeEvidenceBernardTool({ name: 'demo', result: 'ok' }));
      const augmented = augmentTools(
        { demo: aisdk },
        { profileStore: store, provenance }, // no evidenceEnabled
      );

      await augmented.demo.execute({ x: 1 }, {});

      expect(provenance.list()).toHaveLength(0);
    });

    it('evidenceEnabled: false short-circuits registration even with a store wired', async () => {
      const provenance = new ProvenanceStore();
      const aisdk = toolToAISDK(makeEvidenceBernardTool({ name: 'demo', result: 'ok' }));
      const augmented = augmentTools(
        { demo: aisdk },
        { profileStore: store, provenance, evidenceEnabled: false },
      );

      await augmented.demo.execute({ x: 1 }, {});

      expect(provenance.list()).toHaveLength(0);
    });

    it('no provenance store wired → no registration, no throw', async () => {
      const aisdk = toolToAISDK(makeEvidenceBernardTool({ name: 'demo', result: 'ok' }));
      const augmented = augmentTools({ demo: aisdk }, store);

      await expect(augmented.demo.execute({ x: 1 }, {})).resolves.toBeDefined();
    });
  });
});
