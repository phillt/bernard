import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { scopeContext } from '../../framework/context.js';
import { declaredScope } from '../../framework/agents/dispatch-profile.js';
import { KnowledgeCorpus } from '../corpus.js';
import { KnowledgeStore, closeAllKnowledgeStores } from '../store.js';
import { knowledgeDir } from '../../paths.js';
import { createTools } from '../../tools/index.js';
import type { AgentContext } from '../../framework/context.js';
import type { ToolOptions } from '../../tools/types.js';

/**
 * The corpus fence, at the two places it can fail SILENTLY (#516).
 *
 * A broken fence and a bad retrieval look identical from outside — both surface
 * as a library simply not being there — so each of these has to fail when the
 * mechanism is removed rather than merely pass when it is present.
 */

const IDENTITY = { model: 'fake/model-v1', dimensions: 4 };
const LIBS = ['alpha', 'beta'];

function seed(id: string): void {
  const store = new KnowledgeStore(id, IDENTITY);
  store.replaceSource(
    {
      uri: `/${id}.md`,
      kind: 'file',
      contentHash: 'h',
      bytes: 1,
      chunkerVersion: 1,
      chunkTarget: 700,
      ingestedAt: '2026-09-08T00:00:00.000Z',
    },
    [
      {
        ordinal: 0,
        text: `body of ${id}`,
        charStart: 0,
        charEnd: 5,
        prefixLen: 0,
        embedding: Float32Array.from([1, 0, 0, 0]),
      },
    ],
  );
  store.close();
}

beforeEach(() => {
  for (const id of LIBS) seed(id);
  closeAllKnowledgeStores();
});
afterEach(() => {
  closeAllKnowledgeStores();
  for (const id of LIBS) fs.rmSync(knowledgeDir(id), { recursive: true, force: true });
});

const baseCtx = (): AgentContext =>
  ({
    knowledge: new KnowledgeCorpus(IDENTITY),
    stores: {},
  }) as unknown as AgentContext;

describe('scopeContext', () => {
  it('fences a corpus-only profile', () => {
    // **The mutation this exists for.** Omit `corpusScope` from
    // `scopeContext`'s early return and this is the only test in the tree that
    // fails: every corpus-only fence silently becomes a no-op while every other
    // suite stays green.
    const scoped = scopeContext(baseCtx(), { corpusScope: ['alpha'] });
    expect(scoped.knowledge!.listIds()).toEqual(['alpha']);
  });

  it('still returns the receiver when nothing at all is declared', () => {
    // What keeps `main`'s tool block byte-identical for the prompt cache.
    const ctx = baseCtx();
    expect(scopeContext(ctx, {})).toBe(ctx);
  });

  it('leaves the memory store alone for a corpus-only fence', () => {
    const ctx = baseCtx();
    expect(scopeContext(ctx, { corpusScope: ['alpha'] }).stores).toBe(ctx.stores);
  });

  it('narrows monotonically across two applications', () => {
    // Two call sites scope before the runner sees the input and let the runner
    // scope again; that is only safe because narrowing twice is narrowing once.
    const once = scopeContext(baseCtx(), { corpusScope: ['alpha'] });
    const twice = scopeContext(once, { corpusScope: ['alpha', 'beta'] });
    expect(twice.knowledge!.listIds()).toEqual(['alpha']);
  });
});

