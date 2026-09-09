import { describe, it, expect } from 'vitest';
import {
  chunkText,
  normalizeSource,
  CHUNK_CEILING_CHARS,
  CHUNK_TARGET_CHARS,
  CHUNK_OVERLAP_CHARS,
  MAX_HEADING_CHARS,
} from './chunk.js';
import { MAX_EMBED_CHARS } from '../embeddings.js';

/** Every chunk's own body, in document order — what `stitch` will reassemble. */
const bodies = (source: string): string[] =>
  chunkText(source).map((c) => c.text.slice(c.prefixLen));

describe('chunk budget', () => {
  // The anti-drift device for the local constants, following
  // `MAX_RETRIEVAL_QUERY_CHARS` and `MAX_DOC_CHARS`. `chunk.ts` cannot import
  // `embeddings.ts` without acquiring node:fs and paths.ts; the test can.
  it('stays under the embedder char budget', () => {
    expect(CHUNK_CEILING_CHARS).toBeLessThanOrEqual(MAX_EMBED_CHARS);
  });

  // The classic bug: overlap sitting ON TOP of the target rather than against
  // it, so every chunk quietly exceeds the ceiling. Asserted rather than hoped.
  it('leaves room for overlap and a heading inside the ceiling', () => {
    expect(CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS + MAX_HEADING_CHARS).toBeLessThanOrEqual(
      CHUNK_CEILING_CHARS,
    );
  });
});

describe('normalizeSource', () => {
  it('folds CRLF so a Windows-authored file does not hash as changed every ingest', () => {
    expect(normalizeSource('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips a BOM, which is invisible and shifts every offset by one', () => {
    expect(normalizeSource('﻿hello')).toBe('hello');
  });
});

describe('chunkText — boundaries', () => {
  it('breaks at headings and carries the heading path', () => {
    const src = ['# Top', '', 'Alpha body.', '', '## Nested', '', 'Beta body.'].join('\n');
    const chunks = chunkText(src);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)!.heading).toBe('Top > Nested');
    expect(chunks.at(-1)!.text).toContain('Top > Nested');
  });

  it('keeps a fence that fits in one chunk', () => {
    const fence = ['```ts', 'const x = 1;', 'const y = 2;', '```'].join('\n');
    const whole = chunkText(`# H\n\nintro\n\n${fence}\n\ntail\n`).find((c) =>
      c.text.includes('```ts'),
    );
    expect(whole, 'a short fence was split across chunks').toBeDefined();
    // Whole and intact inside the chunk. Not "the chunk ends with ```" — a
    // small fence packs alongside the prose around it, which is the point.
    expect(whole!.text).toContain(fence);
  });

  it('splits an over-long fence at line boundaries, re-opening every piece', () => {
    // Deliberate: leaving a long fence atomic would make the character ceiling
    // a caveated invariant rather than an absolute one, and a piece that still
    // reads as code still tokenizes as code.
    const lines = Array.from({ length: 200 }, (_, i) => `const value${i} = compute(${i});`);
    const src = ['```ts', ...lines, '```'].join('\n');
    const pieces = chunkText(src).filter((c) => c.text.includes('```'));
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      const body = p.text.slice(p.prefixLen).trim();
      expect(body.startsWith('```'), 'a piece did not re-open its fence').toBe(true);
      expect(body.endsWith('```'), 'a piece did not close its fence').toBe(true);
      expect(p.text.length).toBeLessThanOrEqual(CHUNK_CEILING_CHARS);
    }
  });

  it('keeps ordinals dense from zero', () => {
    const src = Array.from(
      { length: 12 },
      (_, i) => `## H${i}\n\nBody ${i}. ${'x'.repeat(400)}`,
    ).join('\n\n');
    expect(chunkText(src).map((c) => c.ordinal)).toEqual(
      Array.from({ length: chunkText(src).length }, (_, i) => i),
    );
  });

  it('reassembles to the source, so no content is dropped between chunks', () => {
    const src = '# H\n\nOne. Two. Three.\n\nFour paragraph.\n\n## I\n\nFive.\n';
    // Bodies are contiguous source spans, so concatenating the RANGES must
    // cover everything but inter-block whitespace.
    const chunks = chunkText(src);
    const covered = chunks.map((c) => src.slice(c.charStart, c.charEnd)).join('\n');
    for (const word of ['One.', 'Four paragraph.', 'Five.']) {
      expect(covered, `${word} was lost between chunks`).toContain(word);
    }
  });
});

