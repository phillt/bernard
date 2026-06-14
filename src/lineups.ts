/**
 * @module lineups
 *
 * Disk-backed registry of **lineups**. A lineup is a user-named 2D matrix
 * binding `(role, cost-tier) → (provider, model)` (#264). The *cost tier*
 * (`premium / mid / cheap`) is how much model to spend; the *role*
 * (orchestrator, executor, function-caller, summarizer, classifier, coder —
 * see {@link module:model-roles}) is what kind of work the call site does.
 * Each role carries its own `{premium, mid, cheap}` ladder, so a user can give
 * e.g. their `coder` role a top-tier model in performance mode and a cheaper
 * one in token-saving mode.
 *
 * The active profile (`ProfileSettings.activeLineupId`) selects which lineup
 * `resolveSiteModel` consults: `site → role` (static) → `tier`
 * (via `config.modelMode`) → `lineup.roles[role][tier]`.
 *
 * Lineups may freely mix providers — built-in or custom — for any (role, tier)
 * cell. This dissolves the previous "active provider" concept.
 *
 * Storage: `~/.config/bernard/lineups.json`.
 *
 * Lineups themselves are **global**, shared across profiles, just like
 * `custom-providers.json` and `keys.json`. Only the *selection* is profile-
 * scoped.
 *
 * Pre-#264 lineups stored flat top-level `{premium, mid, cheap}` slots; those
 * are auto-migrated on load by replicating each cost slot across all roles
 * (see {@link migrateLineupShape}), so behavior is identical until a user
 * customizes a role.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LINEUPS_PATH } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';
import { getCatalogForProvider } from './providers/catalog.js';
import { deriveTiers } from './providers/tiers.js';
import { BUILTIN_PROVIDERS, type BuiltinProvider } from './providers/types.js';
import { ALL_ROLE_IDS, type RoleId } from './model-roles.js';

/** The three cost-tier slots every role defines. */
export const LINEUP_TIERS = ['premium', 'mid', 'cheap'] as const;
export type LineupTier = (typeof LINEUP_TIERS)[number];

/** One (provider, model) binding for a single tier slot. */
export interface LineupSlot {
  provider: string;
  model: string;
}

/** The `{premium, mid, cheap}` cost ladder for one role. */
export type RoleSlots = Record<LineupTier, LineupSlot>;

/** A single named lineup: a `role → {premium, mid, cheap}` matrix. */
export interface Lineup {
  /** Stable id used for `activeLineupId` lookups. Lowercase slug. */
  id: string;
  /** User-editable display name. */
  name: string;
  /** Per-role cost ladders. Always covers every {@link RoleId}. */
  roles: Record<RoleId, RoleSlots>;
  createdAt: string;
  updatedAt: string;
}

interface LineupsFile {
  lineups: Record<string, Lineup>;
}

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const ID_MAX_LENGTH = 32;
const NAME_MAX_LENGTH = 64;

export const PROVIDER_DISPLAY_NAMES: Record<BuiltinProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
};

/**
 * Last-resort fallback used only when the model catalog has zero entries for a
 * built-in provider (e.g. first run on an offline machine with a broken
 * vendored fallback). Models here mirror the legacy hardcoded `PROVIDER_TIERS`
 * table.
 *
 * Single source of truth for offline-fallback model names — `config.ts`
 * derives its `FALLBACK_PROVIDER_MODELS` lists from this table, so a new
 * model name only ever needs to land here.
 */
export const FALLBACK_TIERS: Record<
  BuiltinProvider,
  { premium: string; mid: string; cheap: string }
> = {
  anthropic: {
    premium: 'claude-opus-4-6',
    mid: 'claude-sonnet-4-5-20250929',
    cheap: 'claude-haiku-4-5-20251001',
  },
  openai: {
    premium: 'gpt-5.2',
    mid: 'gpt-4.1',
    cheap: 'gpt-4.1-mini',
  },
  xai: {
    premium: 'grok-4-1-fast-reasoning',
    mid: 'grok-4-fast-non-reasoning',
    cheap: 'grok-3-mini',
  },
};

export function validateLineupId(id: string): string | null {
  if (!id) return 'Lineup id cannot be empty.';
  if (id.length > ID_MAX_LENGTH) return `Lineup id must be ${ID_MAX_LENGTH} characters or fewer.`;
  if (!ID_PATTERN.test(id))
    return 'Lineup id must start with a lowercase letter and contain only lowercase letters, digits, hyphens, and underscores.';
  return null;
}

