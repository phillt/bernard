import { createShellTool } from './shell.js';
import { createMemoryTool, createScratchTool } from './memory.js';
import { createDateTimeTool } from './datetime.js';
import { createCronTool } from './cron.js';
import { createCronLogTool } from './cron-logs.js';
import { createCronNotesTool } from './cron-notes.js';
import { createTimeTools } from './time.js';
import { createMCPConfigTool } from './mcp.js';
import { createMCPAddUrlTool } from './mcp-url.js';
import { createMCPVerifyTool } from './mcp-verify.js';
import { createWebReadTool } from './web.js';
import { createWebSearchTool } from './web-search.js';
import { createWaitTool } from './wait.js';
import { createFileTools } from './file.js';
import { createRoutineTool } from './routine.js';
import { createLineupTool } from './lineup.js';
import { createSpecialistTool } from './specialist.js';
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
 * Tools a `worker` surface omits (#253): Bernard's own configuration and
 * scheduling controls.
 *
 * These mutate durable user state that belongs to the main agent and the REPL —
 * cron jobs, model lineups, specialist definitions, saved routines, MCP server
 * config. A dispatched worker exists to carry out one delegated task, not to
 * reconfigure the assistant while doing it.
 *
 * Removing them is a cost win and a containment win:
 *  - Cost: the worker surface is 11 tools / ~6.4k chars against a full 20 /
 *    ~21.2k — about 14.8k chars (~3.7k tokens) skipped per dispatch. Ephemeral
 *    dispatches are never prompt-cache-marked (`run.ts`: `promptCacheActive`
 *    requires `historyMode === 'persistent'`, and only the main agent is), so
 *    unlike the main agent's block this is billed at full rate every time.
 *    (Measured after the cron consolidation that shrank the full surface; a
 *    sub-agent's end-to-end drop across both changes is ~24.1k -> 6.4k chars.)
 *  - Containment: `createRoutineTool(undefined)` falls back to
 *    `new RoutineStore()`, so a worker handed no store would otherwise get a
 *    live one pointed at the user's real routines directory.
 *
 * Deliberately a name list rather than a `kind`/`sideEffect` predicate: the
 * distinction here is "who owns this decision", not "is this a write". `shell`
 * and `file_edit_lines` are writes a worker legitimately needs.
 *
 * The registry below skips CONSTRUCTING these on a worker rather than deleting
 * them afterwards, so this list is the declared contract and the assertion
 * source for `cron-consolidation.test.ts` — which pins that the two agree.
 */
export const WORKER_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'routine',
  'lineup_edit',
  'specialist',
  'mcp_config',
  'mcp_add_url',
  'mcp_verify',
]);

/** Which built-in surface a dispatch receives. */
export interface CreateToolsOptions {
  /**
   * `'full'` (default) — every built-in, for the main agent.
   * `'worker'` — drops {@link WORKER_EXCLUDED_TOOLS} and the `cron_*` family.
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
export function createTools(
  options: ToolOptions,
  memoryStore: MemoryStore,
  mcpTools?: Record<string, any>,
  routineStore?: RoutineStore,
  specialistStore?: SpecialistStore,
  candidateStore?: CandidateStoreReader,
  config?: BernardConfig,
  provenance?: ProvenanceStore,
  opts?: CreateToolsOptions,
): Record<string, any> {
  // Pure function of its arguments: no ctx, no policy, no per-turn state. The
  // main agent's tool block must stay byte-identical across turns for the
  // prompt cache to hit, so this must never vary with anything turn-scoped.
  const worker = opts?.surface === 'worker';
  const registry: Record<string, any> = {
    // Migrated to BernardTool (Phase B). `toolToAISDK` preserves model-facing
    // bytes via each tool's `serializeForModel`; the source BernardTool is
    // attached via `__bernardSource` so `augmentTools` can detect errors
    // deterministically from the envelope.
    shell: toolToAISDK(createShellTool(options)),
    memory: toolToAISDK(createMemoryTool(memoryStore, provenance)),
    scratch: toolToAISDK(createScratchTool(memoryStore, provenance)),
    datetime: createDateTimeTool(),
    // Not constructed at all on a worker, rather than built and deleted: these
    // constructors touch disk. `createRoutineTool(undefined)` falls back to
    // `new RoutineStore()` (mkdirSync on the user's real routines dir) and
    // `createSpecialistTool(undefined, …)` runs the bundled-specialist seed
    // check — on a dispatch that was deliberately handed no stores.
    ...(worker
      ? {}
      : {
          routine: createRoutineTool(routineStore),
          lineup_edit: createLineupTool(config),
          specialist: createSpecialistTool(specialistStore, candidateStore, config),
        }),
    // Scheduling is a main-agent concern; the cron *definition* builds its own
    // registry for headless runs and is unaffected by this.
    ...(worker ? {} : createCronTool()),
    ...(worker ? {} : createCronLogTool()),
    ...(worker ? {} : createCronNotesTool()),
    ...createTimeTools(),
    ...(worker
      ? {}
      : {
          mcp_config: createMCPConfigTool(),
          mcp_add_url: createMCPAddUrlTool(),
          mcp_verify: createMCPVerifyTool(),
        }),
    web_read: createWebReadTool(provenance),
    web_search: createWebSearchTool(provenance),
    wait: createWaitTool(),
    ...createFileTools(provenance),
    ...(provenance ? { cite: createCiteTool(provenance) } : {}),
  };
  // MCP merges last, so a server exporting a colliding name still wins — the
  // exclusions above are about Bernard's own built-ins, not about MCP.
  return { ...registry, ...mcpTools };
}
