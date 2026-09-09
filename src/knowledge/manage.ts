import * as fs from 'node:fs';
import * as path from 'node:path';
import { getEmbeddingProvider, type EmbeddingProvider } from '../embeddings.js';
import { knowledgeDir } from '../paths.js';
import {
  embeddingIdentity,
  openCorpus,
  type KnowledgeCorpus,
  type LibrarySummary,
} from './corpus.js';
import { isValidLibraryId } from './ids.js';
import { collectSources, ingestFiles, type IngestOutcome, type IngestProgress } from './ingest.js';
import { searchCorpus, type KnowledgeSearchResult } from './search.js';
import {
  closeKnowledgeStore,
  knowledgeStoreFor,
  type SourceRow,
  type KnowledgeStore,
} from './store.js';
import { stitchWindow } from './stitch.js';

/**
 * Knowledge-library management that RETURNS rather than prints (#516).
 *
 * `apps/manage.ts`'s split, for its reason: the CLI prints through `printInfo`
 * and sets `process.exitCode`, and both are wrong inside Ink's alternate screen
 * buffer — the writes land outside the render loop and a failed action would
 * exit the whole session non-zero. So the decision lives here and the CLI is a
 * printer over it, which is also what makes it testable without a terminal.
 */

export type Outcome<T> = { ok: false; error: string } | ({ ok: true } & T);

/**
 * A caller's path or URL as the store spells it.
 *
 * One definition, because `removeSource` and `readSource` are the delete and
 * the read of ONE identity: if one grows a scheme case and the other does not,
 * they silently disagree about which document is which.
 */
function resolveSourceUri(uri: string): string {
  return path.isAbsolute(uri) || uri.includes('://') ? uri : path.resolve(uri);
}

/** Never fails — a missing knowledge directory is "no libraries", not an error. */
export function listLibraries(): LibrarySummary[] {
  return openCorpus().list();
}

export function createLibrary(id: string, title?: string): Outcome<{ id: string; path: string }> {
  if (!isValidLibraryId(id)) {
    return {
      ok: false,
      error: `"${id}" is not a valid library id. Use lowercase letters, digits and hyphens (1-64 characters).`,
    };
  }
  if (openCorpus().open(id)) return { ok: false, error: `Library "${id}" already exists.` };
  // Constructing the store is what creates it, stamp and all.
  knowledgeStoreFor(id, { ...embeddingIdentity(), ...(title ? { title } : {}) });
  return { ok: true, id, path: knowledgeDir(id) };
}

export function removeLibrary(id: string): Outcome<{ id: string }> {
  const dir = knowledgeDir(id);
  if (!isValidLibraryId(id) || !fs.existsSync(dir)) {
    return { ok: false, error: `No library "${id}".` };
  }
  // Closed first: removing the directory under a live SQLite connection leaves
  // a handle to a file that is gone, and the next write fails somewhere far
  // from here.
  closeKnowledgeStore(id);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, id };
}

export function removeSource(id: string, uri: string): Outcome<{ uri: string }> {
  const store = openCorpus().open(id);
  if (!store) return { ok: false, error: `No library "${id}".` };
  const target = resolveSourceUri(uri);
  if (!store.deleteSource(target)) {
    return { ok: false, error: `Library "${id}" has no source "${target}".` };
  }
  return { ok: true, uri: target };
}

export function libraryStats(
  id: string,
): Outcome<{ summary: LibrarySummary; sources: SourceRow[] }> {
  const store = openCorpus().open(id);
  if (!store) return { ok: false, error: `No library "${id}".` };
  // Built from the store already in hand. `corpus.list().find(...)` opened,
  // stamped and ran `stats()` over EVERY library to describe one.
  const stamp = store.stamp();
  const stats = store.stats();
  return {
    ok: true,
    summary: {
      id,
      title: stamp?.title ?? id,
      sources: stats.sources,
      chunks: stats.chunks,
      bytes: stats.bytes,
      ...(stamp ? { stamp } : {}),
    },
    sources: store.listSources(),
  };
}

