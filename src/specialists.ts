import * as fs from 'node:fs';
import * as path from 'node:path';
import { SPECIALISTS_DIR } from './paths.js';
import { RESERVED_NAMES } from './reserved-names.js';
import { atomicWriteFileSync } from './fs-utils.js';

/** Specialist category. `persona` is the historical default; `tool-wrapper` specialists front a concrete tool or CLI; `meta` specialists operate on other specialists (e.g. specialist-creator, correction-agent). */
export type SpecialistKind = 'persona' | 'tool-wrapper' | 'meta';

export interface SpecialistExample {
  /** User-facing request or scenario that triggered this call. */
  input: string;
  /** The tool invocation that was made (stringified for readability, e.g. `shell { command: "ls -la" }`). */
  call: string;
  /** Optional short note explaining why this is a good/bad example. */
  note?: string;
}

export interface SpecialistBadExample extends SpecialistExample {
  /** The error or misbehavior observed when the call ran. */
  error: string;
  /** The corrected call or approach that should be taken instead. */
  fix: string;
}

export interface Specialist {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  guidelines: string[];
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  /** Optional. Defaults to 'persona' for back-compat. */
  kind?: SpecialistKind;
  /** For tool-wrapper/meta specialists, the tool names exposed to the child agent. */
  targetTools?: string[];
  /** Correct usage patterns used for few-shot priming. */
  goodExamples?: SpecialistExample[];
  /** Failed usage patterns with their corrected form. */
  badExamples?: SpecialistBadExample[];
  /** When true, the child agent must emit a JSON `{status, result, error?, reasoning?}` object as its final message. */
  structuredOutput?: boolean;
}

export interface SpecialistSummary {
  id: string;
  name: string;
  description: string;
  provider?: string;
  model?: string;
  kind?: SpecialistKind;
}

/** Maximum examples retained per list (oldest drop-off during correction updates). */
export const MAX_EXAMPLES_PER_LIST = 10;

export interface CreateSpecialistInput {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  guidelines?: string[];
  provider?: string;
  model?: string;
  kind?: SpecialistKind;
  targetTools?: string[];
  goodExamples?: SpecialistExample[];
  badExamples?: SpecialistBadExample[];
  structuredOutput?: boolean;
}

export type SpecialistUpdates = Partial<
  Pick<
    Specialist,
    | 'name'
    | 'description'
    | 'systemPrompt'
    | 'guidelines'
    | 'provider'
    | 'model'
    | 'kind'
    | 'targetTools'
    | 'goodExamples'
    | 'badExamples'
    | 'structuredOutput'
  >
>;

const MAX_SPECIALISTS = 50;

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** Marker file that prevents re-seeding bundled specialists on every start. */
const SEED_MARKER = '.seeded-v1';

/**
 * Locates the bundled `builtin-specialists` directory sitting next to the
 * compiled/loaded `specialists.js` (or `.ts` under tsx). Returns `null` when
 * running in an environment where the bundle was not deployed (e.g. certain
 * test harnesses).
 */
function findBuiltinSpecialistsDir(): string | null {
  const candidate = path.join(__dirname, 'builtin-specialists');
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    // fall through
  }
  return null;
}

let cachedBuiltinIds: Set<string> | null = null;

/**
 * Returns the set of specialist IDs that ship bundled with Bernard. Used to
 * distinguish seeded specialists from user-authored ones in the UI. Result is
 * cached after the first call — the bundle is packaged alongside the binary
 * and does not change at runtime.
 */
export function getBuiltinSpecialistIds(): Set<string> {
  if (cachedBuiltinIds) return cachedBuiltinIds;
  const ids = new Set<string>();
  const bundledDir = findBuiltinSpecialistsDir();
  if (!bundledDir) {
    cachedBuiltinIds = ids;
    return ids;
  }
  try {
    for (const file of fs.readdirSync(bundledDir)) {
      if (file.endsWith('.json')) ids.add(file.replace(/\.json$/, ''));
    }
  } catch {
    // fall through with whatever we collected
  }
  cachedBuiltinIds = ids;
  return ids;
}

/**
 * Disk-backed store for named specialists (reusable expert profiles).
 *
 * Each specialist is stored as a separate JSON file under `SPECIALISTS_DIR`.
 * All writes use atomic rename to prevent partial-read corruption.
 */
export class SpecialistStore {
  constructor() {
    fs.mkdirSync(SPECIALISTS_DIR, { recursive: true });
    this.seedBundledSpecialists();
  }

  /**
   * Copies bundled specialists (shell-wrapper, file-wrapper, web-wrapper,
   * correction-agent, specialist-creator) from the packaged `builtin-specialists`
   * directory into the user's specialists dir on first run. A `.seeded-v1`
   * marker prevents re-seeding on subsequent runs, so users can freely edit or
   * delete the seeded files. Existing files with the same id are never
   * overwritten.
   */
  private seedBundledSpecialists(): void {
    const markerPath = path.join(SPECIALISTS_DIR, SEED_MARKER);
    if (fs.existsSync(markerPath)) return;
    const bundledDir = findBuiltinSpecialistsDir();
    if (!bundledDir) return;

    try {
      const files = fs.readdirSync(bundledDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const src = path.join(bundledDir, file);
        const dest = path.join(SPECIALISTS_DIR, file);
        if (fs.existsSync(dest)) continue; // never overwrite user-edited copies
        try {
          const raw = fs.readFileSync(src, 'utf-8');
          // Parse once to catch obviously corrupt bundle files before seeding.
          JSON.parse(raw);
          atomicWriteFileSync(dest, raw);
        } catch {
          // skip individual bad files; continue seeding the rest
        }
      }
      fs.writeFileSync(markerPath, new Date().toISOString(), 'utf-8');
    } catch {
      // seed is best-effort; never block startup
    }
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
    if (!ID_PATTERN.test(id)) return undefined;
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
    if (!ID_PATTERN.test(id)) return false;
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
    provider?: string,
    model?: string,
  ): Specialist {
    return this.createFull({ id, name, description, systemPrompt, guidelines, provider, model });
  }

