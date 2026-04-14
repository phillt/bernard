import { describe, it, expect, vi, beforeEach } from 'vitest';
import { augmentTools } from './augment.js';

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
    patchLastBadWithFix: vi.fn(),
    list: vi.fn(() => []),
  };
}

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
    it('when tool returns an error result, recordBadExample is called with correct profileKey and args', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'permission denied' });

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
        'permission denied',
      );
    });

    it('shell git commands get shell.git profile key', async () => {
      vi.mocked(detectToolError).mockReturnValue({
        isError: true,
        snippet: 'fatal: not a git repo',
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
        'fatal: not a git repo',
      );
    });

    it('shell gh commands get shell.gh profile key', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'not authenticated' });

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
        'not authenticated',
      );
    });

    it('shell general commands get shell.general profile key', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'error occurred' });

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
        'error occurred',
      );
    });

    it('MCP tools (name contains __) get mcp. prefix as profile key', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'mcp error' });

      const tools = {
        myServer__myTool: { execute: vi.fn(async () => ({ error: 'mcp error' })) },
      };

      const augmented = augmentTools(tools, store);
      await augmented['myServer__myTool'].execute({ input: 'test' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledWith(
        'mcp.myServer__myTool',
        expect.any(String),
        'mcp error',
      );
    });

    it('non-shell non-MCP tools use their name as-is for profile key', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'web error' });

      const tools = { web_read: { execute: vi.fn(async () => ({ error: 'web error' })) } };

      const augmented = augmentTools(tools, store);
      await augmented.web_read.execute({ url: 'https://example.com' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledWith(
        'web_read',
        expect.any(String),
        'web error',
      );
    });

    it('printInfo is called with error message for user visibility', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'some error' });

      const tools = {
        shell: { execute: vi.fn(async () => ({ output: 'error', is_error: true })) },
      };

      const augmented = augmentTools(tools, store);
      await augmented.shell.execute({ command: 'bad-cmd' }, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(printInfo).toHaveBeenCalledWith(expect.stringContaining('recorded error'));
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
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'err' });

      const tools = { myTool: { execute: vi.fn(async () => 'result') } };

      vi.mocked(printInfo).mockClear();
      augmentTools(tools, store);

      // printInfo should NOT have been called during augmentTools setup
      expect(printInfo).not.toHaveBeenCalled();
    });

    it('store.recordBadExample is not called synchronously — only after setImmediate', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'err' });

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
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'err' });

      const tools = { shell: { execute: vi.fn(async () => 'result') } };
      // Pass args where command is not a string
      const augmented = augmentTools(tools, store);
      await augmented.shell.execute({ command: 42 }, {});
      await new Promise((resolve) => setImmediate(resolve));

      // With non-string command, resolveProfileKey returns 'shell' (the tool name)
      expect(store.recordBadExample).toHaveBeenCalledWith('shell', expect.any(String), 'err');
    });

    it('shell tool with no args object falls back to tool name', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'err' });

      const tools = { shell: { execute: vi.fn(async () => 'result') } };
      const augmented = augmentTools(tools, store);
      await augmented.shell.execute(null, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.recordBadExample).toHaveBeenCalledWith('shell', expect.any(String), 'err');
    });

    it('tool name with __ uses mcp. prefix regardless of shell classification', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'mcp err' });

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
        'mcp err',
      );
    });
  });

  describe('safeSerialize', () => {
    it('args are serialized and truncated to 300 chars when very long', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'err' });

      const longValue = 'x'.repeat(400);
      const tools = { myTool: { execute: vi.fn(async () => 'result') } };
      const augmented = augmentTools(tools, store);
      await augmented.myTool.execute({ key: longValue }, {});
      await new Promise((resolve) => setImmediate(resolve));

      const calledArgs = store.recordBadExample.mock.calls[0][1] as string;
      expect(calledArgs.length).toBeLessThanOrEqual(300);
    });

    it('non-serializable args fall back to String()', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'err' });

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

  describe('multiple tools', () => {
    it('augments all tools in the record independently', async () => {
      vi.mocked(detectToolError).mockReturnValue({ isError: true, snippet: 'err' });

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
});