describe('declaredScope', () => {
  it('validates shape, not existence', () => {
    // The defect that makes `knowledgeScope` unusable for libraries: its
    // predicate asks whether a DOMAIN exists, so a library name resolves to
    // `[]` — deny-all. A well-formed id for a library nobody has created yet
    // must survive and fail closed later by matching nothing.
    expect(declaredScope({ corpusScope: ['not-created-yet'] })).toEqual({
      corpusScope: ['not-created-yet'],
    });
  });

  it('drops malformed ids and keeps the rest', () => {
    const rejected: Record<string, unknown> = {};
    expect(declaredScope({ corpusScope: ['alpha', '../etc', 'Beta'] }, rejected)).toEqual({
      corpusScope: ['alpha'],
    });
    expect(rejected.corpusScope).toEqual(['../etc', 'Beta']);
  });

  it('treats a non-array as deny-all', () => {
    // The fallback INVERTS for a fence: falling back to the site default would
    // be falling back to full access.
    expect(declaredScope({ corpusScope: 'alpha' })).toEqual({ corpusScope: [] });
  });

  it('leaves an absent field absent, which means unscoped', () => {
    expect(declaredScope({})).toEqual({});
  });

  it('does not touch the other two axes', () => {
    expect(declaredScope({ corpusScope: ['alpha'] })).not.toHaveProperty('memoryScope');
  });
});

describe('the registry', () => {
  const options = {} as ToolOptions;
  const memory = { scoped: () => memory } as never;

  it('builds no knowledge tool without a corpus handle', () => {
    // Fail-closed by construction: the tool cannot exist unfenced, because it
    // cannot exist without the handle that carries the fence.
    return createTools(
      options,
      memory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        surface: 'full',
      },
    ).then((tools) => {
      expect(tools).not.toHaveProperty('knowledge');
    });
  });

  it('hands the tool the FENCED corpus, not an unfenced one', async () => {
    // Asserted on what `createTools` is HANDED, because everything downstream
    // inherits that argument — testing the tool in isolation proves it honours
    // a fence, not that the registry gives it the right one.
    const fenced = new KnowledgeCorpus(IDENTITY, ['alpha']);
    const tools = await createTools(
      options,
      memory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { surface: 'full', knowledge: fenced },
    );
    expect(tools).toHaveProperty('knowledge');
    const listed = JSON.parse(await tools.knowledge.execute({ action: 'list' }, {} as never));
    expect(listed.libraries.map((l: { id: string }) => l.id)).toEqual(['alpha']);
  });
});

describe('the record and its renderer', () => {
  const record = (scope: Partial<Record<string, string[]>>) =>
    ({
      dispatchId: 'ab12',
      definitionId: 'specialist',
      telemetrySite: 'specialist:s',
      timestamp: 0,
      sections: { persistent_memory: 10 },
      ...scope,
    }) as never;

  it('renders a corpus-only fence, which had no header at all', async () => {
    // The guard was `memoryScope || knowledgeScope`, so a corpus-only fence
    // rendered NO "Scoped to:" section — not a missing line inside an otherwise
    // correct block, but the whole thing absent on exactly the dispatch the
    // record exists to explain. A fence and a bad retrieval look identical from
    // outside; this is the surface that tells them apart.
    //
    // Asserted on the RENDERER, not on the file's source text. The predecessor
    // regex-matched the guard expression and a literal interpolation, which
    // pinned one spelling of the fix rather than the behaviour — and the
    // table-driven form (#552) has neither string in it while being correct.
    const { detailBody } = await import('../../ui/overlays/DispatchContextViewer.js');
    const out = detailBody(record({ corpusScope: ['alpha'] }));
    expect(out).toContain('Scoped to:');
    expect(out).toContain('corpus: alpha');
  });

  it('renders every axis, and only the ones declared', async () => {
    const { detailBody } = await import('../../ui/overlays/DispatchContextViewer.js');
    const all = detailBody(
      record({ memoryScope: ['k*'], knowledgeScope: ['general'], corpusScope: ['alpha'] }),
    );
    for (const line of ['memory: k*', 'knowledge: general', 'corpus: alpha']) {
      expect(all).toContain(line);
    }
    expect(detailBody(record({ memoryScope: ['k*'] }))).not.toContain('corpus:');
  });

  it('renders no header at all when nothing is fenced', async () => {
    // Guards the guard: every assertion above would pass if the header were
    // unconditional, which would report a fence on every unscoped dispatch.
    const { detailBody } = await import('../../ui/overlays/DispatchContextViewer.js');
    expect(detailBody(record({}))).not.toContain('Scoped to:');
  });
});
