/**
 * What a user may widen an applet's CSP to, and the parsing that decides it
 * (#467, #468).
 *
 * A pure leaf — no I/O, no `node:http` — so every rule here is testable
 * without standing up a server, the same shape `csp.ts` and `guard.ts` have.
 * The store that persists a grant is `src/apps/app-csp-grants.ts`; the header
 * that emits one is {@link cspFor}. Neither belongs here.
 *
 * **Three channels that must not merge.** An applet's manifest may *declare*
 * what it needs (a request, which grants nothing); the user's profile records
 * what was *granted*; the browser reports what it actually *blocked*. This
 * module validates the values that flow through all three, and grants nothing
 * by existing.
 */

/**
 * The directives a user may widen, as camelCase keys.
 *
 * Written down rather than derived, the `AUTHORITY_ACTION_FIELDS` idiom
 * (`apps/manifest.ts`): a test can assert the model-facing tool schema names
 * none of them, the sanitizer drops everything outside the list, and adding
 * one later is a row in this table plus a row in {@link DIRECTIVE_NAMES}.
 *
 * `script-src` and `style-src` are deliberately absent and always will be.
 * #424 made the served stylesheet mandatory by refusing inline style, and an
 * off-origin script is the one thing the origin boundary cannot survive.
 */
export const GRANTABLE_DIRECTIVES = ['imgSrc', 'connectSrc', 'fontSrc', 'mediaSrc'] as const;

export type GrantableDirective = (typeof GRANTABLE_DIRECTIVES)[number];

/**
 * Key → the directive it, and only it, widens.
 *
 * Per-directive separation is structural rather than conventional: key `k`'s
 * sources are emitted into `DIRECTIVE_NAMES[k]` and nowhere else, so an
 * `imgSrc` value and `connect-src` never meet in a variable. #467 requires
 * that an image grant can never widen a network channel; this is what makes
 * that a property of the code rather than something to remember.
 */
export const DIRECTIVE_NAMES: Record<GrantableDirective, string> = {
  imgSrc: 'img-src',
  connectSrc: 'connect-src',
  fontSrc: 'font-src',
  mediaSrc: 'media-src',
};

/**
 * The sandbox tokens a user may add to `allow-scripts allow-same-origin`.
 *
 * Everything absent from this list is refused, and the omissions are reasoned
 * rather than incidental:
 *
 * - `allow-top-navigation` — navigates with no user activation required, i.e.
 *   drive-by. Its `-by-user-activation` sibling is the same capability behind
 *   a gesture, and is the one offered.
 * - `allow-forms` — `form-action 'none'` closes an exfiltration channel
 *   `connect-src` does not cover (`csp.ts`). Re-opening it through the
 *   sandbox would be the same hole by another door.
 * - `allow-downloads`, `allow-modals`, `allow-pointer-lock`,
 *   `allow-presentation` — no applet case has asked, and an unused grant is
 *   an unreviewed one.
 * - `allow-scripts`, `allow-same-origin` — unconditional already. Naming them
 *   here would imply they could be withheld, and `csp.ts` explains at length
 *   why withholding `allow-same-origin` is the actively broken configuration.
 */
export const GRANTABLE_SANDBOX_TOKENS = [
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-top-navigation-by-user-activation',
] as const;

export type SandboxGrant = (typeof GRANTABLE_SANDBOX_TOKENS)[number];

/**
 * What the user typed, and what it resolves to.
 *
 * Aliases exist because the tokens are not independently useful. `links`
 * resolves to BOTH popup tokens: `allow-popups` alone means the opened window
 * *inherits the sandbox*, so an external page loads with no scripts, no
 * storage and no forms — broken more confusingly than not opening at all,
 * which is the trap #468 names. `allow-popups-to-escape-sandbox` without
 * `allow-popups` is a no-op, since nothing may open a window in the first
 * place. The pair is the only coherent state, so the alias stores the pair.
 */
export const SANDBOX_ALIASES: Record<string, readonly SandboxGrant[]> = {
  links: ['allow-popups', 'allow-popups-to-escape-sandbox'],
  navigate: ['allow-top-navigation-by-user-activation'],
};

