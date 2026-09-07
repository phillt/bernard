import { z } from 'zod';
import type { MemoryStore } from '../memory.js';
import { MemoryKeyCollisionError } from '../memory.js';
import { MEMORY_DIR } from '../paths.js';
import type { BernardTool } from '../framework/tools/types.js';
import { ok, err } from '../framework/tools/types.js';
import type { ProvenanceStore } from '../provenance.js';

/**
 * Split from the scratch tool's schema with #513.
 *
 * They shared one object, so adding `supersede` to the enum would have
 * advertised it on `scratch` as well — where it means nothing, since scratch is
 * an in-memory map discarded at session end and has no supersession to record.
 */
const MEMORY_PARAMETERS = z.object({
  action: z
    .enum(['list', 'read', 'write', 'delete', 'supersede'])
    .describe('The action to perform'),
  key: z.string().optional().describe('The memory key (required for read/write/delete/supersede)'),
  content: z.string().optional().describe('The content to write (required for write)'),
  replacement: z
    .string()
    .optional()
    .describe(
      'For supersede: the key of the memory that replaces this one. It must already exist.',
    ),
});

const SCRATCH_PARAMETERS = z.object({
  action: z.enum(['list', 'read', 'write', 'delete']).describe('The action to perform'),
  key: z.string().optional().describe('The scratch key (required for read/write/delete)'),
  content: z.string().optional().describe('The content to write (required for write)'),
});

type MemoryArgs = z.infer<typeof MEMORY_PARAMETERS>;
type ScratchArgs = z.infer<typeof SCRATCH_PARAMETERS>;

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
        return action === 'write' || action === 'delete' || action === 'supersede';
      },
    },
    description: `Persistent memory that survives across sessions. Use this to remember user preferences, project knowledge, or anything worth recalling later. Stored as files on disk at ${MEMORY_DIR}. When a memory is replaced by a newer one, use action 'supersede' rather than 'delete': the retired note stops being shown but stays on disk, so a wrong call costs nothing.`,
    parameters: MEMORY_PARAMETERS,
    execute: async ({ action, key, content, replacement }) => {
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
          try {
            memoryStore.writeMemory(key, content);
          } catch (e) {
            // A collision is a call-shape mistake the model can fix by picking
            // a distinct key, so it comes back as a tool error with the
            // conflicting key named rather than as a throw out of `execute`.
            // `invalid_args` is what `error-taxonomy` classifies as correctable.
            if (e instanceof MemoryKeyCollisionError)
              return err({ type: 'invalid_args', message: e.message });
            throw e;
          }
          return ok(`Memory "${key}" saved.`);
        }
        case 'supersede': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for supersede action.' });
          if (!replacement)
            return err({
              type: 'invalid_args',
              message: 'replacement is required for supersede action.',
            });
          try {
            const done = memoryStore.supersede(key, replacement);
            if (!done) return ok(`No memory found for key "${key}".`);
          } catch (e) {
            return err({
              type: 'invalid_args',
              message: e instanceof Error ? e.message : String(e),
            });
          }
          return ok(
            `Memory "${key}" retired in favour of "${replacement}". ` +
              `It is no longer shown, and its file is still on disk.`,
          );
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
): BernardTool<ScratchArgs, string> {
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
    parameters: SCRATCH_PARAMETERS,
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
