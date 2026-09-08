import { describe, it, expect } from 'vitest';
import { stitchWindow, mergeWindows, GAP_MARKER } from './stitch.js';

/** `text` is `prefix + body`, so `prefixLen` is where the body starts. */
const chunk = (ordinal: number, prefix: string, body: string) => ({
  ordinal,
  text: prefix + body,
  prefixLen: prefix.length,
});

describe('stitchWindow', () => {
  it('drops the carried prefix so the seam does not stutter', () => {
    const window = [
      chunk(0, '', 'Alpha one. Alpha two.'),
      chunk(1, 'Alpha two. ', 'Beta one.'),
      chunk(2, 'Beta one. ', 'Gamma one.'),
    ];
    const out = stitchWindow(window);
    // Each overlapped sentence appears once. Emitting the prefix verbatim
    // returns it twice, which halves the useful content in the caller's budget.
    expect(out.split('Alpha two.').length - 1).toBe(1);
    expect(out.split('Beta one.').length - 1).toBe(1);
    expect(out).toContain('Gamma one.');
  });

  it('keeps the first chunk whole, prefix included', () => {
    // The first chunk's prefix is its heading path, which is the context that
    // identifies the passage — it has no predecessor to have already said it.
    const out = stitchWindow([chunk(3, 'Architecture > Stores\n\n', 'Body text.')]);
    expect(out).toBe('Architecture > Stores\n\nBody text.');
  });

  it('sorts by ordinal rather than trusting the caller', () => {
    const out = stitchWindow([chunk(2, 'b. ', 'c.'), chunk(0, '', 'a.'), chunk(1, 'a. ', 'b.')]);
    expect(out.indexOf('a.')).toBeLessThan(out.indexOf('b.'));
    expect(out.indexOf('b.')).toBeLessThan(out.indexOf('c.'));
  });

  it('marks a hole rather than closing it', () => {
    // Concatenating across a missing ordinal produces text that reads as
    // continuous and is not — the one failure a reader cannot detect.
    const out = stitchWindow([chunk(0, '', 'First.'), chunk(5, 'x. ', 'Sixth.')]);
    expect(out).toContain(GAP_MARKER.trim());
  });

  it('keeps the prefix across a gap, because it is the only trace of what is missing', () => {
    const out = stitchWindow([chunk(0, '', 'First.'), chunk(5, 'carried. ', 'Sixth.')]);
    expect(out).toContain('carried.');
  });

  it('returns empty for no chunks', () => {
    expect(stitchWindow([])).toBe('');
  });
});

describe('mergeWindows', () => {
  it('merges overlapping windows from one source', () => {
    // Two adjacent hits expand into windows sharing most of their chunks.
    // Returned separately the caller pays for the same text twice.
    expect(
      mergeWindows(
        [
          { sourceId: 1, ordinal: 10 },
          { sourceId: 1, ordinal: 11 },
        ],
        1,
        1,
      ),
    ).toEqual([{ sourceId: 1, from: 9, to: 12 }]);
  });

  it('merges windows that merely abut', () => {
    // 0-2 and 3-5 have nothing between them, so they are one run of text.
    // `span.from <= last.to + 1` rather than `<= last.to` is what catches this.
    expect(
      mergeWindows(
        [
          { sourceId: 1, ordinal: 1 },
          { sourceId: 1, ordinal: 4 },
        ],
        1,
        1,
      ),
    ).toEqual([{ sourceId: 1, from: 0, to: 5 }]);
  });

  it('never merges across sources', () => {
    const out = mergeWindows(
      [
        { sourceId: 1, ordinal: 5 },
        { sourceId: 2, ordinal: 5 },
      ],
      1,
      1,
    );
    expect(out).toHaveLength(2);
    expect(out.map((w) => w.sourceId)).toEqual([1, 2]);
  });

  it('clamps at the start of a source', () => {
    expect(mergeWindows([{ sourceId: 1, ordinal: 0 }], 3, 1)).toEqual([
      { sourceId: 1, from: 0, to: 1 },
    ]);
  });

  it('leaves distant windows separate', () => {
    expect(
      mergeWindows(
        [
          { sourceId: 1, ordinal: 0 },
          { sourceId: 1, ordinal: 50 },
        ],
        1,
        1,
      ),
    ).toHaveLength(2);
  });
});
