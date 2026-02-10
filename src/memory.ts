import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const MEMORY_DIR = path.join(os.homedir(), '.bernard', 'memory');

/** @internal */
export function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '');
}

export class MemoryStore {
  private scratch: Map<string, string> = new Map();

  constructor() {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }

  // --- Persistent Memory (disk-backed) ---

  listMemory(): string[] {
    const files = fs.readdirSync(MEMORY_DIR);
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  }

  readMemory(key: string): string | null {
    const filePath = path.join(MEMORY_DIR, `${sanitizeKey(key)}.md`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  }

  writeMemory(key: string, content: string): void {
    const filePath = path.join(MEMORY_DIR, `${sanitizeKey(key)}.md`);
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  deleteMemory(key: string): boolean {
    const filePath = path.join(MEMORY_DIR, `${sanitizeKey(key)}.md`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

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

  listScratch(): string[] {
    return Array.from(this.scratch.keys());
  }

  readScratch(key: string): string | null {
    return this.scratch.get(key) ?? null;
  }

  writeScratch(key: string, content: string): void {
    this.scratch.set(key, content);
  }

  deleteScratch(key: string): boolean {
    return this.scratch.delete(key);
  }

  getAllScratchContents(): Map<string, string> {
    return new Map(this.scratch);
  }

  clearScratch(): void {
    this.scratch.clear();
  }
}
