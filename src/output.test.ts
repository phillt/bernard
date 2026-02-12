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
  startSpinner,
  stopSpinner,
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
