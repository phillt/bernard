import type { Step } from '../plan-store.js';
import { clampOffset, listPosition } from './overlays/viewer-util.js';

/**
 * Pure geometry for the pinned plan panel (#358) — no React, no Ink.
 *
 * Split out for the reason `line-geometry.ts` and `overlays/menu-geometry.ts`
 * give at their own heads: this is arithmetic that wants unit tests, and
 * leaving it inside `PlanPanel.tsx` would drag React and Ink into a suite that
 * needs neither. It also sidesteps the `DimensionsProvider` trap — a bare
 * `render()` silently receives the 80×24 fallback, so a bound expressed only
 * inside a component can only be exercised at one terminal size.
 *
 * **The defect is two axes, not one.** `PlanStore.create` / `add` push without
 * limit and the `plan` tool's schema declares no `.max()`, so the step count is
 * unbounded; and `STEP_FIELD_MAX` caps a description at 400 characters per
 * FIELD, not per row, so one maximal step soft-wraps to 7 rows (8 with a
 * cancelled note) in the ~66 columns the panel gets at 80. Capping only the
 * count leaves a 3-step plan able to occupy 21 rows. The horizontal cap is also
 * what makes windowing over step INDICES valid — one step is one row, so
 * `clampOffset` / `listPosition` apply unmodified — which is the move
 * `HelpOverlay` made in #392 with `descriptionWidth`.
 *
 * What it squeezes: `TranscriptViewport` is the only `flexGrow={1}` child of the
 * full-screen frame, so it absorbs every row the prompt box takes and shrinks
 * toward zero — clipped, bottom-pinned, PgUp paging by one line. Past zero Yoga
 * starts shrinking the bordered box and the hint row, which is where it visibly
 * breaks. Same failure class as #392 / #396.
 *
 * Deliberately NOT `line-geometry.windowBuffer`: that takes a single string
 * with a character cursor and rebases the index into a pre-wrapped slice, wraps
 * positionally rather than by word, and PINS the cursor to the last visible
 * row. All three are right for an input and wrong for a step list, whose
 * implicit cursor is the `in_progress` step and should stay wherever in the
 * window it already sits.
 *
 * Deliberately NOT `menu-geometry.overlayViewport` / `viewer-util.
 * viewerFrameHeight` either: both baseline at `rows - 1` because the component
 * they serve owns the whole frame. The plan panel owns a SLICE of the prompt
 * box, so its budget is handed down by `Prompt` — see {@link planPanelMaxRows}.
 */

/**
 * Rows the panel spends on its own chrome: the `◇ plan n/m` header, the
 * scroll-position row, and the interior divider that separates it from the
 * input line below.
 *
 * The position row is reserved **unconditionally** — blank when everything
 * fits, exactly as `OverlayFooter` documents. Rendering it only when something
 * is hidden would make the panel's height depend on the very budget that
 * decides what is hidden, so the last row would flicker as a plan grew past the
 * threshold.
 */
export const PLAN_CHROME_ROWS = 3;

/** Never less than chrome + one step: a header with nothing under it is worse
 * than no panel at all. */
const MIN_PANEL_ROWS = PLAN_CHROME_ROWS + 1;
/** Never more than chrome + six steps, however tall the terminal. */
const MAX_PANEL_ROWS = PLAN_CHROME_ROWS + 6;

/**
 * Total terminal rows the whole panel — chrome included — may occupy.
 *
 * Called by `Prompt`, which is the one component that knows both children and
 * the border, so the box's total height reads as an expression in one file
 * rather than an emergent sum of two files' private constants. The mirror of
 * `BoundedLine`'s `reserveColumns`, which is owned by the caller for the same
 * reason: only the caller knows what box it sits in.
 *
 * A **quarter** of the frame against the input's third (`BoundedLine`:
 * `max(3, min(10, floor(rows / 3)))`). The two budgets are deliberately
 * independent — a genuinely shared pool would need both children to lift their
 * demand into `Prompt`, and the plan lives behind `PlanPanel`'s own store
 * subscription — but the plan's fraction is the smaller one on purpose: the
 * input is where the user's attention is, the plan is reference material. The
 * gap is wider than 1/3 vs. 1/4 makes it look, because the plan pays its three
 * chrome rows out of this budget while the input's two affordance rows are
 * siblings outside its own cap.
 */
