import { createShellTool } from './shell.js';
import { createMemoryTool, createScratchTool } from './memory.js';
import { createDateTimeTool } from './datetime.js';
import { createCronTools } from './cron.js';
import { createCronLogTools } from './cron-logs.js';
import { createTimeTools } from './time.js';
import { createMCPConfigTool } from './mcp.js';
import { createMCPAddUrlTool } from './mcp-url.js';
import { createWebReadTool } from './web.js';
import type { ToolOptions } from './types.js';
import type { MemoryStore } from '../memory.js';

export type { ToolOptions } from './types.js';

export function createTools(options: ToolOptions, memoryStore: MemoryStore, mcpTools?: Record<string, any>) {
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
    ...mcpTools,
  };
}
