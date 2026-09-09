import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateText: vi.fn() };
});

vi.mock('../../../providers/index.js', () => ({
  getModelForConfig: vi.fn(() => 'mock-model'),
  getProviderOptionsForConfig: vi.fn(() => undefined),
}));

vi.mock('../../../tool-call-repair.js', () => ({
  makeRepairHook: vi.fn(() => vi.fn()),
}));

import { generateText } from 'ai';
import { MemoryStore } from '../../../memory.js';
import { RAGStore } from '../../../rag.js';
import { declaredScope, resolveDispatchProfile } from '../dispatch-profile.js';
import { scopeContext, withUsageRecorder } from '../../context.js';
import { runDefinition } from '../run.js';
import { makeTestContext } from '../../../__tests__/agent-context.js';
import { NormalStrategy } from '../../strategies/normal.js';
import { createMemoryTool, createScratchTool } from '../../../tools/memory.js';
import { definitions, registerBuiltinDefinitions } from '../index.js';
import { mcpDelegateDefinition } from '../mcp-delegate.js';
import { makeCtx, toolsOf } from './_mcp-delegation-fixture.js';
import type { AgentContext } from '../../context.js';
import type { AgentDefinition } from '../types.js';
import type { BernardConfig } from '../../../config.js';
import type { Specialist } from '../../../specialists.js';

/**
 * The knowledge fence, end to end (#511).
 *
 * A **unit test, not an eval**, deliberately: "cannot reach what it was not
 * granted" is a property, not a measurement, and a measurement of it would
 * report a number where the only acceptable answer is "never".
 *
 * The design under test is one line — `runDefinition` shadows its own `ctx`
 * with a scoped view — so the assertions that matter are the ones that catch a
 * path AROUND that line: a definition that builds its own store, or a caller
 * that assembles tools before the runner sees the input.
 */

const SENTINEL = 'SENTINEL-OUT-OF-SCOPE-CONTENT';

function seededMemory(): MemoryStore {
  const store = new MemoryStore();
  store.writeMemory('proj-brief', 'the granted note');
  store.writeMemory('secrets', SENTINEL);
  store.writeScratch('proj-scratch', 'granted scratch');
  store.writeScratch('secrets', SENTINEL);
  return store;
}

// ── declaredScope: the one place the module's fallback rule inverts ──────────

describe('declaredScope', () => {
  it('is absent when the record declares nothing, which is unscoped', () => {
    expect(declaredScope({})).toEqual({});
  });

  /**
   * The inversion, and the assertion that would catch someone "fixing" it to
   * match `stepRatio`'s. For a step count an invalid value falls back to the
   * site default and costs nothing. For a fence the fallback IS full access,
   * so a shape error must resolve to deny-all.
   */
  it('resolves a non-array to deny-all rather than to unscoped', () => {
    expect(declaredScope({ memoryScope: 'proj-*' })).toEqual({ memoryScope: [] });
    expect(declaredScope({ knowledgeScope: 42 })).toEqual({ knowledgeScope: [] });
  });

  it('drops invalid entries and keeps the rest, because dropping already narrows', () => {
    expect(declaredScope({ memoryScope: ['proj-*', 'a b', 7, '*'] })).toEqual({
      memoryScope: ['proj-*'],
    });
  });

  it('validates a knowledge scope against the real domain registry', () => {
    expect(declaredScope({ knowledgeScope: ['general', 'not-a-domain'] })).toEqual({
      knowledgeScope: ['general'],
    });
  });

  // `[]` is a coherent posture — "verify against the task and nothing else" —
  // which is why it is honoured rather than treated as "declared nothing". That
  // diverges from `targetToolsScopeError`, where "no tools" is incoherent.
  it('honours an explicitly empty scope', () => {
    expect(declaredScope({ memoryScope: [] })).toEqual({ memoryScope: [] });
  });

  it('records what it rejected, so a broken record is a bug report not a silence', () => {
    const rejected: Record<string, unknown> = {};
    declaredScope({ memoryScope: ['ok', 'not ok'] }, rejected);
    expect(rejected.memoryScope).toEqual(['not ok']);
  });
});

// ── scopeContext ────────────────────────────────────────────────────────────

