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
 * ## The middle row is not true on its own, and that is a real seam
 *
 * `Ask only about risky things` describes a COMBINATION: `toolMode: 'write'`
 * plus `confirmMode: 'auto'`, which is the default and so the common case. Set
 * confirm mode to `off` on the very next screen and the label is a lie. The row
 * note therefore points at where the rest of the answer lives rather than
 * pretending the answer is here.
 *
 * The honest fix is to merge the two questions, because from a reader's seat
 * they ARE one question — how much do I want to be asked — and only the
 * implementation splits them into "is it allowed" and "do I get a prompt". Four
 * rows would cover every coherent state (`read-only`; `write`+`strict`;
 * `write`+`auto`; `unrestricted`), and the machinery exists: `covers` already
 * lets one question write two settings keys, which is how the third row writes
 * `skipPermissions`.
 *
 * Not done here, because it is a change to what the settings surface IS rather
 * than to its wording: `confirmMode` would lose its own question while keeping
 * its env var, its `/agent-options` row and its per-job cron field, and the
 * first two rows are nearly indistinguishable to a reader (`read-only` blocks
 * a write until allowed; `write`+`strict` runs it after a prompt) which is a
 * finding about the two settings rather than about the copy.
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
    label: 'Ask before every change',
    description: 'Each one waits for you, and can be allowed for the session.',
  },
  {
    value: 'write',
    label: 'Ask only about risky things',
    // The one row whose label is not true on its own: WHICH calls are risky
    // enough to stop for is `confirmMode`, the very next question, and setting
    // that to `off` makes this label a lie. Rather than word around it — "let
    // changes through" says nothing a reader can act on — the label states the
    // common case (`confirmMode` defaults to `auto`) and the note points at
    // where the rest of the answer lives. See the merge note in the module
    // docstring.
    description: 'How risky is the next question.',
  },
  {
    value: UNRESTRICTED,
    label: '⚠ Never ask',
    // `toolModePolicy` short-circuits on `skipPermissions` BEFORE every other
    // rule, so this does not merely relax the confirm gate — it makes the
    // confirm-mode answer inert. Said on the row, because the two questions are
    // asked on separate screens and nothing else connects them.
    description: 'At your own risk: nothing blocked, nothing confirmed.',
  },
];
