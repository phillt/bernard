/**
 * @module profiles
 *
 * Disk-backed registry of **settings profiles** (#207). A profile is a named
 * snapshot of every user-tunable preference (provider, model, mode toggles,
 * thresholds, etc.). Bernard always has at least one profile (`default`); the
 * `activeProfileId` field nominates the one whose settings are live.
 *
 * Storage: `~/.config/bernard/profiles.json`
 *
 * API keys (`keys.json`) and custom providers (`custom-providers.json`) are
 * intentionally **not** profile-scoped — they remain global.
 *
 * ## Migration
 *
 * On first read after the upgrade introducing this module, if `profiles.json`
 * does not exist we look for the legacy `preferences.json` and ingest its
 * contents as the seed `default` profile. A sibling marker file is dropped so
 * subsequent loads short-circuit. The legacy `preferences.json` is left in
 * place (no destructive delete) so users can roll back.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PREFS_PATH, PROFILES_PATH, PROFILES_MIGRATED_MARKER } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';
import type { ResponseStyle } from './agent-prompt.js';
import type { ToolPermissions, ToolPermissionRules } from './tool-permissions.js';
import type { VoiceBackend } from './voice-service.js';

/** Slug pattern + length cap used for profile ids. */
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const ID_MAX_LENGTH = 32;
const NAME_MAX_LENGTH = 64;

/** The id of the always-present default profile. */
export const DEFAULT_PROFILE_ID = 'default';

/**
 * Settings blob carried by every profile.
 *
 * Shape mirrors the partial-preferences object returned by `loadPreferences()`
 * so that profile.settings can flow directly into `loadConfig()` without any
 * caller-side mapping.
 */
export interface ProfileSettings {
  provider?: string;
  model?: string;
  maxTokens?: number;
  shellTimeout?: number;
  tokenWindow?: number;
  maxSteps?: number;
  theme?: string;
  autoUpdate?: boolean;
  coordinatorMode?: 'on' | 'off' | 'auto';
  modelMode?: 'optimize-tokens' | 'balanced' | 'optimize-performance';
  subagentPac?: boolean;
  toolDetails?: boolean;
  autoCreateSpecialists?: boolean;
  autoCreateApplets?: boolean;
  autoOpenApplets?: boolean;
  autoCreateThreshold?: number;
  promptRewriter?: boolean;
  recallFilter?: boolean;
  referenceLookup?: boolean;
  scratchSubjectThreshold?: number;
  conciseMode?: boolean;
  confirmMode?: 'off' | 'auto' | 'strict';
  toolMode?: 'read-only' | 'write';
  maxConcurrentAgents?: number;
  responseStyle?: ResponseStyle;
  /**
   * Id of the active tier lineup (`src/lineups.ts`). `resolveSiteModel`
   * consults the named lineup's `{premium, mid, cheap}` slots. When unset,
   * the resolver falls back to the lineup whose id matches the active
   * provider, then to the first lineup in the store.
   */
  activeLineupId?: string;
  /**
   * Profile-persisted tool permission grants (#212). Keys are tool names
   * (`web_read`) or `shell:<primary-command>` (`shell:ls`); see
   * `permissionKeyFor` in `src/tool-permissions.ts`. `allow` bypasses both
   * the read-only block gate and the risk confirm gate; `deny` refuses the
   * call without prompting. On disk this may be a legacy v1 object or the v2
   * `PermissionRule[]` (#261); both are migrated on read by
   * `sanitizePermissionRules`.
   */
  toolPermissions?: ToolPermissions | ToolPermissionRules;
  /**
   * Per-app permission rules (#420), keyed by app id — the grants a user
   * attaches to an applet, distinct from `toolPermissions`, which are their
   * own. An app must never inherit the user's grants: "always allow
   * `shell rm *`" flowing into a browser-triggered dispatch is exactly the
   * confused-deputy widening the capability design exists to prevent.
   * Read and written through `src/apps/app-grants.ts`.
   */
  appToolGrants?: Record<string, ToolPermissionRules>;
  /**
   * "Run Without Permission Checks or Safeguards" (#212). When true the
   * policy engine forces `toolMode: 'write'` + `confirmThreshold: 'never'`
   * for every turn — no block gate, no confirmation prompts.
   */
  skipPermissions?: boolean;
  /** Whether text-to-speech readback is active after each assistant turn. */
  voiceTts?: boolean;
  /** Which TTS backend to use (`'auto'` = platform-detect). */
  voiceBackend?: VoiceBackend;
  /** Optional voice name passed to the TTS backend. */
  voiceVoice?: string;
  /** Optional speech rate in words per minute. */
  voiceRate?: number;
  /** Ms of silence played to wake a suspended sink before speaking (0 = off). */
  voiceWarmupMs?: number;
  /**
   * Run the LLM speech-normalization pass before speaking (#432). On by default;
   * gates only the LLM half — the deterministic markup/number handling is
   * unconditional. Speech path only; the transcript stays literal.
   */
  voiceNormalizer?: boolean;
}

