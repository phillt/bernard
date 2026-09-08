import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
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
import { debugLog } from './logger.js';

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
  /**
   * The tool names exposed to the child agent — for EVERY kind, since #507.
   *
   * It was wrapper-only in practice rather than by design: `buildChildTools`
   * was reached from `tool_wrapper_run` and applet dispatch, and
   * `specialistDefinition.tools` never read the field, so a `persona` declaring
   * one received the whole worker registry anyway. `createSpecialistTool` still
   * REQUIRES it on a `tool-wrapper`/`meta` (an unscoped one is handed nothing
   * and is inert); on a `persona` it stays optional, and absent means
   * everything the resolved surface allows.
   *
   * An EMPTY array reads as absent on the persona path and as "no tools" on the
   * wrapper path. Not an inconsistency: the creation boundary refuses an
   * unscoped wrapper, so `[]` there is unreachable, while personas carry `[]`
   * from before anything read the field at all.
   */
  targetTools?: string[];
  /**
   * Steps this specialist gets, as a fraction of `config.maxSteps` (#508).
   *
   * A ratio rather than a count, so it scales with `BERNARD_MAX_STEPS` instead
   * of fighting it — the same reason `role` is preferred over a `provider`
   * pin. Absent means the dispatching definition's own default (0.5 for both
   * `specialist` and `tool-wrapper`), which is what every record has always
   * had: a constant nobody chose, applied to a one-shot lookup and a
   * twenty-step research run alike.
   *
   * Validated at resolution, never trusted — see `dispatch-profile.ts`.
   */
  stepRatio?: number;
  /**
   * The execution strategy this specialist wants (#508).
   *
   * `'react'` opts a specialist into the think → act → evaluate loop with plan
   * enforcement; `'normal'` pins it to a single pass. Absent keeps what the
   * dispatching definition does today, which for `specialist` is
   * `coordinatorMode`-dependent and for `tool-wrapper` is always Normal — so a
   * wrapper that genuinely needs to plan had no way to say so.
   *
   * Rides `BuildStrategyOpts.strategyId`, the seam #167 already built for
   * per-turn variation, rather than a second mechanism.
   */
  strategy?: 'normal' | 'react';
  /**
   * Which built-in tool registry this specialist is scoped to (#508).
   *
   * `'worker'` drops the tools a dispatched worker has no business using
   * (`routine`, `lineup_edit`, `specialist`, the `cron` family, MCP config);
   * `'full'` keeps them. Absent derives from `historyMode`, i.e. `'worker'` for
   * every dispatched specialist — and the only exception in the tree today is
   * `tool-wrapper`'s hardcoded `'full'`, chosen for three bundled wrappers and
   * therefore applied to every wrapper anyone has since written.
   *
   * Narrowing here is free; widening is a real grant, and it is bounded by
   * {@link targetTools}, which is a fence for every kind since #507.
   */
  toolSurface?: 'full' | 'worker';
  /**
   * Memory keys this specialist may read and write (#511).
   *
   * Exact keys, or prefixes ending in `*`. Absent means unscoped, which is what
   * every record has today and what keeps this change a capability rather than
   * a migration. **An empty array is honoured as deny-all**, which diverges
   * from `targetToolsScopeError`'s rejection of `targetTools: []` — correctly,
   * because "no tools" is incoherent while "verify against the task and nothing
   * else" is a coherent posture. Validated at resolution, never trusted.
   *
   * **Not on `CreateSpecialistInput`, deliberately.** The `specialist` tool's
   * schema does not expose it — `SpecialistUpdates` clears a field with a
   * sentinel and an array has none that is not already meaningful, since `[]`
   * must mean deny-all and so cannot also mean clear. Day-one authoring is
   * hand-edited JSON, which goes through this type; adding the field to the
   * create input would leave a plumbed-looking route nobody can reach and
   * would read as "already done" to whoever lands the authoring surface.
   */
  memoryScope?: string[];
  /**
   * RAG domains this specialist may retrieve from (#511).
   *
   * Validated against the domain registry. Absent means unscoped.
   */
  knowledgeScope?: string[];
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
  /**
   * Binds this specialist to one applet action (#423), so it is reachable
   * only through that capability and never as a free-floating specialist.
   *
   * Enforced at the three dispatch chokepoints — `specialist_run` and
   * `tool_wrapper_run` refuse a bound record outright, and an app dispatch
   * permits it only for the matching `(appId, action)`. `getSummaries()`
   * omits it too, so the main agent is never advised to dispatch something it
   * would then be refused for. It stays in `list()`, and therefore in
   * `/specialists`: a user must be able to see what an applet is running.
   *
   * Settable at create, and via `update` **only on a record that is not yet
   * bound**. The property that matters is that a model cannot RE-bind — that
   * would steal a specialist from the applet it belongs to, which is a model
   * writing a policy field. Binding one it just created is the ordinary flow,
   * and forbidding it outright made the builder's own loop impossible:
   * validation goes through `tool_wrapper_run`, which refuses a bound record,
   * so a create-bound specialist could never be validated by execution.
   */
  boundTo?: { appId: string; action: string };
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
  /** See {@link Specialist.stepRatio}. */
  stepRatio?: number;
  /** See {@link Specialist.strategy}. */
  strategy?: 'normal' | 'react';
  /** See {@link Specialist.toolSurface}. */
  toolSurface?: 'full' | 'worker';
  goodExamples?: SpecialistExample[];
  badExamples?: SpecialistBadExample[];
  structuredOutput?: boolean;
  /** See {@link Specialist.boundTo}. Create-only, deliberately. */
  boundTo?: { appId: string; action: string };
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
    | 'boundTo'
    | 'params'
    | 'kind'
    | 'targetTools'
    | 'goodExamples'
    | 'badExamples'
    | 'structuredOutput'
    | 'disabled'
  >