  /**
   * Creates a new specialist from a full input object, supporting tool-wrapper
   * fields (kind, targetTools, good/bad examples, structuredOutput).
   * @throws {Error} If the ID is invalid, reserved, already taken, or the max limit is reached.
   */
  createFull(input: CreateSpecialistInput): Specialist {
    const idError = this.validateId(input.id);
    if (idError) throw new Error(idError);
    if (this.exists(input.id)) throw new Error(`Specialist "${input.id}" already exists.`);
    const count = this.list().length;
    if (count >= MAX_SPECIALISTS)
      throw new Error(`Maximum of ${MAX_SPECIALISTS} specialists reached.`);

    const now = new Date().toISOString();
    const specialist: Specialist = {
      id: input.id,
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      guidelines: input.guidelines ?? [],
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.targetTools !== undefined ? { targetTools: input.targetTools } : {}),
      ...(input.goodExamples !== undefined ? { goodExamples: input.goodExamples } : {}),
      ...(input.badExamples !== undefined ? { badExamples: input.badExamples } : {}),
      ...(input.structuredOutput !== undefined ? { structuredOutput: input.structuredOutput } : {}),
      createdAt: now,
      updatedAt: now,
    };
    atomicWriteFileSync(
      path.join(SPECIALISTS_DIR, `${input.id}.json`),
      JSON.stringify(specialist, null, 2),
    );
    return specialist;
  }

  /**
   * Updates an existing specialist with partial fields.
   * @returns The updated specialist, or `undefined` if not found.
   */
  update(id: string, updates: SpecialistUpdates): Specialist | undefined {
    if (!ID_PATTERN.test(id)) return undefined;
    const specialist = this.get(id);
    if (!specialist) return undefined;
    if (updates.name !== undefined) specialist.name = updates.name;
    if (updates.description !== undefined) specialist.description = updates.description;
    if (updates.systemPrompt !== undefined) specialist.systemPrompt = updates.systemPrompt;
    if (updates.guidelines !== undefined) specialist.guidelines = updates.guidelines;
    // Empty string clears the override; undefined means "don't change"
    if (updates.provider !== undefined) {
      if (updates.provider === '') {
        delete specialist.provider;
      } else {
        specialist.provider = updates.provider;
      }
    }
    if (updates.model !== undefined) {
      if (updates.model === '') {
        delete specialist.model;
      } else {
        specialist.model = updates.model;
      }
    }
    if (updates.kind !== undefined) specialist.kind = updates.kind;
    if (updates.targetTools !== undefined) specialist.targetTools = updates.targetTools;
    if (updates.goodExamples !== undefined) specialist.goodExamples = updates.goodExamples;
    if (updates.badExamples !== undefined) specialist.badExamples = updates.badExamples;
    if (updates.structuredOutput !== undefined)
      specialist.structuredOutput = updates.structuredOutput;
    specialist.updatedAt = new Date().toISOString();
    atomicWriteFileSync(
      path.join(SPECIALISTS_DIR, `${id}.json`),
      JSON.stringify(specialist, null, 2),
    );
    return specialist;
  }

  /**
   * Appends one good and one bad example to a specialist, dropping the oldest
   * entries once the list exceeds {@link MAX_EXAMPLES_PER_LIST}. Used by the
   * correction agent after a validated fix.
   * @returns The updated specialist, or `undefined` if not found.
   */
  appendExamples(
    id: string,
    good?: SpecialistExample,
    bad?: SpecialistBadExample,
  ): Specialist | undefined {
    const specialist = this.get(id);
    if (!specialist) return undefined;
    const goodList = [...(specialist.goodExamples ?? [])];
    const badList = [...(specialist.badExamples ?? [])];
    if (good) {
      goodList.push(good);
      while (goodList.length > MAX_EXAMPLES_PER_LIST) goodList.shift();
    }
    if (bad) {
      badList.push(bad);
      while (badList.length > MAX_EXAMPLES_PER_LIST) badList.shift();
    }
    return this.update(id, { goodExamples: goodList, badExamples: badList });
  }

  /** Removes a specialist by ID. Returns `true` if it existed and was deleted. */
  delete(id: string): boolean {
    if (!ID_PATTERN.test(id)) return false;
    const filePath = path.join(SPECIALISTS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /** Returns id + name + description + optional model info for all specialists, for system prompt injection. */
  getSummaries(): SpecialistSummary[] {
    return this.list().map(({ id, name, description, provider, model, kind }) => ({
      id,
      name,
      description,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(kind !== undefined ? { kind } : {}),
    }));
  }
}