export function planPanelMaxRows(termRows: number): number {
  return Math.max(MIN_PANEL_ROWS, Math.min(MAX_PANEL_ROWS, Math.floor(termRows / 4)));
}

/** Step rows left over once {@link PLAN_CHROME_ROWS} is paid. */
export function planListRows(maxRows: number): number {
  return Math.max(1, maxRows - PLAN_CHROME_ROWS);
}

/**
 * The step a window should be seeded on — a plan's implicit cursor.
 *
 * `in_progress` first (that is the work happening right now), then the next
 * `pending` step, and failing both the last step, so a finished plan shows its
 * tail rather than scrolling back to a run of `✔`s the user has already read.
 */
export function activeStepIndex(steps: readonly Step[]): number {
  if (steps.length === 0) return 0;
  const running = steps.findIndex((s) => s.status === 'in_progress');
  if (running !== -1) return running;
  const next = steps.findIndex((s) => s.status === 'pending');
  if (next !== -1) return next;
  return steps.length - 1;
}

export interface PlanWindow {
  /** Index of the first step rendered. */
  offset: number;
  /** How many steps are rendered. */
  size: number;
  /** `steps first–last of total`, or `null` when nothing is hidden. */
  position: { first: number; last: number; total: number } | null;
}

/**
 * Which slice of `steps` to render inside `maxRows`.
 *
 * Stateless: the panel is not focusable and has no scroll keys, so there is no
 * offset to persist between renders — the window is a pure function of where
 * the work currently is. `clampOffset` is called with a stored offset of `0`,
 * which makes it "scroll just far enough that the active step is the last
 * visible one", and `listPosition` returning `null` IS the affordance-
 * suppression rule (no second `total <= size` test to drift from it).
 */
export function planWindow(steps: readonly Step[], maxRows: number): PlanWindow {
  const total = steps.length;
  const size = Math.min(planListRows(maxRows), Math.max(1, total));
  const offset = clampOffset(activeStepIndex(steps), 0, size, total);
  return { offset, size, position: listPosition(offset, size, total) };
}

/**
 * Columns the panel's own gutters cost: the fixed 2-column icon cell plus the
 * step list's `paddingLeft={2}` / `paddingRight={1}`. The id cell is sized per
 * plan (widest id + `". "`) and so is passed in, not folded in here.
 */
export const PLAN_GUTTER_COLUMNS = 2 + 2 + 1;

/**
 * Room a step's text gets before it has to be cut. `reserveColumns` is the
 * surrounding chrome `Prompt` owns — its rounded border — on the same contract
 * as `BoundedLine`'s prop of that name.
 *
 * Floored at 8 rather than 1: below that the row is illegible anyway, and a
 * hard floor keeps a pathologically narrow terminal from producing a width of
 * zero that `truncate` would turn into a bare ellipsis.
 */
export function stepTextWidth(
  columns: number,
  reserveColumns: number,
  idCellWidth: number,
): number {
  return Math.max(8, columns - reserveColumns - PLAN_GUTTER_COLUMNS - idCellWidth);
}

/** Separator between a step's description and its failure note. */
export const NOTE_SEPARATOR = ' · ';
/** Upper bound on a note regardless of how wide the terminal is. */
export const NOTE_MAX_WIDTH = 60;

/**
 * Split one row's width between the description and a cancelled/error note.
 *
 * Two budgets rather than one truncation of the joined string, because the note
 * renders in its own dimmed `<Text>` — joining them first would lose that. The
 * halves sum to at most `width`, which is what keeps "one step is one row"
 * true, and the note is capped at a third so a long reason can never crowd out
 * the description that names the step it belongs to.
 */
export function splitStepWidth(
  width: number,
  hasNote: boolean,
): { description: number; note: number } {
  const w = Math.max(1, width);
  if (!hasNote) return { description: w, note: 0 };
  const note = Math.max(1, Math.min(NOTE_MAX_WIDTH, Math.floor(w / 3)));
  return { description: Math.max(1, w - note - NOTE_SEPARATOR.length), note };
}
