import {
  GRANTABLE_DIRECTIVES,
  isWildcardSource,
  normalizeSandboxTokens,
  type AppCspGrant,
  type GrantableDirective,
  type SandboxGrant,
} from '../host/csp-grant.js';
import type { AppPermissions } from './manifest.js';

/**
 * Turning what an applet ASKED for into what a person can answer (#467, #468).
 *
 * Pure — no I/O, no React, no Ink — because the same decision is rendered by
 * three surfaces (the build-time prompt, `/applets → Permissions`, and the
 * CLI) and a label written three times is three labels that drift. The
 * `viewer-util.ts` / `ViewerShell` split, one layer over.
 *
 * ## The user is asked about what the applet does, not about CSP
 *
 * "Show images from 6 sites" is answerable; `img-src https://cdn.example.com`
 * is a question about a header. Bernard writes the label and the origin list
 * itself, from the structure — that half is verifiable. The applet's own
 * `reason` rides along as {@link PendingPermission.reason} and every renderer
 * must show it as what it is: model-written prose, quoted and attributed,
 * never the only thing on screen. It is the one field here Bernard did not
 * author, and it is being used to influence a security decision.
 *
 * ## Two tiers, and the split is about what the channel can carry
 *
 * `img-src` pulls a picture in; `connect-src` is a full two-way channel that
 * can send the applet's data out. So a blanket "allow all" covers the first
 * kind and never the second — {@link PendingPermission.ownScreen} marks the
 * asks that must be answered individually, which is also where a whole-scheme
 * wildcard lands however narrow the directive.
 */

/** One thing the applet asked for, ready to put in front of a person. */
export interface PendingPermission {
  /** The grant key this answers — a directive, or the sandbox axis. */
  key: GrantableDirective | 'sandbox';
  /** Bernard's own words for what this lets the applet do. */
  label: string;
  /** The origins or tokens themselves, for the user to read. */
  detail: string;
  /** The applet's stated reason. Untrusted: quote it, attribute it, cap it. */
  reason?: string;
  /** Origins to add when allowed. Empty for the sandbox axis. */
  sources: string[];
  /** Sandbox tokens to add when allowed. Empty for a directive. */
  tokens: SandboxGrant[];
  /**
   * Whether this must be answered on its own rather than under "allow all".
   * True for any two-way channel, and for any whole-scheme wildcard.
   */
  ownScreen: boolean;
}

/**
 * What Bernard says each ask lets the applet do.
 *
 * Deliberately phrased as a capability rather than a directive: a person can
 * answer "show images from 6 sites" and cannot answer "img-src".
 */
const DIRECTIVE_LABELS: Record<GrantableDirective, (n: number) => string> = {
  imgSrc: (n) => `Show images from ${n} ${n === 1 ? 'site' : 'sites'}`,
  connectSrc: (n) => `Send and receive data with ${n} ${n === 1 ? 'site' : 'sites'}`,
  fontSrc: (n) => `Load fonts from ${n} ${n === 1 ? 'site' : 'sites'}`,
  mediaSrc: (n) => `Play audio or video from ${n} ${n === 1 ? 'site' : 'sites'}`,
};

/**
 * Directives that always get their own screen.
 *
 * `connect-src` is the one that can send data out rather than pull content in,
 * and #467 asks for it to be the hardest to widen.
 */
const ALWAYS_OWN_SCREEN: ReadonlySet<GrantableDirective> = new Set<GrantableDirective>([
  'connectSrc',
]);

const SANDBOX_LABELS: Record<SandboxGrant, string> = {
  'allow-popups': 'Open links in your browser',
  'allow-popups-to-escape-sandbox': 'Open links in your browser',
  'allow-top-navigation-by-user-activation': 'Follow links, replacing the applet',
};

/** At most this many origins are named before the rest are counted. */
const NAMED_ORIGINS = 3;

function summarize(sources: string[]): string {
  if (sources.length <= NAMED_ORIGINS) return sources.join(', ');
  const shown = sources.slice(0, NAMED_ORIGINS).join(', ');
  return `${shown}, +${sources.length - NAMED_ORIGINS} more`;
}

/**
 * What the applet asked for that it has not already been given.
 *
 * Already-granted asks are dropped rather than re-shown, so re-running an
 * update does not re-ask a question the user has answered; a *partially*
 * covered ask is kept, listing only the origins still missing, because "you
 * already allowed two of these six" is the honest form.
 */
export function pendingPermissions(
  permissions: AppPermissions | undefined,
  grant: AppCspGrant | null,
): PendingPermission[] {
  if (!permissions) return [];
  const out: PendingPermission[] = [];

  for (const key of GRANTABLE_DIRECTIVES) {
    const asked = permissions[key];
    if (!asked) continue;
    const held = new Set(grant?.[key] ?? []);
    const missing = asked.origins.filter((o) => !held.has(o));
    if (missing.length === 0) continue;
    out.push({
      key,
      label: DIRECTIVE_LABELS[key](missing.length),
      detail: summarize(missing),
      reason: asked.reason,
      sources: missing,
      tokens: [],
      ownScreen: ALWAYS_OWN_SCREEN.has(key) || missing.some(isWildcardSource),
    });
  }

  if (permissions.sandbox) {
    const held = new Set(grant?.sandbox ?? []);
    const wanted = normalizeSandboxTokens(permissions.sandbox.tokens);
    const missing = wanted.filter((t) => !held.has(t));
    if (missing.length > 0) {
      out.push({
        key: 'sandbox',
        // The pair `links` resolves to is one capability to a person, so it is
        // labelled once rather than twice.
        label: SANDBOX_LABELS[missing[0]],
        detail: missing.join(' '),
        reason: permissions.sandbox.reason,
        sources: [],
        tokens: missing,
        ownScreen: false,
      });
    }
  }
  return out;
}

/**
 * The grant that results from allowing some asks.
 *
 * Additive against what is already held: answering one ask never withdraws
 * another, which matters because the prompt only ever shows what is still
 * outstanding.
 */
export function grantWith(
  grant: AppCspGrant | null,
  allowed: readonly PendingPermission[],
): AppCspGrant {
  const next: AppCspGrant = { ...(grant ?? {}) };
  for (const item of allowed) {
    if (item.key === 'sandbox') {
      next.sandbox = normalizeSandboxTokens([...(next.sandbox ?? []), ...item.tokens]);
      continue;
    }
    next[item.key] = [...new Set([...(next[item.key] ?? []), ...item.sources])];
  }
  return next;
}

/**
 * The reassurance line, which is a real part of the decision.
 *
 * A permission prompt that lists only what was asked for leaves the reader
 * guessing at the rest. This states what the applet did NOT ask for, and it is
 * derived from the ask rather than written by hand so it cannot go stale — an
 * applet that later asks for a network channel stops being described as one
 * that did not.
 */
export function notAskedLine(pending: readonly PendingPermission[]): string {
  const asked = new Set(pending.map((p) => p.key));
  const absent: string[] = [];
  if (!asked.has('connectSrc')) absent.push('send data out');
  if (!asked.has('imgSrc') && !asked.has('mediaSrc')) absent.push('load remote content');
  // Never grantable through this path at all, and worth saying: the reader is
  // deciding how much to trust a program, not how much to trust a directive.
  absent.push('read your files', 'run commands');
  return `It did not ask to: ${absent.join(', ')}.`;
}
