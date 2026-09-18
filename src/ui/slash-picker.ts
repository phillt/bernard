import { FRAME_CHROME_ROWS, MIN_TRANSCRIPT_ROWS, PROMPT_CHROME_ROWS } from './plan-window.js';

/**
 * Pure geometry for the slash-command picker (#589) — no React, no Ink.
 *
 * The `line-geometry.ts` / `menu-geometry.ts` / `plan-window.ts` doctrine: this
 * is arithmetic that wants unit tests over every terminal size, and a bound
 * expressed only inside a component can be exercised at exactly one — a bare
 * `render()` silently receives the 80×24 `FALLBACK_DIMENSIONS`.
 *
 * **The defect was that there was no bound at all.** `SlashHints` rendered one
 * `MenuRow` per match with no cap, no slice and no window, and a bare `/`
 * matches the whole catalogue: 38 rows under a prompt box that sits inside a
 * fixed-height frame. Measured before this change, typing `/` produced a
 * 42-row frame. Same class as #358 (the plan panel, unbounded in the same box)
 * and #354/#355 (the input, unbounded on both axes); this was the one
 * selectable list that never got the fix, because it lives in `Prompt.tsx`
 * rather than in `overlays/`.
 *
 * A sibling of `plan-window.ts` rather than part of it: the three frame
 * constants it needs are already exported from there, so nothing is duplicated,
 * and a module named for the plan should not accumulate a second surface's
 * arithmetic. Everything else the picker needs — `clampOffset`, `listPosition`,
 * `formatPosition` — already exists in `viewer-util.ts` and is used unmodified,
 * because the horizontal cap below makes one command exactly one row.
 */

/**
 * Rows the popover spends on its own chrome: the two rounded-border rows plus
 * the header, which carries the scroll position.
 *
 * Reserved **unconditionally**, as `OverlayFooter` and `PlanPanel` both
 * document: a row rendered only when something is hidden makes the popover's
 * height depend on the very budget that decides what is hidden, so it would
 * flicker as the match list crossed the threshold. `listPosition` returning
 * `null` IS that suppression rule — the header degrades to the bare noun
 * rather than disappearing.
 */
export const SLASH_PICKER_CHROME_ROWS = 3;

/** Never fewer than chrome plus one command — see {@link slashPickerMaxRows}. */
const MIN_PICKER_ROWS = SLASH_PICKER_CHROME_ROWS + 1;
/** Never more than chrome plus eight, however tall the terminal. */
const MAX_PICKER_ROWS = SLASH_PICKER_CHROME_ROWS + 8;

/**
 * What this budget charges the input line, and why it is not
 * `plan-window.ts`'s `inputRegionRows`.
 *
 * That function charges `BoundedLine`'s **cap** — up to ten rows plus two
 * affordance rows — because the plan panel is persistent: it is on screen while
 * the user types anything at all, including a pasted paragraph, so its budget
 * has to hold for a buffer it cannot see. The picker is on screen only while
 * the buffer is a single `/`-token that is a **prefix of a command that
 * exists**: `matchSlashCommands` returns nothing once the buffer contains a
 * space, and nothing once the token is longer than every name it could match.
 * So the input beneath the popover is one row on any terminal wide enough to
 * hold the longest command name, which `slash-picker.test.ts` pins.
 *
 * Charging the cap instead is not conservative, it is fatal: at 24 rows — the
 * fallback size, and the one most people run — it leaves the picker two
 * command rows out of 38.
 *
 * **The slack this spends is already reserved.** `planPanelMaxRows` charges
 * that same input its cap while the real input is one row, so when a plan and
 * the picker are both up the picker's under-charge comes out of the plan
 * budget's over-charge rather than out of the frame. That is why
 * `planPanelMaxRows` needs no parameter for the picker and the plan does not
 * flicker away when the popover opens — checked at every terminal height by
 * `slash-picker.test.ts` and, on the rendered frame, by `Prompt.test.tsx`.
 */
const SLASH_INPUT_ROWS = 1;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