/** A single named profile entry. */
export interface Profile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: ProfileSettings;
}

/** On-disk shape of `profiles.json`. */
export interface ProfilesFile {
  activeProfileId: string;
  profiles: Record<string, Profile>;
}

/** Result of `loadProfiles()` — exposes whether this load also initialized the file. */
export interface LoadResult {
  file: ProfilesFile;
  /** True only when this load created `profiles.json` for the first time. */
  wasFreshlyCreated: boolean;
  /** True when the freshly-created file ingested settings from the legacy `preferences.json`. */
  migratedFromPreferences: boolean;
}

/** Validates a profile id slug. Returns an error message or null. */
export function validateProfileId(id: string): string | null {
  if (!id) return 'Profile id cannot be empty.';
  if (id.length > ID_MAX_LENGTH) return `Profile id must be ${ID_MAX_LENGTH} characters or fewer.`;
  if (!ID_PATTERN.test(id))
    return 'Profile id must start with a lowercase letter and contain only lowercase letters, digits, hyphens, and underscores.';
  return null;
}

/** Validates a profile display name. Returns an error message or null. */
export function validateProfileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Profile name cannot be empty.';
  if (trimmed.length > NAME_MAX_LENGTH)
    return `Profile name must be ${NAME_MAX_LENGTH} characters or fewer.`;
  return null;
}

/**
 * Derives a slug id from a free-form display name. Lower-cases, replaces
 * non-alphanumerics with hyphens, trims leading/trailing hyphens, and clamps
 * to the max length. Returns an empty string when the input contains no
 * usable characters.
 */
export function slugifyProfileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX_LENGTH);
  if (!slug) return '';
  if (/^[0-9]/.test(slug)) return `p-${slug}`.slice(0, ID_MAX_LENGTH);
  return slug;
}

/** Picks a unique slug derived from `name`, suffixing `-2`, `-3`, ... on collision. */
export function uniqueProfileId(name: string, existing: Record<string, Profile>): string {
  const base = slugifyProfileName(name);
  if (!base) {
    // Fall back to a numeric id when slugification fails entirely.
    let i = 1;
    while (existing[`profile-${i}`]) i += 1;
    return `profile-${i}`;
  }
  if (!existing[base]) return base;
  // Trim the base so `${base}-${i}` always fits within ID_MAX_LENGTH —
  // otherwise a max-length collision could produce an id that violates
  // `validateProfileId` (caught by `phillt/bernard#210` review).
  let i = 2;
  const buildCandidate = (n: number): string => {
    const suffix = `-${n}`;
    const trimmed = base.slice(0, ID_MAX_LENGTH - suffix.length);
    return `${trimmed}${suffix}`;
  };
  let candidate = buildCandidate(i);
  while (existing[candidate]) {
    i += 1;
    candidate = buildCandidate(i);
  }
  return candidate;
}

function writeFile(file: ProfilesFile): void {
  fs.mkdirSync(path.dirname(PROFILES_PATH), { recursive: true });
  atomicWriteFileSync(PROFILES_PATH, JSON.stringify(file, null, 2) + '\n');
}

/**
 * Subset of legacy `preferences.json` keys we accept as profile settings.
 * Anything outside this list (or anything whose type does not match) is
 * dropped so a hand-edited or malformed legacy file cannot smuggle garbage
 * into the new profile store.
 */
const LEGACY_STRING_KEYS = ['provider', 'model', 'theme'] as const;
const LEGACY_NUMBER_KEYS = [
  'maxTokens',
  'shellTimeout',
  'tokenWindow',
  'maxSteps',
  'autoCreateThreshold',
  'scratchSubjectThreshold',
  'maxConcurrentAgents',
] as const;
const LEGACY_BOOLEAN_KEYS = [
  'autoUpdate',
  'subagentPac',
  'toolDetails',
  'autoCreateSpecialists',
  'autoCreateApplets',
  'autoOpenApplets',
  'promptRewriter',
  'recallFilter',
  'referenceLookup',
  'conciseMode',
] as const;

