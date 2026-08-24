import { describe, it, expect } from 'vitest';
import { cronDefinition } from '../cron.js';
import { mainAgentDefinition } from '../main.js';
import { mcpDelegateDefinition } from '../mcp-delegate.js';
import { pacActorDefinition } from '../pac-actor.js';
import { pacCriticDefinition } from '../pac-critic.js';
import { pacPlannerDefinition } from '../pac-planner.js';
import { specialistDefinition } from '../specialist.js';
import { subAgentDefinition } from '../sub.js';
import { taskDefinition } from '../task.js';
import { toolWrapperDefinition } from '../tool-wrapper.js';
import { resolveToolSurface } from '../tool-surface.js';
import type { AgentDefinition } from '../types.js';
import { makeCtx, toolsOf, DELEGATE_TOOLS, RAW_MCP_TOOLS } from './_mcp-delegation-fixture.js';
import { WORKER_EXCLUDED_TOOLS } from '../../../tools/index.js';

/**
 * #315 / #322: the built-in registry scope and the MCP bag are resolved once by
 * `runDefinition`, not re-decided by each definition. Two things need pinning.
 *
 * 1. What each definition RESOLVES TO. The derivation is `historyMode`-based
 *    with one declared opt-out; if someone adds a definition, flips a
 *    `historyMode`, or removes `tool-wrapper`'s declaration, the effect must be
 *    a red test rather than a silent ~3.7k-token-per-dispatch regression (or,
 *    for `tool-wrapper`, three bundled specialists losing their target tools).
 *
 * 2. That the definitions actually CONSUME the resolved value. A definition may
 *    ignore its third parameter and still typecheck — TypeScript accepts a
 *    function with fewer parameters — so the honest guard is behavioural.
 */

/** Every registered definition, plus `mcp-delegate` (dispatched, not registered). */
const ALL: ReadonlyArray<{ name: string; def: AgentDefinition<any, any> }> = [
  { name: 'main', def: mainAgentDefinition },
  { name: 'sub', def: subAgentDefinition },
  { name: 'task', def: taskDefinition },
  { name: 'specialist', def: specialistDefinition },
  { name: 'tool-wrapper', def: toolWrapperDefinition },
  { name: 'cron', def: cronDefinition },
  { name: 'pac-planner', def: pacPlannerDefinition },
  { name: 'pac-actor', def: pacActorDefinition },
  { name: 'pac-critic', def: pacCriticDefinition },
  { name: 'mcp-delegate', def: mcpDelegateDefinition },
];

/**
 * The surface each definition is expected to resolve to. `main` is the only
 * persistent-history definition, so it is the only `'full'` by derivation;
 * `tool-wrapper` is the only one that declares its way back to `'full'`.
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
  it.each(ALL)('$name resolves to the expected built-in surface', ({ name, def }) => {
    expect(resolveToolSurface(makeCtx(true), def).surface).toBe(EXPECTED[name]);
  });

  it('tool-wrapper is the only definition that opts out of the historyMode derivation', () => {
    // If a second opt-out appears, it needs the same scrutiny this one got:
    // the default is the cheap surface precisely so opting out is deliberate.
    expect(ALL.filter(({ def }) => def.toolSurface !== undefined).map(({ name }) => name)).toEqual([
      'tool-wrapper',
    ]);
  });

  it('every ephemeral definition without a declaration derives worker', () => {
    for (const { name, def } of ALL) {
      if (def.toolSurface !== undefined) continue;
      const expected = def.historyMode === 'ephemeral' ? 'worker' : 'full';
      expect(resolveToolSurface(makeCtx(true), def).surface, name).toBe(expected);
    }
  });
});

/**
 * The definitions that assemble a registry from `createTools` must PASS the
 * resolved surface through rather than hardcoding one. Asserting on the
 * excluded names is what catches a definition that quietly ignores the
 * parameter — the failure mode the old per-call-site `{ surface: 'worker' }`
 * had no way to detect.
 */
const CREATE_TOOLS_WORKERS: ReadonlyArray<{ name: string; def: AgentDefinition<any, any> }> = [
  { name: 'sub', def: subAgentDefinition },
  { name: 'task', def: taskDefinition },
  { name: 'specialist', def: specialistDefinition },
  { name: 'pac-actor', def: pacActorDefinition },
];

const inputFor = (name: string) => (name === 'specialist' ? { planStore: {} } : {});

describe('definitions consume the resolved surface (#322)', () => {
  it.each(CREATE_TOOLS_WORKERS)('$name carries no worker-excluded tool', async ({ name, def }) => {
    const names = Object.keys(await toolsOf(def, makeCtx(true), inputFor(name)));
    for (const excluded of WORKER_EXCLUDED_TOOLS) expect(names, name).not.toContain(excluded);
    expect(
      names.filter((n) => n.startsWith('cron')),
      name,
    ).toEqual([]);
  });

  it('main carries the full surface — the config + scheduling tools stay', async () => {
    const names = Object.keys(
      await toolsOf(mainAgentDefinition, makeCtx(true), { planStore: {}, systemPrompt: '' }),
    );
    for (const excluded of WORKER_EXCLUDED_TOOLS) expect(names).toContain(excluded);
    expect(names).toContain('cron');
  });
});

/**
 * #315's "gap closed for free": `cron` used to take MCP from `input.mcpTools`,
 * making it a sixth definition that never participated in per-server delegation
 * — so an MCP-heavy cron job re-billed every server's full schema set on every
 * step. There is no second path any more; this pins that.
 */
describe('cron participates in MCP delegation (#315)', () => {
  const cronInput = {
    job: { id: 'j1', name: 't', prompt: 'noop', enabled: true },
    runId: 'r1',
    steps: [],
    store: { getJob: () => undefined },
    notesStore: { read: () => ({ entries: [] }), append: () => ({ total: 0 }) },
    log: () => {},
    serverNames: ['google', 'slack'],
  };

  it('with delegation ON, carries delegate_<server> tools and no raw MCP schemas', () => {
    const ctx = makeCtx(true);
    const names = Object.keys(
      cronDefinition.tools(ctx, cronInput as never, resolveToolSurface(ctx, cronDefinition)),
    );
    expect(names.filter((n) => n.startsWith('delegate_')).sort()).toEqual([...DELEGATE_TOOLS]);
    for (const raw of RAW_MCP_TOOLS) expect(names).not.toContain(raw);
  });

  it('with delegation OFF, carries the raw MCP tools', () => {
    const ctx = makeCtx(false);
    const names = Object.keys(
      cronDefinition.tools(ctx, cronInput as never, resolveToolSurface(ctx, cronDefinition)),
    );
    for (const raw of RAW_MCP_TOOLS) expect(names).toContain(raw);
    expect(names.filter((n) => n.startsWith('delegate_'))).toEqual([]);
  });
});
