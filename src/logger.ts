import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve('.logs');
let dirCreated = false;

/**
 * Append a JSON log entry to `.logs/<date>.log` when `BERNARD_DEBUG` is enabled.
 * No-ops silently when debug mode is off.
 * @param label - Short tag identifying the log source (e.g. `"agent"`, `"rag"`).
 * @param data - Arbitrary payload serialized as JSON.
 */
export function debugLog(label: string, data: unknown): void {
  if (process.env.BERNARD_DEBUG !== 'true' && process.env.BERNARD_DEBUG !== '1') return;

  if (!dirCreated) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirCreated = true;
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const entry = JSON.stringify({ timestamp: now.toISOString(), label, data });
  fs.appendFileSync(path.join(LOG_DIR, `${dateStr}.log`), entry + '\n');
}