/**
 * Total terminal rows the popover — its border and header included — may take.
 *
 * Called by `Prompt`, which is the one component that sees the input, the plan
 * panel, the border and this popover, so the dock's height reads as an
 * expression in one file rather than an emergent sum of several files' private
 * constants. The same contract as `PlanPanel`'s `maxRows` and `BoundedLine`'s
 * `reserveColumns`: the caller owns it because only the caller knows what it
 * sits in.
 *
 * **It never returns 0, which is the one place it diverges from
 * `planPanelMaxRows`.** That function yields the plan panel entirely on a short
 * terminal, and can, because a plan is reference material the user can do
 * without. Here the popover is the answer to a keystroke the user just pressed:
 * rendering nothing would leave `/ex` showing no completion while Enter still
 * ran `/exit`, which is a silent action. So on a terminal too short to hold the
 * transcript floor as well, the picker borrows from the transcript — and the
 * rows come straight back on the next keystroke, which is the difference
 * between this surface and a persistent one.
 */
export function slashPickerMaxRows(termRows: number): number {
  const spoken = SLASH_INPUT_ROWS + PROMPT_CHROME_ROWS + FRAME_CHROME_ROWS + MIN_TRANSCRIPT_ROWS;
  return clamp(termRows - spoken, MIN_PICKER_ROWS, MAX_PICKER_ROWS);
}

/** Command rows left once {@link SLASH_PICKER_CHROME_ROWS} is paid. */
export function slashPickerListRows(maxRows: number): number {
  return Math.max(1, maxRows - SLASH_PICKER_CHROME_ROWS);
}

/**
 * Columns of the popover's own chrome: one border cell and one padding column
 * on each side.
 */
export const SLASH_PICKER_CHROME_COLUMNS = 4;

/**
 * `MenuRow`'s selection gutter, which every row pays whether selected or not.
 *
 * Restated rather than imported: `MENU_MARKER` lives in a `.tsx` and this is a
 * pure leaf. Nothing has to remember to keep them in step, though — a wider
 * marker makes a maximal row wrap, and `SlashHints.test.tsx` fails any frame
 * whose rows do not all measure the same width.
 */
const MARKER_COLUMNS = 2;

/** Between a command name and its description. */
export const SLASH_ROW_SEPARATOR = ' — ';

/**
 * Below this a description is noise rather than a gloss, so the row drops it
 * and gives the whole width to the name — which is the half the user is
 * matching against.
 */
const MIN_DESCRIPTION_COLUMNS = 12;

/**
 * Widest the popover is allowed to get.
 *
 * A popover that spans the terminal is a bar, not a popover, and at 200 columns
 * a 46-character gloss stranded at the far right is unreadable. Fixed rather
 * than sized to the widest current match, deliberately: content sizing makes
 * the box's width change on every keystroke as the match list narrows, which is
 * the horizontal twin of the "window that visibly breathes" `menu-geometry.ts`
 * refuses.
 */
const MAX_PICKER_COLUMNS = 74;

/** Interior width the rows get, border and padding already paid. */
export function slashPickerTextWidth(columns: number): number {
  return Math.max(12, Math.min(MAX_PICKER_COLUMNS, columns) - SLASH_PICKER_CHROME_COLUMNS);
}

/**
 * Split one row's interior width between the command name and its gloss.
 *
 * Two budgets rather than one truncation of the joined string, because the
 * description renders in its own muted `<Text>` and joining them first would
 * lose that — the same shape, and the same reason, as `splitStepWidth`. The
 * halves sum to at most `width`, which is what keeps **one command is one row**
 * true, and that invariant is what lets the window run over command INDICES so
 * `clampOffset` / `listPosition` apply unmodified.
 *
 * The name wins ties: it is what the buffer is a prefix of, so a row that has
 * cut the name has cut the only part that answers "did I type enough?".
 */
export function splitSlashRowWidth(
  width: number,
  nameWidth: number,
): { name: number; description: number } {
  const available = Math.max(1, width - MARKER_COLUMNS);
  const name = Math.max(1, Math.min(nameWidth, available));
  const rest = available - name - SLASH_ROW_SEPARATOR.length;
  return { name, description: rest >= MIN_DESCRIPTION_COLUMNS ? rest : 0 };
}
