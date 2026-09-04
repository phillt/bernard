import * as fs from 'node:fs';
import * as path from 'node:path';
import { APPLET_BLOCKS_FILE } from '../paths.js';
import { atomicWriteFileSync } from '../fs-utils.js';
import {
  isGrantableSource,
  GRANTABLE_DIRECTIVES,
  DIRECTIVE_NAMES,
  type GrantableDirective,
} from './csp-grant.js';
import { APP_ID_RE } from '../apps/manifest.js';

/**
 * What the browser actually blocked, per applet (#467).
 *
 * The third channel in the permission design, and the one that makes the other
 * two survive being wrong. A declaration is what the applet's author *thought*
 * it would need and a grant is what the user allowed; neither is what the page
 * turns out to reach at runtime. Without this, a denied or under-declared
 * applet is silently broken — the image does not render, nothing is logged,
 * and the user's only evidence is that the page looks wrong.
 *
 * ## It is a claim, not evidence
 *
 * The page decides what to report — it is the applet's own JavaScript calling
 * the endpoint — so everything here is attacker-controlled in the sense that
 * matters: an applet can invent a blocked origin it never requested, hoping to
 * be granted it. Three things keep that harmless, and all three are load-bearing:
 * the origin is validated through {@link isGrantableSource} before it is
 * stored, so nothing unpresentable is kept; it is rendered structurally with
 * no free text taken from the report; and **granting still requires the user's
 * own action**. This saves the user typing an origin. It never decides one.
 *
 * ## Bounded, because an applet controls how often it reports
 *
 * A map keyed by `(directive, origin)` rather than a log: a page that fails to
 * load the same image on a timer would otherwise append forever. Counts and a
 * last-seen timestamp are what a person actually wants to read anyway — "14
 * times, last 2 minutes ago" is the useful form, and a list of 14 identical
 * lines is not.
 */

/** One thing the browser refused, and how often. */
export interface BlockedRequest {
  directive: GrantableDirective;
  origin: string;
  count: number;
  /** ISO timestamp of the most recent report. */
  lastSeen: string;
}

/** Distinct `(directive, origin)` pairs kept per applet. */
export const MAX_BLOCKS_PER_APP = 20;

type BlocksFile = Record<string, BlockedRequest[]>;

/**
 * The CSP directive names a browser reports, mapped to our grant keys.
 *
 * A report names the directive that fired, which for a fallback can be
 * `default-src` rather than the specific one — those are dropped rather than
 * guessed at, since presenting the user with a grant that would not have
 * helped is worse than presenting nothing.
 */
// Derived, not written out: `csp-grant.ts` states the rule as "adding one
// later is a row in this table plus a row in `DIRECTIVE_NAMES`", and a
// hand-written mirror here would quietly make it three. Forgetting the third
// fails silently — reports for the new directive would simply be dropped.
const FROM_CSP_DIRECTIVE: Record<string, GrantableDirective> = Object.fromEntries(
  Object.entries(DIRECTIVE_NAMES).map(([key, directive]) => [directive, key]),
) as Record<string, GrantableDirective>;

/**
 * Reduces a violation report to the grant it would need, or `null`.
 *
 * `null` covers everything a grant could not fix — a `script-src` violation, a
 * `default-src` fallback, a blocked `data:` URI — and dropping those is the
 * point: the surface this feeds offers a one-keystroke grant, so an entry that
 * cannot be granted would be an offer that does nothing.
 */
export function blockedFromReport(
  report: unknown,
): { directive: GrantableDirective; origin: string } | null {
  if (!report || typeof report !== 'object') return null;
  const { directive, blockedURL } = report as { directive?: unknown; blockedURL?: unknown };
  if (typeof directive !== 'string' || typeof blockedURL !== 'string') return null;
  const key = FROM_CSP_DIRECTIVE[directive];
  if (!key) return null;
  let origin: string;
  try {
    const url = new URL(blockedURL);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    origin = url.port
      ? `${url.protocol}//${url.hostname}:${url.port}`
      : `${url.protocol}//${url.hostname}`;
  } catch {
    return null;
  }
  // The same validator the grant path uses, so nothing can be recorded that
  // could not later be granted.
  return isGrantableSource(origin) ? { directive: key, origin } : null;
}

/** Everything an applet has been refused, most recent first. */
export function loadBlocked(appId: string): BlockedRequest[] {
  const all = readAll();
  return [...(all[appId] ?? [])].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/**
 * Records one refusal, merging into the existing count.
 *
 * Best-effort by design — this is called from a request handler on the applet
 * host, and failing to note that an image did not load must never fail the
 * request that noted it.
 */
export function recordBlocked(appId: string, report: unknown): void {
  const parsed = blockedFromReport(report);
  if (!parsed || !APP_ID_RE.test(appId)) return;
  try {
    const all = readAll();
    const rows = all[appId] ?? [];
    const existing = rows.find(
      (r) => r.directive === parsed.directive && r.origin === parsed.origin,
    );
    if (existing) {
      existing.count += 1;
      existing.lastSeen = new Date().toISOString();
    } else {
      if (rows.length >= MAX_BLOCKS_PER_APP) {
        // Evict the least recently seen: a page hammering one origin should
        // not push out the one the user has not seen yet, but something has to
        // go, and staleness is the least arbitrary axis.
        rows.sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
        rows.shift();
      }
      rows.push({ ...parsed, count: 1, lastSeen: new Date().toISOString() });
    }
    all[appId] = rows;
    write(all);
  } catch {
    // Noting a block is never worth failing a request over.
  }
}

/** Forgets an applet's record — used when it is deleted, or once granted. */
export function clearBlocked(appId: string): void {
  try {
    const all = readAll();
    if (!(appId in all)) return;
    delete all[appId];
    write(all);
  } catch {
    // As above.
  }
}

function readAll(): BlocksFile {
  try {
    const raw = JSON.parse(fs.readFileSync(APPLET_BLOCKS_FILE, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: BlocksFile = {};
    for (const [appId, rows] of Object.entries(raw as Record<string, unknown>)) {
      if (!APP_ID_RE.test(appId) || !Array.isArray(rows)) continue;
      out[appId] = rows
        .filter((r): r is BlockedRequest => {
          if (!r || typeof r !== 'object') return false;
          const row = r as BlockedRequest;
          return (
            GRANTABLE_DIRECTIVES.includes(row.directive) &&
            typeof row.origin === 'string' &&
            isGrantableSource(row.origin) &&
            typeof row.count === 'number'
          );
        })
        .slice(0, MAX_BLOCKS_PER_APP);
    }
    return out;
  } catch {
    return {};
  }
}

function write(all: BlocksFile): void {
  fs.mkdirSync(path.dirname(APPLET_BLOCKS_FILE), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(APPLET_BLOCKS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}
