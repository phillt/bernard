import {
  getActiveSettings,
  loadProfiles,
  saveActiveSettings,
  type ProfileSettings,
} from '../profiles.js';
import { sanitizePermissionRules, type PermissionRule } from '../tool-permissions.js';
import { APP_ID_RE } from './manifest.js';

/**
 * Per-app permission grants (#420).
 *
 * An app's `toolAllowlist` decides which tools are *constructed* for its
 * dispatch — `buildActionTools` intersects it with the specialist's own
 * `targetTools`, so an action can narrow and never widen. That structural
 * allowlist stays the primary control, and is what makes a refused call fail
 * because the tool is absent rather than because the model declined.
 *
 * This is the refinement on top of it: rules the **user** attaches to an app,
 * evaluated by the same deterministic engine the REPL uses, so a capability
 * can be taken away from an app that already has it. Rules cannot express
 * "deny everything else" — `scanRules` answers `'ask'` when nothing matches —
 * so an allowlist is not derivable from rules alone, which is the other half
 * of why both layers exist.
 *
 * **Grants live in the profile, never in the manifest.** The manifest is
 * bundle-seeded and user-editable by anything running as the user, and it is
 * the app's own file: a grant stored there would be settable by the app. That
 * is the same reasoning that keeps `skipPermissions` out of the manifest
 * schema. For the same reason the producer is a CLI command and nothing an
 * agent can call — letting a model widen the authority of the app it is
 * running inside is the escalation the gate exists to prevent.
 */

/** Rules by app id, as persisted. */
export type AppToolGrants = Record<string, PermissionRule[]>;

/**
 * Reads one app's rules from the active profile.
 *
 * Read per dispatch rather than cached, which is what makes revocation take
 * effect on the **next invocation** with no restart — an acceptance item of
 * #420. Returns `null`, not `[]`, when an app has no grants: `null` is what
 * `HeadlessPostureInput.toolPermissions` means by "no rules apply", and it
 * lets `runHeadless` skip both the reader and the shell-parser warmup.
 */
export function loadAppGrants(appId: string): PermissionRule[] | null {
  const all = readAll();
  const rules = all[appId];
  return rules && rules.length > 0 ? rules : null;
}

/** Every app that currently has rules, sorted. */
export function listGrantedApps(): AppToolGrants {
  return readAll();
}

/**
 * Replaces one app's rules, or removes the app's entry when `rules` is empty.
 *
 * Whole-app replacement rather than append: the rules are an ordered list the
 * engine scans, so "add one" is a merge whose result depends on where it
 * landed. The CLI composes the list and writes it, which keeps the ordering
 * decision at the one place a person can see it.
 */
export function saveAppGrants(appId: string, rules: PermissionRule[]): void {
  const all = readAll();
  if (rules.length === 0) delete all[appId];
  else all[appId] = sanitizePermissionRules(rules);
  saveActiveSettings({ appToolGrants: all } as ProfileSettings);
}

/**
 * Reads and sanitizes the whole map.
 *
 * Every value goes through `sanitizePermissionRules` — the same normalizer the
 * user's own grants use — because this file is hand-editable and a malformed
 * rule that survived to the engine would be matched against, not ignored.
 * An app id that does not match {@link APP_ID_RE} is dropped rather than
 * repaired: it can only have been hand-written, and it addresses nothing.
 */
function readAll(): AppToolGrants {
  const { file } = loadProfiles();
  const raw = getActiveSettings(file).appToolGrants;
  if (!raw || typeof raw !== 'object') return {};
  const out: AppToolGrants = Object.create(null) as AppToolGrants;
  for (const [appId, rules] of Object.entries(raw)) {
    if (!APP_ID_RE.test(appId)) continue;
    const clean = sanitizePermissionRules(rules);
    if (clean.length > 0) out[appId] = clean;
  }
  return out;
}
