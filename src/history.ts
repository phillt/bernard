import * as fs from 'node:fs';
import type { CoreMessage } from 'ai';
import { STATE_DIR, HISTORY_FILE } from './paths.js';

/**
 * Manages persistence of conversation history.
 *
 * Uses atomic writes (write-to-temp then rename) to prevent corruption on unexpected exit.
 */
export class HistoryStore {
  /** Loads and validates saved conversation history, returning an empty array if the file is missing or malformed. */
  load(): CoreMessage[] {
    try {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry: unknown) => typeof entry === 'object' && entry !== null && 'role' in entry,
      ) as CoreMessage[];
    } catch {
      return [];
    }
  }

  /** Atomically writes the conversation history to disk. */
  save(messages: CoreMessage[]): void {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(messages, null, 2), 'utf-8');
    fs.renameSync(tmp, HISTORY_FILE);
  }

  /** Deletes the saved history file. Silently succeeds if the file does not exist. */
  clear(): void {
    try {
      fs.unlinkSync(HISTORY_FILE);
    } catch {
      // file may not exist — ignore
    }
  }
}
