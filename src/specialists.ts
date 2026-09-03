import * as fs from 'node:fs';
import * as path from 'node:path';
import { SPECIALISTS_DIR } from './paths.js';
import { RESERVED_NAMES } from './reserved-names.js';
import {
  atomicWriteFileSync,
  seedOnce,
  seedBundledJsonDir,
  copyBundledJsonIfAbsent,
} from './fs-utils.js';
import {
  findBuiltinSpecialistsDir,
  assertCanDeleteSpecialist,
  assertCanEditSpecialist,
} from './specialist-authority.js';
import type { ModelParams } from './providers/model-params.js';
import type { RoleId } from './model-roles.js';

// Re-exported so existing importers (e.g. the `/specialists` UI grouping) keep
// resolving it from this module; the authoritative definition lives in
// `specialist-authority.ts`.
export { getBuiltinSpecialistIds } from './specialist-authority.js';

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
  /**
   * What this specialist is FOR, in model-selection terms (#423).
   *
   * A `RoleId` — `executor`, `function-caller`, `summarizer`, … — not a vendor
   * and not a model. `resolveSiteModel` maps role → tier → the active lineup's
   * slot, so a role says "whatever the user's current profile considers right
   * for this kind of work" and keeps meaning that when the profile changes.
   *
   * **This is what an agent building a specialist should choose**, precisely
   * because a persisted `provider`/`model` is the thing the off-lineup pin
   * guard exists to drop — and a pin an agent minted itself is the most
   * confusing kind, since nobody chose it.
   *
   * Ranks BELOW an explicit pin and ABOVE the dispatching site's default, so
   * a user who pinned a model keeps it. Absent = the site decides, i.e. today.
   */
  role?: RoleId;
  /**
   * Optional generation parameters applied when this specialist's pinned
   * `provider`/`model` resolves (issue #286). Absent = model defaults. Keyed
   * by {@link ParamDescriptor.id}; serialized by `serializeModelParams`.
   */
  params?: ModelParams;
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
  /**
   * When true the specialist is kept on disk and shown in `/specialists` but
   * excluded from dispatch: `getSummaries()` omits it (so it leaves the system
   * prompt and the auto-matcher), and `specialist_run` / `tool_wrapper_run`
   * refuse to invoke it. Toggle from the `/specialists` menu.
   */
  disabled?: boolean;
}

export interface SpecialistSummary {
  id: string;
  name: string;
  description: string;
  provider?: string;
  model?: string;
  params?: ModelParams;
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
  /** See {@link Specialist.role}. Prefer this over a `provider`/`model` pin. */
  role?: RoleId;
  params?: ModelParams;
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
    | 'role'
    | 'params'
    | 'kind'
    | 'targetTools'
    | 'goodExamples'
    | 'badExamples'
    | 'structuredOutput'
    | 'disabled'
  >
>;

const MAX_SPECIALISTS = 50;

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** Marker file that prevents re-seeding bundled specialists on every start. */
const SEED_MARKER = '.seeded-v1';

/**
 * Bundled specialists added after the original `.seeded-v1` set. Seeded
 * additively (each via its own marker) so existing installs pick them up
 * without a v1-marker bump that would resurrect user-deleted v1 specialists.
 */
const POST_V1_BUNDLED = ['mcp-manager.json', 'research-agent.json'];

/**
 * Disk-backed store for named specialists (reusable expert profiles).
 *
 * Each specialist is stored as a separate JSON file under `SPECIALISTS_DIR`.
 * All writes use atomic rename to prevent partial-read corruption.
 */
export class SpecialistStore {
  constructor(opts?: { seed?: boolean }) {
    fs.mkdirSync(SPECIALISTS_DIR, { recursive: true });
    if (opts?.seed !== false) this.seedBundledSpecialists();
  }

