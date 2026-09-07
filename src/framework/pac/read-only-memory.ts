import type { MemoryStore } from '../../memory.js';
import { createMemoryTool, createScratchTool } from '../../tools/memory.js';
import { err, type BernardTool } from '../tools/types.js';
import { shouldBlockInReadOnly } from '../../risk.js';

/**
 * Wraps a tool so any action it classifies as a write is rejected at runtime.
 *
 * **The write set is `shouldBlockInReadOnly`, the function the real gate uses.**
 * It used to be `args.action === 'write' || args.action === 'delete'` alongside
 * a local `MemoryAction` union — a second copy of a decision made elsewhere, and
 * one that failed **open**: `memory` gained a `supersede` action (#513) and this
 * wrapper would have admitted it, letting a PAC Critic retire a user's memories
 * from a phase whose whole contract is that it cannot write.
 *
 * Reading `inner.meta.isWriteAction` directly was the first fix and it stopped
 * one rung short — it took the count from three implementations to two, when
 * `risk.ts` already owns the answer and `augment.ts:630` already calls it for
 * the read-only block gate (#179). It is a pure leaf over a type import, so
 * this adds no layering edge.
 *
 * The difference is the fallback for a tool with no predicate. Refusing every
 * action, as the first fix did, is a false refusal on a `kind: 'read'` tool;
 * `shouldBlockInReadOnly` consults the declared classification instead, which
 * is not guessing. For a `kind: 'write'` tool the two agree exactly, so the
 * substitution keeps every assertion below.
 */
export function readOnlyWrap<TArgs extends { action: string }, TData>(
  inner: BernardTool<TArgs, TData>,
): BernardTool<TArgs, TData> {
  return {
    meta: inner.meta,
    description: `${inner.description}\n\n[Restricted to read-only: mutating actions are rejected.]`,
    parameters: inner.parameters,
    execute: async (args, opts) => {
      if (shouldBlockInReadOnly(inner.meta, args)) {
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
