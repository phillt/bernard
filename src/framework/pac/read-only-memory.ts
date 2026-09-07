import type { MemoryStore } from '../../memory.js';
import { createMemoryTool, createScratchTool } from '../../tools/memory.js';
import { err, type BernardTool } from '../tools/types.js';

/**
 * Wraps a tool so any action it classifies as a write is rejected at runtime.
 *
 * **The write set is the tool's own `meta.isWriteAction`, not a list here.** It
 * used to be `args.action === 'write' || args.action === 'delete'` alongside a
 * local `MemoryAction` union — a second copy of a decision the tool already
 * makes, and one that failed **open**: `memory` gained a `supersede` action
 * (#513) and this wrapper would have admitted it, letting a PAC critic retire a
 * user's memories from a phase whose whole contract is that it cannot write.
 * The same predicate already drives the read-only block gate (#179) and the
 * confirm gate (#144), so there is one answer to "is this call a write" rather
 * than three that can disagree.
 *
 * A tool that declares no predicate is refused entirely, not admitted: a
 * read-only wrapper that cannot tell a read from a write must not guess. Both
 * current callers declare one.
 *
 * @internal Exported for tests; callers use the two factories below.
 */
export function readOnlyWrap<TArgs extends { action: string }, TData>(
  inner: BernardTool<TArgs, TData>,
): BernardTool<TArgs, TData> {
  const isWrite = inner.meta.isWriteAction;
  return {
    meta: inner.meta,
    description: `${inner.description}\n\n[Restricted to read-only: mutating actions are rejected.]`,
    parameters: inner.parameters,
    execute: async (args, opts) => {
      if (!isWrite) {
        return err({
          type: 'invalid_args',
          message: `${inner.meta.name} cannot be used in this phase (read-only context).`,
        });
      }
      if (isWrite(args)) {
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

/** Memory tool with every mutating action rejected at runtime. */
export function createReadOnlyMemoryTool(store: MemoryStore) {
  return readOnlyWrap(createMemoryTool(store));
}

/** Scratch tool with every mutating action rejected at runtime. */
export function createReadOnlyScratchTool(store: MemoryStore) {
  return readOnlyWrap(createScratchTool(store));
}
