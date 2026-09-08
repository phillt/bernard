/**
 * The corpus chunker (#517).
 *
 * **A pure leaf with no imports at all**, like `src/lexical.ts`, so it is
 * testable with a string and nothing else — no SQLite, no embedder, no
 * filesystem. That is also why the budget constants below are declared here
 * rather than imported from `embeddings.ts`: importing that module for one
 * number would drag `node:fs`, `logger.ts` and `paths.ts` into the one module
 * whose whole value is having none of them. The repo has made this call twice
 * already — `retrieval.ts`'s `MAX_RETRIEVAL_QUERY_CHARS` and `docs-store.ts`'s
 * `MAX_DOC_CHARS` — and the anti-drift device is the same: a test imports the
 * real constant and asserts the relation.
 *
 * ## This is the planner, not the verifier
 *
 * The chunker measures in CHARACTERS. The embedder truncates at 256 WORD
 * PIECES, silently — it returns a well-formed vector for a prefix with no
 * error and no time penalty. Characters per word piece is not a constant, and
 * measured against the real tokenizer it is not even close to one:
 *
 * | | chars | pieces | chars/piece |
 * | --- | --- | --- | --- |
 * | English prose | 1,034 | 222 | 4.66 |
 * | TypeScript | 1,012 | **409** | 2.47 |
 * | Japanese | 990 | **992** | 1.00 |
 *
 * So a 1,000-character target — the value `MAX_EMBED_CHARS`' 4:1 divisor
 * implies — loses 37% of a code chunk and 74% of a CJK one, silently, on every
 * chunk. A codebase is a corpus type this feature exists to serve, so that is
 * not a corner case.
 *
 * {@link CHUNK_TARGET_CHARS} is therefore set for the code ratio rather than
 * the prose one, and **ingestion re-splits against a real word-piece count**.
 * The two are deliberately separate: an exact count needs the tokenizer, the
 * tokenizer needs the model, and the model has no business in a function that
 * splits a string. What this file guarantees is a *ceiling in characters*;
 * what ingestion guarantees is a ceiling in word pieces.
 */

/**
 * Bumped whenever a change here would produce different chunks for the same
 * input. Stored per source, and a mismatch forces a re-chunk on the next
 * ingest — without it a chunker fix silently never reaches content that is
 * already stored, because the content hash still matches.
 */
export const CHUNKER_VERSION = 1;

/**
 * Packing target. 700 rather than the ~1,000 that `MAX_EMBED_CHARS` implies,
 * because that divisor is an English-prose average — see the table above. At
 * 700 a code chunk measures ~283 pieces, which still needs ingestion's
 * re-split, and CJK needs it badly; the target buys headroom cheaply rather
 * than pretending to be sufficient.
 */
export const CHUNK_TARGET_CHARS = 700;

/**
 * Hard ceiling on an emitted chunk's `text`, heading prefix and overlap
 * included. `CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS + MAX_HEADING_CHARS`
 * must stay under this, which is an invariant a test asserts rather than a
 * coincidence: the classic bug here is overlap sitting on TOP of the target
 * and pushing every chunk past the ceiling.
 */
export const CHUNK_CEILING_CHARS = 950;

/** Sentences carried back from the previous chunk. Counts AGAINST the target. */
export const CHUNK_OVERLAP_CHARS = 100;

/** Heading path prefix, truncated oldest-ancestor-first past this. */
export const MAX_HEADING_CHARS = 120;

/** One emitted chunk. */
export interface Chunk {
  /** 0-based, dense, per source. Document order — the whole neighbour-expansion win. */
  ordinal: number;
  /**
   * What gets embedded and what `read` returns: heading prefix, then overlap
   * carried from the previous chunk, then this chunk's own body.
   */
  text: string;
  /** The heading path at this chunk's start, e.g. `Architecture > Key Patterns`. */
  heading?: string;
  /** Offsets of the BODY into the normalised source. Overlap and heading are outside them. */
  charStart: number;
  charEnd: number;
  /**
   * Leading characters of `text` that are not this chunk's own body — the
   * heading prefix plus the carried overlap.
   *
   * One number rather than a separate heading length and overlap length,
   * because there is exactly one question anyone asks of them: when stitching
   * a window of consecutive chunks back together, how much of this chunk did
   * the previous one already say? `text.slice(prefixLen)` is that answer, and
   * splitting it into two columns invites a caller to drop one and stutter.
   */
  prefixLen: number;
}

/**
 * Line-ending and code-point normalisation, applied ONCE before hashing and
 * before chunking.
 *
 * Offsets are stored against this form, so it has to be the same form the
 * content hash is taken over — otherwise a Windows-authored source hashes as
 * changed on every ingest, and `read --from/--to` disagrees with the file.
 */