function readLegacyPreferences(): ProfileSettings | null {
  try {
    if (!fs.existsSync(PREFS_PATH)) return null;
    const raw = fs.readFileSync(PREFS_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const src = parsed as Record<string, unknown>;
    const out: ProfileSettings = {};
    for (const k of LEGACY_STRING_KEYS) {
      const v = src[k];
      if (typeof v === 'string') (out as Record<string, unknown>)[k] = v;
    }
    for (const k of LEGACY_NUMBER_KEYS) {
      const v = src[k];
      if (typeof v === 'number' && Number.isFinite(v)) (out as Record<string, unknown>)[k] = v;
    }
    for (const k of LEGACY_BOOLEAN_KEYS) {
      const v = src[k];
      if (typeof v === 'boolean') (out as Record<string, unknown>)[k] = v;
    }
    if (
      src.coordinatorMode === 'on' ||
      src.coordinatorMode === 'off' ||
      src.coordinatorMode === 'auto'
    ) {
      out.coordinatorMode = src.coordinatorMode;
    } else if (typeof src.reactMode === 'boolean') {
      out.coordinatorMode = src.reactMode ? 'on' : 'off';
    }
    if (
      src.modelMode === 'optimize-tokens' ||
      src.modelMode === 'balanced' ||
      src.modelMode === 'optimize-performance'
    ) {
      out.modelMode = src.modelMode;
    } else if (src.modelMode === 'off') {
      out.modelMode = 'optimize-performance';
    }
    if (src.confirmMode === 'off' || src.confirmMode === 'auto' || src.confirmMode === 'strict') {
      out.confirmMode = src.confirmMode;
    }
    if (src.toolMode === 'read-only' || src.toolMode === 'write') {
      out.toolMode = src.toolMode;
    }
    if (typeof src.responseStyle === 'string') {
      out.responseStyle = src.responseStyle as ResponseStyle;
    }
    return out;
  } catch {
    return null;
  }
}

function emptyDefaultProfile(settings: ProfileSettings = {}): Profile {
  const now = new Date().toISOString();
  return {
    id: DEFAULT_PROFILE_ID,
    name: 'default',
    createdAt: now,
    updatedAt: now,
    settings,
  };
}

/**
 * Reads the profiles file from disk, lazily migrating from `preferences.json`
 * if needed. Always returns a valid `ProfilesFile` containing at least the
 * `default` profile. Fails open: a malformed file on disk is rebuilt from
 * defaults (the original is left untouched so the user can recover it).
 */
export function loadProfiles(): LoadResult {
  // Happy path: file exists, parses, has a valid active profile.
  try {
    const raw = fs.readFileSync(PROFILES_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ProfilesFile>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.activeProfileId === 'string' &&
      parsed.profiles &&
      typeof parsed.profiles === 'object'
    ) {
      const profiles: Record<string, Profile> = {};
      for (const [id, p] of Object.entries(parsed.profiles)) {
        if (!p || typeof p !== 'object') continue;
        const entry = p as Partial<Profile>;
        if (typeof entry.id !== 'string' || typeof entry.name !== 'string') continue;
        profiles[id] = {
          id: entry.id,
          name: entry.name,
          createdAt:
            typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
          updatedAt:
            typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
          settings:
            entry.settings && typeof entry.settings === 'object'
              ? (entry.settings as ProfileSettings)
              : {},
        };
      }
      if (Object.keys(profiles).length === 0) {
        profiles[DEFAULT_PROFILE_ID] = emptyDefaultProfile();
      }
      // Prefer the stored activeProfileId; if it's stale, fall back to
      // `default` when present, otherwise the alphabetically-first id (so
      // ordering is deterministic across reloads).
      const activeProfileId = profiles[parsed.activeProfileId]
        ? parsed.activeProfileId
        : profiles[DEFAULT_PROFILE_ID]
          ? DEFAULT_PROFILE_ID
          : Object.keys(profiles).sort()[0];
      return {
        file: { activeProfileId, profiles },
        wasFreshlyCreated: false,
        migratedFromPreferences: false,
      };
    }
  } catch {
    // fall through to creation path
  }

  // File missing or unparseable — create it (optionally migrating).
  // If the migration marker exists from a prior run, skip the legacy ingest:
  // the user (or a sync conflict) has since deleted profiles.json, and we
  // don't want to silently resurrect months-old preferences. Fresh start.
  const alreadyMigrated = (() => {
    try {
      return fs.existsSync(PROFILES_MIGRATED_MARKER);
    } catch {
      return false;
    }
  })();
  const legacy = alreadyMigrated ? null : readLegacyPreferences();
  const migrated = legacy !== null;
  const file: ProfilesFile = {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: { [DEFAULT_PROFILE_ID]: emptyDefaultProfile(legacy ?? {}) },
  };
  try {
    writeFile(file);
    if (migrated) {
      try {
        atomicWriteFileSync(PROFILES_MIGRATED_MARKER, new Date().toISOString() + '\n');
      } catch {
        /* marker is best-effort */
      }
    }
  } catch {
    // Disk write failed — return the in-memory file anyway so the session can
    // proceed. Next load will retry the write.
  }
  return { file, wasFreshlyCreated: true, migratedFromPreferences: migrated };
}

/** Returns the active profile object from a loaded file. */
export function getActiveProfile(file: ProfilesFile): Profile {
  return file.profiles[file.activeProfileId] ?? emptyDefaultProfile();
}

/** Returns the settings blob of the active profile (convenience wrapper). */
export function getActiveSettings(file: ProfilesFile): ProfileSettings {
  return getActiveProfile(file).settings;
}

/**
 * Merges `patch` into the active profile's settings and writes the file. A
 * `key: undefined` in `patch` removes that field from the stored settings, so
 * "explicit undefined" can be used to reset a setting back to its env/default.
 *
 * Returns the updated `ProfilesFile`.
 */
export function saveActiveSettings(patch: ProfileSettings): ProfilesFile {
  const { file } = loadProfiles();
  let active = file.profiles[file.activeProfileId];
  if (!active) {
    // Self-heal: activeProfileId points at a deleted/missing entry. Reseat it
    // onto the default profile (creating one if necessary) so a manual edit
    // to profiles.json doesn't silently swallow every subsequent save.
    if (!file.profiles[DEFAULT_PROFILE_ID]) {
      file.profiles[DEFAULT_PROFILE_ID] = emptyDefaultProfile();
    }
    file.activeProfileId = DEFAULT_PROFILE_ID;
    active = file.profiles[DEFAULT_PROFILE_ID];
  }
  const next: ProfileSettings = { ...active.settings };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      delete (next as Record<string, unknown>)[k];
    } else {
      (next as Record<string, unknown>)[k] = v;
    }
  }
  file.profiles[file.activeProfileId] = {
    ...active,
    settings: next,
    updatedAt: new Date().toISOString(),
  };
  writeFile(file);
  return file;
}

