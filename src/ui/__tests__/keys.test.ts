import { describe, it, expect } from 'vitest';
import { parseNavKeys, stripModifiedEnter, isModifiedEnter } from '../keys.js';

/**
 * Pure-module tests for #399 — no React, no Ink, matching `mouse.test.ts`.
 * The behaviour through the real input path is pinned separately, in
 * `input-escapes.test.tsx`.
 */
const ESC = '';

describe('parseNavKeys', () => {
  it('decodes every encoding Ink maps to home/end', () => {
    // Terminals genuinely disagree about which they send, so supporting only
    // the one on this machine is how this ships as "works for me".
    for (const seq of ['[H', 'OH', '[1~', '[7~']) {
      expect(parseNavKeys(`${ESC}${seq}`)).toEqual(['home']);
    }
    for (const seq of ['[F', 'OF', '[4~', '[8~']) {
      expect(parseNavKeys(`${ESC}${seq}`)).toEqual(['end']);
    }
  });

  it('finds keys coalesced with ordinary typing, in order', () => {
    // A TTY read returns whatever was buffered, so fast typing and key repeat
    // pack several keystrokes into one chunk. Ink anchors its own parse at the
    // start of the chunk and mis-handles exactly this; our decoding must not.
    expect(parseNavKeys(`abc${ESC}[H`)).toEqual(['home']);
    expect(parseNavKeys(`${ESC}[Habc`)).toEqual(['home']);
    expect(parseNavKeys(`${ESC}[H${ESC}[F`)).toEqual(['home', 'end']);
    // Held down: one move per press, not one per chunk.
    expect(parseNavKeys(`${ESC}[F${ESC}[F${ESC}[F`)).toEqual(['end', 'end', 'end']);
  });

  it('ignores chunks with no escape, and other escapes', () => {
    expect(parseNavKeys('')).toEqual([]);
    expect(parseNavKeys('plain typing')).toEqual([]);
    // Arrows, PgUp, Shift+Tab, a mouse report: all decoded elsewhere or by Ink.
    expect(parseNavKeys(`${ESC}[A${ESC}[5~${ESC}[Z${ESC}[<64;1;1M`)).toEqual([]);
  });

  it('does not treat a bare ESC or a truncated sequence as a key', () => {
    expect(parseNavKeys(ESC)).toEqual([]);
    expect(parseNavKeys(`${ESC}[`)).toEqual([]);
    expect(parseNavKeys(`${ESC}[1`)).toEqual([]);
  });
});

describe('stripModifiedEnter', () => {
  it('removes the CSI-u sequence with or without the leading ESC', () => {
    // Ink strips the ESC before `useInput` sees it, so both forms occur.
    expect(stripModifiedEnter('[13;2u')).toBe('');
    expect(stripModifiedEnter(`${ESC}[13;2u`)).toBe('');
    // Any modifier, not just Shift.
    expect(stripModifiedEnter('[13;5u')).toBe('');
  });

  it('keeps text coalesced with the keypress', () => {
    // Swallowing the whole chunk — what the mouse-report guard does — would
    // silently eat real keystrokes here.
    expect(stripModifiedEnter('[13;2uabc')).toBe('abc');
    expect(stripModifiedEnter('abc[13;2u')).toBe('abc');
    expect(stripModifiedEnter('a[13;2ub')).toBe('ab');
  });

  it('leaves ordinary text alone', () => {
    expect(stripModifiedEnter('hello')).toBe('hello');
    expect(stripModifiedEnter('')).toBe('');
    // Similar-looking but not a modified Enter: a different codepoint.
    expect(stripModifiedEnter('[27;2u')).toBe('[27;2u');
  });
});

describe('isModifiedEnter', () => {
  it('is true only when the input is nothing else', () => {
    expect(isModifiedEnter('[13;2u')).toBe(true);
    expect(isModifiedEnter(`${ESC}[13;2u`)).toBe(true);
    expect(isModifiedEnter('[13;2uabc')).toBe(false);
    expect(isModifiedEnter('abc')).toBe(false);
    expect(isModifiedEnter('')).toBe(false);
  });
});
