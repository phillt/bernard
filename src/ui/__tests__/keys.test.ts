import { describe, it, expect } from 'vitest';
import { parseNavKeys, stripModifiedEnter, isModifiedEnter } from '../keys.js';
// `_keys.ts` imports only `strip-ansi`, so this file stays React- and Ink-free.
import { ESC, HOME_ALL, END_ALL } from './_keys.js';

/**
 * Pure-module tests for #399 — no React, no Ink, matching `mouse.test.ts`.
 * The behaviour through the real input path is pinned separately, in
 * `input-escapes.test.tsx`.
 */
describe('parseNavKeys', () => {
  it('decodes every encoding Ink maps to home/end', () => {
    // Driven from the shared constants, not a third hand-written copy of the
    // table: `keys.ts`'s `NAV_SEQUENCES` is the source, `_keys.ts` exports the
    // spellings for tests, and re-typing them here is how a ninth encoding gets
    // added to production and silently stays uncovered by this file while the
    // behavioural suite covers it — the unit test reading green on the old set.
    for (const seq of HOME_ALL) expect(parseNavKeys(seq)).toEqual(['home']);
    for (const seq of END_ALL) expect(parseNavKeys(seq)).toEqual(['end']);
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

/**
 * The mirror-drift guard (#399). `keys.ts` copies Ink's `keyName` rows because
 * production must not deep-import a path outside Ink's `exports` map — but a
 * copy drifts, and this one shipped its first draft with four of Ink's twelve
 * rows missing, under a docstring claiming completeness.
 *
 * So walk Ink's actual file, in the direction the mistake is made: read every
 * row Ink maps to `home`/`end` and require `parseNavKeys` to decode it. A test
 * MAY depend on the installed tree this way; the `exports` map does not
 * restrict a file-path read, and if a future Ink moves the file this fails
 * loudly rather than silently covering nothing. Same idiom as
 * `meta-coverage.test.ts` walking the constructed registry.
 */
describe("mirror of Ink's keyName table", () => {
  it('decodes every home/end encoding Ink itself recognises', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('node_modules/ink/build/parse-keypress.js', 'utf8');
    const table = src.match(/const keyName = \{([\s\S]*?)\n\};/);
    expect(table, "Ink's keyName table moved — update this guard").not.toBeNull();

    const rows = [...table![1].matchAll(/'?([^\s':]+)'?\s*:\s*'(home|end)'/g)];
    // If the scrape breaks, the loop below vacuously passes — so pin the count
    // too. Ink 5.2.1 has twelve; a change here means Ink's table moved.
    expect(rows.length).toBe(12);

    for (const [, seq, name] of rows) {
      expect(parseNavKeys(`${ESC}${seq}`), `Ink maps ${seq} -> ${name}`).toEqual([name]);
    }
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
