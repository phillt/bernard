import * as fs from 'node:fs';
import type { TurnProvenance } from './provenance.js';
import { STATE_DIR, PROVENANCE_HISTORY_FILE } from './paths.js';

/**
 * Persists the per-turn citation snapshots that power the Shift+Tab
 * full-screen citation viewer (#211). Sibling of {@link HistoryStore}:
 * conversation history stores messages; this stores the sources cited in
 * each turn. Uses atomic writes (write-to-temp then rename).
 */
export class ProvenanceHistoryStore {
  load(): TurnProvenance[] {
    try {
      const data = fs.readFileSync(PROVENANCE_HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry: unknown): entry is TurnProvenance => {
        if (typeof entry !== 'object' || entry === null) return false;
        const e = entry as Partial<TurnProvenance>;
        return (
          typeof e.turnIndex === 'number' &&
          typeof e.userInput === 'string' &&
          typeof e.timestamp === 'number' &&
          Array.isArray(e.sources) &&
          Array.isArray(e.citedIds)
        );
      });
    } catch {
      return [];
    }
  }

  save(records: TurnProvenance[]): void {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = PROVENANCE_HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
    fs.renameSync(tmp, PROVENANCE_HISTORY_FILE);
  }

  clear(): void {
    try {
      fs.unlinkSync(PROVENANCE_HISTORY_FILE);
    } catch {
      // file may not exist — ignore
    }
  }
}
