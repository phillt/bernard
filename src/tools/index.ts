import { createShellTool } from './shell.js';
import { createMemoryTool, createScratchTool } from './memory.js';
import { createDateTimeTool } from './datetime.js';
import { createCronTools } from './cron.js';
import { createCronLogTools } from './cron-logs.js';
import { createTimeTools } from './time.js';
import { createMCPConfigTool } from './mcp.js';
import { createMCPAddUrlTool } from './mcp-url.js';
import { createWebReadTool } from './web.js';
import { createWaitTool } from './wait.js';
import type { ToolOptions } from './types.js';
import type { MemoryStore } from '../memory.js';

export type { ToolOptions } from './types.js';

/**
 * Assembles the complete tool registry for the agent.
 *
 * @param options - Shell execution options (timeout, dangerous-command confirmation callback).
 * @param memoryStore - Persistent and scratch memory backing store.
 * @param mcpTools - Optional MCP-provided tools to merge into the registry.
 * @returns A flat record of all available AI SDK tools keyed by tool name.
 */
export function createTools(
  options: ToolOptions,
  memoryStore: MemoryStore,
  mcpTools?: Record<string, any>,
): Record<string, any> {
  return {
    shell: createShellTool(options),
    memory: createMemoryTool(memoryStore),
    scratch: createScratchTool(memoryStore),
    datetime: createDateTimeTool(),
    ...createCronTools(),
    ...createCronLogTools(),
    ...createTimeTools(),
    mcp_config: createMCPConfigTool(),
    mcp_add_url: createMCPAddUrlTool(),
    web_read: createWebReadTool(),
    wait: createWaitTool(),
    ...mcpTools,
  };
}
