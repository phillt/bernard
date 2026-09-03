import { z } from 'zod';
import type { MemoryStore } from '../memory.js';
import { MEMORY_DIR } from '../paths.js';
import type { BernardTool } from '../framework/tools/types.js';
import { ok, err } from '../framework/tools/types.js';
import type { ProvenanceStore } from '../provenance.js';

const MEMORY_PARAMETERS = z.object({
  action: z.enum(['list', 'read', 'write', 'delete']).describe('The action to perform'),
  key: z.string().optional().describe('The memory key (required for read/write/delete)'),
  content: z.string().optional().describe('The content to write (required for write)'),
});

type MemoryArgs = z.infer<typeof MEMORY_PARAMETERS>;

/**
 * Creates the persistent memory tool backed by on-disk markdown files.
 *
 * Supports list, read, write, and delete actions for cross-session recall.
 * Returns a {@link BernardTool}; `serializeForModel` reproduces the historical
 * plain-string output (including the `"Error: "` prefix on validation errors).
 *
 * @param memoryStore - The backing MemoryStore instance.
 */
export function createMemoryTool(
  memoryStore: MemoryStore,
  provenance?: ProvenanceStore,
): BernardTool<MemoryArgs, string> {
  return {
    meta: {
      name: 'memory',
      kind: 'write',
      // action / key / content, all scalars (#445). `isWriteAction` below
      // still refines the gates per call, and a per-app `deny memory:action:write`
      // rule narrows it further.
      directInvocable: true,
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
      // memory.list / memory.read are pure reads despite the tool's static
      // `kind: 'write'`. Without this refinement, the read-only block gate
      // (#179) would prompt the user on every recall lookup and confirmMode
      // strict would pop a confirm menu on every list — both intolerable.
      isWriteAction: (args) => {
        const action = (args as { action?: string } | undefined)?.action;
        return action === 'write' || action === 'delete';
      },
    },
    description: `Persistent memory that survives across sessions. Use this to remember user preferences, project knowledge, or anything worth recalling later. Stored as files on disk at ${MEMORY_DIR}.`,
    parameters: MEMORY_PARAMETERS,
    execute: async ({ action, key, content }) => {
      switch (action) {
        case 'list': {
          const keys = memoryStore.listMemory();
          if (keys.length === 0) return ok('No persistent memories stored.');
          return ok(`Stored memories:\n${keys.map((k) => `  - ${k}`).join('\n')}`);
        }
        case 'read': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for read action.' });
          const value = memoryStore.readMemory(key);
          if (value === null) return ok(`No memory found for key "${key}".`);
          if (provenance) {
            const id = provenance.add({
              kind: 'memory',
              label: `memory:${key}`,
              contentPreview: value,
              rawRef: `memory:${key}`,
            });
            return ok(`[Source: ${id}]\n${value}`);
          }
          return ok(value);
        }
        case 'write': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for write action.' });
          if (!content)
            return err({ type: 'invalid_args', message: 'content is required for write action.' });
          memoryStore.writeMemory(key, content);
          return ok(`Memory "${key}" saved.`);
        }
        case 'delete': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for delete action.' });
          const deleted = memoryStore.deleteMemory(key);
          if (!deleted) return ok(`No memory found for key "${key}".`);
          return ok(`Memory "${key}" deleted.`);
        }
        default:
          return err({ type: 'invalid_args', message: `Unknown action: ${action}` });
      }
    },
    serializeForModel: (r) => (r.status === 'ok' ? r.result : `Error: ${r.error.message}`),
  };
}

/**
 * Creates the session-scoped scratch-pad tool for tracking intermediate work.
 *
 * Scratch notes survive context compression but are discarded when the session ends.
 *
 * @param memoryStore - The backing MemoryStore instance.
 */
export function createScratchTool(
  memoryStore: MemoryStore,
  provenance?: ProvenanceStore,
): BernardTool<MemoryArgs, string> {
  return {
    meta: {
      name: 'scratch',
      kind: 'write',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
      // scratch.list / scratch.read are pure reads — see memory tool above
      // for the rationale on this predicate (#179 + #144 both consult it).
      isWriteAction: (args) => {
        const action = (args as { action?: string } | undefined)?.action;
        return action === 'write' || action === 'delete';
      },
    },
    description:
      'Session scratch notes for tracking complex task progress, intermediate findings, and working plans. These notes survive context compression but are discarded when the session ends. Use this to keep track of multi-step work within a single session.',
    parameters: MEMORY_PARAMETERS,
    execute: async ({ action, key, content }) => {
      switch (action) {
        case 'list': {
          const keys = memoryStore.listScratch();
          if (keys.length === 0) return ok('No scratch notes in this session.');
          return ok(`Scratch notes:\n${keys.map((k) => `  - ${k}`).join('\n')}`);
        }
        case 'read': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for read action.' });
          const value = memoryStore.readScratch(key);
          if (value === null) return ok(`No scratch note found for key "${key}".`);
          if (provenance) {
            const id = provenance.add({
              kind: 'memory',
              label: `scratch:${key}`,
              contentPreview: value,
              rawRef: `scratch:${key}`,
            });
            return ok(`[Source: ${id}]\n${value}`);
          }
          return ok(value);
        }
        case 'write': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for write action.' });
          if (!content)
            return err({ type: 'invalid_args', message: 'content is required for write action.' });
          memoryStore.writeScratch(key, content);
          return ok(`Scratch note "${key}" saved.`);
        }
        case 'delete': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for delete action.' });
          const deleted = memoryStore.deleteScratch(key);
          if (!deleted) return ok(`No scratch note found for key "${key}".`);
          return ok(`Scratch note "${key}" deleted.`);
        }
        default:
          return err({ type: 'invalid_args', message: `Unknown action: ${action}` });
      }
    },
    serializeForModel: (r) => (r.status === 'ok' ? r.result : `Error: ${r.error.message}`),
  };
}
