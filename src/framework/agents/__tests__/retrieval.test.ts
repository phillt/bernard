import { describe, it, expect, vi } from 'vitest';
import { definitions, registerBuiltinDefinitions } from '../index.js';
import { mcpDelegateDefinition } from '../mcp-delegate.js';
import { resolveRetrieval, retrievalQueryFor, MAX_RETRIEVAL_QUERY_CHARS } from '../retrieval.js';
import { DEFAULT_MAX_QUERY_CHARS } from '../../../rag-query.js';
import type { AgentContext } from '../../context.js';
import type { AgentDefinition } from '../types.js';

/**
 * One retrieval path (#510), pinned the way `tool-surface.test.ts` pins the
 * refactor it copies.
 *
 * Two properties, and the second is the one that would rot: what each
 * definition resolves to, and that the runner actually **uses** the value. A
 * definition can declare `retrievalQuery` and the runner can quietly stop
 * calling it, and every existing test stays green — the old per-definition
 * search was inside `contextInputs`, so nothing outside asserted on it.
 */

/** Every registered definition, plus the one dispatched directly. */
function allDefinitions(): Array<{ name: string; def: AgentDefinition<any, any> }> {
  registerBuiltinDefinitions();
  return [
    ...definitions.ids().map((id) => ({ name: id, def: definitions.get(id) })),
    { name: 'mcp-delegate', def: mcpDelegateDefinition },
  ] as Array<{ name: string; def: AgentDefinition<any, any> }>;
}

/**
 * How each definition gets its recalled context. Three states, not two.
 *
 * A boolean collapsed the two `false`s into one word meaning opposite things:
 * `main` and `cron` DO retrieve — just not here — while `pac-critic` and
 * `tool-wrapper` deliberately go without. A reader adding a definition had to
 * go read `retrieval.ts`'s prose to tell "already covered elsewhere" from "goes
 * without", which is the special case that rots.
 *
 *  - `runner` — `runDefinition` resolves it, once per dispatch.
 *  - `input`  — the caller retrieves and supplies `ragResults` on `TInput`.
 *    `main` searches in the `Agent` class with `applyStickiness`,
 *    `provenance.add` and `previousRAGFacts`, all turn-scoped and invisible to
 *    the runner; `cron` searches in `headless.ts`, deliberately BEFORE
 *    `mcpManager.connect()` so the cold embedding load overlaps a measured
 *    ~1.1-1.6 s connect. Neither should move.
 *  - `none`   — nothing retrieves, on purpose.
 */
const EXPECTED: Record<string, 'runner' | 'input' | 'none'> = {
  main: 'input',
  sub: 'runner',
  task: 'runner',
  specialist: 'runner',
  'tool-wrapper': 'none',
  cron: 'input',
  'pac-planner': 'none',
  'pac-actor': 'runner',
  'pac-critic': 'none',
  'mcp-delegate': 'none',
};

