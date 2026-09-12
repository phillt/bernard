import { createShellTool } from './shell.js';
import { createMemoryTool, createScratchTool } from './memory.js';
import { createDateTimeTool } from './datetime.js';
import { createTimeTools } from './time.js';
import { createWebReadTool } from './web.js';
import { createWebSearchTool } from './web-search.js';
import { createWaitTool } from './wait.js';
import { createFileTools } from './file.js';
import { createCiteTool } from './cite.js';
import { toolToAISDK } from '../framework/tools/adapter.js';
import type { ToolOptions } from './types.js';
import type { MemoryStore } from '../memory.js';
import type { RoutineStore } from '../routines.js';
import type { SpecialistStore } from '../specialists.js';
import type { KnowledgeCorpus } from '../knowledge/corpus.js';
import type { CandidateStoreReader } from '../specialist-candidates.js';
import type { BernardConfig } from '../config.js';
import type { ProvenanceStore } from '../provenance.js';

export type { ToolOptions } from './types.js';

/**
 * Who a tool is FOR (#253, #322) — an ownership question, not a write-ness one.
 *
 *  - `'main'` — Bernard's own configuration and scheduling controls (cron jobs,
 *    model lineups, specialist definitions, saved routines, MCP server config).
 *    They mutate durable user state that belongs to the main agent and the
 *    REPL. A dispatched worker exists to carry out one delegated task, not to
 *    reconfigure the assistant while doing it.
 *  - `'any'` — everything else, including writes a worker legitimately needs.
 *    `shell` and `file_edit_lines` are `'any'`: the field encodes ownership,
 *    not write-ness, which is why it is declared rather than derived from
 *    `kind`/`sideEffect`.
 */
export type ToolAudience = 'main' | 'any';

/**
 * One audience-homogeneous group of built-ins, constructed lazily.
 *
 * The laziness is load-bearing, not a style choice: these constructors touch
 * disk. `createRoutineTool(undefined)` falls back to `new RoutineStore()`
 * (mkdirSync on the user's real routines directory) and
 * `createSpecialistTool(undefined, …)` runs the bundled-specialist seed check —
 * on a dispatch that was deliberately handed no stores. A filtered-out thunk is
 * never invoked, so a worker never constructs them.
 *
 * That deferral is also what lets `audience` be the single source of truth.
 * Meta can't answer "may a worker have this?" because meta lives on a
 * constructed tool, and constructing is the thing we must avoid — so the
 * declaration has to sit beside the constructor. `audience` is REQUIRED on
 * every group, which makes omission a compile error rather than a silent
 * ~3.7k-token-per-dispatch leak. (An earlier form kept a `WORKER_EXCLUDED_TOOLS`
 * name list next to hand-written `worker ? {} : …` branches; the list drove
 * nothing, so "who owns this tool" was stated in three places and pinned by
 * tests. One table, checked by the compiler, replaces all three.)
 */
interface ToolGroup {
  audience: ToolAudience;
  /**
   * Async so a `main`-audience group can `await import()` its modules (#452).
   *
   * The laziness was always the design — "a filtered-out thunk is never
   * invoked" — but it was CONSTRUCTION-time laziness, and the static imports at
   * the top of this file happened first. Measured: a worker surface paid 167 ms
   * of module graph to build a registry in 0.20 ms, because `cron.ts` reaches
   * `cron/runner.ts` and from there every agent definition. Deferring the nine
   * `main`-only modules takes that to 76 ms.
   */
  make: () => Record<string, any> | Promise<Record<string, any>>;
}

/** Which built-in surface a dispatch receives. */
export interface CreateToolsOptions {
  /**
   * `'full'` (default) — every built-in, for the main agent.
   * `'worker'` — only groups declaring `audience: 'any'`.
   *
   * Resolved centrally by `runDefinition` (#315) rather than passed by hand at
   * each dispatch site; see `framework/agents/tool-surface.ts`.
   */
  surface?: 'full' | 'worker';
  /**
   * The knowledge libraries this dispatch may read (#516), already fenced.
   *
   * The tool is constructed only when this is present, which is the fail-closed
   * shape and has a precedent in the same table — the `cite` group builds
   * nothing without a provenance store. Because the fence lives ON the handle,
   * a tool that exists at all is a tool that is already scoped, and there is no
   * "fall back to an unscoped corpus" path a call site could reach for.
   *
   * It does not vary the tool BYTES — description and schema are constants — so
   * the prompt-cache rule is untouched; only the group's presence changes, and
   * that is session-stable exactly as `cite`'s is.
   */
  knowledge?: KnowledgeCorpus;
}

