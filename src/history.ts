import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CoreMessage } from 'ai';

const BERNARD_DIR = path.join(os.homedir(), '.bernard');
const HISTORY_FILE = path.join(BERNARD_DIR, 'conversation-history.json');

export class HistoryStore {
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

  save(messages: CoreMessage[]): void {
    fs.mkdirSync(BERNARD_DIR, { recursive: true });
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(messages, null, 2), 'utf-8');
    fs.renameSync(tmp, HISTORY_FILE);
  }

  clear(): void {
    try {
      fs.unlinkSync(HISTORY_FILE);
    } catch {
      // file may not exist — ignore
    }
  }
}
