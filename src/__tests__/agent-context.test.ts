import { describe, it, expect } from 'vitest';
import { makeTestContext, makeMemoryDouble, makeStores } from './agent-context.js';

/**
 * The properties that made the twenty-two hand-built contexts break (#318).
 *
 * Each of these is a shape a real dispatch can never be handed, and each has
 * cost a test-file repair at least once.
 */
describe('makeTestContext', () => {
  it('carries every field AgentContextMCP requires', () => {
    // `run.test.ts` omitted `serverTools` and `resolveAlias`, both required —
    // so it built a context `MCPManager.snapshot()` could not produce.
    const { mcp } = makeTestContext();
    expect(Object.keys(mcp).sort()).toEqual([
      'resolveAlias',
      'serverNames',
      'serverTools',
      'tools',
    ]);
    expect(mcp.resolveAlias('anything')).toBeNull();
  });

  it('merges stores one level deeper than everything else', () => {
    // The trap two files had independently hand-rolled around: a shallow spread
    // replaces the bag, dropping the other five stores and silently changing
    // what `createTools` builds.
    const ctx = makeTestContext({ stores: { memory: { marker: true } } as never });
    expect((ctx.stores.memory as unknown as { marker: boolean }).marker).toBe(true);
    expect(ctx.stores.toolProfiles).toBeDefined();
    expect(ctx.stores.specialists).toBeDefined();
  });

  it('replaces every other field wholesale', () => {
    // Guards the guard: a deep merge everywhere would defeat the suites that
    // assert on a deliberately incomplete `mcp`.
    const ctx = makeTestContext({ mcp: { tools: {} } as never });
    expect(Object.keys(ctx.mcp)).toEqual(['tools']);
  });

  it('answers `undefined` for a specialist nobody seeded', () => {
    // The Proxy this replaces — `new Proxy({}, { get: () => () => [] })` —
    // answered `get(anyId)` with a truthy EMPTY ARRAY, so every `if (record)`
    // guard took the "found" branch for ids that were never seeded, and every
    // field read off it was `undefined`, silently selecting each consumer's
    // back-compat path.
    expect(makeStores().specialists).toBeDefined();
    const store = makeStores().specialists as { get: (id: string) => unknown };
    expect(store.get('never-created')).toBeUndefined();
  });
});

describe('the memory double', () => {
  it('answers the whole narrowing surface', () => {
    // The single property that makes the next narrowing field a one-file edit.
    // `asOwner` (#501) broke `run.test.ts` and `tool-wrapper-run.test.ts`;
    // `scoped` (#511) broke `fence.test.ts` and `dispatch-scope.test.ts` — two
    // disjoint sets, so neither repair converged on a shared double.
    const m = makeMemoryDouble() as Record<string, () => unknown>;
    expect(m.asOwner()).toBe(m);
    expect(m.scoped()).toBe(m);
  });

  it('carries no shared spy state', () => {
    // Plain functions rather than `vi.fn()`: a spy on a module-level double
    // accumulates calls across every suite that imports it, and a suite that
    // wants to observe replaces the method it cares about.
    const m = makeMemoryDouble() as Record<string, unknown>;
    expect((m.asOwner as { mock?: unknown }).mock).toBeUndefined();
  });

  it('hands back a fresh double per call', () => {
    expect(makeMemoryDouble()).not.toBe(makeMemoryDouble());
  });
});
