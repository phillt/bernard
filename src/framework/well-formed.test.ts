import { describe, it, expect } from 'vitest';
import { toWellFormedString, toWellFormedValue } from './well-formed.js';

const HAT = '\u{1F3A9}'; // 🎩 — a surrogate pair
const HIGH = HAT[0];
const LOW = HAT[1];

describe('toWellFormedString', () => {
  it('returns the same string when already well-formed', () => {
    const s = `hello ${HAT} world é 中`;
    expect(toWellFormedString(s)).toBe(s);
  });

  it('replaces a lone high surrogate left by a mid-emoji cut', () => {
    // The observed shape: an observation block cut through a reactionKey emoji.
    const cut = `"reactionKey":"${HIGH}... (truncated, 9231 chars total)`;
    const out = toWellFormedString(cut);
    expect(out).toBe(`"reactionKey":"�... (truncated, 9231 chars total)`);
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('replaces a lone low surrogate and keeps intact pairs', () => {
    expect(toWellFormedString(`${LOW}a${HAT}b${HIGH}`)).toBe(`�a${HAT}b�`);
  });

  it('is repeatable (the global regex carries no state between calls)', () => {
    const bad = `x${HIGH}`;
    expect(toWellFormedString(bad)).toBe('x�');
    expect(toWellFormedString(bad)).toBe('x�');
  });
});

describe('toWellFormedValue', () => {
  it('preserves identity for a message list with nothing to repair', () => {
    const msgs = [
      { role: 'user', content: `hi ${HAT}` },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ];
    expect(toWellFormedValue(msgs)).toBe(msgs);
  });

  it('repairs nested strings without mutating the input, copying only the changed path', () => {
    const untouched = { role: 'assistant', content: 'fine' };
    const msgs = [
      untouched,
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 't', result: { text: `a${HIGH}` } }],
      },
    ];
    const out = toWellFormedValue(msgs);
    expect(out).not.toBe(msgs);
    expect(out[0]).toBe(untouched);
    expect(JSON.stringify(out)).toContain('a�');
    expect(JSON.stringify(msgs)).toContain('\\ud83c');
  });

  it('passes non-plain objects through untouched', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const msg = { role: 'user', content: [{ type: 'image', image: bytes }] };
    const out = toWellFormedValue(msg);
    expect(out).toBe(msg);
    expect(out.content[0].image).toBe(bytes);
  });
});