> & {
  /**
   * `''` clears the role, the way `''` clears `provider`/`model` — those are
   * typed `string` so they get it for free, while `RoleId` has to say so.
   */
  role?: RoleId | '';
  /**
   * The three execution fields (#508) carry the same sentinel, for the same
   * reason: `undefined` means "don't change", so removing a declaration needs
   * a value that says so. `0` is out of {@link Specialist.stepRatio}'s valid
   * range and `''` is not a member of either union, so neither sentinel can
   * collide with a real declaration.
   */
  stepRatio?: number;
  strategy?: 'normal' | 'react' | '';
  toolSurface?: 'full' | 'worker' | '';
};

const MAX_SPECIALISTS = 50;

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** Marker file that prevents re-seeding bundled specialists on every start. */
const SEED_MARKER = '.seeded-v1';

/** Prefix of the single bundle-definition marker. See `refreshBundledDefinitions`. */
const DEFINITION_MARKER_PREFIX = '.definitions-';

/**
 * Bundled specialists added after the original `.seeded-v1` set. Seeded
 * additively (each via its own marker) so existing installs pick them up
 * without a v1-marker bump that would resurrect user-deleted v1 specialists.
 */
export const POST_V1_BUNDLED = [
  'mcp-manager.json',
  'research-agent.json',
  'agent-builder.json',
  'applet-styler.json',
  'applet-reviewer.json',
  'applet-architect.json',
  'applet-ux-planner.json',
  'applet-data-planner.json',
];

/**
 * The fields a bundled record's SHIPPED copy owns, and the ones it does not.
 *
 * Everything not listed here is the user's install: `goodExamples` and
 * `badExamples` are written by the correction flow — the one channel
 * `permissionsFor` deliberately leaves open on a bundled record — and
 * `createdAt` / `disabled` are facts about this machine.
 */
const LEARNED_FIELDS = ['goodExamples', 'badExamples', 'createdAt', 'disabled'] as const;

/**
 * Merges a shipped bundled record over an installed one, keeping what was
 * learned (#519).
 *
 * **Bundled specialists could not be updated at all**, and that is the blocker
 * #519 does not name. `copyBundledJsonIfAbsent` returns early when the file
 * exists — "never overwrite a user-edited copy" — `seedOnce` returns early once
 * its marker is written, and `permissionsFor` gives builtins
 * `canEditDefinition: false`, so there is no runtime path either. Editing
 * `specialist-creator.json` in place therefore reaches **only fresh installs**.
 * A `-v2` filename plus a `POST_V1_BUNDLED` entry reaches an existing one, but
 * leaves the old record on disk beside it: two creators with one job, which is
 * worse than the divergence being fixed.
 *
 * Overwriting is safe here precisely BECAUSE of the authority model rather than
 * in spite of it: `canEditDefinition: false` means a user cannot legitimately
 * have edited the definition, and `appendExamples` is the one carve-out — which
 * is exactly what this preserves.
 *
 * Pure and exported so the merge rule can be tested without a filesystem —
 * which it briefly was not: it stamped `updatedAt` itself, taking on
 * `writeRecord`'s job and becoming non-deterministic in the process. The write
 * side owns that.
 */
