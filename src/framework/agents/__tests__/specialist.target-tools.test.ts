import { describe, it, expect, vi } from 'vitest';
import type { AgentContext } from '../../context.js';
import { specialistDefinition } from '../specialist.js';
import { makeCtx, toolsOf, RAW_MCP_TOOLS, DELEGATE_TOOLS } from './_mcp-delegation-fixture.js';

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
  const base = makeCtx(opts.delegation ?? false);
  return {
    ...base,
    ...(opts.coordinatorMode
      ? { config: { ...base.config, coordinatorMode: opts.coordinatorMode } }
      : {}),
    stores: {
      ...base.stores,
      specialists: { get: (id: string) => (id === SPECIALIST_ID ? record : undefined) },
    },
  } as unknown as AgentContext;
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
    // An EXACT set, not a `toContain` pair: the bug was extra tools, so the
    // assertion has to be able to fail on presence.
    expect(await registryFor({ targetTools: ['web_search'] })).toEqual([
      'plan',
      'think',
      'web_search',
    ]);
  });

  it('drops the tools the record does not name', async () => {
    const names = await registryFor({ targetTools: ['web_search'] });
    // Named individually as well, because these are the ones that made the
    // gap a scoping hole rather than a tidiness one.
    for (const withheld of ['shell', 'file_write', 'file_edit_lines', 'web_read', 'memory'])
      expect(names).not.toContain(withheld);
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
    const { debugLog } = await import('../../../logger.js');
    const spy = vi.spyOn(await import('../../../logger.js'), 'debugLog');
    void debugLog;
    await registryFor({ targetTools: [] });
    expect(spy.mock.calls.some(([tag]) => tag === 'specialist:target-tools-empty')).toBe(true);
    spy.mockRestore();
  });
});

describe('scoping and MCP delegation compose', () => {
  it('resolves a raw MCP name while delegation is ON', async () => {
    // The reason the lookup is the surface PLUS `ctx.mcp.tools`. With
    // delegation on, `surface.mcpTools` holds only `delegate_*` keys, so a
    // record naming a real MCP tool would resolve against nothing and be
    // dropped with only a debug line to show for it.
    expect(await registryFor({ targetTools: [RAW_MCP_TOOLS[0]] }, { delegation: true })).toEqual(
      [RAW_MCP_TOOLS[0], 'plan', 'think'].sort(),
    );
  });

  it('resolves a delegate name while delegation is ON', async () => {
    expect(await registryFor({ targetTools: [DELEGATE_TOOLS[0]] }, { delegation: true })).toEqual(
      [DELEGATE_TOOLS[0], 'plan', 'think'].sort(),
    );
  });

  it('resolves a raw MCP name while delegation is OFF', async () => {
    expect(await registryFor({ targetTools: [RAW_MCP_TOOLS[0]] }, { delegation: false })).toEqual(
      [RAW_MCP_TOOLS[0], 'plan', 'think'].sort(),
    );
  });

  it('carries no other server when one server tool is named', async () => {
    const names = await registryFor({ targetTools: [RAW_MCP_TOOLS[0]] }, { delegation: true });
    expect(names).not.toContain(RAW_MCP_TOOLS[2]);
    expect(names).not.toContain(DELEGATE_TOOLS[1]);
  });
});

describe('the reasoning tools sit outside the scope', () => {
  it('keeps plan and think even when the record names neither', async () => {
    // They are reasoning affordances, not capability grants: `plan` writes to a
    // dispatch-scoped `PlanStore`, `think` is a scratchpad. Neither touches the
    // world, no record anywhere names them, and `buildStrategy`'s enforcement
    // loop re-prompts the model to resolve plan steps — which it can only do by
    // calling `plan`. Filtering them out would break the strategy this same
    // definition declares.
    const names = await registryFor({ targetTools: ['web_search'] });
    expect(names).toContain('plan');
    expect(names).toContain('think');
  });

  it('keeps evaluate under coordinator mode, and still adds it under a scope', async () => {
    expect(await registryFor({ targetTools: ['web_search'] }, { coordinatorMode: 'on' })).toEqual([
      'evaluate',
      'plan',
      'think',
      'web_search',
    ]);
  });

  it('does not add evaluate when coordinator mode is off', async () => {
    expect(await registryFor({ targetTools: ['web_search'] })).not.toContain('evaluate');
  });
});
