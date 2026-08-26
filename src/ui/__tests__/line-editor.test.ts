import { describe, it, expect } from 'vitest';
import {
  lineStart,
  lineEnd,
  wordLeft,
  wordRight,
  wrapRows,
  windowBuffer,
} from '../line-geometry.js';

/**
 * Boundary math for the readline bindings (#356). Pure functions, so these
 * need no rendering — the split exists precisely so the semantics can be
 * pinned here rather than inferred through a frame diff.
 */
describe('lineStart / lineEnd', () => {
  it('spans the whole buffer when there are no newlines', () => {
    expect(lineStart('hello', 3)).toBe(0);
    expect(lineEnd('hello', 3)).toBe(5);
  });

  it('is line-wise, not buffer-wise, in a multiline buffer', () => {
    // This is the correctness fix: Ctrl-A/Ctrl-E used to jump to buffer
    // start/end, which is wrong once Shift+Enter can insert a newline.
    const b = 'alpha\nbravo\ncharlie';
    const mid = b.indexOf('bravo') + 2; // inside "bravo"
    expect(lineStart(b, mid)).toBe(6);
    expect(lineEnd(b, mid)).toBe(11);
  });

  it('treats a cursor at index 0 as line start even when the buffer opens with a newline', () => {
    // `lastIndexOf('\n', -1)` clamps its fromIndex to 0 and would match the
    // leading newline, reporting 1 — one past where the cursor actually is.
    expect(lineStart('\nabc', 0)).toBe(0);
  });

  it('puts the boundary before the newline, not after it', () => {
    const b = 'one\ntwo';
    expect(lineEnd(b, 0)).toBe(3);
    expect(b[lineEnd(b, 0)]).toBe('\n');
    expect(lineStart(b, 4)).toBe(4);
  });

  it('handles a cursor sitting on the newline itself', () => {
    const b = 'one\ntwo';
    expect(lineStart(b, 3)).toBe(0);
    expect(lineEnd(b, 3)).toBe(3);
  });
});

describe('wordLeft / wordRight', () => {
  it('moves across one word', () => {
    const b = 'foo bar baz';
    expect(wordLeft(b, 11)).toBe(8);
    expect(wordRight(b, 0)).toBe(3);
  });

  it('skips the whitespace between words before consuming one', () => {
    const b = 'foo   bar';
    // From just after the spaces, back over "foo" — not into the gap.
    expect(wordLeft(b, 6)).toBe(0);
    // From the end of "foo", forward past the gap and over "bar".
    expect(wordRight(b, 3)).toBe(9);
  });

  it('clamps at the buffer edges instead of running off', () => {
    expect(wordLeft('abc', 0)).toBe(0);
    expect(wordRight('abc', 3)).toBe(3);
    expect(wordLeft('   ', 3)).toBe(0);
    expect(wordRight('   ', 0)).toBe(3);
  });

  it('is a no-op on an empty buffer', () => {
    expect(wordLeft('', 0)).toBe(0);
    expect(wordRight('', 0)).toBe(0);
  });

  it('treats a newline as whitespace, so word motion crosses lines', () => {
    const b = 'one\ntwo';
    expect(wordLeft(b, 7)).toBe(4);
    expect(wordRight(b, 3)).toBe(7);
  });

  it('tolerates a cursor past the end', () => {
    expect(wordLeft('abc', 99)).toBe(0);
    expect(wordRight('abc', -5)).toBe(3);
  });
});

describe('wrapRows / windowBuffer', () => {
  it('splits a long line at exactly `width`, keeping every character', () => {
    const rows = wrapRows('abcdefghij', 4);
    expect(rows.map((r) => 'abcdefghij'.slice(r.start, r.end))).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('preserves empty lines as their own row', () => {
    const b = 'a\n\nb';
    expect(wrapRows(b, 10).map((r) => b.slice(r.start, r.end))).toEqual(['a', '', 'b']);
  });

  it('keeps whitespace verbatim, unlike wrapText', () => {
    // The reason this exists instead of reusing `viewer-util.wrapText`: that
    // collapses runs of whitespace, which desyncs every cursor column.
    const b = 'foo   bar';
    const rows = wrapRows(b, 100);
    expect(b.slice(rows[0].start, rows[0].end)).toBe('foo   bar');
  });

  it('returns the buffer untouched when it fits, so Ink keeps word-wrapping it', () => {
    const w = windowBuffer('short line', 3, 80, 10);
    expect(w).toEqual({ text: 'short line', cursor: 3, above: 0, below: 0 });
  });

  it('windows to the cap and reports what is hidden', () => {
    const b = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const w = windowBuffer(b, b.length, 80, 5);
    expect(w.text.split('\n')).toHaveLength(5);
    expect(w.above).toBe(15);
    expect(w.below).toBe(0);
    expect(w.text).toContain('line19');
    expect(w.text).not.toContain('line0\n');
  });

  it('keeps the cursor inside the window and rebases it correctly', () => {
    const b = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    // Cursor at the very end — the reported symptom is not being able to see
    // what you are typing, and you type at the end.
    const w = windowBuffer(b, b.length, 80, 5);
    expect(w.cursor).toBeGreaterThanOrEqual(0);
    expect(w.cursor).toBeLessThanOrEqual(w.text.length);
    // The character before the rebased cursor must be the one before the real
    // cursor — i.e. the rebase points at the same place in the text.
    expect(w.text.slice(0, w.cursor).endsWith('line19')).toBe(true);
  });

  it('scrolls up to follow a cursor near the start', () => {
    const b = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const w = windowBuffer(b, 2, 80, 5);
    expect(w.above).toBe(0);
    expect(w.below).toBe(15);
    expect(w.text).toContain('line0');
    expect(w.cursor).toBe(2);
  });

  it('counts soft-wrapped rows, not just newlines', () => {
    // One logical line of 100 chars at width 10 is ten rows, so a cap of 3
    // must still window it.
    const b = 'x'.repeat(100);
    const w = windowBuffer(b, 100, 10, 3);
    expect(w.text.split('\n')).toHaveLength(3);
    expect(w.above).toBe(7);
  });
});
