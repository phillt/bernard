import { describe, it, expect } from 'vitest';
import type { CoreMessage } from 'ai';
import { seedHasAttachment, visionRefusal } from '../vision-gate.js';

describe('seedHasAttachment', () => {
  // The whole gate hangs off this, so a false positive would put every
  // text-only dispatch through a capability check it does not need.
  it('is false for string content and for text-only parts', () => {
    const msgs: CoreMessage[] = [
      { role: 'user', content: 'Task: hi' },
      { role: 'user', content: [{ type: 'text', text: 'Task: hi' }] },
    ];
    expect(seedHasAttachment(msgs)).toBe(false);
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
    expect(seedHasAttachment(msgs)).toBe(true);
  });

  it('ignores non-user messages with array content', () => {
    const msgs: CoreMessage[] = [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }];
    expect(seedHasAttachment(msgs)).toBe(false);
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