  /**
   * Copies bundled specialists (shell-wrapper, file-wrapper, web-wrapper,
   * correction-agent, specialist-creator, mcp-manager) from the packaged
   * `builtin-specialists` directory into the user's specialists dir on first
   * run. A `.seeded-v1` marker prevents re-seeding on subsequent runs; existing
   * files with the same id are never overwritten.
   *
   * Bundled specialists are protected at runtime — see `specialist-authority.ts`
   * — so they cannot be deleted or edited through the store. The correction
   * flow may still append learned examples to them via {@link appendExamples}.
   */
  private seedBundledSpecialists(): void {
    const bundledDir = findBuiltinSpecialistsDir();
    if (!bundledDir) return;

    // First-run seed of the original bundle. Gated by `.seeded-v1` so users
    // can freely edit OR delete these without them coming back.
    seedBundledJsonDir(bundledDir, SPECIALISTS_DIR, path.join(SPECIALISTS_DIR, SEED_MARKER));

    try {
      // Additive seed for specialists shipped AFTER `.seeded-v1`. Each gets its
      // own marker so existing installs receive the new file without the v1
      // marker bump that would resurrect a v1 specialist the user deleted on
      // purpose. (If the user later deletes one of these, its marker keeps it
      // from returning.)
      for (const file of POST_V1_BUNDLED) {
        seedOnce(path.join(SPECIALISTS_DIR, `.seeded-${file.replace(/\.json$/, '')}`), () =>
          copyBundledJsonIfAbsent(bundledDir, SPECIALISTS_DIR, file),
        );
      }
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
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.params !== undefined ? { params: input.params } : {}),
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

  /** Stamps `updatedAt` and atomically persists a specialist record. */
  private writeRecord(specialist: Specialist): void {
    specialist.updatedAt = new Date().toISOString();
    atomicWriteFileSync(
      path.join(SPECIALISTS_DIR, `${specialist.id}.json`),
      JSON.stringify(specialist, null, 2),
    );
  }

  /**
   * Updates an existing specialist with partial fields.
   * @returns The updated specialist, or `undefined` if not found.
   * @throws {ProtectedSpecialistError} If `id` is a bundled specialist — its
   *   definition and enable/disable state are frozen (see specialist-authority).
   */
  update(id: string, updates: SpecialistUpdates): Specialist | undefined {
    if (!ID_PATTERN.test(id)) return undefined;
    const specialist = this.get(id);
    if (!specialist) return undefined;
    // Authoritative gate: bundled specialists are read-only. The learned-example
    // channel (appendExamples) bypasses update() so correction can still teach
    // bundled wrappers without opening the definition to edits.
    assertCanEditSpecialist(id);
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
    // `''` clears the role, matching how provider/model clear — `undefined`
    // means "don't change", so there has to be a way to say "remove it".
    if (updates.role !== undefined) {
      if ((updates.role as string) === '') {
        delete specialist.role;
      } else {
        specialist.role = updates.role;
      }
    }
    // An empty object clears params; undefined means "don't change".
    if (updates.params !== undefined) {
      if (Object.keys(updates.params).length === 0) {
        delete specialist.params;
      } else {
        specialist.params = updates.params;
      }
    }
    if (updates.kind !== undefined) specialist.kind = updates.kind;
    if (updates.targetTools !== undefined) specialist.targetTools = updates.targetTools;
    if (updates.goodExamples !== undefined) specialist.goodExamples = updates.goodExamples;
    if (updates.badExamples !== undefined) specialist.badExamples = updates.badExamples;
    if (updates.structuredOutput !== undefined)
      specialist.structuredOutput = updates.structuredOutput;
    // Store `disabled` only when true so an enabled record stays clean on disk.
    if (updates.disabled !== undefined) {
      if (updates.disabled) specialist.disabled = true;
      else delete specialist.disabled;
    }
    this.writeRecord(specialist);
    return specialist;
  }

  /**
   * Appends one good and one bad example to a specialist, dropping the oldest
   * entries once the list exceeds {@link MAX_EXAMPLES_PER_LIST}. Used by the
   * correction agent after a validated fix.
   *
   * This is the sanctioned learned-example channel and deliberately bypasses
   * the {@link update} definition guard, so the correction flow may still teach
   * bundled (protected) wrappers — appending examples only, never touching the
   * definition or enable/disable state.
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
    specialist.goodExamples = goodList;
    specialist.badExamples = badList;
    this.writeRecord(specialist);
    return specialist;
  }

  /**
   * Removes a specialist by ID. Returns `true` if it existed and was deleted.
   * @throws {ProtectedSpecialistError} If `id` is a bundled specialist.
   */
  delete(id: string): boolean {
    if (!ID_PATTERN.test(id)) return false;
    // Authoritative gate: bundled specialists cannot be deleted.
    assertCanDeleteSpecialist(id);
    const filePath = path.join(SPECIALISTS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /**
   * Returns id + name + description + optional model info for all *enabled*
   * specialists, for system-prompt injection and the auto-matcher. Disabled
   * specialists are excluded here so they drop out of dispatch while still
   * appearing in `list()` (and thus the `/specialists` menu).
   */
  getSummaries(): SpecialistSummary[] {
    return this.list()
      .filter((s) => !s.disabled)
      .map(({ id, name, description, provider, model, params, kind }) => ({
        id,
        name,
        description,
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(params !== undefined ? { params } : {}),
        ...(kind !== undefined ? { kind } : {}),
      }));
  }
}
