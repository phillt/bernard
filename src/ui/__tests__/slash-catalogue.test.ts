import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SLASH_COMMANDS } from '../SlashHints.js';

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
 * silently reduces coverage rather than failing. The `expect(dispatched.size)`
 * floor below is the guard against exactly that: it turns "the regex stopped
 * matching anything" into a failure instead of a pass.
 *
 * The exact fix is to hoist that if-chain into a dispatch table keyed by
 * command name. Both catalogues would then be derivable from the dispatch
 * itself and this file would collapse into a set comparison against real
 * exported data — no source-text parsing, no shape assumptions, no floor.
 * Deferred because it is a large refactor of a file under active edit; #390
 * carries the rationale.
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
  '/quit': 'alias of /exit, named in that entry’s description',
  '/cost': 'alias of /usage, named in that entry’s description',
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

  // `if (text === '/foo')`, including multi-command branches such as
  // `text === '/exit' || text === '/quit'` — the `g` flag walks every
  // occurrence, so both halves of an `||` are picked up independently.
  for (const m of source.matchAll(/\btext === '(\/[^']*)'/g)) found.add(m[1]);

  // `text.startsWith('/foo ')` — the arg-taking commands. The trailing space is
  // part of the literal, so trim it. This also matches the routine fallback's
  // bare `text.startsWith('/')`, which names no command; it is dropped below.
  for (const m of source.matchAll(/\btext\.startsWith\('(\/[^']*)'\)/g)) found.add(m[1].trim());

  // The legacy-shim `Record<string, string>` maps old names to their pointer
  // text. Its keys are dispatched by lookup rather than by an `if`, so the two
  // patterns above cannot see them.
  const shim = /const legacyToggle: Record<string, string> = \{([\s\S]*?)\};/.exec(source);
  if (shim) for (const m of shim[1].matchAll(/'(\/[^']+)':/g)) found.add(m[1]);

  // `'/'` alone is the dynamic-routine fallback, not a command.
  found.delete('/');
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
    expect(dispatched.has('/help')).toBe(true);
    expect(dispatched.has('/session-log')).toBe(true);
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
