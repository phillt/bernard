/**
 * @module specialist-authority
 *
 * The authoritative layer governing what may be done to a specialist, by role.
 *
 * Bernard ships a set of **bundled** specialists (the `builtin-specialists/`
 * manifest: shell/file/web wrappers, correction-agent, specialist-creator,
 * mcp-manager). These are part of the product surface — the agent relies on
 * them — so they are protected: they cannot be deleted, their definition
 * cannot be edited, and they cannot be enabled/disabled. The single carve-out
 * is that the shutdown correction flow may still append *learned* good/bad
 * examples to them (few-shot priming for the busiest wrappers).
 *
 * Rather than scatter `if (isBundled) throw` checks across every call site,
 * this module is the one source of truth: it resolves a specialist's
 * {@link SpecialistRole}, derives the {@link SpecialistPermissions}, and
 * exposes assert guards that the {@link SpecialistStore} mutation methods call.
 * Because every mutation path (REPL menu, the agent's `specialist` tool, the
 * correction flow) funnels through the store, guarding the store covers them
 * all from one place.
 *
 * Role is resolved AUTHORITATIVELY from the shipped manifest — never from a
 * field on the on-disk JSON, which a user could edit to flip a record to
 * "user-owned" and bypass the protection.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A specialist's authority role. `builtin` specialists ship bundled with
 * Bernard and are protected; `user` specialists are fully mutable.
 */
export type SpecialistRole = 'builtin' | 'user';

export interface SpecialistPermissions {
  role: SpecialistRole;
  /** May the record be deleted? */
  canDelete: boolean;
  /** May definitional fields (prompt, guidelines, tools, name, …) be edited? */
  canEditDefinition: boolean;
  /** May the enable/disable dispatch toggle be flipped? */
  canToggleDisabled: boolean;
  /** May the correction flow append learned good/bad examples? */
  canAppendExamples: boolean;
}

/**
 * Locates the bundled `builtin-specialists` directory sitting next to the
 * compiled/loaded module (or `.ts` under tsx). Returns `null` when running in
 * an environment where the bundle was not deployed.
 */
export function findBuiltinSpecialistsDir(): string | null {
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
 * Returns the set of specialist IDs that ship bundled with Bernard, read from
 * the packaged manifest. Result is cached after the first call — the bundle is
 * packaged alongside the binary and does not change at runtime.
 */
export function getBuiltinSpecialistIds(): Set<string> {
  if (cachedBuiltinIds) return cachedBuiltinIds;
  const ids = new Set<string>();
  const dir = findBuiltinSpecialistsDir();
  if (dir) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.json')) ids.add(file.replace(/\.json$/, ''));
      }
    } catch {
      // fall through with whatever we collected
    }
  }
  cachedBuiltinIds = ids;
  return ids;
}

/** Test hook: drops the cached manifest so a test can vary the bundled set. */
export function _resetBuiltinSpecialistCache(): void {
  cachedBuiltinIds = null;
}

/** Resolves a specialist's role from the shipped manifest. */
export function roleOf(id: string): SpecialistRole {
  return getBuiltinSpecialistIds().has(id) ? 'builtin' : 'user';
}

/** Resolves the full permission set for a specialist id. */
export function permissionsFor(id: string): SpecialistPermissions {
  if (roleOf(id) === 'builtin') {
    return {
      role: 'builtin',
      canDelete: false,
      canEditDefinition: false,
      canToggleDisabled: false,
      // The one carve-out: the correction flow may still teach bundled wrappers.
      canAppendExamples: true,
    };
  }
  return {
    role: 'user',
    canDelete: true,
    canEditDefinition: true,
    canToggleDisabled: true,
    canAppendExamples: true,
  };
}

/**
 * Thrown by {@link SpecialistStore} mutations when an action is not permitted
 * on a protected (bundled) specialist. Carries structured detail so the UI and
 * tool layers can render a precise message.
 */
export class ProtectedSpecialistError extends Error {
  readonly specialistId: string;
  readonly action: 'delete' | 'edit';
  constructor(specialistId: string, action: 'delete' | 'edit') {
    const verb = action === 'delete' ? 'deleted' : 'edited';
    super(
      `"${specialistId}" is a bundled specialist and cannot be ${verb}. ` +
        'Bundled specialists ship with Bernard and are protected (read-only).',
    );
    this.name = 'ProtectedSpecialistError';
    this.specialistId = specialistId;
    this.action = action;
  }
}