/**
 * Creates a new profile from `(name, settings)`. The id is derived from the
 * name via `uniqueProfileId`. Does not switch the active profile.
 *
 * @throws if `name` fails validation.
 */
export function createProfile(name: string, settings: ProfileSettings = {}): Profile {
  const nameErr = validateProfileName(name);
  if (nameErr) throw new Error(nameErr);
  const { file } = loadProfiles();
  const id = uniqueProfileId(name, file.profiles);
  const now = new Date().toISOString();
  const profile: Profile = {
    id,
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
    settings,
  };
  file.profiles[id] = profile;
  writeFile(file);
  return profile;
}

/**
 * Renames an existing profile's display label. The profile id stays stable.
 *
 * @throws if the id is unknown or the new name is invalid.
 */
export function renameProfile(id: string, newName: string): Profile {
  const nameErr = validateProfileName(newName);
  if (nameErr) throw new Error(nameErr);
  const { file } = loadProfiles();
  const target = file.profiles[id];
  if (!target) throw new Error(`No profile with id "${id}".`);
  const updated: Profile = {
    ...target,
    name: newName.trim(),
    updatedAt: new Date().toISOString(),
  };
  file.profiles[id] = updated;
  writeFile(file);
  return updated;
}

/**
 * Deletes a profile. Rejects deletion of the last remaining profile, and of
 * the currently-active profile (the user must switch first).
 *
 * @throws on either guard, or when `id` is unknown.
 */
export function deleteProfile(id: string): void {
  const { file } = loadProfiles();
  if (!file.profiles[id]) throw new Error(`No profile with id "${id}".`);
  if (Object.keys(file.profiles).length <= 1)
    throw new Error('Cannot delete the last remaining profile.');
  if (file.activeProfileId === id)
    throw new Error('Cannot delete the active profile. Switch to another profile first.');
  // The default profile is part of Bernard's startup contract — never let it
  // be removed (callers can rename its display label but not erase the id).
  if (id === DEFAULT_PROFILE_ID)
    throw new Error('Cannot delete the default profile. Rename it instead.');
  delete file.profiles[id];
  writeFile(file);
}

/**
 * Sets the active profile to `id`. Returns the new active profile.
 *
 * @throws when `id` is unknown.
 */
export function switchActiveProfile(id: string): Profile {
  const { file } = loadProfiles();
  if (!file.profiles[id]) throw new Error(`No profile with id "${id}".`);
  file.activeProfileId = id;
  writeFile(file);
  return file.profiles[id];
}

/** Lists all profiles, with the active one flagged. Order is insertion order. */
export function listProfiles(): Array<Profile & { active: boolean }> {
  const { file } = loadProfiles();
  return Object.values(file.profiles).map((p) => ({ ...p, active: p.id === file.activeProfileId }));
}
