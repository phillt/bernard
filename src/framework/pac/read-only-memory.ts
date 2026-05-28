import type { MemoryStore } from '../../memory.js';
import { createMemoryTool, createScratchTool } from '../../tools/memory.js';
import { err, type BernardTool } from '../tools/types.js';

type MemoryAction = 'list' | 'read' | 'write' | 'delete';

function readOnlyWrap<TArgs extends { action: MemoryAction }, TData>(
  inner: BernardTool<TArgs, TData>,
): BernardTool<TArgs, TData> {
  return {
    meta: inner.meta,
    description: `${inner.description}\n\n[Restricted to read-only: write/delete actions are rejected.]`,
    parameters: inner.parameters,
    execute: async (args, opts) => {
      if (args.action === 'write' || args.action === 'delete') {
        return err({
          type: 'invalid_args',
          message: `${args.action} is not permitted in this phase (read-only context).`,
        });
      }
      return inner.execute(args, opts);
    },
    serializeForModel: inner.serializeForModel,
  };
}

/** Memory tool with `write` and `delete` actions rejected at runtime. */
export function createReadOnlyMemoryTool(store: MemoryStore) {
  return readOnlyWrap(createMemoryTool(store));
}

/** Scratch tool with `write` and `delete` actions rejected at runtime. */
export function createReadOnlyScratchTool(store: MemoryStore) {
  return readOnlyWrap(createScratchTool(store));
}
