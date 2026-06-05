/**
 * @module lineups
 *
 * Disk-backed registry of **tier lineups**. A lineup is a user-named mapping
 * of `{premium, mid, cheap}` → `(provider, model)` pairs. The active profile
 * (`ProfileSettings.activeLineupId`) selects which lineup `resolveSiteModel`
 * consults when `config.modelMode` is on, replacing the legacy hard-coded
 * `PROVIDER_TIERS` table.
 *
 * Lineups may freely mix providers — built-in or custom — for any tier. This
 * dissolves the previous "active provider" concept (which silently broke
 * tiered model-resolution for custom/local providers because they had no
 * `PROVIDER_TIERS` entry).
 *
 * Storage: `~/.config/bernard/lineups.json`.
 *
 * Lineups themselves are **global**, shared across profiles, just like
 * `custom-providers.json` and `keys.json`. Only the *selection* is profile-
 * scoped.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LINEUPS_PATH } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';
import { getCatalogForProvider } from './providers/catalog.js';
import { deriveTiers } from './providers/tiers.js';
import { BUILTIN_PROVIDERS, type BuiltinProvider } from './providers/types.js';

/** The three tier slots every lineup must define. */
export const LINEUP_TIERS = ['premium', 'mid', 'cheap'] as const;
export type LineupTier = (typeof LINEUP_TIERS)[number];

/** One (provider, model) binding for a single tier slot. */
export interface LineupSlot {
  provider: string;
  model: string;
}

/** A single named tier lineup. */
export interface Lineup {
  /** Stable id used for `activeLineupId` lookups. Lowercase slug. */
  id: string;
  /** User-editable display name. */
  name: string;
  premium: LineupSlot;
  mid: LineupSlot;
  cheap: LineupSlot;
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
  return {
    id: provider,
    name: `${PROVIDER_DISPLAY_NAMES[provider]}-only`,
    premium: { provider, model: tiers.premium },
    mid: { provider, model: tiers.mid },
    cheap: { provider, model: tiers.cheap },
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
 * Reads `lineups.json`. If the file is missing or unparseable, seeds the
 * three built-in provider lineups, persists them, and returns the result.
 * Always returns at least the seeded set so callers never have to handle an
 * empty-map case.
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
      for (const [id, entry] of Object.entries(parsed.lineups)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Partial<Lineup>;
        if (
          typeof e.id === 'string' &&
          typeof e.name === 'string' &&
          isLineupSlot(e.premium) &&
          isLineupSlot(e.mid) &&
          isLineupSlot(e.cheap)
        ) {
          out[id] = {
            id: e.id,
            name: e.name,
            premium: e.premium,
            mid: e.mid,
            cheap: e.cheap,
            createdAt: typeof e.createdAt === 'string' ? e.createdAt : nowIso(),
            updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : nowIso(),
          };
        }
      }
      if (Object.keys(out).length > 0) return out;
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

export interface SaveLineupInput {
  id?: string;
  name: string;
  premium: LineupSlot;
  mid: LineupSlot;
  cheap: LineupSlot;
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
  for (const tier of LINEUP_TIERS) {
    const slot = input[tier];
    if (!isLineupSlot(slot)) {
      throw new Error(`Tier "${tier}" must have non-empty provider and model.`);
    }
  }
  const existing = loadLineups();
  const id = input.id ?? uniqueLineupId(input.name, existing);
  const idErr = validateLineupId(id);
  if (idErr) throw new Error(idErr);
  const now = nowIso();
  const entry: Lineup = {
    id,
    name: input.name.trim(),
    premium: input.premium,
    mid: input.mid,
    cheap: input.cheap,
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
