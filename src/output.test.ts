import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CoreMessage } from 'ai';
import {
  printAssistantText,
  printToolCall,
  printToolResult,
  printError,
  printInfo,
  printWelcome,
  printHelp,
  printConversationReplay,
  printSubAgentStart,
  printSubAgentEnd,
  startSpinner,
  stopSpinner,
  buildSpinnerMessage,
  type SpinnerStats,
} from './output.js';

describe('output', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stopSpinner(); // ensure clean state
    stdoutWriteSpy.mockClear();
  });

  describe('printAssistantText', () => {
    it('prints non-empty text', () => {
      printAssistantText('Hello there');
      expect(logSpy).toHaveBeenCalled();
      expect(logSpy.mock.calls[0][0]).toContain('Hello there');
    });

    it('skips whitespace-only text', () => {
      printAssistantText('   \n  ');
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe('printToolCall', () => {
    it('shows command string for shell tool', () => {
      printToolCall('shell', { command: 'ls -la' });
      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('shell');
      expect(output).toContain('ls -la');
    });

    it('shows JSON args for other tools', () => {
      printToolCall('memory', { action: 'list' });
      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('memory');
      expect(output).toContain('"action"');
    });
  });

  describe('printToolResult', () => {
    it('handles string result', () => {
      printToolResult('shell', 'file contents here');
      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('file contents here');
    });

    it('handles object with .output property', () => {
      printToolResult('shell', { output: 'command output' });
      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('command output');
    });

    it('JSON-stringifies other objects', () => {
      printToolResult('memory', { action: 'list', keys: ['a', 'b'] });
      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('"action"');
    });

    it('truncates output longer than 2000 chars', () => {
      const longString = 'x'.repeat(3000);
      printToolResult('shell', longString);
      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('truncated');
    });
  });

  describe('printError', () => {
    it('writes to console.error', () => {
      printError('something broke');
      expect(errorSpy).toHaveBeenCalled();
      expect(errorSpy.mock.calls[0][0]).toContain('something broke');
    });
  });

  describe('printInfo', () => {
    it('writes to console.log', () => {
      printInfo('info message');
      expect(logSpy).toHaveBeenCalled();
      expect(logSpy.mock.calls[0][0]).toContain('info message');
    });
  });

  describe('printWelcome', () => {
    it('writes to console.log', () => {
      printWelcome('anthropic', 'claude-sonnet');
      expect(logSpy).toHaveBeenCalled();
    });

    it('includes version when provided', () => {
      printWelcome('anthropic', 'claude-sonnet', '1.2.3');
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('v1.2.3');
    });

    it('omits version when not provided', () => {
      printWelcome('anthropic', 'claude-sonnet');
      const output = logSpy.mock.calls[0][0];
      expect(output).not.toContain('v');
    });
  });

  describe('printHelp', () => {
    it('writes to console.log', () => {
      printHelp();
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe('startSpinner', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      stopSpinner();
      vi.useRealTimers();
    });

    it('writes spinner frames after interval', () => {
      startSpinner();
      vi.advanceTimersByTime(80);
      expect(stdoutWriteSpy).toHaveBeenCalled();
      const writes = stdoutWriteSpy.mock.calls.map(c => String(c[0]));
      const hasFrame = writes.some(w => w.includes('⠋') || w.includes('⠙'));
      expect(hasFrame).toBe(true);
    });

    it('is idempotent (double start is a no-op)', () => {
      startSpinner();
      startSpinner();
      vi.advanceTimersByTime(160);
      stopSpinner();
      // Should not throw and should clean up fine
    });
  });

  describe('stopSpinner', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('clears line and shows cursor', () => {
      startSpinner();
      vi.advanceTimersByTime(80);
      stdoutWriteSpy.mockClear();
      stopSpinner();
      const writes = stdoutWriteSpy.mock.calls.map(c => String(c[0]));
      expect(writes.some(w => w.includes('\x1B[2K'))).toBe(true); // clear line
      expect(writes.some(w => w.includes('\x1B[?25h'))).toBe(true); // show cursor
    });

    it('is idempotent (double stop is a no-op)', () => {
      stopSpinner();
      stopSpinner();
      // Should not throw
    });
  });

  describe('printConversationReplay', () => {
    it('prints user and assistant string messages', () => {
      const messages: CoreMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];
      printConversationReplay(messages);
      const output = logSpy.mock.calls.map(c => String(c[0]));
      expect(output.some(l => l.includes('you>') && l.includes('Hello'))).toBe(true);
      expect(output.some(l => l.includes('assistant>') && l.includes('Hi there'))).toBe(true);
    });

    it('skips tool messages', () => {
      const messages: CoreMessage[] = [
        { role: 'user', content: 'run ls' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '1', toolName: 'shell', args: { command: 'ls' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: '1', result: 'file.txt' }] },
        { role: 'assistant', content: 'Done' },
      ];
      printConversationReplay(messages);
      const output = logSpy.mock.calls.map(c => String(c[0]));
      expect(output.some(l => l.includes('tool-result'))).toBe(false);
      expect(output.some(l => l.includes('file.txt'))).toBe(false);
    });

    it('skips assistant messages with only tool-call parts', () => {
      const messages: CoreMessage[] = [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '1', toolName: 'shell', args: {} }] },
      ];
      printConversationReplay(messages);
      // header + separator + blank line = 3 calls, no message lines
      const output = logSpy.mock.calls.map(c => String(c[0]));
      expect(output.some(l => l.includes('assistant>'))).toBe(false);
    });

    it('extracts text parts from array content', () => {
      const messages: CoreMessage[] = [
        { role: 'assistant', content: [
          { type: 'text', text: 'Here is the result' },
          { type: 'tool-call', toolCallId: '1', toolName: 'shell', args: {} },
        ] },
      ];
      printConversationReplay(messages);
      const output = logSpy.mock.calls.map(c => String(c[0]));
      expect(output.some(l => l.includes('Here is the result'))).toBe(true);
    });

    it('truncates long messages', () => {
      const longText = 'a'.repeat(300);
      const messages: CoreMessage[] = [
        { role: 'user', content: longText },
      ];
      printConversationReplay(messages);
      const output = logSpy.mock.calls.map(c => String(c[0]));
      const userLine = output.find(l => l.includes('you>'));
      expect(userLine).toBeDefined();
      expect(userLine!.includes('…')).toBe(true);
      // Should not contain the full 300-char string
      expect(userLine!.includes(longText)).toBe(false);
    });

    it('prints header and separator', () => {
      printConversationReplay([{ role: 'user', content: 'hi' }]);
      const output = logSpy.mock.calls.map(c => String(c[0]));
      expect(output[0]).toContain('Previous conversation');
      expect(output.some(l => l.includes('———'))).toBe(true);
    });

    it('handles empty messages array', () => {
      printConversationReplay([]);
      const output = logSpy.mock.calls.map(c => String(c[0]));
      expect(output[0]).toContain('Previous conversation');
      expect(output.some(l => l.includes('———'))).toBe(true);
    });
  });

  describe('prefix support', () => {
    it('printToolCall with prefix includes [sub:N] label', () => {
      printToolCall('shell', { command: 'ls' }, 'sub:1');
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('[sub:1]');
      expect(output).toContain('shell');
    });

    it('printToolCall without prefix works unchanged', () => {
      printToolCall('shell', { command: 'ls' });
      const output = logSpy.mock.calls[0][0];
      expect(output).not.toContain('[sub:');
      expect(output).toContain('shell');
    });

    it('printAssistantText with prefix includes label', () => {
      printAssistantText('Hello', 'sub:2');
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('[sub:2]');
      expect(output).toContain('Hello');
    });

    it('printToolResult with prefix includes label on each line', () => {
      printToolResult('shell', 'line1\nline2', 'sub:1');
      const output = logSpy.mock.calls[0][0];
      // Both lines should have the prefix
      const lines = output.split('\n');
      expect(lines[0]).toContain('[sub:1]');
      expect(lines[1]).toContain('[sub:1]');
    });
  });

  describe('printSubAgentStart', () => {
    it('prints id and task', () => {
      printSubAgentStart(1, 'List all files');
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('sub:1');
      expect(output).toContain('List all files');
      expect(output).toContain('┌─');
    });

    it('truncates long tasks at 80 chars', () => {
      const longTask = 'a'.repeat(100);
      printSubAgentStart(1, longTask);
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('…');
      expect(output).not.toContain(longTask);
    });
  });

  describe('printSubAgentEnd', () => {
    it('prints id with done', () => {
      printSubAgentEnd(1);
      const output = logSpy.mock.calls[0][0];
      expect(output).toContain('sub:1');
      expect(output).toContain('done');
      expect(output).toContain('└─');
    });
  });

  describe('buildSpinnerMessage', () => {
    it('shows only elapsed time when no tokens yet', () => {
      const stats: SpinnerStats = {
        startTime: Date.now() - 5000,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        latestPromptTokens: 0,
        model: 'gpt-4o-mini',
      };
      const msg = buildSpinnerMessage(stats);
      expect(msg).toBe('Thinking (5s)');
    });

    it('shows token counts with arrows when data available', () => {
      const stats: SpinnerStats = {
        startTime: Date.now() - 12000,
        totalPromptTokens: 1500,
        totalCompletionTokens: 200,
        latestPromptTokens: 1500,
        model: 'gpt-4o-mini', // 128k context
      };
      const msg = buildSpinnerMessage(stats);
      expect(msg).toContain('12s');
      expect(msg).toContain('1.5k\u2191');
      expect(msg).toContain('200\u2193');
      expect(msg).toContain('% until compression');
    });

    it('formats large token counts with k suffix', () => {
      const stats: SpinnerStats = {
        startTime: Date.now() - 1000,
        totalPromptTokens: 20000,
        totalCompletionTokens: 15000,
        latestPromptTokens: 20000,
        model: 'gpt-4o-mini',
      };
      const msg = buildSpinnerMessage(stats);
      expect(msg).toContain('20k\u2191');
      expect(msg).toContain('15k\u2193');
    });

    it('shows 0% when at or beyond compression threshold', () => {
      // gpt-4o-mini = 128k, threshold = 75% = 96k
      const stats: SpinnerStats = {
        startTime: Date.now() - 1000,
        totalPromptTokens: 100000,
        totalCompletionTokens: 5000,
        latestPromptTokens: 100000,
        model: 'gpt-4o-mini',
      };
      const msg = buildSpinnerMessage(stats);
      expect(msg).toContain('0% until compression');
    });

    it('formats minutes for long durations', () => {
      const stats: SpinnerStats = {
        startTime: Date.now() - 125000, // 2m5s
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        latestPromptTokens: 0,
        model: 'gpt-4o-mini',
      };
      const msg = buildSpinnerMessage(stats);
      expect(msg).toBe('Thinking (2m5s)');
    });

    it('shows small token counts without k suffix', () => {
      const stats: SpinnerStats = {
        startTime: Date.now() - 3000,
        totalPromptTokens: 850,
        totalCompletionTokens: 42,
        latestPromptTokens: 850,
        model: 'gpt-4o-mini',
      };
      const msg = buildSpinnerMessage(stats);
      expect(msg).toContain('850\u2191');
      expect(msg).toContain('42\u2193');
    });
  });

  describe('dynamic spinner message', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      stopSpinner();
      vi.useRealTimers();
    });

    it('calls message function each frame', () => {
      let callCount = 0;
      const getter = () => { callCount++; return `msg ${callCount}`; };
      startSpinner(getter);
      vi.advanceTimersByTime(80 * 3);
      stopSpinner();
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('renders updated message text', () => {
      let counter = 0;
      startSpinner(() => `Step ${++counter}`);
      vi.advanceTimersByTime(80);
      const writes = stdoutWriteSpy.mock.calls.map(c => String(c[0]));
      expect(writes.some(w => w.includes('Step 1'))).toBe(true);
      vi.advanceTimersByTime(80);
      const writes2 = stdoutWriteSpy.mock.calls.map(c => String(c[0]));
      expect(writes2.some(w => w.includes('Step 2'))).toBe(true);
    });
  });

  describe('spinner auto-stop', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      stopSpinner();
      vi.useRealTimers();
    });

    it('printAssistantText stops the spinner', () => {
      startSpinner();
      vi.advanceTimersByTime(80);
      printAssistantText('Hello');
      // Spinner should be stopped — further advances should not write more frames
      stdoutWriteSpy.mockClear();
      vi.advanceTimersByTime(160);
      const writes = stdoutWriteSpy.mock.calls.map(c => String(c[0]));
      const hasFrame = writes.some(w => w.includes('⠋') || w.includes('⠙'));
      expect(hasFrame).toBe(false);
    });

    it('printToolCall stops the spinner', () => {
      startSpinner();
      vi.advanceTimersByTime(80);
      printToolCall('shell', { command: 'ls' });
      stdoutWriteSpy.mockClear();
      vi.advanceTimersByTime(160);
      const writes = stdoutWriteSpy.mock.calls.map(c => String(c[0]));
      const hasFrame = writes.some(w => w.includes('⠋') || w.includes('⠙'));
      expect(hasFrame).toBe(false);
    });

    it('printError stops the spinner', () => {
      startSpinner();
      vi.advanceTimersByTime(80);
      printError('something broke');
      stdoutWriteSpy.mockClear();
      vi.advanceTimersByTime(160);
      const writes = stdoutWriteSpy.mock.calls.map(c => String(c[0]));
      const hasFrame = writes.some(w => w.includes('⠋') || w.includes('⠙'));
      expect(hasFrame).toBe(false);
    });
  });
});
