import { describe, it, expect } from 'vitest';
import type { CoreMessage } from 'ai';
import { visionRefusal } from '../vision-gate.js';
import { hasImagePart } from '../../../image.js';

describe('hasImagePart', () => {
  // The whole gate hangs off this, so a false positive would put every
  // text-only dispatch through a capability check it does not need.
  it('is false for string content and for text-only parts', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'Task: hi' },
      { role: 'user', content: [{ type: 'text', text: 'Task: hi' }] },
    ];
    expect(hasImagePart(msgs)).toBe(false);
  });

  it('is true when any message carries a non-text part', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'Task: hi' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: Buffer.from('x'), mimeType: 'image/png' },
        ],
      },
    ];
    expect(hasImagePart(msgs)).toBe(true);
  });

  /**
   * The shape that actually occurs in production, and the one an earlier cut of
   * this predicate got wrong: `agent.ts` pushes tool results into history, so a
   * `{role:'tool', content:[{type:'tool-result'}]}` message is present from the
   * first tool call onward. A predicate testing "any non-text part" reported
   * TRUE for every tool-using turn, sending each one through a capability
   * lookup and a full sanitize pass it did not need.
   */
  it('ignores tool and assistant messages, which carry non-text parts routinely', () => {
    const msgs: CoreMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'shell', result: { output: 'x' } },
        ],
      },
    ];
    expect(hasImagePart(msgs)).toBe(false);
  });
});

describe('visionRefusal', () => {
  // It must name the RESOLVED model, not the session's — they routinely differ
  // once a specialist is pinned or re-tiered by a role — and it must name the
  // override, because that is what the caller can actually do about it.
  it('names the resolved model and the way out', () => {
    const msg = visionRefusal('openai', 'gpt-4.1-mini');
    expect(msg).toContain('openai/gpt-4.1-mini');
    expect(msg).toContain('provider');
    expect(msg).toContain('model');
  });
});
