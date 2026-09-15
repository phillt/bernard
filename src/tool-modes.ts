/**
 * What Bernard is allowed to do, and how that is worded (#144/#179/#212).
 *
 * A pure table in the `remote-messages.ts` shape, at `src/` root for the reason
 * that module records: `profiles-wizard-data.ts` is host-agnostic by contract,
 * so a table under `src/ui/` is one the setup wizard cannot import and therefore
 * one it hand-writes. That already happened here — three surfaces spelled the
 * same three answers three different ways:
 *
 * - setup: `Read-only (least privilege)` / `Write (allow all tools)` /
 *   `⚠ Unrestricted (no permission checks)`
 * - `/agent-options`: `Read-only (least privilege)` / `Write` /
 *   `Run Without Permission Checks or Safeguards`
 * - the `/agent-options` parent row's own description, a third paraphrase
 *
 * And one of them was simply WRONG: "allow all tools" is what `unrestricted`
 * does. `write` lets a write RUN and leaves the confirm gate standing, so the
 * two rows a reader most needs to tell apart were described as the same thing.
 *
 * ## `unrestricted` is a row here and two fields on disk
 *
 * `ProfileSettings.toolMode` is `'read-only' | 'write'`; the third answer is
 * `skipPermissions`, which `toolModePolicy` short-circuits on before every other
 * rule. Presenting it as a third row is what `/agent-options` already did and is
 * right — a mode you can set and then contradict on the next screen is not a
 * mode — so the sentinel is written down once, here, rather than invented as
 * `'unrestricted'` in one caller and `'skip'` in another.
 */

/** The three answers, as a reader meets them. Least- to most-permissive. */
export type ToolModeChoice = 'read-only' | 'write' | typeof UNRESTRICTED;

/**
 * The third row's value, which is `skipPermissions` rather than a `toolMode`.
 *
 * Exported because every caller has to map it back to the two fields it really
 * sets, and a caller that spells the sentinel itself is a caller that can spell
 * it differently — which is how this arrived as `'unrestricted'` in the wizard
 * and `'skip'` in the menu.
 */
export const UNRESTRICTED = 'unrestricted';

/**
 * One row per answer, for every surface that asks.
 *
 * `description` is a sentence that ADDS to whatever framing the surface already
 * shows — what the row costs you, not a restatement of what it is. The setup
 * wizard renders it on its reserved note row and `/agent-options` under the row.
 * The parenthetical helper text it replaces could be neither: it competed with
 * the label for the same space, and it had to be stripped back off before the
 * answer could be decoded.
 *
 * **Kept under about fifty characters**, because the wizard's note row is
 * reserved as exactly ONE row and truncates to it — so a longer sentence is not
 * wrapped, it is cut. The bound is the structural guard; short copy is what
 * keeps it from firing.
 */
export const TOOL_MODES: ReadonlyArray<{
  value: ToolModeChoice;
  label: string;
  description: string;
}> = [
  {
    value: 'read-only',
    label: 'Read-only',
    description: 'Allow a blocked tool once, or for the session.',
  },
  {
    value: 'write',
    label: 'Write',
    description: 'The confirm prompts still apply.',
  },
  {
    value: UNRESTRICTED,
    label: '⚠ Unrestricted',
    // `toolModePolicy` short-circuits on `skipPermissions` BEFORE every other
    // rule, so this does not merely relax the confirm gate — it makes the
    // confirm-mode answer inert. Said on the row, because the two questions are
    // asked on separate screens and nothing else connects them.
    description: 'Nothing is blocked and nothing is confirmed.',
  },
];
