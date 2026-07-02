import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Generic disk-backed store for a JSON array of per-turn snapshot records —
 * the shared skeleton behind {@link ProvenanceHistoryStore} (cite-able sources)
 * and {@link TurnContextStore} (prompt-assembly trail). Atomic writes
 * (write-to-temp then rename), tolerant load that drops malformed rows via a
 * caller-supplied type guard, and unlink-on-clear.
 *
 * Options let each store diverge on the two axes that actually differ:
 *  - `pretty` — 2-space-indented JSON (default) vs. compact. Large payloads
 *    (e.g. full system prompts) opt out of pretty-printing to save space.
 *  - `maxRecords` — retention cap enforced at save time (`slice(-maxRecords)`),
 *    so a store owns its own size bound rather than relying on callers.
 */
export class PerTurnStore<T> {
  private readonly filePath: string;
  private readonly validate: (entry: unknown) => entry is T;
  private readonly pretty: boolean;
  private readonly maxRecords?: number;

  constructor(opts: {
    filePath: string;
    validate: (entry: unknown) => entry is T;
    pretty?: boolean;
    maxRecords?: number;
  }) {
    this.filePath = opts.filePath;
    this.validate = opts.validate;
    this.pretty = opts.pretty ?? true;
    this.maxRecords = opts.maxRecords;
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
    const capped =
      this.maxRecords !== undefined && records.length > this.maxRecords
        ? records.slice(-this.maxRecords)
        : records;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(capped, null, this.pretty ? 2 : undefined), 'utf-8');
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