export function normalizeSource(text: string): string {
  // Strip a BOM: it is invisible, it shifts every offset by one, and it makes
  // an otherwise identical file hash differently.
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** A span of the source that the packer may not split further. */
interface Unit {
  text: string;
  start: number;
  end: number;
  /** Heading path in force at this unit. */
  heading: string;
  /** A heading forces a chunk boundary before it. */
  breakBefore: boolean;
}

const FENCE_RE = /^(\s*)(```+|~~~+)(.*)$/;
const ATX_RE = /^(#{1,6})\s+(.*)$/;

/** `[.!?]` followed by a closing quote/bracket and whitespace. */
const SENTENCE_END_RE = /[.!?]["')\]]?\s+/g;

/**
 * Abbreviations that end in a period and are not sentence ends. Deliberately
 * tiny and deliberately not an NLP dependency — a missed abbreviation splits
 * one chunk in an odd place, which costs nothing a reader would notice.
 */
const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'cf',
  'al',
  'fig',
  'no',
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'approx',
]);

/**
 * Split `source` into chunks.
 *
 * Boundary priority, highest first: fenced code blocks are atomic, ATX
 * headings force a break, then blank-line paragraphs, then sentences, then a
 * hard character cut. Each level only applies when the level above leaves a
 * unit over the ceiling.
 */
export function chunkText(source: string, opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetChars ?? CHUNK_TARGET_CHARS;
  const ceiling = opts.ceilingChars ?? CHUNK_CEILING_CHARS;
  const code = opts.mode === 'code';
  // Overlap borrows whole SENTENCES, which code does not have. Borrowing lines
  // instead would carry a fragment of a statement into the next chunk, so code
  // carries none: the ordinal is what stitches a window back together.
  const overlapBudget = code ? 0 : (opts.overlapChars ?? CHUNK_OVERLAP_CHARS);

  const units = buildUnits(source, target, code);
  if (units.length === 0) return [];

  const chunks: Chunk[] = [];
  let pending: Unit[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    // Joined from the units' own text, NOT re-sliced from the source by offset.
    // A unit may carry text the source does not: an over-long fence is split
    // into pieces that each re-open the fence, and re-slicing threw those
    // synthesised markers away — every piece after the first arrived as bare
    // code that no longer read, or tokenized, as code. `charStart`/`charEnd`
    // stay honest source offsets, so they can differ from `body.length` by the
    // whitespace between units and by anything synthesised.
    const body = pending.map((u) => u.text).join('\n\n');
    if (body.trim().length === 0) {
      pending = [];
      return;
    }
    const heading = pending[0].heading;
    const prefix = heading ? `${truncateHeading(heading)}\n\n` : '';
    const previous = chunks[chunks.length - 1];
    const overlap = previous ? tailSentences(previous, overlapBudget) : '';
    chunks.push({
      ordinal: chunks.length,
      // The ceiling is enforced here rather than merely asserted by the tests.
      // Everything above bounds the BODY by the target and trusts
      // `target + overlap + heading <= ceiling` to bound the rest — which is
      // true today and is exactly the kind of arithmetic a later edit to the
      // heading path or the overlap rule breaks without noticing. A chunk over
      // the ceiling is a silently truncated embedding, so the last step cuts
      // rather than trusts.
      text: capText(`${prefix}${overlap}${body}`, ceiling),
      ...(heading ? { heading } : {}),
      charStart: pending[0].start,
      charEnd: pending[pending.length - 1].end,
      prefixLen: prefix.length + overlap.length,
    });
    pending = [];
  };

  for (const unit of units) {
    const pendingLen = pending.length ? pending[pending.length - 1].end - pending[0].start : 0;
    if (pending.length > 0 && (unit.breakBefore || pendingLen + unit.text.length > target)) {
      flush();
    }
    pending.push(unit);
  }
  flush();

  return chunks;
}

export interface ChunkOptions {
  targetChars?: number;
  ceilingChars?: number;
  overlapChars?: number;
  /**
   * `code` splits an over-long block on LINE boundaries instead of sentence
   * ones, and carries no overlap.
   *
   * Sentences are not a unit of code. `[.!?]` followed by whitespace matches
   * inside a method chain and inside a string literal, so prose splitting cuts
   * expressions in half at points that mean nothing — and the pieces then
   * tokenize worse, which matters most here because code is where the
   * chars-per-word-piece ratio is already worst (2.47 measured, against 4.66
   * for prose).
   *
   * **Not tree-sitter, and that is a deliberate deferral rather than an
   * oversight.** `tree-sitter-wasms` is already a dependency and ships 36
   * grammars, so syntactic boundaries would cost no new dependency — but the
   * loader needs `createRequire` and a WASM read, which this module cannot have
   * without giving up being a pure leaf. It would need a sibling module that
   * falls back to here, and line boundaries already capture most of the win:
   * they never split a statement, which is the property that actually matters.
   */
  mode?: 'prose' | 'code';
}

/**
 * Whole sentences from the tail of the previous chunk's BODY, up to `budget`.
 *
 * Sentence-level rather than character-level: a character cut lands mid-word,
 * which makes the same passage a different string in two embeddings and buys
 * nothing. Reads the previous chunk's body — never its own prefix — so overlap
 * cannot compound across chunks.
 */
function tailSentences(previous: Chunk, budget: number): string {
  if (budget <= 0) return '';
  const body = previous.text.slice(previous.prefixLen);
  const bounds = sentenceBounds(body);
  let start = body.length;
  for (let i = bounds.length - 1; i >= 0; i--) {
    if (body.length - bounds[i] > budget) break;
    start = bounds[i];
  }
  const tail = body.slice(start).trim();
  if (!tail || tail.length > budget) return '';
  return `${tail}\n\n`;
}

/**
 * Final bound on an emitted chunk, cut on a code-point boundary.
 *
 * A backstop, not a strategy: reaching it means the packing arithmetic above
 * is wrong, and the right response is still to emit something embeddable
 * rather than to store a chunk the tokenizer will truncate anyway.
 */
function capText(text: string, ceiling: number): string {
  return text.length <= ceiling ? text : text.slice(0, safeCut(text, ceiling));
}

/** Offsets at which a sentence begins, excluding 0. */
function sentenceBounds(text: string): number[] {
  const out: number[] = [];
  SENTENCE_END_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END_RE.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const word = /([A-Za-z.]+)$/.exec(before)?.[1]?.toLowerCase();
    if (word && ABBREVIATIONS.has(word.replace(/\.$/, ''))) continue;
    const at = m.index + m[0].length;
    if (at < text.length) out.push(at);
  }
  return out;
}

/** Offsets at which a line begins, excluding 0. The code-mode boundary. */
function lineBounds(text: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf('\n'); i >= 0 && i + 1 < text.length; i = text.indexOf('\n', i + 1)) {
    out.push(i + 1);
  }
  return out;
}

/** Truncate a heading path oldest-ancestor-first, so the nearest heading survives. */
function truncateHeading(path: string): string {
  if (path.length <= MAX_HEADING_CHARS) return path;
  const parts = path.split(' > ');
  while (parts.length > 1 && parts.join(' > ').length > MAX_HEADING_CHARS) parts.shift();
  const kept = parts.join(' > ');
  return kept.length <= MAX_HEADING_CHARS
    ? `… > ${kept}`.slice(0, MAX_HEADING_CHARS)
    : kept.slice(-MAX_HEADING_CHARS);
}

/**
 * Source → units, none longer than `target`.
 *
 * The force-cut at the end is what makes the packer provably progress-making:
 * a source with no boundaries at all — minified JavaScript, a single CSV row,
 * a base64 blob — otherwise yields one unit the packer can never fit and never
 * split, which is an infinite loop on real input the first time someone runs
 * this over a `src/` directory.
 */
function buildUnits(source: string, target: number, code: boolean): Unit[] {
  const blocks = splitBlocks(source, target);
  const out: Unit[] = [];
  for (const block of blocks) {
    if (block.text.length <= target) {
      out.push({ ...block, breakBefore: block.breakBefore });
      continue;
    }
    // Too long to embed whole: paragraphs, then sentences, then a hard cut.
    let first = true;
    for (const piece of splitLong(block.text, block.start, target, code)) {
      out.push({ ...piece, heading: block.heading, breakBefore: first && block.breakBefore });
      first = false;
    }
  }
  return out;
}

interface Block {
  text: string;
  start: number;
  end: number;
  heading: string;
  breakBefore: boolean;
}

/**
 * Headings, fences and paragraphs, in one pass, carrying the heading path.
 *
 * A heading LINE is consumed into the path rather than emitted as content: the
 * path is prefixed to every chunk beneath it, so emitting the line too made a
 * chunk state its own heading twice. `pendingBreak` carries the forced boundary
 * onto whatever content follows.
 */
function splitBlocks(source: string, target: number): Block[] {
  const out: Block[] = [];
  const lines = source.split('\n');
  const headings: string[] = [];
  let offset = 0;
  let i = 0;
  /** A heading was seen; the next emitted block starts a new chunk. */
  let pendingBreak = false;

  const push = (text: string, start: number): void => {
    if (text.trim().length === 0) return;
    out.push({
      text,
      start,
      end: start + text.length,
      heading: headings.filter(Boolean).join(' > '),
      breakBefore: pendingBreak,
    });
    pendingBreak = false;
  };

  /**
   * A fenced block, split at LINE boundaries if it is too long, with every
   * piece re-opened using the same marker and info string.
   *
   * Splitting at sentence boundaries would be wrong here — code has few — and
   * leaving it atomic would make the character ceiling a caveated invariant
   * rather than an absolute one. A piece that still reads as code also still
   * TOKENIZES as code, which is what keeps ingestion's word-piece re-split from
   * having to undo this.
   */
  const pushFence = (text: string, start: number, marker: string, info: string): void => {
    if (text.length <= target) {
      push(text, start);
      return;
    }
    const open = `${marker}${info}`;
    const lines = text.split('\n');
    let buf: string[] = [];
    let bufStart = start;
    let cursor = start;
    const emit = (): void => {
      if (buf.length === 0) return;
      const reopened = buf[0].trimStart().startsWith(marker) ? buf : [open, ...buf];
      const closed = reopened[reopened.length - 1].trimStart().startsWith(marker)
        ? reopened
        : [...reopened, marker];
      push(closed.join('\n'), bufStart);
      buf = [];
    };
    // A single line longer than the target — minified code inside a fence —
    // still lands over budget here and falls through to `splitLong`. Bounded,
    // but it stops being valid code; nothing can keep both properties.
    for (const line of lines) {
      // +2 for the re-opened fence and its closer.
      // Bounded by the TARGET, not the ceiling: `buildUnits` sends anything
      // over the target to `splitLong`, which splits on sentences and would
      // tear the fence markers off the pieces this just built.
      if (
        buf.length > 0 &&
        buf.join('\n').length + line.length + open.length + marker.length + 2 > target
      ) {
        emit();
        bufStart = cursor;
      }
      buf.push(line);
      cursor += line.length + 1;
    }
    emit();
  };

  let paraStart = offset;
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    push(para.join('\n'), paraStart);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[2];
      const body = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        body.push(l);
        offset += l.length + 1;
        i++;
        if (l.trimStart().startsWith(marker)) break;
      }
      pushFence(body.join('\n'), lineStart, marker, fence[3] ?? '');
      paraStart = offset;
      continue;
    }

    const atx = ATX_RE.exec(line);
    if (atx) {
      flushPara();
      const depth = atx[1].length;
      headings.length = Math.min(headings.length, depth - 1);
      while (headings.length < depth - 1) headings.push('');
      headings[depth - 1] = atx[2].trim();
      // The heading LINE is deliberately not pushed as a unit. It is carried in
      // the heading path, which is prefixed to every chunk beneath it, so
      // emitting it too made a chunk state its own heading twice — once in the
      // prefix and once at the top of its body. `pendingBreak` moves the forced
      // boundary onto whatever content comes next.
      pendingBreak = true;
      paraStart = offset;
      i++;
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      paraStart = offset;
      i++;
      continue;
    }

    if (para.length === 0) paraStart = lineStart;
    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

/**
 * A single over-long block → sentences, then a hard cut on code-point boundaries.
 *
 * Bounded by the TARGET, not the ceiling. A unit becomes at most one chunk
 * body, and the ceiling has to accommodate that body plus the carried overlap
 * plus a heading prefix — so splitting at the ceiling here means every such
 * chunk exceeds it by exactly the overlap, which is what the first run of the
 * ceiling property test caught (1,051 against a 950 ceiling on plain prose).
 */
function splitLong(
  text: string,
  base: number,
  limit: number,
  code = false,
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const bounds = [0, ...(code ? lineBounds(text) : sentenceBounds(text)), text.length];
  let from = 0;
  for (let b = 1; b < bounds.length; b++) {
    const to = bounds[b];
    if (to - from < limit && b < bounds.length - 1 && bounds[b + 1] - from <= limit) continue;
    let piece = text.slice(from, to);
    let pieceStart = from;
    while (piece.length > limit) {
      const cut = safeCut(piece, limit);
      out.push({
        text: piece.slice(0, cut),
        start: base + pieceStart,
        end: base + pieceStart + cut,
      });
      piece = piece.slice(cut);
      pieceStart += cut;
    }
    if (piece.length > 0) {
      out.push({ text: piece, start: base + pieceStart, end: base + pieceStart + piece.length });
    }
    from = to;
  }
  return out;
}

/**
 * The largest cut at or below `limit` that does not split a surrogate pair.
 *
 * A hard cut at an odd offset inside an astral-plane character (an emoji, most
 * of CJK Extension B) produces a lone surrogate — which is not a character,
 * embeds as garbage, and round-trips through SQLite as a replacement
 * character, so the stored text no longer matches the source it claims to be a
 * span of.
 */
function safeCut(text: string, limit: number): number {
  if (limit >= text.length) return text.length;
  const code = text.charCodeAt(limit - 1);
  // A high surrogate at the last kept position means its pair is the first
  // dropped one. Step back so the pair stays together.
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}
