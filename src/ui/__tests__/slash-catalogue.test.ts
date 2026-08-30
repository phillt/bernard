import { describe, it, expect } from 'vitest';
import { DISPATCHED_COMMANDS, SLASH_COMMANDS } from '../slash-commands.js';

/**
 * The reconciliation between what `<App>.handleSubmit` dispatches and what the
 * REPL documents (#390, #393). Both sets are exported from `slash-commands.ts`:
 * `DISPATCHED_COMMANDS` mirrors the if-chain, `SLASH_COMMANDS` feeds the hint
 * strip and the help screen.
 *
 * `DISPATCHED_COMMANDS` is a hand-maintained mirror, and a hand-maintained
 * mirror compared only against a second list is blind to the drift that
 * actually happened — a branch added and never listed. What closes that is not
 * this file: it is the typed `is` / `startsWithCmd` helpers in `App.tsx`, whose
 * command parameter is `DispatchedCommand`, so an unlisted branch fails to
 * compile. **Do not "simplify" those helpers back to bare `===`** — the array
 * becomes decorative and this test becomes a comparison of two things nobody
 * checks against the code. `SLASH_COMMANDS`' `name` is narrowed to the same
 * type, which closes the other direction.
 *
 * What is left for a test is the middle ground the compiler has no opinion on:
 * which dispatched commands are *supposed* to be absent from the catalogue.
 *
 * This replaced a regex that read `App.tsx` as source text. It knew exactly two
 * branch shapes and lost coverage silently for any third, and it made the
 * chain's syntax a tested interface — nudging the next person to keep writing
 * `text === '/foo'` rather than to hoist.
 */

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

describe('slash-command catalogue', () => {
  const dispatched = new Set<string>(DISPATCHED_COMMANDS);
  const documented = new Set<string>(SLASH_COMMANDS.map((c) => c.name));

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
