import * as fs from 'node:fs';
import * as path from 'node:path';
import { SPECIALISTS_DIR } from './paths.js';

export interface Specialist {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  guidelines: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SpecialistSummary {
  id: string;
  name: string;
  description: string;
}

const MAX_SPECIALISTS = 50;

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

const RESERVED_NAMES = new Set([
  'help',
  'clear',
  'compact',
  'task',
  'memory',
  'scratch',
  'mcp',
  'cron',
  'rag',
  'facts',
  'provider',
  'model',
  'theme',
  'options',
  'update',
  'exit',
  'routines',
  'create-routine',
  'specialists',
  'create-specialist',
]);

/**
 * Disk-backed store for named specialists (reusable expert profiles).
 *
 * Each specialist is stored as a separate JSON file under `SPECIALISTS_DIR`.
 * All writes use atomic rename to prevent partial-read corruption.
 */
export class SpecialistStore {
  constructor() {
    fs.mkdirSync(SPECIALISTS_DIR, { recursive: true });
  }

  /**
   * Validates a specialist ID.
   * @returns An error message if invalid, or `null` if valid.
   */
  validateId(id: string): string | null {
    if (!id) return 'Specialist ID cannot be empty.';
    if (!ID_PATTERN.test(id))
      return 'Specialist ID must be 1–60 characters, lowercase alphanumeric and hyphens, cannot start or end with a hyphen.';
    if (RESERVED_NAMES.has(id)) return `"${id}" is a reserved command name.`;
    return null;
  }

  /** Returns all specialists sorted alphabetically by ID, skipping corrupt files. */
  list(): Specialist[] {
    if (!fs.existsSync(SPECIALISTS_DIR)) return [];
    const files = fs.readdirSync(SPECIALISTS_DIR).filter((f) => f.endsWith('.json'));
    const specialists: Specialist[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(SPECIALISTS_DIR, file), 'utf-8');
        specialists.push(JSON.parse(raw) as Specialist);
      } catch {
        // skip corrupt files
      }
    }
    return specialists.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Returns a single specialist by ID, or `undefined` if not found. */
  get(id: string): Specialist | undefined {
    const filePath = path.join(SPECIALISTS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Specialist;
    } catch {
      return undefined;
    }
  }

  /** Returns true if a specialist with the given ID exists on disk. */
  exists(id: string): boolean {
    return fs.existsSync(path.join(SPECIALISTS_DIR, `${id}.json`));
  }

  /**
   * Creates a new specialist and persists it.
   * @throws {Error} If the ID is invalid, reserved, already taken, or the max limit is reached.
   */
  create(
    id: string,
    name: string,
    description: string,
    systemPrompt: string,
    guidelines: string[] = [],
  ): Specialist {
    const idError = this.validateId(id);
    if (idError) throw new Error(idError);
    if (this.exists(id)) throw new Error(`Specialist "${id}" already exists.`);
    const count = this.list().length;
    if (count >= MAX_SPECIALISTS) throw new Error(`Maximum of ${MAX_SPECIALISTS} specialists reached.`);

    const now = new Date().toISOString();
    const specialist: Specialist = {
      id,
      name,
      description,
      systemPrompt,
      guidelines,
      createdAt: now,
      updatedAt: now,
    };
    this.atomicWrite(path.join(SPECIALISTS_DIR, `${id}.json`), JSON.stringify(specialist, null, 2));
    return specialist;
  }

  /**
   * Updates an existing specialist with partial fields.
   * @returns The updated specialist, or `undefined` if not found.
   */
  update(
    id: string,
    updates: Partial<Pick<Specialist, 'name' | 'description' | 'systemPrompt' | 'guidelines'>>,
  ): Specialist | undefined {
    const specialist = this.get(id);
    if (!specialist) return undefined;
    if (updates.name !== undefined) specialist.name = updates.name;
    if (updates.description !== undefined) specialist.description = updates.description;
    if (updates.systemPrompt !== undefined) specialist.systemPrompt = updates.systemPrompt;
    if (updates.guidelines !== undefined) specialist.guidelines = updates.guidelines;
    specialist.updatedAt = new Date().toISOString();
    this.atomicWrite(
      path.join(SPECIALISTS_DIR, `${id}.json`),
      JSON.stringify(specialist, null, 2),
    );
    return specialist;
  }

  /** Removes a specialist by ID. Returns `true` if it existed and was deleted. */
  delete(id: string): boolean {
    const filePath = path.join(SPECIALISTS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /** Returns id + name + description for all specialists, for system prompt injection. */
  getSummaries(): SpecialistSummary[] {
    return this.list().map(({ id, name, description }) => ({ id, name, description }));
  }

  /** Writes data to a `.tmp` file then renames it into place for crash-safe persistence. */
  private atomicWrite(filePath: string, data: string): void {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, filePath);
  }
}
