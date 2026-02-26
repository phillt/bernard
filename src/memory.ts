import * as fs from 'node:fs';
import * as path from 'node:path';
import { MEMORY_DIR } from './paths.js';

/** @internal */
export function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Dual-layer store providing disk-backed persistent memory and ephemeral in-memory scratch notes.
 *
 * Persistent memory is stored as individual Markdown files in the data directory.
 * Scratch notes live only for the current session and are discarded on exit.
 */
export class MemoryStore {
  private scratch: Map<string, string> = new Map();

  constructor() {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }

  // --- Persistent Memory (disk-backed) ---

  /** Returns the keys of all persistent memory entries (filenames without `.md` extension). */
  listMemory(): string[] {
    const files = fs.readdirSync(MEMORY_DIR);
    return files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  }

  /** Reads a persistent memory entry by key, returning `null` if it does not exist. */
  readMemory(key: string): string | null {
    const filePath = path.join(MEMORY_DIR, `${sanitizeKey(key)}.md`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  }

  /** Creates or overwrites a persistent memory entry on disk. */
  writeMemory(key: string, content: string): void {
    const filePath = path.join(MEMORY_DIR, `${sanitizeKey(key)}.md`);
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /** Deletes a persistent memory entry. Returns `true` if the entry existed and was removed. */
  deleteMemory(key: string): boolean {
    const filePath = path.join(MEMORY_DIR, `${sanitizeKey(key)}.md`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /** Returns all persistent memory entries as a key-content map. */
  getAllMemoryContents(): Map<string, string> {
    const result = new Map<string, string>();
    for (const key of this.listMemory()) {
      const content = this.readMemory(key);
      if (content !== null) {
        result.set(key, content);
      }
    }
    return result;
  }

  // --- Scratch Notes (in-memory, session only) ---

  /** Returns the keys of all scratch notes in the current session. */
  listScratch(): string[] {
    return Array.from(this.scratch.keys());
  }

  /** Reads a scratch note by key, returning `null` if it does not exist. */
  readScratch(key: string): string | null {
    return this.scratch.get(key) ?? null;
  }

  /** Creates or overwrites a scratch note for the current session. */
  writeScratch(key: string, content: string): void {
    this.scratch.set(key, content);
  }

  /** Deletes a scratch note. Returns `true` if the note existed and was removed. */
  deleteScratch(key: string): boolean {
    return this.scratch.delete(key);
  }

  /** Returns a shallow copy of all scratch notes as a key-content map. */
  getAllScratchContents(): Map<string, string> {
    return new Map(this.scratch);
  }

  /** Removes all scratch notes from the current session. */
  clearScratch(): void {
    this.scratch.clear();
  }
}