export interface AddOptions {
  force?: boolean;
  onProgress?: (p: IngestProgress) => void;
  pdfProbe?: (bin: string) => boolean;
  /** Injected in tests so the 23 MB model is not a prerequisite. */
  provider?: EmbeddingProvider;
}

export async function addSources(
  id: string,
  targets: readonly string[],
  opts: AddOptions = {},
): Promise<Outcome<IngestOutcome & { library: string }>> {
  const store = openCorpus().open(id);
  if (!store) {
    return {
      ok: false,
      error: `No library "${id}". Create it with \`bernard knowledge create ${id}\`.`,
    };
  }
  if (targets.length === 0) return { ok: false, error: 'Nothing to add.' };

  const provider = opts.provider ?? (await getEmbeddingProvider());
  if (!provider) {
    return { ok: false, error: 'The embedding model is unavailable, so nothing can be indexed.' };
  }
  const mismatch = store.mismatchReason(provider.modelId(), provider.dimensions());
  if (mismatch) return { ok: false, error: mismatch };

  const resolved = targets.map((t) => path.resolve(t));
  const { documents, failed } = collectSources(
    resolved,
    opts.pdfProbe ? { pdfProbe: opts.pdfProbe } : {},
  );

  // A directory ingest OWNS its sources, which is what lets a re-run prune the
  // ones that have gone away. A single-file add owns nothing, so it can never
  // delete its neighbours.
  const roots = resolved.filter((t) => {
    try {
      return fs.statSync(t).isDirectory();
    } catch {
      return false;
    }
  });
  const root = roots.length === 1 ? roots[0] : undefined;

  const outcome = await ingestFiles(store, provider, documents, {
    ...(root ? { root } : {}),
    ...(opts.force ? { force: true } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  outcome.failed.push(...failed);

  if (root) {
    outcome.removed = store.pruneMissing(root, new Set(documents.map((d) => d.uri)));
  }
  return { ok: true, library: id, ...outcome };
}

export interface SearchOptions {
  libraries?: readonly string[];
  limit?: number;
  neighbours?: number;
  provider?: EmbeddingProvider;
}

export async function searchLibraries(
  query: string,
  opts: SearchOptions = {},
): Promise<Outcome<KnowledgeSearchResult>> {
  const provider = opts.provider ?? (await getEmbeddingProvider());
  if (!provider) {
    return { ok: false, error: 'The embedding model is unavailable, so nothing can be searched.' };
  }
  const result = await searchCorpus(openCorpus(), provider, query, {
    ...(opts.libraries ? { libraries: opts.libraries } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.neighbours !== undefined ? { neighbours: opts.neighbours } : {}),
  });
  return { ok: true, ...result };
}

export interface ReadOptions {
  from?: number;
  to?: number;
}

/**
 * A run of one source's chunks, stitched back into continuous text.
 *
 * Takes a CORPUS rather than reaching for `openCorpus()`, so the `knowledge`
 * tool — which holds a fenced one and cannot use the unfenced default — shares
 * this decision instead of copying it. The default window size and the clamping
 * rule lived in two files otherwise, and the "returns rather than prints" layer
 * that exists precisely so two front ends can share a decision had one.
 */
export function readSource(
  corpus: KnowledgeCorpus,
  id: string,
  uri: string,
  opts: ReadOptions = {},
): Outcome<{ uri: string; title?: string; from: number; to: number; text: string; total: number }> {
  const store = corpus.open(id);
  if (!store) return { ok: false, error: `No library "${id}".` };
  const target = resolveSourceUri(uri);
  const source = store.getSource(target);
  if (!source) return { ok: false, error: `Library "${id}" has no source "${target}".` };

  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(source.chunkCount - 1, opts.to ?? from + 4);
  const rows = store.chunksInRange(source.id, from, to);
  return {
    ok: true,
    uri: source.uri,
    ...(source.title ? { title: source.title } : {}),
    from,
    to,
    total: source.chunkCount,
    text: stitchWindow(rows),
  };
}

/** Exposed so the CLI can close connections before the process exits. */
export type { KnowledgeStore };
