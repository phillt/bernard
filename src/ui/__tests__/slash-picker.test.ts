import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import {
  SLASH_PICKER_CHROME_COLUMNS,
  SLASH_PICKER_CHROME_ROWS,
  SLASH_ROW_SEPARATOR,
  padToWidth,
  slashPickerListRows,
  slashPickerMaxRows,
  slashPickerTextWidth,
  splitSlashRowWidth,
  truncateToWidth,
  widthOf,
} from '../slash-picker.js';
import { MIN_TRANSCRIPT_ROWS, planPanelMaxRows } from '../plan-window.js';
import { SLASH_COMMANDS } from '../slash-commands.js';

/**
 * No renderer and no terminal size — the `line-geometry.ts` / `plan-window.ts`
 * doctrine (#589). These assertions cover every terminal height and width,
 * which a rendered test cannot: a bare `render()` silently receives the 80×24
 * `FALLBACK_DIMENSIONS`, so a bound expressed only in a component can be
 * exercised at exactly one size.
 */

describe('slashPickerMaxRows', () => {
  it('bounds the picker however many commands match', () => {
    // The defect, stated as an assertion: the catalogue is 38 entries and a
    // bare `/` matches all of them, so an unbounded list is 38 rows under a
    // prompt box inside a fixed-height frame.
    for (let rows = 1; rows <= 200; rows++) {
      expect(slashPickerMaxRows(rows)).toBeLessThanOrEqual(SLASH_PICKER_CHROME_ROWS + 8);
    }
    expect(SLASH_COMMANDS.length).toBeGreaterThan(SLASH_PICKER_CHROME_ROWS + 8);
  });

  it('never yields the popover entirely — the divergence from the plan panel', () => {
    // `planPanelMaxRows` returns 0 on a short terminal because a plan is
    // reference material. Rendering nothing here would leave `/ex` showing no
    // completion while Enter still ran `/exit`: a silent action.
    for (let rows = 1; rows <= 200; rows++) {
      expect(slashPickerMaxRows(rows)).toBeGreaterThanOrEqual(SLASH_PICKER_CHROME_ROWS + 1);
      expect(slashPickerListRows(slashPickerMaxRows(rows))).toBeGreaterThanOrEqual(1);
    }
  });

  /**
   * NOT monotonic on its own, and that is the shape of the fix rather than a
   * defect: at the height where the plan panel first appears it claims its own
   * floor, and the picker gives those rows up in the same step. What is
   * monotonic is what the two claim TOGETHER — the dock never asks for fewer
   * rows as the frame grows, and every row the picker gives up went to the
   * plan rather than back to the frame.
   */
  it('never shrinks except by exactly what the plan panel took', () => {
    for (let rows = 2; rows <= 200; rows++) {
      const pick = slashPickerMaxRows(rows);
      const prevPick = slashPickerMaxRows(rows - 1);
      const plan = planPanelMaxRows(rows);
      const prevPlan = planPanelMaxRows(rows - 1);
      expect(pick + plan).toBeGreaterThanOrEqual(prevPick + prevPlan);
      if (pick < prevPick) expect(plan - prevPlan).toBeGreaterThanOrEqual(prevPick - pick);
    }
  });

  /**
   * The load-bearing one, and the one the first cut of this PR got wrong in a
   * way that hid a live defect.
   *
   * It restated the chrome by hand — right, per `plan-window.test.ts`'s rule
   * that importing the constants makes an assertion self-consistent with
   * whatever they say — and then restated it as `1` where `FRAME_CHROME_ROWS`
   * is `1 + 2` (the hint/status row PLUS the busy spinner), and dropped
   * `MIN_TRANSCRIPT_ROWS` entirely. So it asserted against a frame two rows
   * shorter than the one `slashPickerMaxRows` itself charges for, and passed at
   * 24 computing 21 <= 24 while the real sum was 26. `Prompt.test.tsx` could
   * not catch it either: it mounts `Prompt` alone, so there is no transcript
   * there to squeeze. A guard computing a different invariant from the one it
   * is named for is worse than no guard.
   *
   * `MIN_TRANSCRIPT_ROWS` is imported rather than restated because it is the
   * thing being ASSERTED, not a term of the sum — the split
   * `plan-window.test.ts` makes in its own sibling of this test.
   */
  it('leaves the transcript its declared floor with a plan panel open as well', () => {
    // These are the rows `App.tsx` actually renders outside the prompt box.
    const frameChrome = 1 /* HintBar/StatusBar row */ + 2; /* busy spinner + its marginTop */
    // From 14 up: below that the floor plus the picker's own minimum exceeds
    // the frame with the plan already yielded to 0, and the popover borrows
    // from the transcript on purpose — the rows come back on the next
    // keystroke, which a persistent surface cannot say. `plan-window.test.ts`
    // carves out the same band for the same reason one floor down.
    for (let rows = 14; rows <= 200; rows++) {
      const dock =
        1 /* the slash token: the buffer is a prefix of a match */ +
        3 /* the round border's two rows plus Prompt's marginTop */ +
        planPanelMaxRows(rows) +
        slashPickerMaxRows(rows) +
        frameChrome;
      expect(rows - dock).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_ROWS);
    }
  });

  it('keeps both surfaces on screen at the fallback height', () => {
    // The concrete repro from the review: a 24-row terminal, a plan of two or
    // more steps open, the user types `/`. Named rather than left to the sweep
    // above, because 24 is `FALLBACK_DIMENSIONS` and the regression was
    // specifically that the transcript got 1 row there.
    expect(planPanelMaxRows(24)).toBeGreaterThan(0);
    expect(slashPickerListRows(slashPickerMaxRows(24))).toBeGreaterThanOrEqual(4);
  });

  it('the input really is one row while the popover is open', () => {
    // `SLASH_INPUT_ROWS` is 1 because `matchSlashCommands` returns nothing once
    // the buffer holds a space and nothing once the token outruns every name it
    // could match — so the buffer is a prefix of some command. Restated by hand
    // (`PROMPT_RESERVED_COLUMNS` lives in a `.tsx`, which this suite must not
    // drag in) and pinned so a very long command name cannot quietly make the
    // charge false.
    const promptReservedColumns = 10;
    const longest = Math.max(...SLASH_COMMANDS.map((c) => c.name.length));
    expect(longest + promptReservedColumns).toBeLessThanOrEqual(80);
  });
});

