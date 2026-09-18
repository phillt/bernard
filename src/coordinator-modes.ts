/**
 * Whether Bernard plans before it starts, and how that is worded (#167).
 *
 * The `tool-modes.ts` / `remote-messages.ts` shape, at `src/` root for the
 * reason those record: `profiles-wizard-data.ts` is host-agnostic by contract,
 * so a table under `src/ui/` is one the setup wizard cannot import and therefore
 * one it hand-writes. It already had — the wizard and `/agent-options` each
 * carried their own copy of these three rows, plus a third paraphrase on the
 * menu's parent row.
 *
 * ## The rows are shared and the framing is not
 *
 * Only the ROWS live here. The sentence that introduces them is per surface,
 * because the budgets differ: the wizard's rows are bare, so its description is
 * the only explanation on the screen and runs to four lines; the menu's parent
 * row is a one-line teaser in front of a submenu whose rows carry their own
 * `description`. Forcing one string to serve both would make the teaser too long
 * or the wizard's too thin.
 */

/** The three answers. `on`/`off` on disk; `Always` in the label — see below. */
export type CoordinatorMode = 'auto' | 'on' | 'off';

/**
 * One row per answer, for every surface that asks.
 *
 * **`Always on` / `Always off`, not `On` / `Off`.** The value is what it always
 * was, and the setting is not a switch on a feature — it is a choice between
 * deciding per message and deciding once, so a bare `On` beside `Auto` invites
 * the reading that `Auto` is somehow less on. The word that distinguishes them
 * is `Always`, so it is in the label rather than left for the note to supply.
 *
 * `description` ADDS to the framing rather than restating it, and is kept under
 * about fifty characters: the wizard reserves exactly one row for it and
 * truncates to that, so a longer sentence is cut rather than wrapped.
 */
export const COORDINATOR_MODES: ReadonlyArray<{
  value: CoordinatorMode;
  label: string;
  description: string;
}> = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Looks at what was asked, and decides per message.',
  },
  {
    value: 'on',
    label: 'Always on',
    description: 'Plans even when the answer is one step away.',
  },
  {
    value: 'off',
    label: 'Always off',
    description: 'Answers straight away, however many steps it takes.',
  },
];
