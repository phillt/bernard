import type { ResolvedEntry } from './reference-resolver.js';
import type { RAGSearchResult } from './rag.js';
import { TURN_CONTEXT_FILE } from './paths.js';
import { PerTurnStore } from './per-turn-store.js';

/**
 * Snapshot of everything the pre-turn pipeline fed the main agent for one
 * completed turn — the input the user typed vs. the rewritten prompt the model
 * actually received, the entities the reference resolver expanded, the memory
 * facts recalled into context, and the full system prompt in force that turn.
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
  /** The full system prompt the agent ran with this turn. */
  systemPrompt: string;
}

/**
 * Cap on retained per-turn context records. System prompts are large (tens of
 * KB each), so — unlike the unbounded provenance history — we keep only the
 * most recent turns to bound the on-disk file. Enforced at save time by the
 * store; the oldest turns drop off the front.
 */
export const TURN_CONTEXT_MAX = 100;

function isTurnContextRecord(entry: unknown): entry is TurnContextRecord {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Partial<TurnContextRecord>;
  return (
    typeof e.turnIndex === 'number' &&
    typeof e.timestamp === 'number' &&
    typeof e.originalInput === 'string' &&
    typeof e.rewrittenInput === 'string' &&
    typeof e.systemPrompt === 'string' &&
    Array.isArray(e.resolvedReferences) &&
    Array.isArray(e.recalledFacts)
  );
}

/**
 * Persists the per-turn prompt/context snapshots that power the Shift+Tab
 * "Prompt & Context" viewer. Sibling of {@link ProvenanceHistoryStore}; both
 * are thin {@link PerTurnStore} instances. Capped at {@link TURN_CONTEXT_MAX}
 * and stored compact (records carry full system prompts, so pretty-printing
 * would bloat the file for no benefit — it's never hand-edited).
 */
export class TurnContextStore extends PerTurnStore<TurnContextRecord> {
  constructor() {
    super({
      filePath: TURN_CONTEXT_FILE,
      validate: isTurnContextRecord,
      pretty: false,
      maxRecords: TURN_CONTEXT_MAX,
    });
  }
}
