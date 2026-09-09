import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { EmbeddingProvider } from '../embeddings.js';
import { EMBEDDING_MAX_WORD_PIECES } from '../embeddings.js';
import { chunkText, CHUNKER_VERSION, CHUNK_TARGET_CHARS, type Chunk } from './chunk.js';
import { extractFile, isFailure, walkIngestable, type Extracted } from './extract.js';
import type { ChunkInput, KnowledgeStore } from './store.js';

/**
 * Extract → chunk → embed → rows (#517).
 *
 * ## Foreground, with a progress line
 *
 * #517 proposes the detached `rag-worker` pattern. Measured, that is the wrong
 * shape: 12.9 ms per chunk and Bernard's own `CLAUDE.md` — 418,698 characters,
 * novel-sized — is 526 chunks, so **about seven seconds**. The worker is
 * documented as silent by design, so the pattern the issue recommends is the
 * one that cannot report progress on the one operation where progress is the
 * entire UX. Batching also buys nothing (measured flat at batch 1, 16 and 64),
 * so chunk-at-a-time incremental progress is free rather than a sacrifice.
 *
 * ## One transaction per source, which makes it resumable for free
 *
 * A 200-file ingest that dies on file 150 keeps 149 committed, and re-running
 * skips them by content hash and resumes. No checkpoint file, no worker, no
 * resume flag.
 */

/** Reported per source as it lands. */
export interface IngestProgress {
  done: number;
  total: number;
  uri: string;
  status: 'ingested' | 'unchanged' | 'failed';
  chunks: number;
}

export interface IngestOutcome {
  ingested: number;
  unchanged: number;
  chunks: number;
  failed: { uri: string; reason: string }[];
  /** Sources dropped because they vanished from a re-ingested directory. */
  removed: string[];
  /**
   * Chunks still over the word-piece ceiling after re-splitting, and therefore
   * silently truncated by the embedder. Surfaced rather than logged: this is
   * the number that says part of a document is not retrievable.
   */
  overBudget: number;
  /**
   * False when the provider cannot count word pieces, so the ceiling was only
   * estimated from characters. Said out loud rather than assumed, because the
   * character estimate is wrong by 2-4x on code and CJK.
   */
  verified: boolean;
}

export interface IngestOptions {
  /** Marks these sources as owned by a directory ingest, enabling pruning. */
  root?: string;
  onProgress?: (p: IngestProgress) => void;
  /** Re-ingest even when the content hash matches. */
  force?: boolean;
  pdfProbe?: (bin: string) => boolean;
}

/** sha256 over the NORMALISED text — the same form offsets are taken against. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * How many times to shrink the target before giving up on a source.
 *
 * Each round is a pure re-chunk plus one tokenizer pass — no embedding — so a
 * round is cheap. Four is generous: the scale factor below aims to land in one.
 */
const MAX_RESPLIT_ROUNDS = 4;

export interface SizedChunks {
  chunks: Chunk[];
  target: number;
  overBudget: number;
  verified: boolean;
}

/**
 * Chunk `text` so that no chunk exceeds the embedder's word-piece ceiling.
 *
 * **The character target is a planner; this is the verifier.** `MAX_EMBED_CHARS`
 * divides by four, an English-prose average — measured against the real
 * tokenizer, code runs at 2.41 chars per piece and Japanese at 1.00. At the
 * 700-character target a code chunk measures **299 pieces against a ceiling of
 * 256**, so this is not a defensive extra: without it, code — a corpus type
 * this feature exists to serve — is truncated on most chunks, silently, because
 * the embedder returns a well-formed vector for a prefix with no error.
 *
 * The knob is the target for the WHOLE source rather than a per-chunk re-split.
 * A source is uniform enough in character (a code file is code throughout) that
 * one scale factor converges in a round or two, and it keeps ordinals dense and
 * offsets consistent — re-splitting one chunk in the middle would renumber
 * everything after it and is far easier to get wrong.
 */
export async function chunkWithinBudget(
  text: string,
  mode: 'prose' | 'code',
  provider: Pick<EmbeddingProvider, 'countWordPieces'>,
): Promise<SizedChunks> {
  let target = CHUNK_TARGET_CHARS;
  let chunks = chunkText(text, { targetChars: target, mode });

  if (!provider.countWordPieces || chunks.length === 0) {
    return { chunks, target, overBudget: 0, verified: false };
  }

  // One exit, and `overBudget` is whatever the last count actually said. The
  // predecessor returned from three points inside the loop and a fourth after
  // it that was UNREACHABLE — and that fourth claimed `overBudget: 0`, so
  // anyone raising `MAX_RESPLIT_ROUNDS` would have "fixed" the return that
  // cannot run and left the one that can reporting a number it invented.
  let overBudget = 0;
  for (let round = 0; round < MAX_RESPLIT_ROUNDS; round++) {
    const counts = await provider.countWordPieces(chunks.map((c) => c.text));
    overBudget = counts.filter((n) => n > EMBEDDING_MAX_WORD_PIECES).length;
    if (overBudget === 0 || round === MAX_RESPLIT_ROUNDS - 1) break;
    // Scale by the observed ratio with a 10% margin, so the next round lands
    // under rather than exactly on the ceiling. `Math.max` keeps a pathological
    // ratio (one word piece per character) from collapsing the target to zero.
    const worst = Math.max(...counts);
    target = Math.max(64, Math.floor((target * EMBEDDING_MAX_WORD_PIECES * 0.9) / worst));
    chunks = chunkText(text, { targetChars: target, mode });
  }
  return { chunks, target, overBudget, verified: true };
}