describe('slashPickerTextWidth / splitSlashRowWidth', () => {
  it('subtracts the popover border and padding', () => {
    expect(slashPickerTextWidth(60)).toBe(60 - SLASH_PICKER_CHROME_COLUMNS);
  });

  it('stops widening on a wide terminal — a popover that spans the screen is a bar', () => {
    expect(slashPickerTextWidth(200)).toBe(slashPickerTextWidth(120));
    expect(slashPickerTextWidth(200)).toBeLessThan(120);
  });

  it('floors at a legible width on a pathologically narrow terminal', () => {
    expect(slashPickerTextWidth(4)).toBeGreaterThanOrEqual(12);
  });

  it('keeps marker + name + separator + description inside one row', () => {
    // One command is one row is what makes windowing over command indices
    // valid, so `clampOffset` / `listPosition` apply unmodified.
    for (const width of [12, 20, 40, 70]) {
      for (const nameWidth of [1, 6, 18, 40]) {
        const { name, description } = splitSlashRowWidth(width, nameWidth);
        const used = 2 /* MenuRow's marker gutter */ + name;
        const total = description > 0 ? used + SLASH_ROW_SEPARATOR.length + description : used;
        expect(total).toBeLessThanOrEqual(width);
      }
    }
  });

  it('gives the name the whole row rather than cutting it for a gloss', () => {
    // The name is what the buffer is a prefix of, so a row that has cut the
    // name has cut the only part answering "did I type enough?".
    const { name, description } = splitSlashRowWidth(20, 18);
    expect(name).toBe(18);
    expect(description).toBe(0);
  });

  it('keeps the gloss when there is room for one', () => {
    const { name, description } = splitSlashRowWidth(70, 18);
    expect(name).toBe(18);
    expect(description).toBeGreaterThanOrEqual(12);
  });
});

