import * as fs from 'node:fs';
import {
  getActiveSettings,
  loadProfiles,
  saveActiveSettings,
  type ProfileSettings,
} from '../profiles.js';
import { PROFILES_PATH } from '../paths.js';
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
  const grant = readCached()[appId];
  return grant && !isEmptyCspGrant(grant) ? grant : null;
}

/** Every app that currently has a grant. */
export function listCspGrantedApps(): AppCspGrants {
  return readCached();
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
  // Invalidated explicitly rather than left to the stat below: this process
  // just wrote the file, and a write landing in the same millisecond at the
  // same size as the previous one is exactly the case an mtime comparison
  // cannot see.
  cached = null;
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
/**
 * The parsed map, re-read only when `profiles.json` has actually changed.
 *
 * **This caches the BYTES, not the decision**, which is the distinction that
 * matters. The grant must still be resolved per request — `server.ts` reads it
 * on every response so that a revoke applies to the next one with no restart,
 * and caching the *answer* would re-open the time-of-check/time-of-use gap
 * (#420 R6) that reading on demand exists to close. What is cached is the
 * result of parsing a file that has not been touched, and freshness is still
 * checked on every single call.
 *
 * A `statSync` costs ~1 µs against ~7 µs to read and parse the small file most
 * users have — and ~240 µs for one carrying grants for thirty applets. That
 * matters more than the absolute number suggests: one daemon process hosts
 * every applet's server, so this is synchronous main-thread work on the path
 * of every request for every applet, including the static assets of a page
 * load and requests the guard is about to refuse.
 *
 * `atomicWriteFileSync` finishes with `renameSync`, which always bumps mtime,
 * so an edit made by any process is seen on the very next call. Size is
 * compared too, and a same-process write clears the entry outright, so the one
 * theoretical miss — an external write landing inside the same millisecond at
 * byte-identical length — is not reachable through any door Bernard offers.
 */
let cached: { mtimeMs: number; size: number; grants: AppCspGrants } | null = null;

function readCached(): AppCspGrants {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(PROFILES_PATH);
  } catch {
    // No profile yet, or unreadable. Nothing is granted, and a later write
    // will populate it.
    cached = null;
    return Object.create(null) as AppCspGrants;
  }
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.grants;
  const grants = readAll();
  cached = { mtimeMs: stat.mtimeMs, size: stat.size, grants };
  return grants;
}

function readAll(): AppCspGrants {
  const out: AppCspGrants = Object.create(null) as AppCspGrants;
  for (const [appId, grant] of Object.entries(readRaw())) {
    const clean = sanitizeCspGrant(grant);
    if (!isEmptyCspGrant(clean)) out[appId] = clean;
  }
  return out;
}
