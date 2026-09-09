import { describe, it, expect, vi } from 'vitest';
import type { AgentContext } from '../../context.js';
import { specialistDefinition } from '../specialist.js';
import {
  makeCtx,
  toolsOf,
  inputFor,
  CREATE_TOOLS_DEFINITIONS,
  RAW_MCP_TOOLS,
  DELEGATE_TOOLS,
} from './_mcp-delegation-fixture.js';

/**
 * A persona's `targetTools` is a fence now, not a label (#507).
 *
 * Driven through the real `specialistDefinition` and the real
 * `resolveToolSurface`, because the property is about the registry the
 * definition actually returns — reading the source proves nothing, and the
 * shipped bug was precisely a field that every surface displayed and no code
 * read.
 *
 * ## Why these tests build their own store rather than reusing the fixture's
 *
 * `_mcp-delegation-fixture.ts` backs `stores.specialists` with
 * `new Proxy({}, { get: () => () => [] })`, so `specialists.get(anything)`
 * returns a truthy `[]` whose `targetTools` is `undefined`, and `inputFor`
 * supplies no `specialistId` at all. Every existing case in
 * `tool-surface.test.ts` and `child.mcp-delegation.test.ts` therefore takes the
 * "declares nothing" branch — correctly, since that is the back-compat path
 * they are about, but it means they would stay green with the filter deleted.
 * That is the vacuous pass `main.applet-styling.test.ts` names. So the record
 * is supplied here explicitly, and the negative assertions below are on an
 * EXACT key set rather than `toContain`, so a leak fails rather than passing
 * quietly.
 */

const SPECIALIST_ID = 'scoped-persona';

/**
 * The fixture's ctx with one specialist record in the store.
 *
 * Merged onto `makeCtx`'s own `stores` rather than passed through `overrides`:
 * that parameter is a shallow spread of the whole context, so a `stores` key
 * would replace routines/candidates/toolProfiles wholesale and silently change
 * what `createTools` builds.
 */
function ctxWith(
  record: { targetTools?: string[] } | undefined,
  opts: { delegation?: boolean; coordinatorMode?: 'on' | 'off' } = {},
): AgentContext {
  const base = makeCtx(opts.delegation ?? false, {
    stores: {
      specialists: { get: (id: string) => (id === SPECIALIST_ID ? record : undefined) },
    },
  } as never);
  return (
    opts.coordinatorMode
      ? { ...base, config: { ...base.config, coordinatorMode: opts.coordinatorMode } }
      : base
  ) as AgentContext;
}

async function registryFor(
  record: { targetTools?: string[] } | undefined,
  opts: { delegation?: boolean; coordinatorMode?: 'on' | 'off' } = {},
): Promise<string[]> {
  const tools = await toolsOf(specialistDefinition, ctxWith(record, opts), {
    specialistId: SPECIALIST_ID,
    task: 'x',
    slotId: 1,
    planStore: {},
  });
  return Object.keys(tools).sort();
}

describe('a persona specialist is scoped by its own targetTools', () => {
  it('holds exactly what it declares, plus the reasoning tools', async () => {
    // An EXACT set, not `toContain` plus a list of `not.toContain`: the bug was
    // EXTRA tools, so the assertion has to be able to fail on presence — and
    // once it is exact it already says that `shell`, `file_write`, `web_read`
    // and every MCP delegate are gone, and that `plan`/`think` survived. Three
    // earlier tests restated those weaker forms and could not fail while this
    // one passed.
    expect(await registryFor({ targetTools: ['web_search'] })).toEqual([
      'plan',
      'think',
      'web_search',
    ]);
  });

  it('leaves a record that declares nothing completely unchanged', async () => {
    // 28 of 30 personas on a real install are this case, and
    // `specialist-run.test.ts` dispatches a record of this shape ~45 times.
    // Compared against a run with no record at all, so the assertion states
    // "identical to before" rather than restating a tool list that would then
    // have to be maintained here.
    expect(await registryFor({})).toEqual(await registryFor(undefined));
  });

  it('treats an empty targetTools as unscoped, not as no tools', async () => {
    // `buildChildTools` reads `[]` and `undefined` identically (#331), which is
    // right for a wrapper — the creation boundary refuses an unscoped one — and
    // wrong here, because nothing ever refused a persona with `[]`. A live
    // record carries it while its own prompt tells it to use MCP tools, so
    // honouring it would leave that specialist running and answering badly.
    expect(await registryFor({ targetTools: [] })).toEqual(await registryFor(undefined));
  });

  it('says so when a record carries an empty list', async () => {
    // `[]` is a value no one decided; the log is what keeps it from being
    // silent as well as inert.
    const logger = await import('../../../logger.js');
    const spy = vi.spyOn(logger, 'debugLog');
    await registryFor({ targetTools: [] });
    expect(spy.mock.calls.some(([tag]) => tag === 'specialist:target-tools-empty')).toBe(true);
    spy.mockRestore();
  });
});