describe('which definitions retrieve', () => {
  it('every registered definition has a pinned expectation', () => {
    // Guards the guard: a new definition must decide, rather than inheriting
    // whichever answer the table happens not to mention.
    expect(
      allDefinitions()
        .map((d) => d.name)
        .sort(),
    ).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(allDefinitions())('$name declares retrieval as expected', ({ name, def }) => {
    expect(Boolean(def.retrievalQuery), name).toBe(EXPECTED[name] === 'runner');
  });

  it('the two definitions that retrieve elsewhere are exactly the two whose input carries it', () => {
    // The partition that makes `input` a fact rather than a note: a definition
    // either declares `retrievalQuery` or its caller supplies `ragResults` —
    // never both, and never neither by accident. This fails the day someone
    // gives `main` a `retrievalQuery` thinking its `false` meant "does not
    // retrieve".
    for (const [name, mode] of Object.entries(EXPECTED)) {
      const def = allDefinitions().find((d) => d.name === name)!.def;
      if (mode === 'input') expect(def.retrievalQuery, name).toBeUndefined();
      if (mode === 'runner') expect(def.retrievalQuery, name).toBeDefined();
    }
  });

  it('pac-critic retrieves nothing, keeping its deliberate opt-out whole', () => {
    // It returns `null` from `contextInputs` and re-exposes memory as read-only
    // TOOLS, so verification stays grounded in the task and the Actor's report
    // rather than ambient memory. A runner-side search would have handed it the
    // ambient context that opt-out exists to refuse.
    registerBuiltinDefinitions();
    const def = definitions.get('pac-critic') as unknown as AgentDefinition<any, any>;
    expect(def.retrievalQuery).toBeUndefined();
    expect(def.contextInputs?.({} as AgentContext, {} as never)).toBeNull();
  });
});

describe('the query a dispatch retrieves for', () => {
  it('includes the context the caller wrote', () => {
    // The change that pays for the refactor. All three `searchRag` copies
    // searched `input.task` alone and threw away the context string the caller
    // went to the trouble of writing.
    const q = retrievalQueryFor({ task: 'fix the build', context: 'it fails on node 22 only' });
    expect(q).toContain('fix the build');
    expect(q).toContain('it fails on node 22 only');
  });

  it('is the task alone when there is no context', () => {
    expect(retrievalQueryFor({ task: 'fix the build' })).toBe('fix the build');
  });

  it('is null when there is no task, so nothing is searched for nothing', () => {
    expect(retrievalQueryFor({})).toBeNull();
    expect(retrievalQueryFor({ task: '   ' })).toBeNull();
    expect(retrievalQueryFor({ task: '', context: 'ignored' })).toBeNull();
  });

  it('ignores a whitespace-only context rather than appending a blank line', () => {
    expect(retrievalQueryFor({ task: 'a', context: '  ' })).toBe('a');
  });

  it('is bounded, which the dispatch path never was', () => {
    // `sub.ts` called `ctx.rag.search(input.task)` raw and `embedQuery` bounds
    // nothing, so this is a bound that was never there rather than one being
    // discarded — and appending caller-written `context`, declared
    // `z.string().optional()` with no `.max()`, is what makes its absence
    // matter.
    const q = retrievalQueryFor({ task: 'a'.repeat(50), context: 'b'.repeat(5000) });
    expect(q!.length).toBeLessThanOrEqual(MAX_RETRIEVAL_QUERY_CHARS);
  });

  it('cuts the context, never the task', () => {
    // The embedder truncates at 256 word pieces whatever is sent, so the
    // priority order decides what survives. Context is supporting detail; a
    // task cut in half retrieves for a different question.
    const task = 'find the failing test';
    const q = retrievalQueryFor({ task, context: 'z'.repeat(5000) })!;
    expect(q.startsWith(task)).toBe(true);
    expect(q.length).toBe(MAX_RETRIEVAL_QUERY_CHARS);
  });

  it('bounds an over-long task on its own', () => {
    const q = retrievalQueryFor({ task: 'a'.repeat(5000) })!;
    expect(q.length).toBe(MAX_RETRIEVAL_QUERY_CHARS);
  });

  it('uses the same budget the interactive path does', () => {
    // The literal is local because `rag-query.ts` reaches `context.ts` — the
    // edge `token-estimate.ts` exists to refuse — so it is pinned here instead,
    // the way `docs-store.ts`'s MAX_DOC_CHARS is.
    expect(MAX_RETRIEVAL_QUERY_CHARS).toBe(DEFAULT_MAX_QUERY_CHARS);
  });
});

function ctxWithRag(search: ReturnType<typeof vi.fn>): AgentContext {
  return { rag: { search } } as unknown as AgentContext;
}

describe('resolveRetrieval', () => {
  const def = { id: 'sub', retrievalQuery: retrievalQueryFor } as Pick<
    AgentDefinition<any, unknown>,
    'id' | 'retrievalQuery'
  >;

  it('searches once, with the joined query', async () => {
    const search = vi.fn(async () => [{ fact: 'f', similarity: 1, domain: 'general' }]);
    const out = await resolveRetrieval(ctxWithRag(search), def, {
      task: 'do it',
      context: 'here is why',
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toContain('here is why');
    expect(out.results).toHaveLength(1);
    // The query comes back too, so the recorder does not have to run the
    // definition's thunk a second time to know what was searched for (#512).
    expect(out.query).toContain('do it');
  });

  it('reports no query when the definition declares none', async () => {
    const search = vi.fn(async () => []);
    const out = await resolveRetrieval(ctxWithRag(search), { id: 'main' }, { task: 'x' });
    expect(search).not.toHaveBeenCalled();
    expect(out).toEqual({});
  });

  it('reports no query when there is no RAG store at all', async () => {
    // The case that made the recorder lie: it re-ran the thunk unconditionally,
    // so a dispatch with no store recorded a `retrievalQuery` for a search that
    // never happened.
    expect(await resolveRetrieval({} as AgentContext, def, { task: 'x' })).toEqual({});
  });

  it('degrades to nothing when the search throws', async () => {
    // Fail-soft, exactly as the four copies were: a RAG failure must not abort
    // a dispatch, and no results renders no `<recalled_context>` rather than an
    // empty one. No query either — nothing was retrieved for.
    const search = vi.fn(async () => {
      throw new Error('embedding provider unavailable');
    });
    expect(await resolveRetrieval(ctxWithRag(search), def, { task: 'x' })).toEqual({});
  });

  it('does not search when the query resolves to null', async () => {
    const search = vi.fn(async () => []);
    expect(await resolveRetrieval(ctxWithRag(search), def, {})).toEqual({});
    expect(search).not.toHaveBeenCalled();
  });
});

/**
 * A specialist's own RAG store is READ, not merely written (#501).
 *
 * The gap this closes: `rag-worker` wrote into `specialistRagDir(id)` and
 * `deleteSpecialist` removed it, and **nothing anywhere constructed one to
 * search** — so the pass paid a ~196 ms model load and ~13 ms per fact to embed
 * facts no dispatch could ever retrieve. A write-only store is worse than none,
 * because it looks done.
 */
describe('the per-specialist store', () => {
  const def = { id: 'specialist', retrievalQuery: retrievalQueryFor } as Pick<
    AgentDefinition<any, unknown>,
    'id' | 'retrievalQuery'
  >;
  const hit = (fact: string, similarity: number) => ({ fact, similarity, domain: 'general' });

  function ctxWith(shared: unknown[], own: unknown[]) {
    return {
      rag: { search: vi.fn(async () => shared) },
      ragForOwner: vi.fn(() => ({ search: vi.fn(async () => own) })),
    } as unknown as AgentContext;
  }

  it('is searched for an owned dispatch, alongside the shared one', async () => {
    const ctx = ctxWith([hit('shared', 0.9)], [hit('mine', 0.95)]);
    const out = await resolveRetrieval(ctx, def, { task: 'x' }, 'coder');
    expect(ctx.ragForOwner).toHaveBeenCalledWith('coder');
    expect(out.results?.map((r) => r.fact)).toContain('mine');
  });

  it('still returns the user’s own facts, which is the point of merging', async () => {
    // The store exists so `maxMemories`, the dedup scan and `prune()` become
    // per-owner — NOT so a specialist stops seeing the user's conversational
    // facts. Replacing `ctx.rag` outright would have been a silent behaviour
    // change for every specialist that already exists.
    const out = await resolveRetrieval(
      ctxWith([hit('shared', 0.9)], [hit('mine', 0.95)]),
      def,
      {
        task: 'x',
      },
      'coder',
    );
    expect(out.results?.map((r) => r.fact)).toEqual(['mine', 'shared']);
  });

  it('is not consulted for an unowned dispatch', async () => {
    const ctx = ctxWith([hit('shared', 0.9)], [hit('mine', 0.95)]);
    const out = await resolveRetrieval(ctx, def, { task: 'x' });
    expect(ctx.ragForOwner).not.toHaveBeenCalled();
    expect(out.results?.map((r) => r.fact)).toEqual(['shared']);
  });

  it('is skipped when the process supplies no factory', async () => {
    // Fail-closed by omission: a process with RAG off supplies none, and every
    // caller written before this supplies none either.
    const ctx = {
      rag: { search: vi.fn(async () => [hit('shared', 0.9)]) },
    } as unknown as AgentContext;
    expect((await resolveRetrieval(ctx, def, { task: 'x' }, 'coder')).results).toHaveLength(1);
  });
});