/**
 * Assembles the complete tool registry for the agent.
 *
 * @param options - Shell execution options (timeout, dangerous-command confirmation callback).
 * @param memoryStore - Persistent and scratch memory backing store.
 * @param mcpTools - Optional MCP-provided tools to merge into the registry.
 * @param config - Optional Bernard config, passed to specialist tool for provider/model validation.
 * @param opts - Surface selector (#253). Trailing options object rather than a
 *   ninth positional parameter, which would be unreadable at the call sites.
 * @returns A flat record of all available AI SDK tools keyed by tool name.
 */
export async function createTools(
  options: ToolOptions,
  memoryStore: MemoryStore,
  mcpTools?: Record<string, any>,
  routineStore?: RoutineStore,
  specialistStore?: SpecialistStore,
  candidateStore?: CandidateStoreReader,
  config?: BernardConfig,
  provenance?: ProvenanceStore,
  opts?: CreateToolsOptions,
): Promise<Record<string, any>> {
  // Pure function of its arguments: no ctx, no policy, no per-turn state. The
  // main agent's tool block must stay byte-identical across turns for the
  // prompt cache to hit, so this must never vary with anything turn-scoped.
  //
  // Group ORDER is the wire order of the tool block (later spreads win on a
  // name collision), so it must stay stable for the same reason.
  const groups: ToolGroup[] = [
    {
      audience: 'any',
      // Migrated to BernardTool (Phase B). `toolToAISDK` preserves model-facing
      // bytes via each tool's `serializeForModel`; the source BernardTool is
      // attached via `__bernardSource` so `augmentTools` can detect errors
      // deterministically from the envelope.
      make: () => ({
        shell: toolToAISDK(createShellTool(options)),
        memory: toolToAISDK(
          createMemoryTool(memoryStore, provenance, {
            ...(config ? { config } : {}),
            // `options?`, not `options.`: the parameter is typed required but
            // `meta-coverage.test.ts` constructs a registry with none, and this
            // is the first line in the group body to dereference it.
            ...(options?.askUser ? { askUser: options.askUser } : {}),
            ...(options?.onUsage ? { onUsage: options.onUsage } : {}),
          }),
        ),
        scratch: toolToAISDK(createScratchTool(memoryStore, provenance)),
        datetime: createDateTimeTool(),
      }),
    },
    {
      audience: 'main',
      make: async () => {
        const [
          { createRoutineTool },
          { createLineupTool },
          { createSpecialistTool },
          { createAppletTool },
        ] = await Promise.all([
          import('./routine.js'),
          import('./lineup.js'),
          import('./specialist.js'),
          import('./applet.js'),
        ]);
        return {
          routine: createRoutineTool(routineStore),
          lineup_edit: createLineupTool(config),
          specialist: createSpecialistTool(specialistStore, candidateStore, config),
          applet: createAppletTool(undefined, {
            requestConsent: options.requestPermissionConsent,
          }),
        };
      },
    },
    // Scheduling is a main-agent concern: a cron job manages its own run via
    // `cron_self_disable`, not by editing the schedule. The cron definition now
    // takes its built-ins from this registry under the worker surface (#333),
    // so these three are the tools it deliberately does NOT get.
    {
      audience: 'main',
      make: async () => {
        // One await for all three: `cron-logs` and `cron-notes` both import
        // `./cron.js`, so they share a module graph and resolve together.
        const [cron, logs, notes] = await Promise.all([
          import('./cron.js'),
          import('./cron-logs.js'),
          import('./cron-notes.js'),
        ]);
        return {
          ...cron.createCronTool(),
          ...logs.createCronLogTool(),
          ...notes.createCronNotesTool(),
        };
      },
    },
    // Watchers are a main-agent concern for the same reason cron is, and one
    // more: a watcher wakes the session that created it, and a dispatched worker
    // has no session to wake — one created inside a sub-agent would be orphaned
    // at birth. The poller that drives these lives in `<App>`.
    //
    // Byte-stable despite closing over the session: the tool's DESCRIPTION and
    // SCHEMA are constants, and only `sessionId` and the MCP bag it validates
    // against are captured — both session-scoped, neither turn-scoped. The
    // prompt-cache invariant this file opens with is about bytes, not closures.
    {
      audience: 'main',
      make: async () => {
        const { createWatcherTool } = await import('./watcher.js');
        // No `tools` getter: it defaults to the live manager's RAW bag.
        // Passing `mcpTools` was a bug — under delegation (the default) that
        // holds `delegate_<server>` and none of the real `server__tool` names,
        // so every MCP watcher was refused as "not available in this session"
        // while the poller, reading the raw bag, could have called it.
        return createWatcherTool();
      },
    },
    { audience: 'any', make: () => createTimeTools() },
    // `'main'`, not `'any'`, and that was measured: as `'any'` it added 839
    // bytes to the worker tool block — full-rate input on every step of every
    // sub-agent, PAC phase, cron run and MCP-delegate helper, none of which
    // build applets, since ephemeral dispatches are never prompt-cached.
    //
    // It costs the one consumer that matters nothing. `tool-wrapper` declares
    // `toolSurface: 'full'`, and the filter below only drops `'main'` groups on
    // a WORKER surface — so a dispatched wrapper still gets `docs` and can name
    // it in `targetTools`. An agent backing an applet action would need `docs`
    // in its manifest `toolAllowlist`; none does, and that is the change to
    // make if one ever should.
    {
      audience: 'main',
      make: async () => ({ docs: (await import('./docs.js')).createDocsTool() }),
    },
    // Constructed only when a corpus handle was supplied, so the tool cannot
    // exist without a fence — which is what makes `'any'` safe. It was `'main'`,
    // and that answered the wrong question: the audience field is about who
    // OWNS a decision, and a corpus is not Bernard's to own the way `mcp_config`
    // or `lineup_edit` are. The practical effect was that no specialist could
    // read an ingested library at all — dropped on the worker surface every
    // persona runs at, and unbuilt on the wrapper path, which passes no handle.
    // This side's own comment already conceded the point: "a dispatched research
    // worker is a plausible best consumer of a document corpus."
    {
      audience: 'any',
      make: async () =>
        opts?.knowledge
          ? { knowledge: (await import('./knowledge.js')).createKnowledgeTool(opts.knowledge) }
          : {},
    },
    {
      audience: 'main',
      make: async () => {
        const [{ createMCPConfigTool }, { createMCPAddUrlTool }, { createMCPVerifyTool }] =
          await Promise.all([
            import('./mcp.js'),
            import('./mcp-url.js'),
            import('./mcp-verify.js'),
          ]);
        return {
          mcp_config: createMCPConfigTool(),
          mcp_add_url: createMCPAddUrlTool(),
          mcp_verify: createMCPVerifyTool(),
        };
      },
    },
    {
      audience: 'any',
      make: () => ({
        web_read: createWebReadTool(provenance),
        web_search: createWebSearchTool(provenance),
        wait: createWaitTool(),
      }),
    },
    { audience: 'any', make: () => createFileTools(provenance) },
    { audience: 'any', make: () => (provenance ? { cite: createCiteTool(provenance) } : {}) },
  ];
  const worker = opts?.surface === 'worker';
  // Started together, merged in declaration order. The three async groups pull
  // unrelated module graphs, so awaiting them one at a time stacked their load
  // and compile time instead of bounding it by the slowest — a cold-start cost
  // on the first `tools()` of a process, since later `import()`s hit Node's
  // module cache. `Object.assign` in the original order is what preserves the
  // "last group wins a collision" rule the table depends on; only the START is
  // concurrent, never the merge.
  // Filtered FIRST, so a dropped group's thunk is never invoked — the property
  // the table exists for — and the survivors keep their relative order.
  const wanted = groups.filter((g) => !(worker && g.audience === 'main'));
  // `async` on the arrow so `make`'s `Record | Promise<Record>` union is always
  // a promise here — `Promise.all` accepts both, but the mixed iterable is the
  // shape `await-thenable` rejects, and `runDefinition` already normalizes
  // `def.tools()` the same way.
  const built = await Promise.all(wanted.map(async (g) => g.make()));
  const registry: Record<string, any> = {};
  for (const group of built) Object.assign(registry, group);
  // MCP merges last, so a server exporting a colliding name still wins — the
  // exclusions above are about Bernard's own built-ins, not about MCP.
  return { ...registry, ...mcpTools };
}