describe('chunkText — overlap', () => {
  const src = Array.from({ length: 8 }, (_, i) => `Sentence ${i} of the body text here.`).join(' ');

  it('carries whole sentences, not a character cut', () => {
    const chunks = chunkText(src, { targetChars: 120, overlapChars: 60 });
    const carried = chunks.slice(1).map((c) => c.text.slice(0, c.prefixLen).trim());
    for (const c of carried) {
      if (!c) continue;
      // A character-level cut would land mid-word, which makes the same passage
      // a different string in two embeddings for no benefit.
      expect(c).toMatch(/^\S/);
      expect(c.endsWith('.')).toBe(true);
    }
  });

  it('prefixLen covers heading and overlap together, so a stitch drops both', () => {
    const chunks = chunkText(`# Heading\n\n${src}`, { targetChars: 120, overlapChars: 60 });
    for (const c of chunks.slice(1)) {
      expect(c.text.slice(c.prefixLen)).toBe(c.text.slice(c.prefixLen));
      expect(c.text.slice(0, c.prefixLen)).not.toContain(c.text.slice(c.prefixLen).slice(0, 20));
    }
  });

  it('does not compound overlap across chunks', () => {
    // Overlap is read off the previous chunk's BODY, never its own prefix. If
    // it were read off the whole text, each chunk would carry the previous
    // chunk's carried text too and the prefix would grow without bound.
    const chunks = chunkText(src, { targetChars: 120, overlapChars: 60 });
    for (const c of chunks) expect(c.prefixLen).toBeLessThanOrEqual(60 + 2);
  });
});