describe('scopeContext', () => {
  function ctxWith(memory: MemoryStore, rag?: RAGStore): AgentContext {
    return { stores: { memory }, rag } as unknown as AgentContext;
  }

  /**
   * Object identity on the unscoped path is not a micro-optimisation: `main`
   * takes it on every turn, and a fresh context object per dispatch would
   * change what `createTools` is handed and so risk the byte-stable tool block
   * the prompt cache depends on (#269).
   */
  it('returns the same object when nothing is declared', () => {
    const ctx = ctxWith(new MemoryStore());
    expect(scopeContext(ctx, {})).toBe(ctx);
    expect(scopeContext(ctx, { stepRatio: 0.5 })).toBe(ctx);
  });

  it('narrows the memory store without touching the rest of the context', () => {
    const ctx = ctxWith(seededMemory());
    const scoped = scopeContext(ctx, { memoryScope: ['proj-*'] });
    expect(scoped).not.toBe(ctx);
    expect(scoped.stores.memory.readMemory('secrets')).toBeNull();
    expect(scoped.stores.memory.readMemory('proj-brief')).toContain('granted');
    // The parent is untouched — this is a view, not a mutation.
    expect(ctx.stores.memory.readMemory('secrets')).toContain(SENTINEL);
  });

  it('narrows RAG independently of memory', () => {
    const ctx = ctxWith(new MemoryStore(), new RAGStore());
    // A knowledge-only fence must not reach for the memory store, and a
    // memory-only fence must leave `rag` alone — asserted by identity, which is
    // what the two independent guards in `scopeContext` buy.
    const knowledgeOnly = scopeContext(ctx, { knowledgeScope: ['general'] });
    expect(knowledgeOnly.rag).not.toBe(ctx.rag);
    expect(knowledgeOnly.stores).toBe(ctx.stores);
    const memoryOnly = scopeContext(ctx, { memoryScope: ['x'] });
    expect(memoryOnly.rag).toBe(ctx.rag);
    expect(memoryOnly.stores.memory).not.toBe(ctx.stores.memory);
  });

  it('is idempotent, which is what lets two readers apply the same scope', () => {
    // `dispatchToolWrapper` and `apps/dispatch.ts` both scope before assembling
    // child tools, and `runDefinition` re-derives afterwards.
    const ctx = ctxWith(seededMemory());
    const once = scopeContext(ctx, { memoryScope: ['proj-*'] });
    const twice = scopeContext(once, { memoryScope: ['proj-*'] });
    expect(twice.stores.memory.readMemory('proj-brief')).toContain('the granted note');
    expect(twice.stores.memory.readMemory('secrets')).toBeNull();
  });
});

// ── the resolver reads the record ───────────────────────────────────────────

describe('resolveDispatchProfile carries the scope', () => {
  function ctxWithRecord(record: Partial<Specialist>): AgentContext {
    const full = { id: 'spec', name: 'S', description: '', systemPrompt: '', ...record };
    return {
      config: { maxSteps: 20 },
      stores: { specialists: { get: (id: string) => (id === 'spec' ? full : undefined) } },
    } as unknown as AgentContext;
  }
  const def = { id: 'specialist', recordId: () => 'spec' } as unknown as AgentDefinition<
    unknown,
    unknown
  >;

  it('reads both axes off the record', () => {
    const { profile } = resolveDispatchProfile(
      ctxWithRecord({ memoryScope: ['proj-*'], knowledgeScope: ['general'] }),
      def,
      {},
    );
    expect(profile.memoryScope).toEqual(['proj-*']);
    expect(profile.knowledgeScope).toEqual(['general']);
  });

  it('leaves a record that declares nothing unscoped', () => {
    const { profile } = resolveDispatchProfile(ctxWithRecord({}), def, {});
    expect(profile.memoryScope).toBeUndefined();
    expect(profile.knowledgeScope).toBeUndefined();
  });
});

// ── the fence, through the real runner ──────────────────────────────────────

function makeConfig(): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    maxSteps: 20,
    tokenWindow: 0,
    shellTimeout: 30000,
    ragEnabled: false,
    coordinatorMode: 'off',
    conciseMode: true,
    anthropicApiKey: 'sk-test',
    customProviders: {},
  } as BernardConfig;
}