export function validateLineupName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Lineup name cannot be empty.';
  if (trimmed.length > NAME_MAX_LENGTH)
    return `Lineup name must be ${NAME_MAX_LENGTH} characters or fewer.`;
  return null;
}

export function slugifyLineupName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX_LENGTH);
  if (!slug) return '';
  if (/^[0-9]/.test(slug)) return `l-${slug}`.slice(0, ID_MAX_LENGTH);
  return slug;
}

export function uniqueLineupId(name: string, existing: Record<string, Lineup>): string {
  const base = slugifyLineupName(name);
  if (!base) {
    let i = 1;
    while (existing[`lineup-${i}`]) i += 1;
    return `lineup-${i}`;
  }
  if (!existing[base]) return base;
  let i = 2;
  const build = (n: number): string => {
    const suffix = `-${n}`;
    return `${base.slice(0, ID_MAX_LENGTH - suffix.length)}${suffix}`;
  };
  let candidate = build(i);
  while (existing[candidate]) {
    i += 1;
    candidate = build(i);
  }
  return candidate;
}

function isLineupSlot(v: unknown): v is LineupSlot {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as LineupSlot).provider === 'string' &&
    typeof (v as LineupSlot).model === 'string' &&
    (v as LineupSlot).provider.length > 0 &&
    (v as LineupSlot).model.length > 0
  );
}

function isRoleSlots(v: unknown): v is RoleSlots {
  if (!v || typeof v !== 'object') return false;
  return LINEUP_TIERS.every((tier) => isLineupSlot((v as Record<string, unknown>)[tier]));
}

/** Deep-copies one `{premium, mid, cheap}` ladder (no shared slot refs). */
function cloneRoleSlots(slots: RoleSlots): RoleSlots {
  return {
    premium: { ...slots.premium },
    mid: { ...slots.mid },
    cheap: { ...slots.cheap },
  };
}

/** Builds a full `role → ladder` map, replicating one ladder across every role. */
function replicateAcrossRoles(slots: RoleSlots): Record<RoleId, RoleSlots> {
  const out = {} as Record<RoleId, RoleSlots>;
  for (const role of ALL_ROLE_IDS) out[role] = cloneRoleSlots(slots);
  return out;
}

function writeFile(lineups: Record<string, Lineup>): void {
  fs.mkdirSync(path.dirname(LINEUPS_PATH), { recursive: true });
  const payload: LineupsFile = { lineups };
  atomicWriteFileSync(LINEUPS_PATH, JSON.stringify(payload, null, 2) + '\n');
}

function nowIso(): string {
  return new Date().toISOString();
}

function seedForProvider(provider: BuiltinProvider, now: string): Lineup {
  const entries = getCatalogForProvider(provider);
  let tiers: { premium: string; mid: string; cheap: string };
  if (entries.length > 0) {
    tiers = deriveTiers(entries);
  } else {
    tiers = FALLBACK_TIERS[provider];
  }
  const ladder: RoleSlots = {
    premium: { provider, model: tiers.premium },
    mid: { provider, model: tiers.mid },
    cheap: { provider, model: tiers.cheap },
  };
  return {
    id: provider,
    name: `${PROVIDER_DISPLAY_NAMES[provider]}-only`,
    roles: replicateAcrossRoles(ladder),
    createdAt: now,
    updatedAt: now,
  };
}

function buildSeedLineups(): Record<string, Lineup> {
  const now = nowIso();
  const out: Record<string, Lineup> = {};
  for (const provider of BUILTIN_PROVIDERS) {
    out[provider] = seedForProvider(provider, now);
  }
  return out;
}

/**
 * Adds default lineups for any built-in provider not yet present on disk.
 * Existing lineups (including user-edited slot picks) are left untouched.
 * Returns the merged map and only writes when something actually changed.
 */
export function seedDefaultLineups(existing: Record<string, Lineup>): Record<string, Lineup> {
  const now = nowIso();
  let mutated = false;
  const out: Record<string, Lineup> = { ...existing };
  for (const provider of BUILTIN_PROVIDERS) {
    if (out[provider]) continue;
    out[provider] = seedForProvider(provider, now);
    mutated = true;
  }
  if (mutated) {
    try {
      writeFile(out);
    } catch {
      // best-effort; return the merged map regardless
    }
  }
  return out;
}

