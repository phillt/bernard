import * as fs from 'node:fs';
import type { ResolvedEntry } from './reference-resolver.js';
import type { RAGSearchResult } from './rag.js';
import { STATE_DIR, TURN_CONTEXT_FILE } from './paths.js';

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
 * most recent turns to bound the on-disk file. Older turns drop off the front.
 */
export const TURN_CONTEXT_MAX = 100;

/**
 * Persists the per-turn prompt/context snapshots that power the Shift+Tab
 * "Prompt & Context" viewer. Mirror of {@link ProvenanceHistoryStore}: atomic
 * writes (write-to-temp then rename), tolerant load that drops malformed rows.
 */
export class TurnContextStore {
  load(): TurnContextRecord[] {
    try {
      const data = fs.readFileSync(TURN_CONTEXT_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry: unknown): entry is TurnContextRecord => {
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
      });
    } catch {
      return [];
    }
  }

  save(records: TurnContextRecord[]): void {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = TURN_CONTEXT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
    fs.renameSync(tmp, TURN_CONTEXT_FILE);
  }

  clear(): void {
    try {
      fs.unlinkSync(TURN_CONTEXT_FILE);
    } catch {
      // file may not exist — ignore
    }
  }
}
