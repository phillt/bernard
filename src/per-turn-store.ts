import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Generic disk-backed store for a JSON array of per-turn snapshot records —
 * the shared skeleton behind {@link ProvenanceHistoryStore} (cite-able sources)
 * and {@link TurnContextStore} (prompt-assembly trail). Atomic writes
 * (write-to-temp then rename), tolerant load that drops malformed rows via a
 * caller-supplied type guard, and unlink-on-clear.
 */
export class PerTurnStore<T> {
  private readonly filePath: string;
  private readonly validate: (entry: unknown) => entry is T;

  constructor(opts: { filePath: string; validate: (entry: unknown) => entry is T }) {
    this.filePath = opts.filePath;
    this.validate = opts.validate;
  }

  load(): T[] {
    try {
      const data = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry: unknown): entry is T => this.validate(entry));
    } catch {
      return [];
    }
  }

  save(records: T[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  clear(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // file may not exist — ignore
    }
  }
}
