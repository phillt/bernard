import { originFor } from './csp.js';

/**
 * The request gate for the applet host (#421).
 *
 * **A localhost server is reachable from the whole web.** The exploit is DNS
 * rebinding, and it is live rather than theoretical: Vite's CVE-2025-24010 was
 * exactly this — no `Host` validation meant "an attacker can send arbitrary
 * requests to the development server bypassing the same-origin policy", and it
 * "even applies to users that only run the Vite dev server on the local
 * machine". Chrome's Local Network Access gate does not land everywhere and
 * cannot be relied on.
 *
 * A rebinding request arrives on a perfectly ordinary socket from the
 * browser's own network stack. Nothing about the connection is suspicious —
 * the only thing that gives it away is that the `Host` header names a domain
 * the attacker controls rather than this applet's own origin. So the check
 * has to be on the header, and it has to be an allowlist.
 *
 * Deliberately a **pure function** over a plain header bag rather than a
 * `node:http` middleware: every rebinding, token and origin case is then
 * testable without a socket, and `node:http` stays a thin shell around it.
 */

/** What the guard needs to know about the applet being addressed. */
export interface GuardContext {
  port: number;
  /** The per-session token, minted at host start and injected into the page. */
  token: string;
}

/** The subset of a request the guard reads. Shaped so a test needs no socket. */
export interface GuardRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export type GuardVerdict =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 404 | 405;
      /**
       * Deliberately terse and identical across causes. A gate that explains
       * which check failed is a gate that helps an attacker enumerate them,
       * and the legitimate caller is our own page, which never trips it.
       */
      reason: string;
    };

const DENY: GuardVerdict = { ok: false, status: 403, reason: 'Forbidden' };

function header(req: GuardRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  // A repeated header is a smuggling shape, not a value to pick from.
  return Array.isArray(v) ? undefined : v;
}

/**
 * Whether this request may be served.
 *
 * Order matters only for cost: the cheap header comparisons come before the
 * token comparison so a rebinding probe never reaches it.
 */
export function checkRequest(ctx: GuardContext, req: GuardRequest): GuardVerdict {
  const expectedOrigin = originFor(ctx.port);

  // 1. Host must name this applet's own origin. This is the rebinding check.
  //    `127.0.0.1:<port>` only — not `localhost`, which resolves through the
  //    system resolver and is therefore attacker-influenceable in exactly the
  //    scenario this defends against.
  const host = header(req, 'host');
  if (host !== `127.0.0.1:${ctx.port}`) return DENY;

  // 2. Origin, when present, must be our own. Absent is legitimate: a
  //    top-level navigation (the user opening the applet in a tab) sends no
  //    Origin. A present-but-foreign Origin is a cross-site caller.
  const origin = header(req, 'origin');
  if (origin !== undefined && origin !== expectedOrigin) return DENY;

  // 3. Sec-Fetch-Site, when the browser sends it, must be same-origin or a
  //    direct navigation. Belt to the Origin check, and it covers a few shapes
  //    Origin does not — but only advisory, since non-browser callers omit it.
  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return DENY;

  // 4. State-changing requests carry the token. Reads of the applet's own
  //    assets do not: the page has to load before it can present anything, and
  //    the origin checks above are what protect it.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const presented = header(req, 'x-bernard-token');
    if (!presented || !constantTimeEquals(presented, ctx.token)) return DENY;
  }

  return { ok: true };
}

/**
 * Length-independent, content-constant comparison.
 *
 * `===` on a secret leaks its prefix through timing. The window on loopback is
 * small but the fix is three lines, and the alternative is arguing about how
 * small. Compares a fixed number of characters so the early-exit is not on
 * length either.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