/**
 * Normalizes one stored lineup entry into the current role-keyed shape,
 * migrating where needed. Returns `null` for unrecoverable entries (caller
 * drops them and re-seeds if the map ends up empty).
 *
 * Handled shapes:
 *  1. **Old flat** (`{premium, mid, cheap}` at top level, no `roles`): replicate
 *     the cost ladder across every role → behavior identical to pre-#264.
 *  2. **Role-keyed** (`{roles: {...}}`): validate each known role; backfill any
 *     role missing from `ALL_ROLE_IDS` (e.g. a role added after this lineup was
 *     saved) from an anchor role (`orchestrator`, else the first valid role).
 *  3. **Neither**: `null`.
 *
 * Sets `mutatedRef.value = true` whenever it changes the on-disk shape so the
 * caller can persist the upgrade.
 */
function migrateLineupShape(
  id: string,
  entry: unknown,
  mutatedRef: { value: boolean },
): Lineup | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.name !== 'string') return null;
  const createdAt = typeof e.createdAt === 'string' ? e.createdAt : nowIso();
  const updatedAt = typeof e.updatedAt === 'string' ? e.updatedAt : nowIso();

  // Case 2 — already role-keyed.
  if (e.roles && typeof e.roles === 'object') {
    const stored = e.roles as Record<string, unknown>;
    // Anchor for backfilling missing roles: prefer orchestrator, else any valid.
    const anchorId =
      ALL_ROLE_IDS.find((r) => isRoleSlots(stored[r])) ?? null;
    if (!anchorId) return null;
    const anchor = stored[anchorId] as RoleSlots;
    const roles = {} as Record<RoleId, RoleSlots>;
    for (const role of ALL_ROLE_IDS) {
      if (isRoleSlots(stored[role])) {
        roles[role] = cloneRoleSlots(stored[role] as RoleSlots);
      } else {
        roles[role] = cloneRoleSlots(anchor);
        mutatedRef.value = true; // backfilled a missing/invalid role
      }
    }
    return { id: e.id, name: e.name, roles, createdAt, updatedAt };
  }

  // Case 1 — legacy flat shape.
  if (isLineupSlot(e.premium) && isLineupSlot(e.mid) && isLineupSlot(e.cheap)) {
    mutatedRef.value = true;
    const ladder: RoleSlots = {
      premium: e.premium,
      mid: e.mid,
      cheap: e.cheap,
    };
    return {
      id: e.id,
      name: e.name,
      roles: replicateAcrossRoles(ladder),
      createdAt,
      updatedAt,
    };
  }

  return null;
}

/**
 * Reads `lineups.json`. If the file is missing or unparseable, seeds the
 * three built-in provider lineups, persists them, and returns the result.
 * Always returns at least the seeded set so callers never have to handle an
 * empty-map case. Auto-migrates legacy flat lineups and backfills newly-added
 * roles, persisting the upgraded shape when anything changed.
 */
export function loadLineups(): Record<string, Lineup> {
  try {
    const raw = fs.readFileSync(LINEUPS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LineupsFile>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.lineups &&
      typeof parsed.lineups === 'object'
    ) {
      const out: Record<string, Lineup> = {};
      const mutatedRef = { value: false };
      for (const [id, entry] of Object.entries(parsed.lineups)) {
        const migrated = migrateLineupShape(id, entry, mutatedRef);
        if (migrated) out[id] = migrated;
        else mutatedRef.value = true; // dropped a corrupt entry
      }
      if (Object.keys(out).length > 0) {
        if (mutatedRef.value) {
          try {
            writeFile(out);
          } catch {
            // best-effort; the in-memory migration still applies this session
          }
        }
        return out;
      }
    }
  } catch {
    // fall through to seed
  }

  const seeded = buildSeedLineups();
  try {
    writeFile(seeded);
  } catch {
    // best-effort; return the in-memory seed regardless
  }
  return seeded;
}

/**
 * Resolves the active lineup id. Precedence:
 *   1. Explicit `activeLineupId` arg (from `ProfileSettings.activeLineupId`).
 *   2. A lineup whose `id` matches `fallbackProviderName` (e.g. the legacy
 *      `config.provider`, so users upgrading land on the seeded lineup for
 *      whichever built-in they had selected).
 *   3. The first lineup in iteration order.
 * Throws only if the map is empty (shouldn't happen because `loadLineups`
 * always seeds).
 */
