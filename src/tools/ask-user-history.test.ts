import { describe, it, expect } from 'vitest';
import { formatAskUserAnswers, injectAskUserHistoryMessages } from './ask-user-history.js';
import type { CoreMessage } from 'ai';
import type { AskUserBatchResult } from './types.js';

// ---------------------------------------------------------------------------
// formatAskUserAnswers
// ---------------------------------------------------------------------------

describe('formatAskUserAnswers', () => {
  it('single answered question — returns bare answer string', () => {
    const result = formatAskUserAnswers({ answers: ['Paris'] });
    expect(result).toBe('Paris');
  });

  it('multi-question answered — joins with newlines using Q→A format when questions provided', () => {
    const result = formatAskUserAnswers({ answers: ['blue', 'large'] }, [
      'Favourite colour?',
      'Size?',
    ]);
    expect(result).toBe('Favourite colour?: blue\nSize?: large');
  });

  it('multi-question answered — no question prompts → bare answer lines', () => {
    const result = formatAskUserAnswers({ answers: ['a', 'b'] });
    expect(result).toBe('a\nb');
  });

  it('single question with label — label is applied (consistent with multi-question path)', () => {
    const result = formatAskUserAnswers({ answers: ['John'] }, ['What is your name?']);
    expect(result).toBe('What is your name?: John');
  });

  it('multi_select slot — array joined with comma', () => {
    const result = formatAskUserAnswers({ answers: [['react', 'vue'], 'large'] });
    expect(result).toBe('react, vue\nlarge');
  });

  it('multi_select single question — returns comma-joined string', () => {
    const result = formatAskUserAnswers({ answers: [['a', 'b']] });
    expect(result).toBe('a, b');
  });

  it('cancelled first question — returns null (no answers)', () => {
    const result = formatAskUserAnswers({ cancelled: true, answered: [] });
    expect(result).toBeNull();
  });

  it('cancelled mid-batch — returns partial answers with [cancelled] marker', () => {
    const result = formatAskUserAnswers({ cancelled: true, answered: ['red'] });
    expect(result).toBe('red\n[cancelled]');
  });

  it('cancelled mid-batch with question labels', () => {
    const result = formatAskUserAnswers({ cancelled: true, answered: ['red'] }, [
      'Colour?',
      'Size?',
    ]);
    expect(result).toBe('Colour?: red\n[cancelled]');
  });

  it('headless — returns null', () => {
    // AskUserBatchResult does not include unavailable, so cast
    const result = formatAskUserAnswers({ unavailable: true } as unknown as AskUserBatchResult);
    expect(result).toBeNull();
  });

  it('empty answers array — returns null', () => {
    const result = formatAskUserAnswers({ answers: [] });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// injectAskUserHistoryMessages
// ---------------------------------------------------------------------------

/** Builds a minimal CoreToolMessage with an ask_user result. */
function makeAskUserToolMsg(payload: object, toolCallId = 'call-1'): CoreMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolName: 'ask_user',
        toolCallId,
        result: JSON.stringify(payload),
      } as { type: 'tool-result'; toolName: string; toolCallId: string; result: string },
    ],
  } as CoreMessage;
}

