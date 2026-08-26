import { describe, expect, it } from 'vitest';
import { detectResultFailure, isMCPErrorResult } from './tool-result-shape.js';

describe('detectResultFailure', () => {
  describe('MCP CallToolResult', () => {
    // The exact payload observed from the browser-control server for ~4
    // minutes of a real session, every call of which logged `status: 'ok'`.
    const deadSocket = {
      content: [{ type: 'text', text: 'WebSocket is not open' }],
      isError: true,
    };

    it('detects the envelope flag', () => {
      expect(detectResultFailure(deadSocket)).toBe('WebSocket is not open');
    });

    it('detects a flagged content entry when the envelope says isError: false', () => {
      // The same server emitted this shape too — the envelope check alone
      // misses it, which is why both are tested.
      const result = {
        content: [
          {
            type: 'text',
            text: 'Element ref 13 is a combobox, not a text input.',
            isError: true,
          },
        ],
        isError: false,
      };
      expect(detectResultFailure(result)).toBe('Element ref 13 is a combobox, not a text input.');
    });

    it('keeps only the flagged entries in the snippet', () => {
      const result = {
        content: [
          { type: 'text', text: 'ordinary output' },
          { type: 'text', text: 'the actual failure', isError: true },
        ],
      };
      expect(detectResultFailure(result)).toBe('the actual failure');
    });

    it('falls back to the whole content when only the envelope is flagged', () => {
      const result = {
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        isError: true,
      };
      expect(detectResultFailure(result)).toBe('a\nb');
    });

    it('never returns an empty snippet for a flagged result', () => {
      // An empty snippet reads as success to `recordOutcome`.
      expect(detectResultFailure({ content: [], isError: true })).toBe('MCP tool reported isError');
    });

    it('reads a truncation wrapper that re-stamped isError', () => {
      expect(detectResultFailure({ _truncated: true, isError: true, preview: 'boom' })).toBe(
        'boom',
      );
    });

    it('treats a successful MCP result as success', () => {
      const ok = { content: [{ type: 'text', text: 'tab id=22' }], isError: false };
      expect(detectResultFailure(ok)).toBeUndefined();
    });

    it('treats an MCP result with no isError at all as success', () => {
      expect(detectResultFailure({ content: [{ type: 'text', text: 'fine' }] })).toBeUndefined();
    });

    it('truncates a long snippet to 200 chars', () => {
      const result = { content: [{ type: 'text', text: 'x'.repeat(300) }], isError: true };
      expect(detectResultFailure(result)).toHaveLength(200);
    });
  });

  describe('shell-shaped results', () => {
    it('detects is_error', () => {
      expect(detectResultFailure({ output: 'command not found', is_error: true })).toBe(
        'command not found',
      );
    });

    it('treats is_error: false as success', () => {
      expect(detectResultFailure({ output: 'ok', is_error: false })).toBeUndefined();
    });
  });

  describe('{error} results', () => {
    it('detects a non-empty error string', () => {
      expect(detectResultFailure({ error: 'File not found' })).toBe('File not found');
    });

    it('ignores a non-string error', () => {
      expect(detectResultFailure({ error: 42 })).toBeUndefined();
    });

    it('ignores a null error — what nullableOptional leaves behind', () => {
      // The old inline check in `augment` used `'error' in result`, which
      // called this a failure.
      expect(detectResultFailure({ status: 'ok', error: null })).toBeUndefined();
      expect(detectResultFailure({ status: 'ok', error: undefined })).toBeUndefined();
    });

    it('ignores an empty/whitespace error', () => {
      expect(detectResultFailure({ error: '' })).toBeUndefined();
      expect(detectResultFailure({ error: '   ' })).toBeUndefined();
    });
  });

  describe('strings and non-objects', () => {
    it('detects an "Error"-prefixed string', () => {
      expect(detectResultFailure('Error: fetch failed')).toBe('Error: fetch failed');
    });

    it('treats other strings as success', () => {
      expect(detectResultFailure('Provider: brave\n\n1. Result')).toBeUndefined();
    });

    it('treats null/undefined as success', () => {
      expect(detectResultFailure(null)).toBeUndefined();
      expect(detectResultFailure(undefined)).toBeUndefined();
    });

    it('treats class instances as success rather than reading their fields', () => {
      class Weird {
        isError = true;
      }
      expect(detectResultFailure(new Weird())).toBeUndefined();
    });
  });
});

describe('isMCPErrorResult', () => {
  it('is true for an envelope flag with no content array', () => {
    expect(isMCPErrorResult({ isError: true })).toBe(true);
  });

  it('is true for a flagged content entry', () => {
    expect(isMCPErrorResult({ content: [{ text: 'x', isError: true }] })).toBe(true);
  });

  it('is false for a healthy result', () => {
    expect(isMCPErrorResult({ content: [{ text: 'x' }], isError: false })).toBe(false);
  });

  it('is false for non-objects', () => {
    expect(isMCPErrorResult('Error: nope')).toBe(false);
    expect(isMCPErrorResult(null)).toBe(false);
  });
});
