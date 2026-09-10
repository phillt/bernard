import { RAGStore } from './rag.js';
import * as path from 'node:path';
import { listSubdirectories } from './fs-utils.js';
import { RAG_DIR, specialistRagDir } from './paths.js';

/**
 * The per-specialist RAG stores this process has opened (#501).
 *
 * A cache rather than a store per dispatch, the shape `apps/store.ts` and
 * `knowledge/store.ts` already use: `new RAGStore()` reads and parses its whole
 * embedding file, and a specialist that runs four times in a session must not
 * pay that four times. Keyed on the specialist id, which is what the directory
 * is keyed on.
 *
 * **Why a separate store at all**, rather than an owner column on the user's:
 * `maxMemories`, the 0.92 dedup scan and `prune()` are all per-INSTANCE, so a
 * directory per specialist makes every one of them per-owner for free. That is
 * the question this answers — not isolation from the user's own facts, which is
 * why {@link resolveRetrieval} searches BOTH the shared store and this one. A
 * specialist that could no longer see the user's conversational facts would be
 * a silent behaviour change for every specialist that already exists.
 *
 * Module-level, following `providers/request-counter.ts`: the accessor is
 * handed to `assembleContext` by whichever composition root already imports
 * `rag.ts`, so the framework keeps its type-only edge to this module's graph.
 */
const stores = new Map<string, RAGStore>();

/** This specialist's own store, opened once per process. */
export function specialistRagFor(specialistId: string): RAGStore {
  const existing = stores.get(specialistId);
  if (existing) return existing;
  const store = new RAGStore({ dir: specialistRagDir(specialistId) });
  stores.set(specialistId, store);
  return store;
}

/**
 * Which specialists actually have a store on disk.
 *
 * A `readdir`, deliberately NOT a loop over {@link specialistRagFor}: the
 * `RAGStore` constructor `mkdirSync`s its directory, so enumerating through the
 * accessor would materialise an empty store for every id it touched — turning a
 * listing into a writer. Nothing else in the tree can answer this; `paths.ts`
 * maps id → path with no inverse.
 *
 * Directories only, and `[]` when the parent does not exist — which is every
 * install where no specialist has yet learned anything.
 */
export function listSpecialistRagIds(): string[] {
  return listSubdirectories(path.join(RAG_DIR, 'specialists'));
}

/**
 * Drops a cached handle, for `deleteSpecialist`.
 *
 * Without it a long-lived process keeps a store pointed at a directory that has
 * just been removed, and a re-created specialist with the same id inherits the
 * deleted one's in-memory facts — the one way "delete means delete" could be
 * false while the directory really is gone.
 */
export function forgetSpecialistRag(specialistId: string): void {
  stores.delete(specialistId);
}

/**
 * Flushes every open per-specialist store.
 *
 * `RAGStore` debounces its bookkeeping writes (#533) and its timer is
 * `unref()`ed, so a process that exits without this loses the access metadata
 * for every specialist that retrieved. Called from the REPL's cleanup beside
 * the shared store's own flush.
 */
export function flushSpecialistRagStores(): void {
  for (const store of stores.values()) {
    try {
      store.flush();
    } catch {
      // Best-effort at exit: losing bookkeeping costs one TTL extension.
    }
  }
}

/**
 * The sentence that tells a user the other fact stores exist.
 *
 * One renderer, because the two surfaces that say it — `bernard facts` and the
 * REPL's `/rag` — had written it twice on the day it was introduced, in two
 * spellings, each naming the `--specialist` flag independently. Copies of a
 * sentence do not fail, they diverge.
 *
 * `null` when there are none, which is the suppression rule itself rather than a
 * second `length` test at each caller — so today's output stays byte-identical
 * on every install where no specialist has learned anything.
 *
 * Takes the ids rather than reading them, so it is a pure renderer a test can
 * drive directly; {@link listSpecialistRagIds} is the reader beside it.
 */
export function specialistFactsNotice(
  ids: readonly string[],
): { summary: string; ids: string[]; hint: string } | null {
  if (ids.length === 0) return null;
  return {
    summary: `${ids.length} specialist ${ids.length === 1 ? 'store' : 'stores'} also hold facts:`,
    ids: [...ids],
    hint: 'bernard facts --specialist <id>',
  };
}
