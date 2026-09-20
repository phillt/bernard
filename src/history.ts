import * as fs from 'node:fs';
import type { CoreMessage } from './framework/sdk.js';
import { STATE_DIR, HISTORY_FILE } from './paths.js';
import { stripImagesFromHistory } from './image.js';
import { normalizeToolResultPart } from './tool-result-output.js';

/**
 * Puts one stored message into the shape the installed SDK requires.
 *
 * Only a `role:'tool'` message can need it — its parts are the only ones
 * carrying a value in a slot the SDK renames — and a part already in the target
 * shape comes back BY REFERENCE, so on today's histories this is an identity
 * pass that allocates nothing. See `tool-result-output.ts` for the shapes.
 */
function normalizeStoredMessage(message: CoreMessage): CoreMessage {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
  // Checked before mapping, so a message needing no conversion allocates no
  // array either — otherwise the common path would build and discard one per
  // tool message (132 of them on the measured install) on every start.
  if (!message.content.some((part) => normalizeToolResultPart(part) !== part)) return message;
  return { ...message, content: message.content.map(normalizeToolResultPart) };
}

/**
 * Manages persistence of conversation history.
 *
 * Uses atomic writes (write-to-temp then rename) to prevent corruption on unexpected exit.
 */
export class HistoryStore {
  /**
   * Loads and validates saved conversation history, returning an empty array if
   * the file is missing or malformed.
   *
   * ## Why the load is normalized and not just cast
   *
   * This was `JSON.parse(data) … as CoreMessage[]` behind a `'role' in entry`
   * filter — an unchecked cast, so whatever shape happened to be on disk went
   * straight back to the provider on the next turn. Measured on a real install:
   * **324 messages, 365 `tool-result` parts, all 365 carrying `result`, none
   * carrying `output`.** The next SDK major requires `output` and types it as
   * required, which makes that file — every returning user's file — a hard
   * failure on the first turn after the upgrade. The existing `try/catch` does
   * not help: it guards the READ, and the failure happens later, at the
   * provider.
   *
   * So the conversion lives here, at the one place a stored shape re-enters the
   * process, and it is shape-directed — each part is read from whichever slot
   * it is in and written to the slot the installed SDK wants. Today both are
   * `result`, so this is an identity pass, which is what
   * `history.v4-fixture.test.ts` pins against a redacted copy of a real file.
   *
   * ## Why there is no version stamp
   *
   * One was considered and declined. The file is a bare JSON array, so stamping
   * it means wrapping it in an object — and `load` rejects a non-array, so a
   * user who rolled back to an older Bernard would silently lose their entire
   * history. A per-part shape check is also STRICTLY stronger than a file-level
   * stamp: it stays correct for a file written across an upgrade boundary,
   * which one stamp cannot describe.
   *
   * ## What is deliberately NOT stripped
   *
   * `redacted-reasoning` assistant parts. They are valid on `ai@4` and handing
   * them back is correct behaviour for Anthropic extended thinking, so dropping
   * them now would be a live behaviour change for a problem that does not exist
   * yet. They stop being valid at the bump, and that is where the strip
   * belongs. (Measured on the same install: zero such parts present, so this is
   * a latent case either way.)
   */
  load(): CoreMessage[] {
    try {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      return (
        parsed.filter(
          (entry: unknown) => typeof entry === 'object' && entry !== null && 'role' in entry,
        ) as CoreMessage[]
      ).map(normalizeStoredMessage);
    } catch {
      return [];
    }
  }

  /** Atomically writes the conversation history to disk. */
  save(messages: CoreMessage[]): void {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const stripped = stripImagesFromHistory(messages);
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stripped, null, 2), 'utf-8');
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
