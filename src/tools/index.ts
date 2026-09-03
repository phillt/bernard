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
        memory: toolToAISDK(createMemoryTool(memoryStore, provenance)),
        scratch: toolToAISDK(createScratchTool(memoryStore, provenance)),
        datetime: createDateTimeTool(),
      }),
    },
    {
      audience: 'main',
      make: async () => {
        const [{ createRoutineTool }, { createLineupTool }, { createSpecialistTool }] =
          await Promise.all([
            import('./routine.js'),
            import('./lineup.js'),
            import('./specialist.js'),
          ]);
        const { createAppletTool } = await import('./applet.js');
        return {
          routine: createRoutineTool(routineStore),
          lineup_edit: createLineupTool(config),
          specialist: createSpecialistTool(specialistStore, candidateStore, config),
          applet: createAppletTool(),
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
    { audience: 'any', make: () => createTimeTools() },
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
  const registry: Record<string, any> = {};
  for (const group of groups) {
    if (worker && group.audience === 'main') continue; // never LOADED — see ToolGroup
    Object.assign(registry, await group.make());
  }
  // MCP merges last, so a server exporting a colliding name still wins — the
  // exclusions above are about Bernard's own built-ins, not about MCP.
  return { ...registry, ...mcpTools };
}
