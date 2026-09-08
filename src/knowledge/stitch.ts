/**
 * Reassembling a window of consecutive chunks (#516).
 *
 * **A pure leaf with no imports**, and split out from `search.ts` rather than
 * inlined there because this is where the neighbour-expansion bug lives, and it
 * has to be testable over hand-written rows with no database and no embedder.
 *
 * Restoring document order is the cheapest measured win in the retrieval
 * milestone — #521's research found it beats a summary hierarchy outright, at
 * zero LLM cost — and it is worth nothing if the seam stutters.
 */

/** The fields stitching needs. A row from the store satisfies it structurally. */
export interface StitchableChunk {
  ordinal: number;
  text: string;
  /** Leading characters of `text` the previous chunk already said. */
  prefixLen: number;
  /** The heading path this chunk sits under, if any. */
  heading?: string;
}

/** Marks a hole where an ordinal is missing, so a reader is not told a lie. */
export const GAP_MARKER = '\n\n[…]\n\n';

/**
 * Join a window of chunks from ONE source back into continuous text.
 *
 * Two properties do the work:
 *
 * **Overlap is dropped, once.** Every chunk after the first carries a prefix —
 * the heading path plus sentences borrowed from its predecessor — and emitting
 * it verbatim makes the seam repeat itself. Reading a three-chunk window then
 * returns each overlapped sentence twice, which reads as a stutter and silently
 * halves the useful content inside the caller's character budget. The prefix is
 * dropped only when the predecessor is actually present, which is why this
 * takes a window rather than a single chunk.
 *
 * **A hole is marked rather than closed.** Non-consecutive ordinals mean a
 * chunk is missing — pruned, or a caller passed a sparse set — and silently
 * concatenating across the hole produces text that reads as continuous and is
 * not. That is the failure a reader cannot detect, so it gets a marker.
 */
export function stitchWindow(chunks: readonly StitchableChunk[]): string {
  if (chunks.length === 0) return '';
  const ordered = [...chunks].sort((a, b) => a.ordinal - b.ordinal);
  let out = ordered[0].text;
  for (let i = 1; i < ordered.length; i++) {
    const chunk = ordered[i];
    const previous = ordered[i - 1];
    if (chunk.ordinal !== previous.ordinal + 1) {
      // Across a gap the borrowed sentences belong to a chunk nobody is being
      // shown, so they are the only remaining trace of it and are kept.
      out += `${GAP_MARKER}${chunk.text}`;
      continue;
    }
    // **A changed heading is re-emitted.** `prefixLen` covers the heading AND
    // the carried overlap, and dropping it wholesale is right only when the
    // predecessor really did already say it — true of the overlap, false of a
    // heading that changed. Dropping a changed heading deletes the section
    // boundary from the stitched text, which is exactly the structure restoring
    // document order exists to preserve: a window spanning "Rolling back" into
    // "Who to wake" read as one undifferentiated passage.
    const body = chunk.text.slice(chunk.prefixLen);
    const sectionChanged = chunk.heading !== undefined && chunk.heading !== previous.heading;
    out += sectionChanged ? `\n\n${chunk.heading}\n\n${body}` : `\n\n${body}`;
  }
  return out;
}

/** One contiguous run of ordinals, produced by {@link mergeWindows}. */
export interface OrdinalWindow {
  sourceId: number;
  from: number;
  to: number;
}

/**
 * Expand each anchor into a window and merge the ones that touch.
 *
 * **Merging is not tidiness, it is the difference between k results and k/3.**
 * Two adjacent hits in the same source expand into windows sharing most of
 * their chunks; returned separately, the caller pays for the same text several
 * times inside one character budget and the effective result count collapses.
 * Windows that touch or overlap therefore become one — and `to + 1 >= from`
 * rather than `to >= from`, because two windows that merely abut are still
 * contiguous text with nothing between them.
 */
export function mergeWindows(
  anchors: ReadonlyArray<{ sourceId: number; ordinal: number }>,
  before: number,
  after: number,
): OrdinalWindow[] {
  const spans = anchors.map((a) => ({
    sourceId: a.sourceId,
    from: Math.max(0, a.ordinal - before),
    to: a.ordinal + after,
  }));
  spans.sort((a, b) => a.sourceId - b.sourceId || a.from - b.from);

  const out: OrdinalWindow[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && last.sourceId === span.sourceId && span.from <= last.to + 1) {
      last.to = Math.max(last.to, span.to);
      continue;
    }
    out.push({ ...span });
  }
  return out;
}
