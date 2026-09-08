import * as fs from 'node:fs';
import * as path from 'node:path';
import { knowledgeDir } from '../paths.js';
import { isValidLibraryId } from './ids.js';
import { knowledgeStoreFor, type KnowledgeStore, type LibraryStamp } from './store.js';

/**
 * The set of knowledge libraries a dispatch may reach (#516, fence per #511).
 *
 * ## The scope lives here, and that is the whole point
 *
 * `corpus.open()` is the SINGLE enforcement point — `list`, `search` and `read`
 * all go through it — so there is one place to get the fence wrong rather than
 * three. A tool is handed a `KnowledgeCorpus`, never a library id and a store
 * factory, so there is no call site that could forget to apply it.
 *
 * ## No per-instance mutable state, deliberately
 *
 * `rag.ts` records a trap in the shallow-clone view pattern: `scoped()` copies
 * every field, so a mutable flag on the instance is FORKED into the view and
 * the view's bookkeeping silently stops reaching the original. That store now
 * holds its flush state in one object shared by reference to work around it.
 *
 * This class dodges the class of mistake instead of handling it: it has nothing
 * mutable to copy. The connection cache is module-level in `store.ts`, and the
 * write generation lives on the per-library store, which `scoped()` does not
 * clone. There is no field here a clone could fork.
 *
 * ## Constructing one opens no database
 *
 * It is a scope array and a stamp — a directory listing at most. That matters
 * because `headless.ts` carries a whole paragraph about `new RAGStore()` costing
 * ~190 ms and ~128 MB for callers that never retrieve; a corpus handle can sit
 * on every `AgentContext` unconditionally without repeating it.
 */
export interface LibrarySummary {
  id: string;
  title: string;
  sources: number;
  chunks: number;
  bytes: number;
  /** Absent when the library is unreadable — the caller decides what to say. */
  stamp?: LibraryStamp;
}

/** What this build embeds with. Supplied by the composition root. */
export interface EmbeddingIdentity {
  model: string;
  dimensions: number;
}

export class KnowledgeCorpus {
  private readonly identity: EmbeddingIdentity;
  /** `null` is unscoped. An empty array is deny-all, and they are not the same. */
  private readonly scope: readonly string[] | null;

  constructor(identity: EmbeddingIdentity, scope: readonly string[] | null = null) {
    this.identity = identity;
    this.scope = scope;
  }

  /**
   * Every library on disk that this handle may reach.
   *
   * Non-throwing: a missing or unreadable knowledge directory is "no libraries",
   * not an error. This is reached from context assembly on paths that must not
   * fail because a directory does not exist yet.
   */
  listIds(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(knowledgeDir(''), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && isValidLibraryId(e.name))
      .map((e) => e.name)
      .filter((id) => this.inScope(id) && fs.existsSync(path.join(knowledgeDir(id), 'library.db')))
      .sort();
  }

  inScope(id: string): boolean {
    return this.scope === null || this.scope.includes(id);
  }

  /**
   * A store for one library, or `null` when it is out of scope or absent.
   *
   * The two are deliberately indistinguishable to the caller. Saying "that
   * library exists but you may not read it" leaks the corpus catalogue past the
   * fence, which is the same reasoning `assets.ts` gives for answering 404
   * rather than 403 — distinguishing them tells a prober which paths exist.
   */
  open(id: string): KnowledgeStore | null {
    if (!isValidLibraryId(id) || !this.inScope(id)) return null;
    if (!fs.existsSync(path.join(knowledgeDir(id), 'library.db'))) return null;
    return knowledgeStoreFor(id, this.identity);
  }

  list(): LibrarySummary[] {
    const out: LibrarySummary[] = [];
    for (const id of this.listIds()) {
      const store = this.open(id);
      if (!store) continue;
      const stamp = store.stamp();
      const stats = store.stats();
      out.push({
        id,
        title: stamp?.title ?? id,
        sources: stats.sources,
        chunks: stats.chunks,
        bytes: stats.bytes,
        ...(stamp ? { stamp } : {}),
      });
    }
    return out;
  }

  /**
   * Narrow to `ids`. Monotone — a view can never widen what it inherited.
   *
   * `scoped(undefined)` returns the receiver, which is the rule `headless.ts`
   * states for the RAG fence: one place decides what an absent scope means, and
   * every caller inherits that decision rather than each guarding for it.
   */
  scoped(ids: readonly string[] | null | undefined): KnowledgeCorpus {
    if (ids === null || ids === undefined) return this;
    const next = this.scope === null ? [...ids] : ids.filter((id) => this.scope!.includes(id));
    return new KnowledgeCorpus(this.identity, next);
  }
}