/** A user's grant for one applet. Absent keys are not granted. */
export type AppCspGrant = Partial<Record<GrantableDirective, string[]>> & {
  sandbox?: SandboxGrant[];
};

/**
 * Sources per directive.
 *
 * A cap at all because the value is concatenated into a response header sent
 * on every request; ten because no real applet has needed more and a grant
 * nobody can read is a grant nobody reviewed.
 */
export const MAX_SOURCES_PER_DIRECTIVE = 10;

/** Hosts longer than this are rejected outright (RFC 1035's limit). */
const MAX_HOST_LENGTH = 253;

/**
 * The character class every accepted source must fall inside.
 *
 * This is a **belt**, not the grammar — {@link isGrantableSource} enforces the
 * shape separately, and both are asserted separately. Its job is that the
 * header cannot be attacked even if the grammar is one day loosened by
 * accident: a grant is concatenated into a `Content-Security-Policy` value, so
 * a hand-edited `"https://x.example; script-src 'unsafe-eval'"` would add a
 * directive nobody granted, and a value carrying CR or LF would make
 * `res.writeHead` throw and kill the socket rather than serve the applet.
 *
 * `;` `,` whitespace, quotes, CR and LF are all outside this class and are
 * therefore structurally unable to reach a header.
 */
const SAFE_SOURCE_CHARS = /^[A-Za-z0-9.:*/-]+$/;

/** `https:` — the whole-scheme wildcard, accepted but never quietly. */
const SCHEME_WILDCARD = 'https:';

/** One host label, or a leading `*` wildcard label. */
const HOST_RE =
  /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * Whether a source expression may be granted.
 *
 * Accepted: `https://host`, `http://host`, either with an optional `:port`,
 * and one leading wildcard label (`https://*.example.com`). Loopback and IPv4
 * literals pass — an applet talking to a local model server on
 * `http://127.0.0.1:11434` is a legitimate `connect-src` grant, and refusing
 * it would push the user toward a broader one.
 *
 * Also accepted: a bare `https:`. #467 is explicit that a grant this broad
 * "should be possible but should look as alarming as it is" — so it is the
 * caller's job to shout, not this function's job to refuse. {@link
 * isWildcardSource} is how a caller tells. Bare `http:` is refused: it is that
 * same breadth plus cleartext, and no real case needs it.
 *
 * Refused, each for its own reason:
 *
 * - **Quoted keywords** (`'self'`, `'none'`, `'unsafe-inline'`, nonces,
 *   hashes) — keywords are the host's business. `'self'` and `data:` are
 *   already emitted and a user cannot remove them, so accepting one here could
 *   only ever add `'unsafe-*'`.
 * - **Non-http schemes** (`data:`, `blob:`, `javascript:`, `file:`) — each is
 *   a capability rather than an origin.
 * - **A path, query, fragment, userinfo or trailing slash** — CSP matches a
 *   host-source, so `https://cdn.example.com/assets` does not mean what the
 *   user typing it believes it means. Refusing beats silently widening.
 * - **Non-ASCII hosts** — the user supplies the punycode form. A validator
 *   that IDNA-encodes is a validator that can disagree with the browser about
 *   what was granted.
 */
export function isGrantableSource(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_HOST_LENGTH + 16) return false;
  if (!SAFE_SOURCE_CHARS.test(value)) return false;
  if (value === SCHEME_WILDCARD) return true;

  const scheme = value.startsWith('https://')
    ? 'https://'
    : value.startsWith('http://')
      ? 'http://'
      : null;
  if (scheme === null) return false;

  const rest = value.slice(scheme.length);
  // A path, query or fragment cannot survive SAFE_SOURCE_CHARS except for
  // `/`, so this is the one separator still worth testing for by hand — and a
  // trailing slash is the common way a user writes an origin they copied out
  // of a browser bar.
  if (rest.includes('/')) return false;

  const colon = rest.lastIndexOf(':');
  const host = colon === -1 ? rest : rest.slice(0, colon);
  const port = colon === -1 ? null : rest.slice(colon + 1);

  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return false;
  if (!HOST_RE.test(host)) return false;

  if (port !== null) {
    if (!/^[0-9]{1,5}$/.test(port)) return false;
    const n = Number(port);
    if (n < 1 || n > 65535) return false;
  }
  return true;
}

