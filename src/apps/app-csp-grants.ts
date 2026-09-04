import {
  getActiveSettings,
  loadProfiles,
  saveActiveSettings,
  type ProfileSettings,
} from '../profiles.js';
import { sanitizeCspGrant, isEmptyCspGrant, type AppCspGrant } from '../host/csp-grant.js';
import { APP_ID_RE } from './manifest.js';

/**
 * Per-app CSP grants (#467, #468) — what external origins an applet may reach,
 * and whether it may open a link.
 *
 * The sibling of `app-grants.ts`, and deliberately its twin rather than a
 * generalization of it: the two share six method shapes and an atomic write,
 * and share nothing else. A tool grant is an ordered `PermissionRule[]` the
 * engine scans and can answer `deny` or `ask` with; a CSP grant is an
 * unordered set of source expressions per directive, with no deny and no ask
 * because the header is default-deny already. Reusing `PermissionRule` would
 * import an ordering semantics that does not exist here and would let
 * `sanitizePermissionRules` launder a junk value into a shape that
 * type-checks and means nothing.
 *
 * **Three channels, and only one of them is authority.** An applet's manifest
 * may DECLARE what it needs and why — the `applet` tool writes that, and a
 * declaration grants nothing. The browser reports what it actually BLOCKED,
 * which is a hint that a grant might be wanted. This file is the third: what
 * the user ALLOWED. Only this reaches a response header. The manifest is
 * bundle-seeded and model-written, so a grant stored there would be settable
 * by the app — the same reasoning that keeps `skipPermissions` out of the
 * manifest schema.
 */

/** Grants by app id, as persisted. */
export type AppCspGrants = Record<string, AppCspGrant>;

/**
 * Reads one app's grant from the active profile.
 *
 * Read per request rather than cached, which is what makes a revoke apply to
 * the **next request** with no restart — the same rule `server.ts` follows for
 * the manifest, and for the same reason: caching a value the user can change
 * between requests re-opens the time-of-check/time-of-use gap that validating
 * on read exists to close (#420 R6).
 *
 * Returns `null`, not `{}`, when nothing survives, so a caller can skip the
 * widening path entirely on the overwhelmingly common ungranted case.
 */
export function loadAppCspGrant(appId: string): AppCspGrant | null {
  const raw = readRaw()[appId];
  if (!raw) return null;
  const grant = sanitizeCspGrant(raw);
  return isEmptyCspGrant(grant) ? null : grant;
}

/** Every app that currently has a grant. */
export function listCspGrantedApps(): AppCspGrants {
  return readAll();
}

/**
 * Replaces one app's grant, or removes its entry when nothing is granted.
 *
 * Whole-value replacement rather than a per-directive merge: the CLI and the
 * consent screen both compose the complete grant and write it, which keeps
 * "what is this applet allowed to do" answerable from one place rather than
 * from the history of how it got there. Sanitized on the way in as well as on
 * the way out — a caller that hand-builds a grant must not be able to store
 * something the reader would then have to drop.
 */
export function saveAppCspGrant(appId: string, grant: AppCspGrant): void {
  const all = readAll();
  const clean = sanitizeCspGrant(grant);
  if (isEmptyCspGrant(clean)) delete all[appId];
  else all[appId] = clean;
  saveActiveSettings({ appCspGrants: all } as ProfileSettings);
}

/**
 * The map as written, unsanitized, with unaddressable ids dropped.
 *
 * An id failing `APP_ID_RE` can only have been hand-written and addresses
 * nothing, so it is dropped rather than repaired — repairing it would silently
 * point the grant at a different applet.
 */
function readRaw(): Record<string, unknown> {
  const { file } = loadProfiles();
  const raw = getActiveSettings(file).appCspGrants;
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([appId]) => APP_ID_RE.test(appId)),
  );
}

/** Reads and sanitizes the whole map. The file is hand-editable. */
function readAll(): AppCspGrants {
  const out: AppCspGrants = Object.create(null) as AppCspGrants;
  for (const [appId, grant] of Object.entries(readRaw())) {
    const clean = sanitizeCspGrant(grant);
    if (!isEmptyCspGrant(clean)) out[appId] = clean;
  }
  return out;
}