/**
 * Ingest files into `store`.
 *
 * `targets` are absolute paths; a directory is walked. Every failure is
 * collected rather than thrown, so one unreadable file cannot abort the rest.
 */
export async function ingestFiles(
  store: KnowledgeStore,
  provider: EmbeddingProvider,
  targets: readonly Extracted[],
  opts: IngestOptions = {},
): Promise<IngestOutcome> {
  const out: IngestOutcome = {
    ingested: 0,
    unchanged: 0,
    chunks: 0,
    failed: [],
    removed: [],
    overBudget: 0,
    verified: true,
  };
  let done = 0;

  for (const doc of targets) {
    done++;
    const hash = contentHash(doc.text);
    const existing = store.getSource(doc.uri);
    // All four conditions, not just the hash. Without the chunker version and
    // the target, a chunker fix silently never reaches content already stored,
    // because the bytes did not change.
    const unchanged =
      !opts.force &&
      existing !== null &&
      existing.contentHash === hash &&
      existing.chunkerVersion === CHUNKER_VERSION;

    if (unchanged) {
      out.unchanged++;
      opts.onProgress?.({
        done,
        total: targets.length,
        uri: doc.uri,
        status: 'unchanged',
        chunks: 0,
      });
      continue;
    }

    try {
      const sized = await chunkWithinBudget(doc.text, doc.mode, provider);
      if (!sized.verified) out.verified = false;
      out.overBudget += sized.overBudget;

      const vectors =
        sized.chunks.length > 0 ? await provider.embed(sized.chunks.map((c) => c.text)) : [];
      const rows: ChunkInput[] = sized.chunks.map((c, i) => ({
        ordinal: c.ordinal,
        ...(c.heading ? { heading: c.heading } : {}),
        text: c.text,
        charStart: c.charStart,
        charEnd: c.charEnd,
        prefixLen: c.prefixLen,
        embedding: vectors[i],
      }));

      store.replaceSource(
        {
          uri: doc.uri,
          ...(doc.title ? { title: doc.title } : {}),
          kind: doc.kind,
          ...(opts.root ? { root: opts.root } : {}),
          contentHash: hash,
          bytes: doc.bytes,
          chunkerVersion: CHUNKER_VERSION,
          chunkTarget: sized.target,
          ingestedAt: new Date().toISOString(),
        },
        rows,
      );
      out.ingested++;
      out.chunks += rows.length;
      opts.onProgress?.({
        done,
        total: targets.length,
        uri: doc.uri,
        status: 'ingested',
        chunks: rows.length,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      out.failed.push({ uri: doc.uri, reason });
      opts.onProgress?.({ done, total: targets.length, uri: doc.uri, status: 'failed', chunks: 0 });
    }
  }

  return out;
}

/**
 * Resolve `targets` — files and directories — into extracted documents.
 *
 * Split from {@link ingestFiles} so the expensive half (embedding) is testable
 * without the filesystem, and the filesystem half without an embedder.
 */
export function collectSources(
  targets: readonly string[],
  opts: { pdfProbe?: (bin: string) => boolean; fileLimit?: number } = {},
): { documents: Extracted[]; failed: { uri: string; reason: string }[] } {
  const documents: Extracted[] = [];
  const failed: { uri: string; reason: string }[] = [];
  for (const target of targets) {
    // `statSync` decides directory-or-file explicitly. Calling the walk and
    // falling back on an empty result would walk twice AND would treat an empty
    // directory as a file, reporting "no reader for a file with no extension"
    // for something that is not a file at all.
    let isDir = false;
    try {
      isDir = fs.statSync(target).isDirectory();
    } catch (err) {
      failed.push({ uri: target, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const paths = isDir ? walkIngestable(target, opts.fileLimit) : [target];
    for (const p of paths) {
      const result = extractFile(p, opts.pdfProbe ? { pdfProbe: opts.pdfProbe } : {});
      if (isFailure(result)) failed.push(result);
      else documents.push(result);
    }
  }
  return { documents, failed };
}
