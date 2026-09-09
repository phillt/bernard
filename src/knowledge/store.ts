import type { DatabaseSync } from 'node:sqlite';
import { LexicalIndex } from '../lexical.js';
import { knowledgeDir } from '../paths.js';
import { openSqliteFile, SqliteConnectionCache } from '../sqlite.js';
import { isValidLibraryId } from './ids.js';

/**
 * One knowledge library's ingested corpus (#516) — SQLite, one file per library.
 *
 * ## Why this is not `RAGStore`
 *
 * The codebase already wrote the rejection, in `tools/docs.ts`: a 90-day TTL
 * would make documentation evaporate and 0.92 dedup would drop similar
 * paragraphs. Two more mechanisms finish the argument — a 5,000-record global
 * cap that a novel takes 40% of, after which `prune()` evicts the user's own
 * conversation history, and a whole-file `JSON.stringify` on every write.
 *
 * This store has **no TTL, no dedup, no cross-owner cap and no whole-file
 * rewrite**. The last three are structural rather than merely absent: there is
 * no code path that could prune across libraries, because a library is a
 * separate file.
 *
 * ## What it deliberately does not know
 *
 * It does not import `embeddings.ts`. Vectors go in and come out as
 * `Float32Array`; it has no idea what a cosine is. That is what keeps its own
 * tests running against injected fake vectors in milliseconds rather than
 * behind a 23 MB model download — the mistake `retrieval-eval.test.ts`
 * documents having made once already.
 *
 * ## Storage
 *
 * Measured on the real 3,662-record conversational store, re-encoded: **29.6 MB
 * of JSON becomes 7.3 MB** (an embedding is 8,069 bytes as JSON text and 1,536
 * as a Float32 BLOB), and **193 ms to load becomes 7 ms** to read ids and
 * vectors. A full brute-force cosine scan over 5,000 chunks is **27 ms**, and
 * inserting 5,000 rows is **74 ms** — so there is no vector index here, no
 * `sqlite-vec` and no ANN. Those would be a new dependency for a problem that
 * does not exist at this scale.
 */

/** Bumped when the table shape changes in a way an older binary cannot read. */
export const KNOWLEDGE_SCHEMA_VERSION = 1;

/** What produced this library's vectors. A mismatch stops search. */
export interface LibraryStamp {
  schemaVersion: number;
  model: string;
  dimensions: number;
  title: string;
  createdAt: string;
}

/** One ingested document. */
export interface SourceRow {
  id: number;
  /** Absolute path or URL. The identity — re-ingesting the same uri updates in place. */
  uri: string;
  title?: string;
  kind: 'file' | 'url' | 'text';
  /** The directory ingest that owns this source, or absent for a single add. */
  root?: string;
  contentHash: string;
  bytes: number;
  chunkCount: number;
  chunkerVersion: number;
  chunkTarget: number;
  ingestedAt: string;
}

/** What a caller supplies to write a source. `id` and `chunkCount` are derived. */
export type SourceInput = Omit<SourceRow, 'id' | 'chunkCount'>;

/** One stored chunk. */
export interface ChunkRow {
  id: number;
  sourceId: number;
  ordinal: number;
  heading?: string;
  text: string;
  charStart: number;
  charEnd: number;
  prefixLen: number;
}

/** A chunk on the way in. `embedding` is not stored on the way out unless asked for. */
export interface ChunkInput extends Omit<ChunkRow, 'id' | 'sourceId'> {
  embedding: Float32Array | readonly number[];
}

/** A chunk's identity, without its text or vector. */
export interface ChunkKey {
  id: number;
  sourceId: number;
  ordinal: number;
}

/** The result of a full vector scan, cached per write generation. */
export interface VectorScan {
  vectors: ChunkVector[];
  malformed: number;
}

/** A chunk's vector plus the identity a ranker needs. */
export interface ChunkVector {
  id: number;
  sourceId: number;
  ordinal: number;
  embedding: Float32Array;
}

