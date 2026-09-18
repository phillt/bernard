import { describe, it, expect } from 'vitest';
import {
  SLASH_PICKER_CHROME_COLUMNS,
  SLASH_PICKER_CHROME_ROWS,
  SLASH_ROW_SEPARATOR,
  slashPickerListRows,
  slashPickerMaxRows,
  slashPickerTextWidth,
  splitSlashRowWidth,
} from '../slash-picker.js';
import { MIN_TRANSCRIPT_ROWS, PROMPT_CHROME_ROWS, planPanelMaxRows } from '../plan-window.js';
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

  it('is monotonic in terminal height', () => {
    for (let rows = 2; rows <= 200; rows++) {
      expect(slashPickerMaxRows(rows)).toBeGreaterThanOrEqual(slashPickerMaxRows(rows - 1));
    }
  });

  it('leaves the transcript its declared floor once the frame can afford one', () => {
    // Below this the popover borrows from the transcript on purpose — the rows
    // come back on the next keystroke, which a persistent surface cannot say.
    for (let rows = 14; rows <= 200; rows++) {
      const dock = 1 /* the slash token */ + PROMPT_CHROME_ROWS + slashPickerMaxRows(rows);
      expect(rows - dock - 1 /* hint + status row */).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_ROWS);
    }
  });

  /**
   * The load-bearing one, and the reason `planPanelMaxRows` needs no parameter
   * for the picker: the two budgets overlap, and the overlap has to come out of
   * slack the plan budget has already reserved rather than out of the frame.
   *
   * The chrome terms are restated by hand rather than imported for the reason
   * `plan-window.test.ts` gives about `inputRegion`: importing the constants
   * would make the assertion self-consistent with whatever they say, so it
   * would still pass with both budgets doubled.
   */
  it('fits the dock inside the frame with a plan panel open as well', () => {
    for (let rows = 12; rows <= 200; rows++) {
      const dock =
        1 /* the slash token: the buffer is a prefix of a match */ +
        3 /* the round border's two rows plus Prompt's marginTop */ +
        planPanelMaxRows(rows) +
        slashPickerMaxRows(rows) +
        1; /* the unconditional hint + status row */
      expect(dock).toBeLessThanOrEqual(rows);
    }
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
