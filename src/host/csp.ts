/**
 * The response headers an applet is served under (#421).
 *
 * Pure string construction, no I/O — so the directives that matter can be
 * asserted without standing up a server.
 */

import { isGrantableSource, type AppCspGrant, type GrantableDirective } from './csp-grant.js';

/** `http://127.0.0.1:<port>` — the applet's canonical origin. */
export function originFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Content-Security-Policy for a served applet.
 *
 * Built from MCP Apps SEP-1865's normative default, which `#431`'s research
 * established as a sound baseline (`docs/research/applet-sandbox.md` §1), with
 * three additions that its default omits and that matter here.
 *
 * - **`connect-src 'self'`** is the highest-value directive: it severs the
 *   exfiltration leg. SEP-1865 defaults to `'none'`; an applet needs its own
 *   origin to reach the callback endpoint, and nothing more. Note the CSP
 *   `'self'` keyword is origin-scoped, so this does not open sibling applets —
 *   they are different ports, hence different origins.
 * - **`img-src` and `form-action`** are exfiltration channels `connect-src`
 *   does **not** cover. An image URL and a form POST both leave the origin
 *   without a `fetch`. These are the two that get forgotten, so they get their
 *   own regression test.
 * - **`sandbox` is emitted as an HTTP header**, not a `<meta>` tag — `<meta>`
 *   does not support the directive at all, and the restriction has to survive
 *   the user opening the applet URL directly in a tab rather than only inside
 *   an iframe the host controls.
 *
 * `script-src 'unsafe-inline'` is accepted deliberately: applet code is
 * generated, and demanding nonces or hashes of a model buys little when the
 * origin and `connect-src` are what actually carry the boundary.
 *
 * **`sandbox allow-scripts allow-same-origin` — and the pairing is required,
 * not merely tolerated.**
 *
 * The widely-quoted MDN warning that these two together are "no more secure
 * than not using the sandbox attribute at all" is about an **iframe** whose
 * document is same-origin with its **embedder**: the frame can then reach into
 * the parent and delete its own `sandbox` attribute. An applet is a top-level
 * document on its own port. There is no embedder to be same-origin with, so
 * there is no escape to grant.
 *
 * Omitting `allow-same-origin` is the actively broken configuration, and it
 * breaks three things at once. Per MDN a sandboxed resource is "treated as
 * being from an opaque origin", which "ensures that it will always fail
 * same-origin policy checks, and hence cannot access `localStorage` and
 * `document.cookie`", and its `Origin` header is `null`. So:
 *
 *  - the applet gets **no storage at all** — which voids the entire reason
 *    per-applet origins exist, since the point was that each applet gets its
 *    OWN `localStorage` rather than sharing one;
 *  - `connect-src 'self'` resolves against an opaque origin and matches
 *    nothing, blocking the applet's own callback at the CSP layer;
 *  - requests carry `Origin: null`, which the guard rejects.
 *
 * Isolation between applets is carried by the **port**, not by withholding
 * `allow-same-origin`: two applets on two ports are two origins either way.
 *
 * **`grant` is optional, and that is load-bearing** (#467, #468). Every call
 * without one produces the byte-identical header this function has always
 * produced, which is what lets `csp.test.ts`'s existing regressions keep
 * asserting the ungranted baseline unchanged. A grant only ever *appends*: it
 * cannot remove a directive, relax `script-src`/`style-src` (neither is
 * grantable), or drop a sandbox token. What may be granted is enumerated in
 * `csp-grant.ts`, and a grant reaches here only after a user allowed it —
 * an applet's manifest may *declare* what it wants, and a declaration is a
 * request that grants nothing.
 */
export function cspFor(grant?: AppCspGrant | null): string {
  // Re-validated here, not merely at the store. `sanitizeCspGrant` already
  // runs on every read, so this is defence in depth for an in-process caller
  // that hand-builds a grant: these strings are concatenated into a response
  // header, and a `;` or a CR reaching one adds a directive nobody granted or
  // kills the socket outright. Cheap — at most ten short strings.
  const sourcesFor = (key: GrantableDirective): string[] =>
    (grant?.[key] ?? []).filter(isGrantableSource);
  const widen = (key: GrantableDirective, base: string): string => {
    const sources = sourcesFor(key);
    return sources.length === 0 ? base : `${base} ${sources.join(' ')}`;
  };
  // Additive by construction: the base pair is never removable. `csp.ts`'s own
  // argument above is that omitting `allow-same-origin` is the actively broken
  // configuration, so a grant may only ever append.
  const sandbox = ['allow-scripts', 'allow-same-origin', ...(grant?.sandbox ?? [])];
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    // `'unsafe-inline'` is deliberately NOT here, unlike `script-src` (#424).
    // The argument for allowing inline SCRIPT — applet code is generated, and
    // demanding nonces of a model buys little — does not transfer: styling is
    // the one thing an applet does not have to invent, because the host serves
    // the palette at `/__bernard/tokens.css`. Refusing inline style is what
    // makes that stylesheet mandatory rather than advisory, so a generated
    // applet cannot quietly reintroduce its own colours.
    "style-src 'self'",
    widen('connectSrc', "connect-src 'self'"),
    widen('imgSrc', "img-src 'self' data:"),
    // Without this a `<link rel="manifest">` falls through to
    // `default-src 'none'` and the manifest is never fetched, so PWA install
    // cannot even be offered (#429). Same-origin only — the manifest is a
    // generated route on this applet's own server.
    "manifest-src 'self'",
    widen('fontSrc', "font-src 'self'"),
    // Emitted ONLY when granted. `media-src` has no base value today —
    // an applet with no grant falls through to `default-src 'none'`, and
    // adding a `'self'` default here would widen every existing applet to
    // pay for a directive none of them use.
    ...(sourcesFor('mediaSrc').length
      ? [`media-src 'self' ${sourcesFor('mediaSrc').join(' ')}`]
      : []),
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `sandbox ${sandbox.join(' ')}`,
  ].join('; ');
}

/**
 * Every security header a served applet response carries.
 *
 * `X-Content-Type-Options` because a served asset whose type is sniffed is a
 * served asset whose CSP treatment can be argued with. `Referrer-Policy` so an
 * applet's URL — which carries its app identity — is not leaked outward.
 * `Cache-Control: no-store` because these responses carry a session token.
 */
export function securityHeaders(grant?: AppCspGrant | null): Record<string, string> {
  return {
    'Content-Security-Policy': cspFor(grant),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    // Applets are never framed by anything we serve; `frame-ancestors 'none'`
    // in the CSP is the modern form and this is the legacy belt.
    'X-Frame-Options': 'DENY',
  };
}