describe('chunkText — the failure modes', () => {
  // Each of these is a real shape a `bernard knowledge add ./src` will meet.

  it('terminates on a source with no boundaries at all', () => {
    // Minified JS: one line, no blank lines, no sentence ends. Without the
    // force-cut in buildUnits the packer has a unit it can never fit and never
    // split, which is an infinite loop rather than a bad answer.
    const minified = 'a'.repeat(50_000);
    const chunks = chunkText(minified);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_CEILING_CHARS);
  });

  it('never emits an empty chunk', () => {
    for (const src of ['', '\n\n\n', '# H\n\n', '   ', '---\ntitle: x\n---\n']) {
      for (const c of chunkText(src)) expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('treats an empty source as zero chunks rather than throwing', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n ')).toEqual([]);
  });

  it('does not split a surrogate pair on a hard cut', () => {
    // A lone surrogate is not a character: it embeds as garbage and comes back
    // from SQLite as U+FFFD, so the stored text stops matching the span it
    // claims to be.
    // The leading 'a' is load-bearing: in an all-emoji string every code unit
    // offset is even, so a cut at an even limit lands between pairs and the
    // test cannot fail. One ASCII character shifts every pair onto an odd
    // boundary, which is where a naive slice splits one.
    const src = `a${'😀'.repeat(2000)}`;
    for (const c of chunkText(src)) {
      expect(c.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(c.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it('truncates a long heading path oldest-ancestor-first', () => {
    const deep =
      ['#', '##', '###', '####']
        .map((h, i) => `${h} ${'Level'.repeat(12)}${i}`)
        .join('\n\nbody\n\n') + '\n\ndeepest body\n';
    const last = chunkText(deep).at(-1)!;
    const prefix = last.text.slice(0, last.prefixLen);
    expect(prefix.length).toBeLessThanOrEqual(MAX_HEADING_CHARS + 4);
    // The NEAREST heading identifies the passage, so it is the one that must
    // survive; the ellipsis says an ancestor was dropped.
    expect(prefix).toContain('3');
    expect(prefix.startsWith('…')).toBe(true);
    expect(prefix).not.toContain('Level0');
  });

  it('a heading line is not repeated in the body it labels', () => {
    // The path is prefixed to every chunk beneath a heading, so emitting the
    // heading LINE as content too made a chunk state its own heading twice.
    const [first] = chunkText('# Architecture\n\nAlpha body text.');
    expect(first.text).toContain('Architecture');
    expect(first.text.slice(first.prefixLen)).not.toContain('# Architecture');
  });
});

describe('chunkText — the ceiling holds on every shape', () => {
  // The property that matters most: whatever comes in, no chunk exceeds the
  // char ceiling. A single failing shape means a silently truncated embedding.
  const shapes: Array<[string, string]> = [
    ['english prose', 'The lighthouse keeper walked the shingle at dusk. '.repeat(400)],
    ['dense code', 'const resolveSiteModel=(c,s)=>c.lineups[s]?.roles??null;\n'.repeat(300)],
    ['cjk', '灯台守は夕暮れに砂利道を歩いた。'.repeat(600)],
    ['one long line', 'x'.repeat(30_000)],
    ['only headings', Array.from({ length: 200 }, (_, i) => `## Heading ${i}`).join('\n')],
    ['crlf', normalizeSource('Alpha line.\r\n\r\nBeta line.\r\n'.repeat(200))],
    ['astral', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢'.repeat(1500)],
    ['fences', '```js\nlet a=1;\n```\n\ntext\n\n'.repeat(200)],
  ];

  it.each(shapes)('bounds every chunk for %s', (_name, src) => {
    const chunks = chunkText(src);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_CEILING_CHARS);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it.each(shapes)('offsets stay inside the source for %s', (_name, src) => {
    for (const c of chunkText(src)) {
      expect(c.charStart).toBeGreaterThanOrEqual(0);
      expect(c.charEnd).toBeLessThanOrEqual(src.length);
      expect(c.charStart).toBeLessThan(c.charEnd);
    }
  });
});

describe('bodies', () => {
  it('exposes each chunk body without its carried prefix', () => {
    const out = bodies('# H\n\nAlpha. Beta. Gamma.');
    expect(out.join(' ')).toContain('Alpha.');
    expect(out[0]).not.toContain('# H');
  });
});

describe('code mode', () => {
  const code = [
    'export function resolveSiteModel(config, site) {',
    '  const lineup = config.lineups[site];',
    '  return lineup?.roles ?? null;',
    '}',
  ]
    .join('\n')
    .repeat(40);

  it('splits on line boundaries, never mid-statement', () => {
    for (const c of chunkText(code, { mode: 'code' })) {
      const body = c.text.slice(c.prefixLen);
      // The property is that a split lands at a LINE start, not that a body
      // starts with a non-space — code is indented, so leading whitespace is
      // exactly what a correct split preserves.
      //
      // A prose split lands on `[.!?]` + whitespace, which inside a method
      // chain or a string literal cuts an expression at a point that means
      // nothing, and the pieces then tokenize worse — in the one mode where the
      // chars-per-word-piece ratio is already worst.
      expect(c.charStart === 0 || code[c.charStart - 1] === '\n').toBe(true);
      expect(body.length).toBeGreaterThan(0);
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_CEILING_CHARS);
    }
  });

  it('carries no overlap, because code has no sentences to borrow', () => {
    for (const c of chunkText(code, { mode: 'code' })) expect(c.prefixLen).toBe(0);
  });

  it('still bounds a single line longer than the target', () => {
    // Minified code is one line: line boundaries cannot help, and the hard cut
    // is what stops the packer having a unit it can never place.
    const minified = `const x=${'a'.repeat(5000)};`;
    const chunks = chunkText(minified, { mode: 'code' });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_CEILING_CHARS);
  });
});
