import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROUTINES_DIR } from './paths.js';

export interface Routine {
  id: string;
  name: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineSummary {
  id: string;
  name: string;
  description: string;
}

const MAX_ROUTINES = 100;

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

const RESERVED_NAMES = new Set([
  'help',
  'clear',
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
]);

/**
 * Disk-backed store for named routines (reusable multi-step workflows).
 *
 * Each routine is stored as a separate JSON file under `ROUTINES_DIR`.
 * All writes use atomic rename to prevent partial-read corruption.
 */
export class RoutineStore {
  constructor() {
    fs.mkdirSync(ROUTINES_DIR, { recursive: true });
  }

  /**
   * Validates a routine ID.
   * @returns An error message if invalid, or `null` if valid.
   */
  validateId(id: string): string | null {
    if (!id) return 'Routine ID cannot be empty.';
    if (!ID_PATTERN.test(id))
      return 'Routine ID must be 1–60 characters, lowercase alphanumeric and hyphens, cannot start or end with a hyphen.';
    if (RESERVED_NAMES.has(id)) return `"${id}" is a reserved command name.`;
    return null;
  }

  /** Returns all routines sorted alphabetically by ID, skipping corrupt files. */
  list(): Routine[] {
    if (!fs.existsSync(ROUTINES_DIR)) return [];
    const files = fs.readdirSync(ROUTINES_DIR).filter((f) => f.endsWith('.json'));
    const routines: Routine[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(ROUTINES_DIR, file), 'utf-8');
        routines.push(JSON.parse(raw) as Routine);
      } catch {
        // skip corrupt files
      }
    }
    return routines.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Returns a single routine by ID, or `undefined` if not found. */
  get(id: string): Routine | undefined {
    const filePath = path.join(ROUTINES_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Routine;
    } catch {
      return undefined;
    }
  }

  /** Returns true if a routine with the given ID exists on disk. */
  exists(id: string): boolean {
    return fs.existsSync(path.join(ROUTINES_DIR, `${id}.json`));
  }

  /**
   * Creates a new routine and persists it.
   * @throws {Error} If the ID is invalid, reserved, already taken, or the max limit is reached.
   */
  create(id: string, name: string, description: string, content: string): Routine {
    const idError = this.validateId(id);
    if (idError) throw new Error(idError);
    if (this.exists(id)) throw new Error(`Routine "${id}" already exists.`);
    const count = this.list().length;
    if (count >= MAX_ROUTINES) throw new Error(`Maximum of ${MAX_ROUTINES} routines reached.`);

    const now = new Date().toISOString();
    const routine: Routine = { id, name, description, content, createdAt: now, updatedAt: now };
    this.atomicWrite(path.join(ROUTINES_DIR, `${id}.json`), JSON.stringify(routine, null, 2));
    return routine;
  }

  /**
   * Updates an existing routine with partial fields.
   * @returns The updated routine, or `undefined` if not found.
   */
  update(
    id: string,
    updates: Partial<Pick<Routine, 'name' | 'description' | 'content'>>,
  ): Routine | undefined {
    const routine = this.get(id);
    if (!routine) return undefined;
    if (updates.name !== undefined) routine.name = updates.name;
    if (updates.description !== undefined) routine.description = updates.description;
    if (updates.content !== undefined) routine.content = updates.content;
    routine.updatedAt = new Date().toISOString();
    this.atomicWrite(path.join(ROUTINES_DIR, `${id}.json`), JSON.stringify(routine, null, 2));
    return routine;
  }

  /** Removes a routine by ID. Returns `true` if it existed and was deleted. */
  delete(id: string): boolean {
    const filePath = path.join(ROUTINES_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /** Returns id + name + description for all routines, for system prompt injection. */
  getSummaries(): RoutineSummary[] {
    return this.list().map(({ id, name, description }) => ({ id, name, description }));
  }

  /** Writes data to a `.tmp` file then renames it into place for crash-safe persistence. */
  private atomicWrite(filePath: string, data: string): void {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, filePath);
  }
}
