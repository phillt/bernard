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
 *  - Cost: 24 tools / ~18k chars (~4.6k tokens) per dispatch. Ephemeral
 *    dispatches are never prompt-cache-marked (`run.ts`: `promptCacheActive`
 *    requires `historyMode === 'persistent'`, and only the main agent is), so
 *    unlike the main agent's block this is billed at full rate every time.
 *  - Containment: `createRoutineTool(undefined)` falls back to
 *    `new RoutineStore()`, so a worker handed no store today still gets a live
 *    one pointed at the user's real routines directory.
 *
 * Deliberately a name list rather than a `kind`/`sideEffect` predicate: the
 * distinction here is "who owns this decision", not "is this a write". `shell`
 * and `file_edit_lines` are writes a worker legitimately needs.
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
    routine: createRoutineTool(routineStore),
    lineup_edit: createLineupTool(config),
    specialist: createSpecialistTool(specialistStore, candidateStore, config),
    datetime: createDateTimeTool(),
    // Scheduling is a main-agent concern; the cron *definition* builds its own
    // registry for headless runs and is unaffected by this.
    ...(worker ? {} : createCronTool()),
    ...(worker ? {} : createCronLogTool()),
    ...(worker ? {} : createCronNotesTool()),
    ...createTimeTools(),
    mcp_config: createMCPConfigTool(),
    mcp_add_url: createMCPAddUrlTool(),
    mcp_verify: createMCPVerifyTool(),
    web_read: createWebReadTool(provenance),
    web_search: createWebSearchTool(provenance),
    wait: createWaitTool(),
    ...createFileTools(provenance),
    ...(provenance ? { cite: createCiteTool(provenance) } : {}),
  };
  // Strip BEFORE merging MCP: the exclusion list names Bernard's own built-ins,
  // and an MCP server that happens to export a colliding name should still win
  // the merge rather than be silently dropped by a rule aimed elsewhere.
  if (worker) {
    for (const name of WORKER_EXCLUDED_TOOLS) delete registry[name];
  }
  return { ...registry, ...mcpTools };
}
