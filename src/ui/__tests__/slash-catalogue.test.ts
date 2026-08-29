import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SLASH_COMMANDS } from '../slash-commands.js';

/**
 * The reconciliation between what `<App>.handleSubmit` actually dispatches and
 * what `SLASH_COMMANDS` documents (#390).
 *
 * `SlashHints.tsx` and `HelpOverlay.tsx` are now one catalogue, but the
 * dispatch is still a third, independent source: a ~1100-line flat if-chain of
 * string literals. It drifts one-directionally — dispatch grows, documentation
 * doesn't — which is how `/session-log` shipped as a working command that
 * appeared in no list at all, and how `/rag`, `/policy` and `/usage` reached
 * the strip but never the help screen.
 *
 * **This test reads `App.tsx` as SOURCE TEXT and regexes the literals out of
 * it, and that is brittle by construction.** It knows exactly two branch
 * shapes (`text === '/foo'` and `text.startsWith('/foo ')`) plus the legacy
 * shim's object-literal keys; a branch written any other way — a `switch`, a
 * variable, a template literal, a renamed `text` — is invisible to it and
 * silently reduces coverage rather than failing.
 *
 * Two different assertions guard that, and they cover different halves. The
 * `expect(dispatched.size)` floor catches a *total* miss — a regex that stopped
 * matching anything — which would otherwise make every set comparison below
 * vacuously true. It does NOT catch a partial one: losing just the three legacy
 * shim keys takes the count from 40 to 37, still over the floor. What catches
 * that is `keeps the exclusion allowlist honest`, because those three names are
 * allowlisted and it asserts every allowlisted name still dispatches. Any new
 * shape added here wants the same treatment: something must fail when it stops
 * matching, and a floor alone is only sensitive to losing nearly everything.
 *
 * The fix is for the dispatch to export its command names, so this file
 * compares two exported sets — no parsing, no shape assumptions, no floor. That
 * needs only the names hoisted, not the branch bodies (which close over REPL
 * state), and `slash-commands.ts` is already a data module so a non-UI consumer
 * can reach the catalogue cheaply. Filed as #393; deferred here only because
 * `App.tsx` was being refactored concurrently on the #266 branch.
 */

const APP_SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'),
  'utf8',
);

/**
 * Commands documented in neither catalogue **on purpose**. Every entry needs a
 * reason: an unexplained name here is indistinguishable from an oversight,
 * which is the failure mode this whole test exists to close.
 */
const DELIBERATELY_UNDOCUMENTED: Readonly<Record<string, string>> = {
  // Aliases. Documented inside their primary's `description` — `/exit` says
  // "(alias /quit)", `/usage` says "(alias /cost)" — rather than as rows of
  // their own, so the help screen doesn't list the same command twice.
  '/quit': 'alias of /exit',
  '/cost': 'alias of /usage',
  // Deprecation pointers. Each one only flashes a "this command moved" toast;
  // listing them would advertise names we are trying to retire.
  '/model': 'prints the per-tier deprecation notice pointing at /models',
  '/react': 'legacy toggle shim → /agent-options',
  '/tool-details': 'legacy toggle shim → /agent-options',
  '/debug': 'legacy toggle shim → /options',
};

/** Every command literal `handleSubmit` branches on. */
function dispatchedCommands(source: string): Set<string> {
  const found = new Set<string>();

  // Both `if (text === '/foo')` and `text.startsWith('/foo ')` in one pass —
  // they differ only in the operator text. Multi-command branches such as
  // `text === '/exit' || text === '/quit'` fall out of the `g` flag, which
  // walks every occurrence rather than one per line.
  //
  // Requiring a non-space character after the slash does two jobs at once: it
  // stops the capture at the trailing space of a `'/foo '` prefix literal, and
  // it declines to match the dynamic-routine fallback's bare
  // `text.startsWith('/')`, which names no command and would otherwise have to
  // be deleted from the set afterwards.
  for (const m of source.matchAll(/\btext(?: === |\.startsWith\()'(\/[^'\s]+)/g)) {
    found.add(m[1]);
  }

  // The legacy-shim record maps old names to their pointer text. Its keys are
  // dispatched by lookup rather than by an `if`, so the pattern above cannot
  // see them. Anchored on the binding name only — matching its type annotation
  // too would break on a reformat or a `satisfies` that changes no behaviour.
  const shim = /const legacyToggle\b[^{]*\{([\s\S]*?)\};/.exec(source);
  if (shim) for (const m of shim[1].matchAll(/'(\/[^']+)':/g)) found.add(m[1]);

  return found;
}

describe('slash-command catalogue', () => {
  const dispatched = dispatchedCommands(APP_SOURCE);
  const documented = new Set(SLASH_COMMANDS.map((c) => c.name));

  it('finds the dispatch branches it is supposed to be reading', () => {
    // A floor, not an exact count: adding a command should not have to touch
    // this test. But a regex that matches nothing would otherwise make every
    // assertion below vacuously true, which is worse than a stale number.
    expect(dispatched.size).toBeGreaterThanOrEqual(35);
  });

  it('documents every command the REPL dispatches', () => {
    const undocumented = [...dispatched].filter(
      (name) => !documented.has(name) && !(name in DELIBERATELY_UNDOCUMENTED),
    );
    expect(undocumented).toEqual([]);
  });

  it('dispatches every command it documents', () => {
    expect([...documented].filter((name) => !dispatched.has(name))).toEqual([]);
  });

  it('keeps the exclusion allowlist honest', () => {
    // An allowlisted name that no longer dispatches is dead weight the next
    // reader would take as evidence the command still exists.
    expect(Object.keys(DELIBERATELY_UNDOCUMENTED).filter((n) => !dispatched.has(n))).toEqual([]);
    // …and one that got documented after all should lose its exemption rather
    // than sit here contradicting the catalogue.
    expect(Object.keys(DELIBERATELY_UNDOCUMENTED).filter((n) => documented.has(n))).toEqual([]);
  });
});
