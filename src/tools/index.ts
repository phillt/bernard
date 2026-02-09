import { createShellTool } from './shell.js';
import { createMemoryTool, createScratchTool } from './memory.js';
import { createDateTimeTool } from './datetime.js';
import type { ToolOptions } from './types.js';
import type { MemoryStore } from '../memory.js';

export type { ToolOptions } from './types.js';

export function createTools(options: ToolOptions, memoryStore: MemoryStore) {
  return {
    shell: createShellTool(options),
    memory: createMemoryTool(memoryStore),
    scratch: createScratchTool(memoryStore),
    datetime: createDateTimeTool(),
  };
}
