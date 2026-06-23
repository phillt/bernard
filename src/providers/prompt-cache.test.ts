import { describe, it, expect } from 'vitest';
import type { CoreMessage } from 'ai';
import { applyAnthropicPromptCache, isAnthropicPromptCacheActive } from './prompt-cache.js';
import type { BernardConfig } from '../config.js';

function cfg(over: Partial<BernardConfig> = {}): BernardConfig {
  return { promptCache: true, ...over } as BernardConfig;
}

const CTX: CoreMessage = {
  role: 'user',
  content: '<system_provided_context>\n…\n</system_provided_context>',
};

function cc(m: CoreMessage): unknown {
  return (m as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions
    ?.anthropic?.cacheControl;
}

describe('isAnthropicPromptCacheActive', () => {
  it('is true only for built-in anthropic with the flag on', () => {
    expect(isAnthropicPromptCacheActive(cfg(), 'anthropic')).toBe(true);
    expect(isAnthropicPromptCacheActive(cfg(), 'openai')).toBe(false);
    expect(isAnthropicPromptCacheActive(cfg(), 'xai')).toBe(false);
    expect(isAnthropicPromptCacheActive(cfg({ promptCache: false }), 'anthropic')).toBe(false);
  });
});

describe('applyAnthropicPromptCache', () => {
  it('moves the system string into a leading cached system message', () => {
    const out = applyAnthropicPromptCache({
      system: 'STABLE SYSTEM',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // The string system is consumed (must not be passed alongside a system message).
    expect(out.system).toBeUndefined();
    const first = out.messages[0];
    expect(first.role).toBe('system');
    expect(first.content).toBe('STABLE SYSTEM');
    expect(cc(first)).toEqual({ type: 'ephemeral' });
  });

  it('marks the last stable message before the volatile context block', () => {
    const messages: CoreMessage[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'answer 1' },
      CTX,
      { role: 'user', content: 'turn 2' },
    ];
    const out = applyAnthropicPromptCache({ system: 'S', messages });
    // out.messages[0] is the system message; the rest follow in order.
    const assistant = out.messages.find((m) => m.role === 'assistant')!;
    expect(cc(assistant)).toEqual({ type: 'ephemeral' });
    // The volatile context block and the current user turn are NOT marked.
    const ctxMsg = out.messages.find(
      (m) => typeof m.content === 'string' && m.content.startsWith('<system_provided_context>'),
    )!;
    expect(cc(ctxMsg)).toBeUndefined();
    const lastUser = out.messages[out.messages.length - 1];
    expect(lastUser.content).toBe('turn 2');
    expect(cc(lastUser)).toBeUndefined();
  });

  it('does not mark a history breakpoint when the context block is first (turn 1)', () => {
    const out = applyAnthropicPromptCache({
      system: 'S',
      messages: [CTX, { role: 'user', content: 'first ask' }],
    });
    // Only the system message carries a breakpoint.
    const marked = out.messages.filter((m) => cc(m) !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0].role).toBe('system');
  });

  it('leaves system undefined alone (no empty system message injected)', () => {
    const out = applyAnthropicPromptCache({ messages: [CTX, { role: 'user', content: 'x' }] });
    expect(out.system).toBeUndefined();
    expect(out.messages.some((m) => m.role === 'system')).toBe(false);
  });
});