/** Throws {@link ProtectedSpecialistError} if `id` is a bundled specialist. */
export function assertCanDeleteSpecialist(id: string): void {
  if (!permissionsFor(id).canDelete) throw new ProtectedSpecialistError(id, 'delete');
}

/**
 * Throws {@link ProtectedSpecialistError} if `id` is a bundled specialist. Used
 * to gate the definitional `update()` path. The learned-example channel
 * ({@link SpecialistStore.appendExamples}) deliberately bypasses this guard, so
 * "edit" here means "change the definition or the enable/disable state".
 */
export function assertCanEditSpecialist(id: string): void {
  if (!permissionsFor(id).canEditDefinition) throw new ProtectedSpecialistError(id, 'edit');
}

/**
 * Where a specialist is being invoked FROM.
 *
 * An applet dispatch is the inverted case: it permits the specialist bound to
 * exactly this `(appId, action)` and refuses everyone else, where a tool
 * dispatch refuses any bound specialist.
 */
export type InvocationVia =
  | { kind: 'tool' }
  | { kind: 'app'; appId: string; action: string }
  | { kind: 'pipeline'; pipeline: string };

/** A refusal reason, or `null` to proceed. */
export interface InvocationRefusal {
  code: 'disabled' | 'bound' | 'pipeline';
  message: string;
}

/**
 * Whether this specialist may be invoked from here — the invocation
 * counterpart to {@link permissionsFor}, which answers the same question for
 * editing.
 *
 * **Written once because it was already drifting.** The `disabled` refusal
 * lived in `specialist_run` and `tool_wrapper_run` only, and an applet action
 * dispatches through `runHeadless` rather than `dispatchToolWrapper` — so a
 * specialist the user disabled in `/specialists` kept running behind every
 * applet button. Adding the `boundTo` gate beside a check that was already
 * missing a door is how three copies become four.
 *
 * The three call sites keep their own error contracts — a prefixed string, a
 * `WrapperResult` envelope, an `InvocationResult` — which is the only thing
 * that legitimately differs between them. The DECISION is here.
 *
 * The discovery half already worked this way: `getSummaries()` filters
 * `disabled` and `boundTo` together at one point.
 */
export function invocationRefusal(
  specialist: {
    id: string;
    disabled?: boolean;
    boundTo?: { appId: string; action: string };
    pipeline?: string;
  },
  via: InvocationVia,
): InvocationRefusal | null {
  if (specialist.disabled) {
    return {
      code: 'disabled',
      message: `Specialist "${specialist.id}" is disabled. Re-enable it from the /specialists menu before invoking it.`,
    };
  }
  /**
   * A stage of a pipeline is not a specialist anybody calls directly.
   *
   * This exists because the applet design pipeline was bypassed in exactly
   * that way: three of its five stages are ordinary roster records, the main
   * agent dispatched them by hand with prose briefs of its own, and the two
   * stages that live ONLY inside the pipeline — the ones that choose button
   * variants and icons — were never reached at all. Neither were the
   * deterministic cross-stage checks, which are code. Zero dispatches, ever.
   *
   * Prose could not prevent that and a description could not either; the
   * records read as invitations because that is what a roster entry is. So
   * the refusal is structural, and it matches `boundTo`'s shape exactly: the
   * record names the one caller that may reach it, and the caller has to say
   * who it is.
   *
   * It carries the pipeline's NAME rather than a boolean so a second pipeline
   * cannot invoke the first one's stages — the same reason `boundTo` matches
   * on both `appId` and `action` rather than on "is bound".
   */
  const pipeline = specialist.pipeline;
  if (pipeline) {
    if (via.kind === 'pipeline' && via.pipeline === pipeline) return null;
    return {
      code: 'pipeline',
      message:
        `Specialist "${specialist.id}" is one stage of the "${pipeline}" pipeline and runs only ` +
        'as part of it. Dispatching a stage by hand skips the stages you did not name and the ' +
        'checks that run between them. Use the pipeline instead.',
    };
  }
  const bound = specialist.boundTo;
  if (!bound) return null;
  if (via.kind === 'app' && bound.appId === via.appId && bound.action === via.action) return null;
  return {
    code: 'bound',
    message: `Specialist "${specialist.id}" is bound to applet action "${bound.appId}/${bound.action}" and can only be invoked through it.`,
  };
}