/**
 * Whether a granted source is a whole-scheme wildcard.
 *
 * Separated from acceptance so the alarm lives with the caller that has a
 * user to alarm — the CLI prints a block, the consent screen routes it to its
 * own page — rather than being buried in a boolean here.
 */
export function isWildcardSource(value: string): boolean {
  return (
    value === SCHEME_WILDCARD || value.startsWith('https://*.') || value.startsWith('http://*.')
  );
}

/**
 * Resolves aliases and hand-written token lists to what will actually be
 * emitted.
 *
 * Re-adds `allow-popups` whenever `allow-popups-to-escape-sandbox` is present:
 * escaping is meaningless without the ability to open a window, so a profile
 * carrying only the escape token describes a state no browser implements. The
 * repair is safe in the one direction only — the reverse (adding escape to a
 * bare `allow-popups`) would silently widen a grant the user made.
 */
export function normalizeSandboxTokens(raw: readonly string[]): SandboxGrant[] {
  const out = new Set<SandboxGrant>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const alias = SANDBOX_ALIASES[entry];
    if (alias) {
      for (const token of alias) out.add(token);
      continue;
    }
    if ((GRANTABLE_SANDBOX_TOKENS as readonly string[]).includes(entry)) {
      out.add(entry as SandboxGrant);
    }
  }
  if (out.has('allow-popups-to-escape-sandbox')) out.add('allow-popups');
  // Emitted in declaration order so a stored grant and a rebuilt header do not
  // differ by shuffling, which would make a byte-comparison test flap.
  return GRANTABLE_SANDBOX_TOKENS.filter((t) => out.has(t));
}

/**
 * Normalizes anything claiming to be a grant.
 *
 * **Drops, never repairs**, the rule `app-grants.ts` follows and for the same
 * reason: the profile is hand-editable, and a malformed value that survived to
 * the builder would be *emitted* rather than ignored. An unknown key is
 * dropped rather than passed through, so a typo'd `styleSrc` is inert instead
 * of arriving somewhere that trusts its own input.
 */
export function sanitizeCspGrant(raw: unknown): AppCspGrant {
  const out: AppCspGrant = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;

  for (const key of GRANTABLE_DIRECTIVES) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      if (!isGrantableSource(entry)) continue;
      seen.add(entry);
      if (seen.size >= MAX_SOURCES_PER_DIRECTIVE) break;
    }
    if (seen.size > 0) out[key] = [...seen];
  }

  if (Array.isArray(record.sandbox)) {
    const tokens = normalizeSandboxTokens(record.sandbox as string[]);
    if (tokens.length > 0) out.sandbox = tokens;
  }
  return out;
}

/** Whether anything survived — the "delete the key" test for a store. */
export function isEmptyCspGrant(grant: AppCspGrant): boolean {
  if (grant.sandbox && grant.sandbox.length > 0) return false;
  return GRANTABLE_DIRECTIVES.every((key) => (grant[key] ?? []).length === 0);
}

/**
 * One line per granted directive, for a CLI to print and a menu to render.
 *
 * Shared rather than written twice, so `bernard app csp` and `/applets` cannot
 * describe the same stored grant differently — the "one implementation, two
 * doors" split `apps/open.ts` already makes.
 */
export function describeCspGrant(grant: AppCspGrant): string[] {
  const lines: string[] = [];
  for (const key of GRANTABLE_DIRECTIVES) {
    const sources = grant[key];
    if (!sources || sources.length === 0) continue;
    lines.push(`${DIRECTIVE_NAMES[key]}: ${sources.join(', ')}`);
  }
  if (grant.sandbox && grant.sandbox.length > 0) {
    lines.push(`sandbox: ${grant.sandbox.join(' ')}`);
  }
  return lines;
}