export function mergeBundledDefinition(
  shipped: Record<string, unknown>,
  installed: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...shipped };
  for (const field of LEARNED_FIELDS) {
    if (installed[field] !== undefined) merged[field] = installed[field];
    else delete merged[field];
  }
  return merged;
}

/** True when the shipped DEFINITION differs from what is installed. */
function definitionDiffers(
  shipped: Record<string, unknown>,
  installed: Record<string, unknown>,
): boolean {
  const strip = (r: Record<string, unknown>): string => {
    const copy = { ...r };
    for (const field of LEARNED_FIELDS) delete copy[field];
    delete copy.updatedAt;
    // Key order is not a difference. `JSON.stringify` over sorted keys is
    // enough here — these records are one level of plain values plus arrays,
    // and the arrays that matter are all in LEARNED_FIELDS.
    return JSON.stringify(copy, Object.keys(copy).sort());
  };
  return strip(shipped) !== strip(installed);
}

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
      this.refreshBundledDefinitions(bundledDir);
    } catch {
      // seed is best-effort; never block startup
    }
  }

  /**
   * Re-seeds the DEFINITION half of an installed bundled record when the
   * shipped copy has changed (#519).
   *
   * This is what makes a fix to a bundled prompt reach an existing install
   * instead of accumulating `-v2` files. Keyed on a hash of the shipped bytes,
   * so it runs once per shipped change and never on an unchanged one — and the
   * marker is per id, so one record's edit does not re-write another's.
   *
   * Only records that already EXIST are touched. A bundled specialist the user
   * deleted stays deleted: `POST_V1_BUNDLED`'s own markers already carry that
   * promise, and quietly resurrecting one here would break it.
   */
  private refreshBundledDefinitions(bundledDir: string): void {
    let files: string[];
    try {
      files = fs.readdirSync(bundledDir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }

    // ONE marker for the whole bundle, keyed on a stat digest of every shipped
    // file. Two reasons, and neither is cosmetic.
    //
    // A per-(id, hash) marker leaves the previous hash's dotfile behind on every
    // shipped edit, forever, in the directory `list()` and `getSummaries()`
    // `readdir` — unbounded, unlike the `.seeded-<id>` markers it sits beside.
    // And the hash had to come from the file's CONTENT, so the read could not be
    // skipped: 77 KB re-read and SHA-256'd on every seeding construction, which
    // is every REPL start, every `assembleContext`, and the `bernard script`
    // path #452 got down to 17 ms. Measured at 0.202 ms warm.
    //
    // Stat metadata instead of bytes: contents cannot change without `mtimeMs`
    // or `size` moving in any realistic install, which is the same assumption
    // `MemoryStore`'s read cache already makes and documents. Steady state is
    // now 13 `stat`s and one `existsSync`, with no file read at all.
    const digest = createHash('sha256');
    for (const file of files) {
      try {
        const st = fs.statSync(path.join(bundledDir, file));
        digest.update(`${file}:${st.mtimeMs}:${st.size}\n`);
      } catch {
        return; // Cannot characterise the bundle; leave every record alone.
      }
    }
    const hash = digest.digest('hex').slice(0, 12);
    const marker = path.join(SPECIALISTS_DIR, `${DEFINITION_MARKER_PREFIX}${hash}`);

    seedOnce(marker, () => {
      // Only reached when the bundle moved, so the sweep and the reads below
      // cost nothing in steady state.
      this.pruneDefinitionMarkers(marker);
      for (const file of files) {
        try {
          const dest = path.join(SPECIALISTS_DIR, file);
          if (!fs.existsSync(dest)) continue;
          const shipped = JSON.parse(
            fs.readFileSync(path.join(bundledDir, file), 'utf-8'),
          ) as Record<string, unknown>;
          const installed = JSON.parse(fs.readFileSync(dest, 'utf-8')) as Record<string, unknown>;
          if (!definitionDiffers(shipped, installed)) continue;
          // Through `writeRecord`, the class's own on-disk convention: it
          // stamps `updatedAt`, pretty-prints and writes atomically to
          // `<id>.json`, which this used to re-implement inline. A second copy
          // means the re-seed keeps writing the old shape the day that method
          // gains anything. The filename equals the id by the store's own
          // invariant, so the path is the same either way.
          this.writeRecord(mergeBundledDefinition(shipped, installed) as unknown as Specialist);
          debugLog('specialists:definition-refreshed', { id: file.replace(/\.json$/, ''), hash });
        } catch {
          // Per-file, so one corrupt record cannot stop the rest.
        }
      }
    });
  }

  /** Drops markers from earlier bundle versions, so they cannot accumulate. */
  private pruneDefinitionMarkers(keep: string): void {
    try {
      for (const entry of fs.readdirSync(SPECIALISTS_DIR)) {
        if (!entry.startsWith(DEFINITION_MARKER_PREFIX)) continue;
        const full = path.join(SPECIALISTS_DIR, entry);
        if (full !== keep) fs.unlinkSync(full);
      }
    } catch {
      // Best-effort tidying; never block seeding.
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
      ...(input.stepRatio !== undefined ? { stepRatio: input.stepRatio } : {}),
      ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
      ...(input.toolSurface !== undefined ? { toolSurface: input.toolSurface } : {}),
      ...(input.goodExamples !== undefined ? { goodExamples: input.goodExamples } : {}),
      ...(input.badExamples !== undefined ? { badExamples: input.badExamples } : {}),
      ...(input.structuredOutput !== undefined ? { structuredOutput: input.structuredOutput } : {}),
      ...(input.boundTo !== undefined ? { boundTo: input.boundTo } : {}),
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
   * Applies one optional update, where a sentinel value means "remove this
   * declaration" (#508).
   *
   * `undefined` means "don't change", so every clearable field needs a value
   * that says "clear" — and there were five hand-rolled copies of the same
   * three-line branch, differing only in the sentinel token, which is the shape
   * in which a `0` gets pasted next to a `''`. #508's own roadmap promises more
   * declarable fields, so this is the third edit each one would otherwise need.
   */
  private setOrClear<K extends keyof Specialist>(
    record: Specialist,
    field: K,
    value: Specialist[K] | '' | undefined,
    isClear: (v: NonNullable<typeof value>) => boolean,
  ): void {
    if (value === undefined) return;
    if (isClear(value as NonNullable<typeof value>)) delete record[field];
    else record[field] = value as Specialist[K];
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
    this.setOrClear(specialist, 'provider', updates.provider, (v) => v === '');
    this.setOrClear(specialist, 'model', updates.model, (v) => v === '');
    // One-way: bind an unbound record, never re-bind or unbind. Enforced in
    // the store rather than only at the tool, since this is the property the
    // field exists for.
    if (updates.boundTo !== undefined) {
      if (specialist.boundTo) {
        throw new Error(
          `Specialist "${id}" is already bound to "${specialist.boundTo.appId}/${specialist.boundTo.action}". A binding cannot be changed.`,
        );
      }
      specialist.boundTo = updates.boundTo;
    }
    // `''` clears the role, matching how provider/model clear — `undefined`
    // means "don't change", so there has to be a way to say "remove it".
    this.setOrClear(specialist, 'role', updates.role, (v) => v === '');
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
    const blank = (v: unknown): boolean => v === '';
    this.setOrClear(specialist, 'stepRatio', updates.stepRatio, (v) => v === 0);
    this.setOrClear(specialist, 'strategy', updates.strategy, blank);
    this.setOrClear(specialist, 'toolSurface', updates.toolSurface, blank);
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
   * Returns id + name + description + optional model info for all *enabled,
   * unbound* specialists, for system-prompt injection and the auto-matcher.
   * Disabled and applet-bound specialists are excluded here so they drop out
   * of dispatch while still appearing in `list()` (and thus the
   * `/specialists` menu).
   *
   * This is the single chokepoint for "excluded from dispatch discovery", and
   * its one caller (`src/agent.ts`) feeds BOTH `matchSpecialists` and the
   * `<specialists>` context block. Filtering in the matcher alone would leave
   * a bound specialist advertised in the prompt but unmatchable — inviting a
   * `specialist_run` call that hits the refusal, i.e. a wasted step per turn.
   */
  /**
   * Every specialist bound to one applet action's app.
   *
   * A scan, because `boundTo` is a FIELD and records are addressed by
   * filename — there is no index. It exists for deletion: a specialist bound
   * to a removed app is unreachable by construction (`getSummaries` filters it
   * out of discovery, the dispatch gates refuse it, and `update` refuses
   * re-binding), so without this it would sit on disk forever, invisible and
   * counting against `MAX_SPECIALISTS`.
   */
  listBoundTo(appId: string): Specialist[] {
    return this.list().filter((s) => s.boundTo?.appId === appId);
  }

  getSummaries(): SpecialistSummary[] {
    return this.list()
      .filter((s) => !s.disabled && !s.boundTo)
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
