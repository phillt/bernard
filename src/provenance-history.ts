import type { TurnProvenance } from './provenance.js';
import { PROVENANCE_HISTORY_FILE } from './paths.js';
import { PerTurnStore } from './per-turn-store.js';

function isTurnProvenance(entry: unknown): entry is TurnProvenance {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Partial<TurnProvenance>;
  return (
    typeof e.turnIndex === 'number' &&
    typeof e.userInput === 'string' &&
    typeof e.timestamp === 'number' &&
    Array.isArray(e.sources) &&
    Array.isArray(e.citedIds)
  );
}

/**
 * Persists the per-turn citation snapshots that power the Shift+Tab
 * full-screen citation viewer (#211). Sibling of {@link TurnContextStore};
 * both are thin {@link PerTurnStore} instances. Uncapped (source records are
 * small) and pretty-printed.
 */
export class ProvenanceHistoryStore extends PerTurnStore<TurnProvenance> {
  constructor() {
    super({ filePath: PROVENANCE_HISTORY_FILE, validate: isTurnProvenance });
  }
}