/**
 * Float32, **explicitly little-endian in both directions**.
 *
 * `Float32Array`'s own byte order follows the host, so aliasing its buffer
 * would make a library written on one architecture unreadable on another —
 * silently, as garbage vectors rather than an error, which `cosineSimilarity`
 * then scores as noise. A `DataView` with an explicit endianness costs a loop
 * and makes the file format a property of the file rather than of the machine.
 */
function encodeVector(v: Float32Array | readonly number[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(v.length * 4));
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i], true);
  return new Uint8Array(view.buffer);
}

/**
 * The inverse, returning `null` for a blob that is not `dimensions` floats.
 *
 * **Refused per row rather than scored.** A wrong-length vector reaches
 * `cosineSimilarity`, which returns `0` for a dimension mismatch — the same
 * silent-empty failure the library stamp exists to prevent, one level down and
 * for one row instead of the whole store. A caller that drops the row and logs
 * it can at least be asked why a document stopped matching.
 *
 * Copies rather than aliasing: a blob's `byteOffset` is not guaranteed to be
 * 4-aligned, and `new Float32Array(buffer, byteOffset)` throws when it is not.
 */
export function decodeVector(blob: Uint8Array, dimensions: number): Float32Array | null {
  if (blob.byteLength !== dimensions * 4) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

interface MetaRow {
  key: string;
  value: string;
}

export class KnowledgeStore {
  private readonly db: DatabaseSync;
  readonly libraryId: string;
  readonly file: string;

  /**
   * Bumped by every write. A lexical index built over this library's chunks is
   * only valid for one value of it.
   *
   * On the STORE rather than on the corpus handle, deliberately: `corpus.scoped()`
   * clones the handle, and `rag.ts` records what a per-instance mutable flag
   * does when it gets copied into a shallow clone — the view's bookkeeping
   * stops reaching the original, silently. The store is shared by reference
   * through the connection cache and is never cloned, so there is nothing here
   * for a clone to fork.
   */
  writeGeneration = 0;

  /**
   * Decoded vectors and the lexical index, both keyed on {@link writeGeneration}.
   *
   * **The counter shipped without its reader.** Its own doc comment said an
   * index "is only valid for one value of it" and nothing consulted it, so both
   * were rebuilt on every search. Measured on a 5,000-chunk library:
   *
   * | | per search |
   * | --- | --- |
   * | read + decode 5,000 vectors | 21.9 ms |
   * | cosine over them | **2.8 ms** |
   * | build the lexical index | 672 ms |
   *
   * So 89% of a dense search was re-decoding rows that had not changed, and a
   * symbol-naming search spent 575 of its 600 ms building an index it threw
   * away. `rag.ts` is the precedent and carries its own measurement for a build
   * **20-27x cheaper** than this one.
   *
   * On the store, which is shared by reference through the connection cache and
   * never cloned — so unlike a flag on a scoped VIEW there is nothing here for
   * a clone to fork, which is the trap `rag.ts` documents.
   */
  private vectorCache: { generation: number; dimensions: number; scan: VectorScan } | null = null;
  private lexicalCache: { generation: number; index: LexicalIndex; rows: ChunkKey[] } | null = null;

  constructor(libraryId: string, opts: { model: string; dimensions: number; title?: string }) {
    if (!isValidLibraryId(libraryId)) {
      // Rejected, never repaired: a sanitised id addresses a different library
      // than the caller named.
      throw new Error(`Not a valid library id: ${JSON.stringify(libraryId)}`);
    }
    this.libraryId = libraryId;
    // Directory mode, the chmod window, WAL and the busy timeout all live in
    // `openSqliteFile` now. Every one of those lines was duplicated from
    // `apps/store.ts`, and quirk-handling for an experimental module plus a
    // filesystem race is exactly what should not be maintained twice.
    const opened = openSqliteFile(knowledgeDir(libraryId), 'library.db');
    this.db = opened.db;
    this.file = opened.file;
    // **Redundant with `node:sqlite`'s default, and kept deliberately.**
    //
    // The widely-repeated rule is that SQLite defaults `foreign_keys` to OFF
    // per connection — true of SQLite, and FALSE of this driver: `DatabaseSync`
    // takes `enableForeignKeyConstraints`, which defaults to `true`. Measured:
    // a bare `new DatabaseSync(':memory:')` reports `foreign_keys = 1`.
    //
    // So this line is belt-and-braces rather than load-bearing, and it cannot
    // be pinned by a test — deleting it changes nothing, which the mutation run
    // duly reported. What IS pinned is the behaviour: the cascade test asserts
    // that deleting a source takes its chunks with it, and that holds whichever
    // of the two supplies the guarantee. Stated at length because the received
    // wisdom is wrong here, and someone will otherwise "correct" this comment
    // back and then rely on a pragma they think is doing the work.
    //
    // What the cascade prevents either way: chunks surviving their source, so
    // they stay in the dense scan forever and search returns text from a
    // document the user removed.
    this.db.exec('PRAGMA foreign_keys = ON');

    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS sources (' +
        'id INTEGER PRIMARY KEY, uri TEXT NOT NULL UNIQUE, title TEXT, kind TEXT NOT NULL, ' +
        'root TEXT, content_hash TEXT NOT NULL, bytes INTEGER NOT NULL, ' +
        'chunker_version INTEGER NOT NULL, chunk_target INTEGER NOT NULL, ' +
        'ingested_at TEXT NOT NULL)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS chunks (' +
        'id INTEGER PRIMARY KEY, ' +
        'source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE, ' +
        'ordinal INTEGER NOT NULL, heading TEXT, text TEXT NOT NULL, ' +
        'char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, prefix_len INTEGER NOT NULL, ' +
        'embedding BLOB NOT NULL)',
    );
    // Makes neighbour expansion a point lookup rather than a sort, and makes a
    // duplicate ordinal a write error rather than a silently doubled chunk.
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS chunks_src_ord ON chunks(source_id, ordinal)');

    this.seedStamp(opts);
  }

  /**
   * Writes the stamp on a new library; leaves an existing one alone.
   *
   * **A missing stamp is corruption, not a legacy store.** `RAGStore` adopts an
   * unstamped file because every install predating #520 has one, and its own
   * note says a model swapped before the stamp existed cannot be detected.
   * There is no legacy here — the stamp is written by the same constructor that
   * creates the tables — so that hole is closed rather than inherited.
   */
  private seedStamp(opts: { model: string; dimensions: number; title?: string }): void {
    const existing = this.stamp();
    if (existing) {
      if (opts.title && !existing.title) this.setMeta('title', opts.title);
      return;
    }
    const now = new Date().toISOString();
    const write = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    write.run('schema_version', String(KNOWLEDGE_SCHEMA_VERSION));
    write.run('embedding_model', opts.model);
    write.run('embedding_dimensions', String(opts.dimensions));
    write.run('title', opts.title ?? this.libraryId);
    write.run('created_at', now);
  }

  stamp(): LibraryStamp | null {
    const rows = this.db.prepare('SELECT key, value FROM meta').all() as unknown as MetaRow[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const model = map.get('embedding_model');
    const dimensions = Number(map.get('embedding_dimensions'));
    if (!model || !Number.isFinite(dimensions)) return null;
    return {
      schemaVersion: Number(map.get('schema_version') ?? 0),
      model,
      dimensions,
      title: map.get('title') ?? this.libraryId,
      createdAt: map.get('created_at') ?? '',
    };
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /**
   * Why this library cannot be searched with the given embedder, or `null`.
   *
   * **Refuse, do not discard** — `RAGStore.modelMismatch`'s rule, and the
   * reason is the same: these are the user's own ingested documents, and
   * silently returning nothing is indistinguishable from a library that has
   * nothing to say. Returned as a STRING for a caller to surface rather than
   * printed, because search runs mid-turn and in the default full-screen REPL
   * a raw write corrupts the frame it lands in.
   */
  mismatchReason(model: string, dimensions: number): string | null {
    const s = this.stamp();
    if (!s) {
      return `Library "${this.libraryId}" has no embedding stamp — the database is incomplete or corrupt. Re-create it with \`bernard knowledge create\` and re-ingest.`;
    }
    if (s.schemaVersion > KNOWLEDGE_SCHEMA_VERSION) {
      return `Library "${this.libraryId}" was written by a newer Bernard (schema ${s.schemaVersion}, this build reads ${KNOWLEDGE_SCHEMA_VERSION}).`;
    }
    if (s.model !== model || s.dimensions !== dimensions) {
      return `Library "${this.libraryId}" was embedded with ${s.model} at ${s.dimensions} dimensions; the active embedder is ${model} at ${dimensions}. Its vectors cannot be compared — the documents are intact, but the library must be re-ingested to be searchable.`;
    }
    return null;
  }

  listSources(): SourceRow[] {
    const rows = this.db
      .prepare(
        'SELECT s.*, (SELECT COUNT(*) FROM chunks c WHERE c.source_id = s.id) AS chunk_count ' +
          'FROM sources s ORDER BY s.uri',
      )
      .all() as unknown as Record<string, unknown>[];
    return rows.map(toSourceRow);
  }

  getSource(uri: string): SourceRow | null {
    const row = this.db
      .prepare(
        'SELECT s.*, (SELECT COUNT(*) FROM chunks c WHERE c.source_id = s.id) AS chunk_count ' +
          'FROM sources s WHERE s.uri = ?',
      )
      .get(uri) as unknown as Record<string, unknown> | undefined;
    return row ? toSourceRow(row) : null;
  }

  /**
   * One source's identity by row id, for labelling a hit.
   *
   * Deliberately not `listSources().find(...)`, which was what the search loop
   * did once per hit: that runs a correlated `COUNT(*)` per source over the
   * whole table to compute a `chunkCount` the caller then discards. Measured at
   * 2,000 sources: **2.597 ms → 0.0038 ms** per call.
   */
  getSourceById(id: number): { uri: string; title?: string } | null {
    const row = this.db.prepare('SELECT uri, title FROM sources WHERE id = ?').get(id) as
      | { uri: string; title: string | null }
      | undefined;
    if (!row) return null;
    return { uri: row.uri, ...(row.title ? { title: row.title } : {}) };
  }

  /**
   * Write one source and all of its chunks, replacing whatever was there.
   *
   * **One transaction per SOURCE, not per run.** A 200-file ingest that dies on
   * file 150 keeps 149 committed, and re-running skips them by content hash and
   * resumes — so ingestion is resumable with no checkpoint file and no worker.
   * A crash mid-source leaves either the whole old set of chunks or the whole
   * new one, never a blend.
   *
   * The `sources.id` is preserved across a replace rather than deleted and
   * recreated, so anything holding a source id keeps meaning the same document.
   */
  replaceSource(source: SourceInput, chunks: readonly ChunkInput[]): number {
    const run = (): number => {
      // **One statement, one column list.** The predecessor wrote the same nine
      // columns twice — an UPDATE arm and an INSERT arm — so adding a column
      // meant editing three places, and forgetting the UPDATE would write the
      // field on first ingest and silently never update it on re-ingest: the
      // exact failure `chunkerVersion` exists to catch, one column over.
      //
      // `uri` is UNIQUE, so the conflict target is the identity, and `RETURNING
      // id` hands back the row id on both paths — replacing a second
      // `SELECT id FROM sources WHERE uri = ?` that ran only on the insert arm.
      const row = this.db
        .prepare(
          'INSERT INTO sources (uri, title, kind, root, content_hash, bytes, ' +
            'chunker_version, chunk_target, ingested_at) VALUES (?,?,?,?,?,?,?,?,?) ' +
            'ON CONFLICT(uri) DO UPDATE SET title=excluded.title, kind=excluded.kind, ' +
            'root=excluded.root, content_hash=excluded.content_hash, bytes=excluded.bytes, ' +
            'chunker_version=excluded.chunker_version, chunk_target=excluded.chunk_target, ' +
            'ingested_at=excluded.ingested_at RETURNING id',
        )
        .get(
          source.uri,
          source.title ?? null,
          source.kind,
          source.root ?? null,
          source.contentHash,
          source.bytes,
          source.chunkerVersion,
          source.chunkTarget,
          source.ingestedAt,
        ) as { id: number };
      const sourceId = Number(row.id);
      // Unconditional: a no-op on a fresh insert, and on a replace it is what
      // makes a source that SHRANK lose its tail rather than keeping orphaned
      // high ordinals forever.
      this.db.prepare('DELETE FROM chunks WHERE source_id = ?').run(sourceId);
      const insert = this.db.prepare(
        'INSERT INTO chunks (source_id, ordinal, heading, text, char_start, char_end, ' +
          'prefix_len, embedding) VALUES (?,?,?,?,?,?,?,?)',
      );
      for (const c of chunks) {
        insert.run(
          sourceId,
          c.ordinal,
          c.heading ?? null,
          c.text,
          c.charStart,
          c.charEnd,
          c.prefixLen,
          encodeVector(c.embedding),
        );
      }
      return sourceId;
    };

    this.db.exec('BEGIN');
    try {
      const id = run();
      this.db.exec('COMMIT');
      this.writeGeneration++;
      return id;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Remove one source and, via the cascade, its chunks. */
  deleteSource(uri: string): boolean {
    const result = this.db.prepare('DELETE FROM sources WHERE uri = ?').run(uri);
    if (Number(result.changes) === 0) return false;
    this.writeGeneration++;
    return true;
  }

  /**
   * Remove sources under `root` whose uri is not in `present`.
   *
   * **Only a re-ingest of the SAME root may prune**, which is what the `root`
   * column exists for. Without it the choice is between leaving deleted files
   * in the index forever — so search returns a document the user removed — and
   * letting a single-file add delete its neighbours.
   */
  pruneMissing(root: string, present: ReadonlySet<string>): string[] {
    const rows = this.db.prepare('SELECT uri FROM sources WHERE root = ?').all(root) as unknown as {
      uri: string;
    }[];
    const gone = rows.map((r) => r.uri).filter((uri) => !present.has(uri));
    for (const uri of gone) this.db.prepare('DELETE FROM sources WHERE uri = ?').run(uri);
    if (gone.length > 0) this.writeGeneration++;
    return gone;
  }

  /**
   * Every chunk's vector, for the dense scan. Text is deliberately not read
   * here — the lexical channel only runs when the query names a symbol, so
   * reading text unconditionally would pay for it on every ordinary turn.
   */
  scanVectors(dimensions: number): VectorScan {
    // `dimensions` is part of the key: a stamp mismatch changes what decodes,
    // and serving a cache built at the old width would be the silent-empty
    // failure the stamp exists to prevent.
    const cached = this.vectorCache;
    if (cached && cached.generation === this.writeGeneration && cached.dimensions === dimensions) {
      return cached.scan;
    }
    const rows = this.db
      .prepare('SELECT id, source_id, ordinal, embedding FROM chunks ORDER BY id')
      .all() as unknown as {
      id: number;
      source_id: number;
      ordinal: number;
      embedding: Uint8Array;
    }[];
    const vectors: ChunkVector[] = [];
    let malformed = 0;
    for (const r of rows) {
      const embedding = decodeVector(r.embedding, dimensions);
      if (!embedding) {
        malformed++;
        continue;
      }
      vectors.push({ id: r.id, sourceId: r.source_id, ordinal: r.ordinal, embedding });
    }
    const scan = { vectors, malformed };
    this.vectorCache = { generation: this.writeGeneration, dimensions, scan };
    return scan;
  }

  /**
   * A BM25 index over every chunk, with the row identities behind it.
   *
   * Built here rather than in `search.ts` so it can share the write-generation
   * key with the vector scan above; `lexical.ts` has zero imports, so the store
   * acquires no edge by holding one.
   */
  lexicalIndex(): { index: LexicalIndex; rows: ChunkKey[] } {
    const cached = this.lexicalCache;
    if (cached && cached.generation === this.writeGeneration) {
      return { index: cached.index, rows: cached.rows };
    }
    const scanned = this.scanTexts();
    const index = new LexicalIndex(scanned.map((r) => r.text));
    const rows = scanned.map((r) => ({ id: r.id, sourceId: r.sourceId, ordinal: r.ordinal }));
    this.lexicalCache = { generation: this.writeGeneration, index, rows };
    return { index, rows };
  }

  /**
   * Every chunk's text in id order, for building a lexical index.
   *
   * Carries `source_id` and `ordinal` too, because the row is being read anyway
   * and the alternative is a second scan: a lexical-ONLY hit still needs its
   * position to expand into a window, and asking `scanVectors` for it would
   * decode every embedding to recover two integers.
   */
  scanTexts(): { id: number; sourceId: number; ordinal: number; text: string }[] {
    const rows = this.db
      .prepare('SELECT id, source_id, ordinal, text FROM chunks ORDER BY id')
      .all() as unknown as { id: number; source_id: number; ordinal: number; text: string }[];
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      ordinal: r.ordinal,
      text: r.text,
    }));
  }

  /** A contiguous run of ordinals from one source, in document order. */
  chunksInRange(sourceId: number, from: number, to: number): ChunkRow[] {
    const rows = this.db
      .prepare(
        'SELECT id, source_id, ordinal, heading, text, char_start, char_end, prefix_len ' +
          'FROM chunks WHERE source_id = ? AND ordinal BETWEEN ? AND ? ORDER BY ordinal',
      )
      .all(sourceId, from, to) as unknown as Record<string, unknown>[];
    return rows.map(toChunkRow);
  }

  stats(): { sources: number; chunks: number; bytes: number } {
    const row = this.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM sources) AS sources, ' +
          '(SELECT COUNT(*) FROM chunks) AS chunks, ' +
          '(SELECT COALESCE(SUM(bytes), 0) FROM sources) AS bytes',
      )
      .get() as unknown as { sources: number; chunks: number; bytes: number };
    return { sources: Number(row.sources), chunks: Number(row.chunks), bytes: Number(row.bytes) };
  }

  close(): void {
    this.db.close();
  }
}

