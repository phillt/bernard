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
