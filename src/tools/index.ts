import { createShellTool } from './shell.js';
import { createMemoryTool, createScratchTool } from './memory.js';
import { createDateTimeTool } from './datetime.js';
import { createCronTools } from './cron.js';
import { createCronLogTools } from './cron-logs.js';
import { createCronNotesTools } from './cron-notes.js';
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
 * Assembles the complete tool registry for the agent.
 *
 * @param options - Shell execution options (timeout, dangerous-command confirmation callback).
 * @param memoryStore - Persistent and scratch memory backing store.
 * @param mcpTools - Optional MCP-provided tools to merge into the registry.
 * @param config - Optional Bernard config, passed to specialist tool for provider/model validation.
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
): Record<string, any> {
  return {
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
    ...createCronTools(),
    ...createCronLogTools(),
    ...createCronNotesTools(),
    ...createTimeTools(),
    mcp_config: createMCPConfigTool(),
    mcp_add_url: createMCPAddUrlTool(),
    mcp_verify: createMCPVerifyTool(),
    web_read: createWebReadTool(provenance),
    web_search: createWebSearchTool(provenance),
    wait: createWaitTool(),
    ...createFileTools(provenance),
    ...(provenance ? { cite: createCiteTool(provenance) } : {}),
    ...mcpTools,
  };
}
