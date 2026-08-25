import { describe, it, expect } from 'vitest';
import { definitions, registerBuiltinDefinitions } from '../index.js';
import { mcpDelegateDefinition } from '../mcp-delegate.js';
import { mainAgentDefinition } from '../main.js';
import { resolveToolSurface } from '../tool-surface.js';
import type { AgentDefinition } from '../types.js';
import { makeCtx, toolsOf, CREATE_TOOLS_DEFINITIONS, inputFor } from './_mcp-delegation-fixture.js';

/**
 * #315 / #322: the built-in registry scope and the MCP bag are resolved once by
 * `runDefinition`, not re-decided by each definition. Two things need pinning.
 *
 * 1. What each definition RESOLVES TO. The derivation is `historyMode`-based
 *    with one declared opt-out; if someone flips a `historyMode` or removes
 *    `tool-wrapper`'s declaration, the effect must be a red test rather than a
 *    silent ~3.7k-token-per-dispatch regression (or, for `tool-wrapper`, three
 *    bundled specialists losing their target tools).
 *
 * 2. That the definitions actually CONSUME the resolved value. A definition may
 *    ignore its third parameter and still typecheck — TypeScript accepts a
 *    function with fewer parameters — so the honest guard is behavioural.
 */

/**
 * Enumerated from the registry, not hand-listed: a hand-list would silently
 * skip a newly registered definition, which is the exact drift this file exists
 * to catch. `mcp-delegate` is appended because it is dispatched directly by
 * `dispatchServerDelegate` rather than registered.
 */
function allDefinitions(): Array<{ name: string; def: AgentDefinition<any, any> }> {
  registerBuiltinDefinitions();
  return [
    ...definitions.ids().map((id) => ({ name: id, def: definitions.get(id) })),
    { name: 'mcp-delegate', def: mcpDelegateDefinition },
  ];
}

/**
 * The surface each definition is expected to resolve to. `main` is the only
 * persistent-history definition, so it is the only `'full'` by derivation;
 * `tool-wrapper` is the only one that declares its way back to `'full'`.
 *
 * `pac-planner`, `pac-critic` and `mcp-delegate` never consult the value (they
 * build hand-picked registries or return `input.childTools`), so their entries
 * pin the derivation only, not an observable effect.
 */
const EXPECTED: Record<string, 'full' | 'worker'> = {
  main: 'full',
  'tool-wrapper': 'full',
  sub: 'worker',
  task: 'worker',
  specialist: 'worker',
  cron: 'worker',
  'pac-planner': 'worker',
  'pac-actor': 'worker',
  'pac-critic': 'worker',
  'mcp-delegate': 'worker',
};

describe('tool-surface resolution (#315, #322)', () => {
  it('every registered definition has a pinned expectation', () => {
    // Guards the guard: a new definition must be given an expected value here
    // rather than silently escaping the table below.
    expect(
      allDefinitions()
        .map((d) => d.name)
        .sort(),
    ).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(allDefinitions())('$name resolves to the expected built-in surface', ({ name, def }) => {
    expect(resolveToolSurface(makeCtx(true), def).surface).toBe(EXPECTED[name]);
  });

  it('tool-wrapper is the only definition that opts out of the historyMode derivation', () => {
    // If a second opt-out appears, it needs the same scrutiny this one got:
    // the default is the cheap surface precisely so opting out is deliberate.
    expect(
      allDefinitions()
        .filter(({ def }) => def.toolSurface !== undefined)
        .map(({ name }) => name),
    ).toEqual(['tool-wrapper']);
  });
});

/**
 * The definitions that assemble a registry from `createTools` must PASS the
 * resolved surface through rather than hardcoding one. Asserting that no
 * main-audience tool survives is what catches a definition that quietly ignores
 * the parameter — the failure mode the old per-call-site `{ surface: 'worker' }`
 * had no way to detect.
 */
describe('definitions consume the resolved surface (#322)', () => {
  it.each(CREATE_TOOLS_DEFINITIONS)(
    '$name carries no main-audience tool',
    async ({ name, def }) => {
      const names = Object.keys(await toolsOf(def, makeCtx(true), inputFor(name)));
      for (const mainOnly of ['routine', 'lineup_edit', 'specialist', 'mcp_config', 'cron']) {
        expect(names, name).not.toContain(mainOnly);
      }
    },
  );

  it('main carries the full surface — the config + scheduling tools stay', async () => {
    const names = Object.keys(
      await toolsOf(mainAgentDefinition, makeCtx(true), { planStore: {}, systemPrompt: '' }),
    );
    for (const mainOnly of ['routine', 'lineup_edit', 'specialist', 'mcp_config', 'cron']) {
      expect(names).toContain(mainOnly);
    }
  });
});

/**
 * #315's "gap closed for free": `cron` used to take MCP from `input.mcpTools`,
 * making it a sixth definition that never participated in per-server delegation
 * — so an MCP-heavy cron job re-billed every server's full schema set on every
 * step. There is no second path any more; this pins that.
 */
describe('cron participates in MCP delegation (#315)', () => {
  const cronDefinition = (() => {
    registerBuiltinDefinitions();
    return definitions.get('cron');
  })();
  const cronInput = {
    job: { id: 'j1', name: 't', prompt: 'noop', enabled: true },
    runId: 'r1',
    steps: [],
    store: { getJob: () => undefined },
    notesStore: { read: () => ({ entries: [] }), append: () => ({ total: 0 }) },
    log: () => {},
    serverNames: ['google', 'slack'],
  };

  it('with delegation ON, carries delegate_<server> tools and no raw MCP schemas', async () => {
    const names = Object.keys(await toolsOf(cronDefinition, makeCtx(true), cronInput));
    expect(names.filter((n) => n.startsWith('delegate_')).sort()).toEqual([
      'delegate_google',
      'delegate_slack',
    ]);
    expect(names).not.toContain('google__gmail_list');
  });

  it('with delegation OFF, carries the raw MCP tools', async () => {
    const names = Object.keys(await toolsOf(cronDefinition, makeCtx(false), cronInput));
    expect(names).toContain('google__gmail_list');
    expect(names.filter((n) => n.startsWith('delegate_'))).toEqual([]);
  });
});