describe('scoping and MCP delegation compose', () => {
  // The reason the lookup is the surface PLUS `ctx.mcp.tools`. With delegation
  // on, `surface.mcpTools` holds only `delegate_*` keys, so a record naming a
  // real MCP tool would resolve against nothing and be dropped with only a
  // debug line to show for it.
  it.each([
    ['a raw MCP name, delegation ON', RAW_MCP_TOOLS[0], true],
    ['a delegate name, delegation ON', DELEGATE_TOOLS[0], true],
    ['a raw MCP name, delegation OFF', RAW_MCP_TOOLS[0], false],
  ])('resolves %s', async (_label, name, delegation) => {
    expect(await registryFor({ targetTools: [name] }, { delegation })).toEqual(
      [name, 'plan', 'think'].sort(),
    );
  });

  it('carries no other server when one server tool is named', async () => {
    const names = await registryFor({ targetTools: [RAW_MCP_TOOLS[0]] }, { delegation: true });
    expect(names).not.toContain(RAW_MCP_TOOLS[2]);
    expect(names).not.toContain(DELEGATE_TOOLS[1]);
  });
});

describe('the reasoning tools sit outside the scope', () => {
  // `plan` and `think` surviving the filter is already asserted by the exact-set
  // test above. They are reasoning affordances rather than capability grants —
  // `plan` writes to a dispatch-scoped `PlanStore`, `think` is a scratchpad,
  // neither touches the world, no record anywhere names them, and
  // `buildStrategy`'s enforcement loop re-prompts the model to resolve plan
  // steps, which it can only do by calling `plan`.
  it('keeps evaluate under coordinator mode, and still adds it under a scope', async () => {
    expect(await registryFor({ targetTools: ['web_search'] }, { coordinatorMode: 'on' })).toEqual([
      'evaluate',
      'plan',
      'think',
      'web_search',
    ]);
  });
});

/**
 * Which definitions scope their registry by a specialist record — an exhaustive
 * table, so a new one has to decide rather than inherit silence.
 *
 * This is the guard #510 built for retrieval and this fix did not have. The
 * argument for putting scoping in `runDefinition` instead was "then no
 * definition can forget"; that property is achievable by a test, which is this
 * repo's own idiom (`tool-surface.test.ts`, `meta-coverage.test.ts`,
 * `bundled-manifest.test.ts`) — and a runner-level hook would have had exactly
 * one implementor while needing a second field to exempt `plan`/`think`/
 * `evaluate`, i.e. two fields to express one policy.
 *
 * `tool-wrapper` is absent from `CREATE_TOOLS_DEFINITIONS` and scopes through
 * `dispatchToolWrapper`, not through its definition, so it is not reachable
 * here — stated because "the table is exhaustive" would otherwise be false.
 */
describe('which definitions scope by a specialist record', () => {
  const SCOPES_BY_RECORD: Record<string, boolean> = {
    sub: false,
    task: false,
    specialist: true,
    'pac-actor': false,
  };

  it('every createTools definition has a pinned expectation', () => {
    expect(CREATE_TOOLS_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      Object.keys(SCOPES_BY_RECORD).sort(),
    );
  });

  it.each(CREATE_TOOLS_DEFINITIONS)('$name scopes by record as expected', async ({ name, def }) => {
    // The same record is in the store for all four. Only a definition that
    // READS it narrows; the rest are unaffected, which is what makes this a
    // statement about the definition rather than about the fixture.
    const ctx = makeCtx(false, {
      stores: {
        specialists: {
          get: (id: string) => (id === SPECIALIST_ID ? { targetTools: ['web_search'] } : undefined),
        },
      },
    } as never);
    const scoped = Object.keys(
      await toolsOf(def, ctx, { ...(inputFor(name) as object), specialistId: SPECIALIST_ID }),
    );
    const narrowed = !scoped.includes('shell');
    expect(narrowed, name).toBe(SCOPES_BY_RECORD[name]);
  });
});

