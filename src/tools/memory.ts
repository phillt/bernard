import { tool } from 'ai';
import { z } from 'zod';
import type { MemoryStore } from '../memory.js';

export function createMemoryTool(memoryStore: MemoryStore) {
  return tool({
    description:
      'Persistent memory that survives across sessions. Use this to remember user preferences, project knowledge, or anything worth recalling later. Stored as files on disk at ~/.bernard/memory/.',
    parameters: z.object({
      action: z.enum(['list', 'read', 'write', 'delete']).describe('The action to perform'),
      key: z.string().optional().describe('The memory key (required for read/write/delete)'),
      content: z.string().optional().describe('The content to write (required for write)'),
    }),
    execute: async ({ action, key, content }): Promise<string> => {
      switch (action) {
        case 'list': {
          const keys = memoryStore.listMemory();
          if (keys.length === 0) return 'No persistent memories stored.';
          return `Stored memories:\n${keys.map((k) => `  - ${k}`).join('\n')}`;
        }
        case 'read': {
          if (!key) return 'Error: key is required for read action.';
          const value = memoryStore.readMemory(key);
          if (value === null) return `No memory found for key "${key}".`;
          return value;
        }
        case 'write': {
          if (!key) return 'Error: key is required for write action.';
          if (!content) return 'Error: content is required for write action.';
          memoryStore.writeMemory(key, content);
          return `Memory "${key}" saved.`;
        }
        case 'delete': {
          if (!key) return 'Error: key is required for delete action.';
          const deleted = memoryStore.deleteMemory(key);
          if (!deleted) return `No memory found for key "${key}".`;
          return `Memory "${key}" deleted.`;
        }
        default:
          return `Unknown action: ${action}`;
      }
    },
  });
}

export function createScratchTool(memoryStore: MemoryStore) {
  return tool({
    description:
      'Session scratch notes for tracking complex task progress, intermediate findings, and working plans. These notes survive context compression but are discarded when the session ends. Use this to keep track of multi-step work within a single session.',
    parameters: z.object({
      action: z.enum(['list', 'read', 'write', 'delete']).describe('The action to perform'),
      key: z.string().optional().describe('The scratch note key (required for read/write/delete)'),
      content: z.string().optional().describe('The content to write (required for write)'),
    }),
    execute: async ({ action, key, content }): Promise<string> => {
      switch (action) {
        case 'list': {
          const keys = memoryStore.listScratch();
          if (keys.length === 0) return 'No scratch notes in this session.';
          return `Scratch notes:\n${keys.map((k) => `  - ${k}`).join('\n')}`;
        }
        case 'read': {
          if (!key) return 'Error: key is required for read action.';
          const value = memoryStore.readScratch(key);
          if (value === null) return `No scratch note found for key "${key}".`;
          return value;
        }
        case 'write': {
          if (!key) return 'Error: key is required for write action.';
          if (!content) return 'Error: content is required for write action.';
          memoryStore.writeScratch(key, content);
          return `Scratch note "${key}" saved.`;
        }
        case 'delete': {
          if (!key) return 'Error: key is required for delete action.';
          const deleted = memoryStore.deleteScratch(key);
          if (!deleted) return `No scratch note found for key "${key}".`;
          return `Scratch note "${key}" deleted.`;
        }
        default:
          return `Unknown action: ${action}`;
      }
    },
  });
}