function toSourceRow(r: Record<string, unknown>): SourceRow {
  return {
    id: Number(r.id),
    uri: String(r.uri),
    ...(r.title ? { title: String(r.title) } : {}),
    kind: String(r.kind) as SourceRow['kind'],
    ...(r.root ? { root: String(r.root) } : {}),
    contentHash: String(r.content_hash),
    bytes: Number(r.bytes),
    chunkCount: Number(r.chunk_count ?? 0),
    chunkerVersion: Number(r.chunker_version),
    chunkTarget: Number(r.chunk_target),
    ingestedAt: String(r.ingested_at),
  };
}

function toChunkRow(r: Record<string, unknown>): ChunkRow {
  return {
    id: Number(r.id),
    sourceId: Number(r.source_id),
    ordinal: Number(r.ordinal),
    ...(r.heading ? { heading: String(r.heading) } : {}),
    text: String(r.text),
    charStart: Number(r.char_start),
    charEnd: Number(r.char_end),
    prefixLen: Number(r.prefix_len),
  };
}

/**
 * One connection per library per process — {@link SqliteConnectionCache} holds
 * the reason a per-call connection is wrong inside a long-lived process.
 *
 * The embedding identity is captured by the first caller, which is safe because
 * it is a property of the BUILD rather than of a call: every caller passes what
 * this binary embeds with. A library whose stamp disagrees is refused by
 * `mismatchReason` rather than silently reopened, and the cache is rebuilt if
 * the identity ever does change so a stale one cannot be handed out.
 */
let cache: SqliteConnectionCache<KnowledgeStore> | undefined;
let cachedIdentity: { model: string; dimensions: number } | undefined;

export function knowledgeStoreFor(
  libraryId: string,
  opts: { model: string; dimensions: number; title?: string },
): KnowledgeStore {
  if (
    !cache ||
    cachedIdentity?.model !== opts.model ||
    cachedIdentity.dimensions !== opts.dimensions
  ) {
    cache?.closeAll();
    cachedIdentity = { model: opts.model, dimensions: opts.dimensions };
    cache = new SqliteConnectionCache((id) => new KnowledgeStore(id, opts));
  }
  return cache.get(libraryId);
}

export function closeKnowledgeStore(libraryId: string): void {
  cache?.close(libraryId);
}

/** Closes every open library so WAL checkpoints rather than being left to exit. */
export function closeAllKnowledgeStores(): void {
  cache?.closeAll();
}