describe('a persona can delegate, if its record says so', () => {
  const DISPATCH = ['agent', 'task', 'specialist_run', 'tool_wrapper_run'];
  /** Stand-ins — this level is about the FILTER, not about what they do. */
  const overlay = () => Object.fromEntries(DISPATCH.map((k) => [k, {} as never]));

  async function withOverlay(targetTools: string[]): Promise<string[]> {
    const tools = await toolsOf(specialistDefinition, ctxWith({ targetTools }), {
      specialistId: SPECIALIST_ID,
      task: 'x',
      slotId: 1,
      planStore: {},
      dispatchTools: overlay,
    });
    return Object.keys(tools).sort();
  }

  it('holds the dispatch tools it names', async () => {
    // The gap this closes: a persona was structurally a leaf, because its
    // registry comes only from `createTools`, which builds none of these.
    expect(await withOverlay(['agent'])).toEqual(['agent', 'plan', 'think']);
  });

  it('holds none of them when its record names none', async () => {
    // Delegation is an opt-in grant, not a new default. An EXACT set, so a leak
    // fails rather than passing quietly.
    expect(await withOverlay(['web_search'])).toEqual(['plan', 'think', 'web_search']);
  });

  it('grants nothing to a record that declares no targetTools at all', async () => {
    // **The case that was wrong and had no test.** `scopeToTargetTools` treats
    // an absent list as "unchanged", so merging the overlay into `baseTools`
    // before that filter handed all four to any record declaring nothing — 28
    // of this install's 30 personas. Every other assertion in this block
    // supplies `targetTools`, so all of them were green while it leaked.
    const tools = await toolsOf(specialistDefinition, ctxWith({} as never), {
      specialistId: SPECIALIST_ID,
      task: 'x',
      slotId: 1,
      planStore: {},
      dispatchTools: overlay,
    });
    for (const name of DISPATCH) expect(Object.keys(tools)).not.toContain(name);
  });

  it('builds the overlay from this dispatch’s context, not the caller’s', async () => {
    // The fence would otherwise be a publishing channel. Every dispatch tool
    // closes over the ctx it was built from, and `runDefinition` scopes a ctx
    // only for the dispatch it starts — so a pre-built overlay hands the
    // persona's own sub-agents the PARENT's unowned, unfenced stores. Passing a
    // BUILDER is what lets `tools()` construct them from the scoped ctx, and
    // this asserts the builder is handed exactly that object.
    const seen: unknown[] = [];
    const ctx = ctxWith({ targetTools: ['agent'] });
    await toolsOf(specialistDefinition, ctx, {
      specialistId: SPECIALIST_ID,
      task: 'x',
      slotId: 1,
      planStore: {},
      dispatchTools: (given: unknown) => {
        seen.push(given);
        return overlay();
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(ctx);
  });

  it('grants nothing to a record whose targetTools is empty', async () => {
    // `[]` is honoured as unscoped for the BUILT-IN registry (#507 settled that
    // from real records), and must still grant no delegation — the two defaults
    // are deliberately opposite.
    const keys = await withOverlay([]);
    for (const name of DISPATCH) expect(keys).not.toContain(name);
  });

  it('is a leaf when the caller supplies no overlay', async () => {
    // Omission is the safe answer, and it is the state every persona was in
    // before this — so a caller that forgets cannot accidentally grant
    // delegation. This is also what the depth gate uses to refuse.
    expect(await registryFor({ targetTools: ['agent'] })).toEqual(['plan', 'think']);
  });

  it('never gains `applet`, however it is declared', async () => {
    // The recursion guard. `main.ts`'s overlay carries a styling-capable
    // `applet` and keeps it as a SIBLING key rather than putting it in the
    // object handed down here, so no dispatched registry can hold one.
    const keys = await withOverlay([...DISPATCH, 'applet']);
    expect(keys).not.toContain('applet');
    expect(keys).toEqual([...DISPATCH, 'plan', 'think'].sort());
  });
});

describe("a persona's learned examples reach the model", () => {
  /** The rendered system prompt for a record, through the real definition. */
  function promptFor(record: Record<string, unknown>): string {
    return specialistDefinition.systemPrompt(ctxWith(record as never), {
      specialistId: SPECIALIST_ID,
      task: 'x',
      slotId: 1,
      planStore: {},
    } as never) as string;
  }

  const RECORD = {
    systemPrompt: 'You are a coder.',
    guidelines: [],
    targetTools: ['web_search'],
  };

  it('renders bad examples, which this path showed to nobody', () => {
    // `formatExamples` was called on the wrapper path ONLY, so these were
    // stored on the record, listed in `/specialists`, writable through the
    // `specialist` tool — and never seen by the model. The same shape as the
    // #507 defect: a field every surface displays and no code reads.
    const prompt = promptFor({
      ...RECORD,
      badExamples: [
        {
          input: 'rename the helper',
          call: 'sed -i',
          error: 'clobbered the file',
          fix: 'read first',
        },
      ],
    });
    expect(prompt).toContain('clobbered the file');
    expect(prompt).toContain('read first');
  });

  it('renders good examples too', () => {
    const prompt = promptFor({
      ...RECORD,
      goodExamples: [{ input: 'find the caller', call: 'grep -rn' }],
    });
    expect(prompt).toContain('grep -rn');
  });

  it('adds nothing when the record carries no examples', () => {
    // Guards the guard: an unconditional block would put empty headings into
    // every persona prompt, which is a per-step cost for nothing.
    const prompt = promptFor(RECORD);
    expect(prompt).not.toContain('Good Examples');
    expect(prompt).not.toContain('Bad Examples');
  });

  it('keeps the execution rules, which the wrapper path does not have', () => {
    // The two paths compose different prompts on purpose; adding examples must
    // not have replaced what was already there.
    expect(promptFor(RECORD)).toContain('You are a coder.');
  });
});

describe('a specialist can reach an ingested library', () => {
  it('holds `knowledge` when it names it and a corpus is in scope', async () => {
    // Three ways this was unreachable: the tool was tagged `audience: 'main'`
    // so it was dropped on the worker surface every persona runs at; the
    // wrapper path passed no corpus handle so it was never built there either;
    // and `corpusScope` fenced something no dispatch could reach. The fence was
    // real and had nothing behind it.
    const corpus = { list: () => [], open: () => undefined, listIds: () => [] };
    const base = makeCtx(false, {
      stores: {
        specialists: {
          get: (id: string) => (id === SPECIALIST_ID ? { targetTools: ['knowledge'] } : undefined),
        },
      },
    } as never);
    const ctx = { ...base, knowledge: corpus } as unknown as AgentContext;
    const tools = await toolsOf(specialistDefinition, ctx, {
      specialistId: SPECIALIST_ID,
      task: 'x',
      slotId: 1,
      planStore: {},
    });
    expect(Object.keys(tools).sort()).toEqual(['knowledge', 'plan', 'think']);
  });

  it('holds no `knowledge` tool when no corpus handle is in scope', async () => {
    // Fail-closed by construction: the tool cannot exist unfenced, because it
    // cannot exist without the handle that carries the fence. That is what makes
    // widening the audience safe.
    expect(await registryFor({ targetTools: ['knowledge'] })).toEqual(['plan', 'think']);
  });
});

describe('a step-limited persona is a failure, not a quiet success', () => {
  const fmt = (text: string, stepLimitHit: boolean) =>
    specialistDefinition.formatResult(
      { text, steps: [] } as never,
      {} as never,
      {} as never,
      { stepLimitHit, steps: 12 } as never,
    ) as string;

  it('marks an empty step-limited run as an error', async () => {
    // It reached the parent as an ordinary string, so `detectResultFailure` saw
    // a success: the run registered as citable evidence, bumped this tool's
    // success count, and minted no `step_limit` — leaving that category's three
    // consumers silent.
    const out = fmt('', true);
    expect(out).toMatch(/^Error:/);
    const { detectResultFailure } = await import('../../../tool-result-shape.js');
    expect(detectResultFailure(out)).toBeTruthy();
  });

  it('leaves a step-limited run that produced real content alone', async () => {
    // Where `relabelStepLimit` draws the line on the wrapper path: the model may
    // have wrapped up on its last step, and calling that a failure throws the
    // work away.
    const out = fmt('Here is the refactor.', true);
    expect(out).not.toMatch(/^Error:/);
    expect(out).toContain('Here is the refactor.');
    const { detectResultFailure } = await import('../../../tool-result-shape.js');
    expect(detectResultFailure(out)).toBeFalsy();
  });

  it('leaves an ordinary empty run alone', async () => {
    // Guards the guard: an unconditional error would fail every run that simply
    // returned no text, which is not the same fact at all.
    expect(fmt('', false)).not.toMatch(/^Error:/);
  });
});