export function resolveActiveLineup(
  lineups: Record<string, Lineup>,
  activeLineupId: string | undefined,
  fallbackProviderName: string | undefined,
): Lineup {
  if (activeLineupId && lineups[activeLineupId]) return lineups[activeLineupId];
  if (fallbackProviderName && lineups[fallbackProviderName]) return lineups[fallbackProviderName];
  const first = Object.values(lineups)[0];
  if (!first)
    throw new Error('No lineups available. This is a bug — loadLineups should always seed.');
  return first;
}

/** Outcome of {@link resolveActiveLineupWithCorrection}. */
export interface LineupResolution {
  /** The lineup that will actually be used. */
  lineup: Lineup;
  /**
   * Set only when `activeLineupId` was non-empty but pointed at a lineup that
   * doesn't exist (e.g. a stale id left over from a deleted lineup, or a typo in
   * a hand-edited profile). Carries the id that was requested and the id we fell
   * back to, so the caller can persist the correction and tell the user.
   */
  corrected?: { requestedId: string; resolvedId: string };
}

/**
 * Like {@link resolveActiveLineup}, but additionally reports whether the
 * requested `activeLineupId` was *invalid* (set, but absent from `lineups`).
 * When that happens the caller should persist `corrected.resolvedId` back onto
 * the active profile and surface a note so the silent fallback isn't invisible.
 *
 * An empty/undefined `activeLineupId` is NOT a correction — that's the normal
 * "no explicit selection, use the provider/first fallback" path.
 */
export function resolveActiveLineupWithCorrection(
  lineups: Record<string, Lineup>,
  activeLineupId: string | undefined,
  fallbackProviderName: string | undefined,
): LineupResolution {
  const lineup = resolveActiveLineup(lineups, activeLineupId, fallbackProviderName);
  if (activeLineupId && !lineups[activeLineupId]) {
    return { lineup, corrected: { requestedId: activeLineupId, resolvedId: lineup.id } };
  }
  return { lineup };
}

export interface SaveLineupInput {
  id?: string;
  name: string;
  roles: Record<RoleId, RoleSlots>;
}

/**
 * Inserts or updates a lineup. When `input.id` is omitted, a fresh slug is
 * derived from `input.name`. Returns the persisted entry.
 *
 * @throws on invalid name/id or empty slot fields.
 */
export function saveLineup(input: SaveLineupInput): Lineup {
  const nameErr = validateLineupName(input.name);
  if (nameErr) throw new Error(nameErr);
  for (const role of ALL_ROLE_IDS) {
    const ladder = input.roles[role];
    for (const tier of LINEUP_TIERS) {
      if (!isLineupSlot(ladder?.[tier])) {
        throw new Error(
          `Role "${role}" tier "${tier}" must have non-empty provider and model.`,
        );
      }
    }
  }
  const existing = loadLineups();
  const id = input.id ?? uniqueLineupId(input.name, existing);
  const idErr = validateLineupId(id);
  if (idErr) throw new Error(idErr);
  const now = nowIso();
  const roles = {} as Record<RoleId, RoleSlots>;
  for (const role of ALL_ROLE_IDS) roles[role] = cloneRoleSlots(input.roles[role]);
  const entry: Lineup = {
    id,
    name: input.name.trim(),
    roles,
    createdAt: existing[id]?.createdAt ?? now,
    updatedAt: now,
  };
  existing[id] = entry;
  writeFile(existing);
  return entry;
}

export function renameLineup(id: string, newName: string): Lineup {
  const nameErr = validateLineupName(newName);
  if (nameErr) throw new Error(nameErr);
  const existing = loadLineups();
  const target = existing[id];
  if (!target) throw new Error(`No lineup with id "${id}".`);
  const updated: Lineup = { ...target, name: newName.trim(), updatedAt: nowIso() };
  existing[id] = updated;
  writeFile(existing);
  return updated;
}

/**
 * Deletes a lineup. Refuses to delete the last remaining lineup so callers
 * always have something to resolve against.
 *
 * @throws when `id` is unknown or it's the last remaining entry.
 */
export function deleteLineup(id: string): void {
  const existing = loadLineups();
  if (!existing[id]) throw new Error(`No lineup with id "${id}".`);
  if (Object.keys(existing).length <= 1)
    throw new Error('Cannot delete the last remaining lineup.');
  delete existing[id];
  writeFile(existing);
}

/** Lists all lineups in iteration order. */
export function listLineups(): Lineup[] {
  return Object.values(loadLineups());
}
