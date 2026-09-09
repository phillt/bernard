import { makePolicyInput } from '../policy/test-helpers.js';
import type { AgentContext } from '../framework/context.js';

/**
 * One `AgentContext` for tests that cannot use the real assembler (#318).
 *
 * **Twenty-two files hand-built one**, and the duplication has broken twice on
 * *disjoint* file sets: `asOwner` (#501) broke `run.test.ts` and
 * `tool-wrapper-run.test.ts`; `scoped` (#511) broke `fence.test.ts` and
 * `dispatch-scope.test.ts`. No file was fixed twice, which is why neither repair
 * converged on a shared double and why the third narrowing field would break a
 * third set nobody has met yet.
 *
 * **The precedent this copies is `assembleContext`, not a new invention.** Four
 * suites already call the production assembler with a `{ stores: { memory } }`
 * override and need no cast at all — that is the right answer whenever a test
 * can afford real stores on a real `BERNARD_HOME`. This is for the ones that
 * cannot: suites that mock `node:fs`, or that need a store to observe rather
 * than to work.
 *
 * Deliberately NOT adopted by the `{} as AgentContext` one-liners: those are
 * honest assertions that the context is never touched, and giving them a
 * populated object would hide a dispatch that started reading one.
 */

/**
 * A memory store double with the WHOLE narrowing surface.
 *
 * The single thing that makes the next narrowing field a one-file edit: both
 * `scoped` and `asOwner` return the view, so a double is never the reason a
 * fence test fails. Returning `this` rather than a fresh object is also what
 * the real store does for a no-op narrowing, and it keeps `toBe` identity
 * assertions meaningful.
 *
 * Every method is a plain function rather than a `vi.fn()`: a shared spy would
 * carry call counts across the suites that share this module, and a test that
 * wants to observe a call replaces the method it cares about.
 */
export function makeMemoryDouble(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  Object.assign(store, {
    asOwner: () => store,
    scoped: () => store,
    listMemory: () => [],
    listAllMemory: () => [],
    listAllByOwner: () => new Map(),
    listScratch: () => [],
    readMemory: () => null,
    readRecord: () => null,
    writeMemory: () => {},
    getAllMemoryContents: () => new Map(),
    getAllScratchContents: () => new Map(),
    readScratch: () => null,
    writeScratch: () => {},
    deleteScratch: () => false,
    clearScratch: () => {},
    // `main.ts` reaches for this when building the tool-profiles prompt.
    list: () => [],
  });
  return store;
}

/**
 * The six stores `AgentContextStores` declares.
 *
 * `specialists.get` returns `undefined` for an unknown id, which the `Proxy`
 * idiom this replaces could not: `new Proxy({}, { get: () => () => [] })`
 * answers every property with a function returning `[]`, so `get(anyId)` is a
 * **truthy empty array** and every `if (record)` guard takes the "found" branch
 * for ids that were never seeded. `specialist.target-tools.test.ts` documents
 * the consequence — its cases "would stay green with the filter deleted".
 */
export function makeStores(): Record<string, unknown> {
  return {
    memory: makeMemoryDouble(),
    routines: { list: () => [], get: () => undefined },
    specialists: { list: () => [], getSummaries: () => [], get: () => undefined },
    candidates: { list: () => [], listPending: () => [] },
    correction: { list: () => [], listPending: () => [], enqueue: () => undefined },
    toolProfiles: { list: () => [] },
  };
}

/**
 * A context, with `stores` merged one level deeper than everything else.
 *
 * The shallow spread was a trap two test files had already discovered
 * independently and hand-rolled around: overriding ONE store replaced the bag
 * wholesale, dropping the other five and silently changing what `createTools`
 * builds. Every other field stays a wholesale replace, which is what a test
 * asserting on a deliberately incomplete `mcp` needs.
 *
 * The config comes from `makePolicyInput`, the repo's one cast-free
 * `BernardConfig` builder, so a new config field surfaces as a compile error in
 * one place rather than defaulting silently in each of the three suites that
 * hand-write a thirty-line literal.
 */
export function makeTestContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const stores = makeStores();
  return {
    config: makePolicyInput().config,
    toolOptions: {},
    mcp: {
      tools: {},
      serverNames: [],
      serverTools: {},
      // Both required on `AgentContextMCP`, and `run.test.ts` omitted them —
      // the shape of context a real dispatch can never be handed.
      resolveAlias: () => null,
    },
    stores,
    provenance: undefined,
    verification: { record: () => {} },
    policyDecision: undefined,
    ...overrides,
    ...(overrides.stores ? { stores: { ...stores, ...(overrides.stores as object) } } : {}),
  } as unknown as AgentContext;
}
