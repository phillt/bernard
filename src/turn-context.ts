import type { ResolvedEntry } from './reference-resolver.js';
import type { RAGSearchResult } from './rag.js';
import { TURN_CONTEXT_FILE } from './paths.js';
import { PerTurnStore } from './per-turn-store.js';

/**
 * Snapshot of what the pre-turn pipeline fed the main agent for one completed
 * turn — the input the user typed vs. the rewritten prompt the model actually
 * received, the entities the reference resolver expanded, and the memory facts
 * recalled into context.
 *
 * Deliberately does NOT include the system prompt: that's internal infra that
 * shouldn't be persisted to disk or surfaced in the UI.
 *
 * Powers the Shift+Tab "Prompt & Context" viewer. Sibling of {@link TurnProvenance}
 * (which stores cite-able sources): this stores the prompt-assembly trail.
 */
export interface TurnContextRecord {
  /** Conversation turn position (0-based count of user messages), like TurnProvenance. */
  turnIndex: number;
  /** Wall-clock epoch ms at end of turn. */
  timestamp: number;
  /** What the user actually typed, before any rewrite. */
  originalInput: string;
  /** The prompt the agent received after the rewriter ran (== original if unchanged). */
  rewrittenInput: string;
  /** Entities the reference resolver expanded this turn. */
  resolvedReferences: ResolvedEntry[];
  /** Memory facts injected into `<recalled_context>` this turn (post-filter, post-stickiness). */
  recalledFacts: RAGSearchResult[];
  /**
   * Keys of the `MemoryStore` entries rendered into `<persistent_memory>` this
   * turn (#307). Optional because records written before this field existed are
   * still valid on disk.
   *
   * Today injection is unconditional, so this is every stored key — which is the
   * point: it makes the size of that block visible per turn instead of invisible.
   * When memory starts going through the recall filter this becomes the set the
   * curator KEPT, and the viewer can show what it dropped.
   */
  injectedMemoryKeys?: string[];
}

function isTurnContextRecord(entry: unknown): entry is TurnContextRecord {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Partial<TurnContextRecord>;
  return (
    typeof e.turnIndex === 'number' &&
    typeof e.timestamp === 'number' &&
    typeof e.originalInput === 'string' &&
    typeof e.rewrittenInput === 'string' &&
    Array.isArray(e.resolvedReferences) &&
    Array.isArray(e.recalledFacts)
  );
}

/**
 * Persists the per-turn prompt/context snapshots that power the Shift+Tab
 * "Prompt & Context" viewer. Sibling of {@link ProvenanceHistoryStore}; both
 * are thin {@link PerTurnStore} instances.
 */
export class TurnContextStore extends PerTurnStore<TurnContextRecord> {
  constructor() {
    super({ filePath: TURN_CONTEXT_FILE, validate: isTurnContextRecord });
  }
}
