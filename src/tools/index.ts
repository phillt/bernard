import { createShellTool } from './shell.js';
import type { ToolOptions } from './types.js';

export type { ToolOptions } from './types.js';

export function createTools(options: ToolOptions) {
  return {
    shell: createShellTool(options),
  };
}