describe('injectAskUserHistoryMessages', () => {
  it('injects a user message for a single answered question', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Asking...' },
      makeAskUserToolMsg({ answers: ['Paris'] }, 'call-a'),
    ];
    const ids = new Set<string>();
    injectAskUserHistoryMessages(history, 0, ids);
    expect(history).toHaveLength(4);
    const injected = history[3];
    expect(injected.role).toBe('user');
    expect(typeof injected.content).toBe('string');
    expect(injected.content).toBe('Paris');
  });

  it('injects multi-question answers as a single user message', () => {
    const history: CoreMessage[] = [
      { role: 'user', content: 'Hi' },
      makeAskUserToolMsg({ answers: ['red', 'large'] }, 'call-b'),
    ];
    const ids = new Set<string>();
    injectAskUserHistoryMessages(history, 0, ids);
    expect(history).toHaveLength(3);
    expect(history[2].content).toBe('red\nlarge');
  });

  it('does NOT inject for a headless unavailable result', () => {
    const history: CoreMessage[] = [makeAskUserToolMsg({ unavailable: true }, 'call-c')];
    const ids = new Set<string>();
    injectAskUserHistoryMessages(history, 0, ids);
    expect(history).toHaveLength(1);
    expect(ids.has('call-c')).toBe(true); // still marked as processed
  });

  it('does NOT inject for a first-question cancel', () => {
    const history: CoreMessage[] = [
      makeAskUserToolMsg({ cancelled: true, answered: [] }, 'call-d'),
    ];
    const ids = new Set<string>();
    injectAskUserHistoryMessages(history, 0, ids);
    expect(history).toHaveLength(1);
  });

  it('injects partial answers on mid-batch cancel', () => {
    const history: CoreMessage[] = [
      makeAskUserToolMsg({ cancelled: true, answered: ['blue'] }, 'call-e'),
    ];
    const ids = new Set<string>();
    injectAskUserHistoryMessages(history, 0, ids);
    expect(history).toHaveLength(2);
    expect(history[1].content).toContain('blue');
    expect(history[1].content).toContain('[cancelled]');
  });

  it('deduplicates: does not inject twice for the same toolCallId', () => {
    const history: CoreMessage[] = [makeAskUserToolMsg({ answers: ['yes'] }, 'call-f')];
    const ids = new Set<string>();
    injectAskUserHistoryMessages(history, 0, ids);
    expect(history).toHaveLength(2);

    // Call again (simulating auto-continue scan) — should not double-inject.
    injectAskUserHistoryMessages(history, 0, ids);
    expect(history).toHaveLength(2);
  });

  it('skips tool messages before `start` — only scans from start', () => {
    const history: CoreMessage[] = [
      // Index 0 — before `start`; should not be scanned
      makeAskUserToolMsg({ answers: ['early'] }, 'call-early'),
      // Index 1 — within scan range
      makeAskUserToolMsg({ answers: ['later'] }, 'call-later'),
    ];
    const ids = new Set<string>();
    injectAskUserHistoryMessages(history, 1, ids);
    // Only one injection for 'later'
    expect(history).toHaveLength(3);
    expect(history[2].content).toBe('later');
    expect(ids.has('call-early')).toBe(false);
    expect(ids.has('call-later')).toBe(true);
  });

  it('is robust to a shrunk history array (compressed/truncated history)', () => {
    // Simulate what happens when compressHistory replaces this.history with a
    // shorter array: `start` points past the end. The function must clamp and
    // not throw.
    const history: CoreMessage[] = [
      // Compression kept only this one message
      makeAskUserToolMsg({ answers: ['after-compression'] }, 'call-g'),
    ];
    // `start` is stale — points past the end of the shrunken array
    const staleStart = 50;
    const ids = new Set<string>();
    expect(() => injectAskUserHistoryMessages(history, staleStart, ids)).not.toThrow();
    // With safeStart clamped to 0 (since length is 1), it will scan and inject
    expect(history).toHaveLength(2);
    expect(history[1].content).toBe('after-compression');
  });

  it('ignores non-ask_user tool results', () => {
    const history: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'shell',
            toolCallId: 'shell-1',
            result: 'output',
          } as { type: 'tool-result'; toolName: string; toolCallId: string; result: string },
        ],
      } as CoreMessage,
    ];
    const ids = new Set<string>();
    injectAskUserHistoryMessages(history, 0, ids);
    expect(history).toHaveLength(1);
  });

  it('handles malformed JSON in ask_user result gracefully', () => {
    const history: CoreMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'ask_user',
            toolCallId: 'call-bad',
            result: 'not-json{',
          } as { type: 'tool-result'; toolName: string; toolCallId: string; result: string },
        ],
      } as CoreMessage,
    ];
    const ids = new Set<string>();
    expect(() => injectAskUserHistoryMessages(history, 0, ids)).not.toThrow();
    expect(history).toHaveLength(1);
  });
});