describe('runDefinition fences the dispatch it runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'done',
      steps: [],
      response: { messages: [] },
      finishReason: 'stop',
    });
  });

  function scopedCtx(memory: MemoryStore): AgentContext {
    return makeTestContext({
      config: makeConfig(),
      stores: {
        memory,
        specialists: {
          get: () => ({
            id: 'spec',
            name: 'S',
            description: '',
            systemPrompt: '',
            memoryScope: ['proj-*'],
          }),
        },
      } as never,
    });
  }

  function fenced(): AgentDefinition<{ specialistId: string }, string> {
    return {
      id: 'fake',
      historyMode: 'ephemeral',
      site: 'main',
      recordId: () => 'spec',
      systemPrompt: () => 'SYS',
      // Reads `ctx.stores.memory` — the field the shadow binding replaces. A
      // definition that built its own store here would escape the fence, which
      // is what the sweep at the bottom of this file checks for real.
      tools: (ctx) => ({
        memory: createMemoryTool(ctx.stores.memory) as never,
        scratch: createScratchTool(ctx.stores.memory) as never,
      }),
      strategy: () => new NormalStrategy(),
      stepBudget: () => 5,
      buildUserMessage: () => ({ role: 'user', content: 'go' }),
      hooks: () => [],
      repairLabel: 'main',
    } as unknown as AgentDefinition<{ specialistId: string }, string>;
  }

  /**
   * The canary, and the reason it asserts on the WHOLE serialized request
   * rather than on named channels: a two-halved fence's real failure mode is a
   * leak through a channel nobody thought to enumerate. Naming the channels
   * would only ever catch the ones already known about.
   */
  it('no out-of-scope content appears anywhere in the request', async () => {
    await runDefinition(scopedCtx(seededMemory()), fenced(), { specialistId: 'spec' });
    const [args] = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const wire = JSON.stringify({ system: args.system, messages: args.messages });
    expect(wire).not.toContain(SENTINEL);
    // …and the granted half really did travel, or the assertion above passes
    // for the trivial reason that nothing was rendered at all.
    expect(wire).toContain('the granted note');
  });

  it('the memory tool the model was handed cannot read outside the fence', async () => {
    await runDefinition(scopedCtx(seededMemory()), fenced(), { specialistId: 'spec' });
    const [args] = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const read = async (key: string) =>
      JSON.stringify(await args.tools.memory.execute({ action: 'read', key }, {}));
    expect(await read('secrets')).not.toContain(SENTINEL);
    expect(await read('proj-brief')).toContain('the granted note');
    const list = JSON.stringify(await args.tools.memory.execute({ action: 'list' }, {}));
    expect(list).not.toContain('secrets');
  });

  /**
   * Scratch is SHARED, not blanked — the assertion that catches a refactor to
   * `new MemoryStore(scopeDir)`, which would render `<scratch_notes>` empty and
   * make `scratch.read` return nothing with no error anywhere.
   */
  it('scratch still sees the session notes it is allowed to see', async () => {
    await runDefinition(scopedCtx(seededMemory()), fenced(), { specialistId: 'spec' });
    const [args] = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const out = JSON.stringify(
      await args.tools.scratch.execute({ action: 'read', key: 'proj-scratch' }, {}),
    );
    expect(out).toContain('granted scratch');
  });

  it('an out-of-scope write is refused as a tool error, not as a thrown dispatch', async () => {
    await runDefinition(scopedCtx(seededMemory()), fenced(), { specialistId: 'spec' });
    const [args] = (generateText as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const res = await args.tools.memory.execute(
      { action: 'write', key: 'secrets', content: 'x' },
      {},
    );
    expect(JSON.stringify(res)).toMatch(/outside this agent's scope/);
  });

  /**
   * A caller-applied fence must reach the record too.
   *
   * `runHeadless` scopes cron from a `CronJob`, which is not a specialist
   * record — so `cronDefinition` has no `recordId`, `resolveDispatchProfile`
   * returns the empty profile, and without `declaredScope` the one field that
   * exists to distinguish a fence from a bad retrieval would read "unscoped"
   * for exactly the unattended dispatch where the confusion costs most.
   */
  it('records a fence the CALLER applied, which no record declares', async () => {
    const { clearDispatchContexts, enableDispatchContextRecording, getDispatchContexts } =
      await import('../../../dispatch-context-history.js');
    clearDispatchContexts();
    enableDispatchContextRecording();
    const ctx = scopedCtx(seededMemory());
    // A definition with no `recordId` — cron's shape.
    const def = { ...fenced(), recordId: undefined } as never;
    await runDefinition(ctx, def, { specialistId: 'spec' } as never, {
      declaredScope: { knowledgeScope: ['general'] },
    });
    const row = getDispatchContexts().at(-1);
    expect(row?.knowledgeScope).toEqual(['general']);
    expect(row?.memoryScope).toBeUndefined();
  });

  /**
   * The WIRING, not the helper in isolation.
   *
   * The three cases above all pass with `runDefinition` never calling it —
   * which is exactly how a plumbing hop goes missing. This asserts on what the
   * definition's `tools()` is actually handed.
   */
  it('reaches the registry a dispatch builds', async () => {
    let seen: unknown;
    const def = {
      ...fenced(),
      recordId: undefined,
      tools: (c: AgentContext) => {
        seen = c.toolOptions.onUsage;
        return {};
      },
    } as never;
    const ctx = { ...scopedCtx(seededMemory()), statsTarget: {} } as unknown as AgentContext;
    await runDefinition(ctx, def, { specialistId: 'spec' } as never);
    expect(typeof seen).toBe('function');
  });

  it('records the fence it ran under, so a short memory list is explicable', async () => {
    const { clearDispatchContexts, enableDispatchContextRecording, getDispatchContexts } =
      await import('../../../dispatch-context-history.js');
    clearDispatchContexts();
    enableDispatchContextRecording();
    await runDefinition(scopedCtx(seededMemory()), fenced(), { specialistId: 'spec' });
    expect(getDispatchContexts().at(-1)?.memoryScope).toEqual(['proj-*']);
  });
});