/**
 * Columns, not UTF-16 units. The rows are not a closed set — `App.tsx`
 * synthesizes one per saved routine, and `RoutineStore.name` is unvalidated —
 * so a width decision that counts units renders at twice its budget for CJK
 * and wraps, taking "one command is one row" with it.
 */
describe('widthOf / truncateToWidth / padToWidth', () => {
  const CJK = '\u4f5c\u696d\u30ed\u30b0';

  it('counts display columns, which is not string length', () => {
    expect(widthOf(CJK)).toBe(CJK.length * 2);
    expect(widthOf('/exit')).toBe(5);
  });

  it('agrees with string-width on both paths', () => {
    // The ASCII fast path is an optimisation, so it has to be exactly that.
    for (const s of ['/exit', '', 'a b c', CJK, `mixed ${CJK} tail`, '\u2014\u2013\u2026']) {
      expect(widthOf(s)).toBe(stringWidth(s));
    }
  });

  it('agrees with string-width on every code point, not just a sample', () => {
    // A fixture list pins the fast path only where someone thought to look, and
    // the range is exactly what a wrong one gets wrong: widening it by one
    // block silently admits the C1 controls, which `stringWidth` measures as 0
    // while `.length` measures them as 1. Asserted as one comparison over the
    // whole range rather than 12 000 `expect`s, which is both faster and gives
    // a readable failure.
    const mismatched: string[] = [];
    for (let cp = 0; cp <= 0x2fff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (widthOf(ch) !== stringWidth(ch)) mismatched.push(`U+${cp.toString(16)}`);
    }
    expect(mismatched).toEqual([]);
  });

  it('never returns more columns than the budget it was given', () => {
    for (const max of [0, 1, 2, 5, 12, 40]) {
      for (const s of [
        'short',
        'x'.repeat(200),
        CJK.repeat(30),
        `${CJK}abc${CJK}`,
        // Astral, and it is the fixture that matters most: `stringWidth`
        // answers **0** for a lone surrogate, so an implementation that walked
        // UTF-16 units instead of code points would never advance its
        // accumulator and would return the whole string — measured at 11
        // columns against a budget of 3. Checking only for an orphan character
        // misses that completely, because there is no orphan; the string is
        // simply never cut.
        '\u{1d400}'.repeat(10),
      ]) {
        expect(widthOf(truncateToWidth(s, max))).toBeLessThanOrEqual(Math.max(0, max));
      }
    }
  });

  it('leaves a string that already fits completely alone', () => {
    expect(truncateToWidth('/exit', 40)).toBe('/exit');
    expect(truncateToWidth(CJK, 8)).toBe(CJK);
  });

  it('marks the cut', () => {
    expect(truncateToWidth('x'.repeat(40), 10)).toMatch(/\u2026$/);
  });

  it('never splits a surrogate pair', () => {
    // A budget counted in UTF-16 units can land between the halves and the
    // terminal renders the orphan as U+FFFD — `text.safeCutIndex`'s subject,
    // sidestepped here by walking code points rather than indices. The width
    // bound above is what actually fails a unit-walking implementation; this
    // pins the character-level property for one that cuts by index instead.
    const astral = '\u{1d400}'.repeat(10);
    for (let max = 1; max <= 12; max++) {
      const cut = truncateToWidth(astral, max);
      expect([...cut].every((c) => c === '\u{1d400}' || c === '\u2026')).toBe(true);
    }
  });

  it('pads to columns, so a name cell aligns its gloss', () => {
    expect(widthOf(padToWidth(CJK, 20))).toBe(20);
    expect(widthOf(padToWidth('/exit', 20))).toBe(20);
    // Never shortens: a name already at or over the cell is left as it is.
    expect(padToWidth('/exit', 2)).toBe('/exit');
  });

  it('measures the row separator in columns too', () => {
    expect(widthOf(SLASH_ROW_SEPARATOR)).toBe(stringWidth(SLASH_ROW_SEPARATOR));
  });
});
