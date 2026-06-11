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

/** True when `id` names a bundled (protected) specialist. */
export function isBuiltinSpecialist(id: string): boolean {
  return roleOf(id) === 'builtin';
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