// ── the behavioural sweep ───────────────────────────────────────────────────

/**
 * Every registered definition, handed an already-scoped context.
 *
 * This is the assertion that catches a definition constructing its own
 * `MemoryStore` instead of reading `ctx.stores.memory` — the one way the shadow
 * binding can be routed around from inside the framework. `pac-critic` is the
 * case that proves the fence is in the right place: it returns
 * `contextInputs: () => null` and builds `createReadOnlyMemoryTool` in its own
 * `tools()`, so it is read-only AND scope-filtered, the two wrappers composing
 * because one fences actions and the other fences rows.
 */
describe('every definition honours a scoped context', () => {
  function allDefinitions(): Array<{ name: string; def: AgentDefinition<any, any> }> {
    registerBuiltinDefinitions();
    return [
      ...definitions.ids().map((id) => ({ name: id, def: definitions.get(id) })),
      { name: 'mcp-delegate', def: mcpDelegateDefinition },
    ] as Array<{ name: string; def: AgentDefinition<any, any> }>;
  }

  const INPUT = {
    task: 'go',
    specialistId: 'spec',
    childTools: {},
    job: { id: 'j', prompt: 'p' },
    serverName: 'google',
  };

  /** Reads `secrets` through whichever of the two memory tools a definition built. */
  async function outOfScopeReads(def: AgentDefinition<any, any>): Promise<string[]> {
    const memory = seededMemory().scoped(['proj-*']);
    const ctx = makeCtx(false, { stores: { memory } as never });
    const tools = await toolsOf(def, ctx, INPUT);
    const out: string[] = [];
    for (const name of ['memory', 'scratch']) {
      const tool = tools[name] as { execute?: (a: unknown, b: unknown) => Promise<unknown> };
      if (!tool?.execute) continue;
      out.push(JSON.stringify(await tool.execute({ action: 'read', key: 'secrets' }, {})));
    }
    return out;
  }

  // Guards the guard. Every assertion below is `not.toContain`, which passes
  // trivially when a definition exposes no memory tool at all — so if the tool
  // names ever change, or `createTools` stops building them, the sweep would go
  // green while testing nothing.
  it('the sweep actually reaches memory tools', async () => {
    const counts = await Promise.all(
      allDefinitions().map(async (d) => (await outOfScopeReads(d.def)).length),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it.each(allDefinitions())(
    '$name exposes no memory tool that can read outside the fence',
    async ({ def }) => {
      for (const out of await outOfScopeReads(def)) expect(out).not.toContain(SENTINEL);
    },
  );
});

/**
 * A tool that calls a model can report what it cost (#373).
 *
 * `ToolExecOptions` carries no usage handle, so the spend a tool makes from
 * inside its own `execute` had nowhere to go. This lives on `ToolOptions` — the
 * bag that already exists for per-dispatch callbacks — rather than on
 * `CreateToolsOptions`, which is a decision about which built-in SURFACE a
 * dispatch receives.
 *
 * Pinned because nothing asserted the WIRING: the recorder was tested at
 * `checkContradiction`, and the path from a dispatch to the memory tool that
 * calls it was three plumbing hops with no test between them.
 */
describe('withUsageRecorder', () => {
  function ctxWith(over: Partial<AgentContext>): AgentContext {
    return { toolOptions: {}, ...over } as AgentContext;
  }

  it('is the identity when there is nothing to record to', () => {
    const ctx = ctxWith({});
    expect(withUsageRecorder(ctx)).toBe(ctx);
  });

  it('gives the tools a recorder when the dispatch has a stats target', () => {
    const ctx = withUsageRecorder(ctxWith({ statsTarget: {} as never }));
    expect(typeof ctx.toolOptions.onUsage).toBe('function');
  });

  // Fail-closed by omission, the doctrine `ToolOptions` already documents:
  // absent, the spend is unrecorded rather than unmade.
  it('never replaces one a caller already supplied', () => {
    const onUsage = () => {};
    const ctx = withUsageRecorder(
      ctxWith({ statsTarget: {} as never, toolOptions: { onUsage } as never }),
    );
    expect(ctx.toolOptions.onUsage).toBe(onUsage);
  });
});

/**
 * The dispatch's own identity reaches both stores that are keyed on it (#501).
 *
 * `resolveDispatchProfile` returns the record id and `runDefinition` hands it to
 * `scopeContext` (which owns the memory view) and to `resolveRetrieval` (which
 * opens that specialist's own RAG store). Neither wiring had a test: dropping
 * the argument at either call site left the whole 5,800-test suite green while
 * a specialist silently wrote into the shared memory pool and retrieved from a
 * store it no longer had.
 */
describe('runDefinition hands a record-backed dispatch its own identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'done',
      steps: [],
      response: { messages: [] },
      finishReason: 'stop',
    });
  });

  function harness(recordId?: () => string) {
    const memory: Record<string, ReturnType<typeof vi.fn>> = {};
    Object.assign(memory, {
      asOwner: vi.fn(() => memory),
      scoped: vi.fn(() => memory),
      getAllMemoryContents: vi.fn(() => new Map()),
      getAllScratchContents: vi.fn(() => new Map()),
      listMemory: vi.fn(() => []),
    });
    const ragForOwner = vi.fn(() => ({ search: vi.fn(async () => []) }));
    // The memory double stays LOCAL and spy-bearing: this suite asserts that
    // `asOwner` and `scoped` are called, which is the one thing the shared
    // double (plain functions, so no counts leak between suites) cannot do.
    // Only the surrounding context comes from the shared builder (#318).
    const ctx = makeTestContext({
      config: makeConfig(),
      stores: { memory, specialists: { get: () => ({ id: 'spec', name: 'S' }) } } as never,
      rag: { search: vi.fn(async () => []) } as never,
      ragForOwner,
    } as never);
    const def = {
      id: 'fake',
      historyMode: 'ephemeral',
      site: 'main',
      ...(recordId ? { recordId } : {}),
      retrievalQuery: (i: { task: string }) => i.task,
      systemPrompt: () => 'SYS',
      tools: () => ({}),
      strategy: () => new NormalStrategy(),
      stepBudget: () => 5,
      buildUserMessage: () => ({ role: 'user', content: 'go' }),
      hooks: () => [],
      repairLabel: 'main',
    } as unknown as AgentDefinition<{ task: string }, string>;
    return { ctx, def, memory, ragForOwner };
  }

  it('owns the memory view and opens the matching RAG store', async () => {
    const { ctx, def, memory, ragForOwner } = harness(() => 'spec');
    await runDefinition(ctx, def, { task: 'do it' });
    expect(memory.asOwner).toHaveBeenCalledWith('spec');
    expect(ragForOwner).toHaveBeenCalledWith('spec');
  });

  it('does neither for a definition that names no record', async () => {
    // Guards the guard: `main`, `sub`, `task`, `cron` and the PAC phases all
    // run as the user, and must keep the shared stores by identity.
    const { ctx, def, memory, ragForOwner } = harness();
    await runDefinition(ctx, def, { task: 'do it' });
    expect(memory.asOwner).not.toHaveBeenCalled();
    expect(ragForOwner).not.toHaveBeenCalled();
  });
});
