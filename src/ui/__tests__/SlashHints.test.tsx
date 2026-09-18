import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { SlashHints, SLASH_COMMANDS, matchSlashCommands } from '../SlashHints.js';
import { SLASH_PICKER_CHROME_ROWS, slashPickerListRows } from '../slash-picker.js';
import type { SlashCommand } from '../slash-commands.js';

/** The budget `Prompt` hands down at the 80x24 fallback the renderer supplies. */
const MAX_ROWS = SLASH_PICKER_CHROME_ROWS + 8;

function show(
  matches: readonly SlashCommand[],
  opts: { selectedIndex?: number; offset?: number; maxRows?: number } = {},
) {
  const { lastFrame } = render(
    createElement(SlashHints, {
      matches,
      selectedIndex: opts.selectedIndex ?? 0,
      offset: opts.offset ?? 0,
      maxRows: opts.maxRows ?? MAX_ROWS,
    }),
  );
  return stripAnsi(lastFrame() ?? '');
}

/** Rows a rendered popover occupies — `''` is nothing, not one blank row. */
function rowsOf(frame: string): number {
  return frame === '' ? 0 : frame.split('\n').length;
}

describe('matchSlashCommands', () => {
  it('returns nothing when buffer does not start with /', () => {
    expect(matchSlashCommands('hello')).toEqual([]);
  });

  it('returns every command for an empty / buffer', () => {
    expect(matchSlashCommands('/')).toEqual([...SLASH_COMMANDS]);
  });

  it('filters by prefix as the user types', () => {
    const matches = matchSlashCommands('/ex');
    expect(matches.map((c) => c.name)).toEqual(['/exit']);
  });

  it('returns nothing once the user types args', () => {
    expect(matchSlashCommands('/task foo')).toEqual([]);
  });

  it('matching is case-insensitive', () => {
    expect(matchSlashCommands('/EX').map((c) => c.name)).toEqual(['/exit']);
  });

  it('includes dynamic (routine/task) commands and filters them by prefix', () => {
    const extra = [
      { name: '/morning-triage', description: 'routine · Morning triage' },
      { name: '/task-deploy', description: 'task · Deploy' },
    ];
    // A prefix unique to a dynamic command surfaces only that command.
    expect(matchSlashCommands('/morn', extra).map((c) => c.name)).toEqual(['/morning-triage']);
    // Dynamic commands appear after the built-ins for an all-match query.
    const all = matchSlashCommands('/', extra).map((c) => c.name);
    expect(all).toContain('/morning-triage');
    expect(all).toContain('/task-deploy');
    expect(all.indexOf('/morning-triage')).toBeGreaterThan(all.indexOf('/exit'));
  });
});

describe('<SlashHints>', () => {
  it('renders nothing when matches is empty', () => {
    expect(show([])).toBe('');
  });

  it('renders the supplied matches with the selected row highlighted', () => {
    const matches = matchSlashCommands('/cr');
    const frame = show(matches);
    for (const cmd of matches) expect(frame).toContain(cmd.name);
    // The selection marker prefixes only the highlighted row.
    expect(frame).toContain(`> ${matches[0].name}`);
  });

  /**
   * The defect (#589): `matchSlashCommands('/')` returns the whole catalogue
   * and nothing capped, sliced or windowed it, so a bare `/` rendered 38 rows
   * below a prompt box that sits inside a fixed-height frame. Measured before
   * the fix, the whole `<Prompt>` frame was 42 rows at a 24-row terminal.
   */
  it('bounds itself to the row budget however many commands match', () => {
    const all = matchSlashCommands('/');
    expect(all.length).toBeGreaterThan(MAX_ROWS);
    const frame = show(all);
    expect(rowsOf(frame)).toBeLessThanOrEqual(MAX_ROWS);
    expect(rowsOf(frame)).toBe(SLASH_PICKER_CHROME_ROWS + slashPickerListRows(MAX_ROWS));
  });

  it('is exactly as tall as its budget says, whatever the budget is', () => {
    const all = matchSlashCommands('/');
    for (const maxRows of [4, 6, 9, 11]) {
      expect(rowsOf(show(all, { maxRows }))).toBe(maxRows);
    }
  });

  /**
   * One command is one row. The window runs over command INDICES, so
   * `clampOffset` / `listPosition` apply unmodified only while that holds — and
   * the longest gloss in the catalogue is 46 characters, which soft-wraps
   * unless it is cut.
   */
  it('cuts a long description rather than wrapping the row', () => {
    const matches: SlashCommand[] = [
      { name: '/long', description: 'x'.repeat(400) },
      { name: '/short', description: 'y' },
    ];
    const frame = show(matches);
    expect(rowsOf(frame)).toBe(SLASH_PICKER_CHROME_ROWS + 2);
    expect(frame).toContain('\u2026');
  });

  /**
   * The border breaks if any row measures differently from its neighbours —
   * which is why the header may hold no emoji glyph (`glyph-width.ts`: Ink 5
   * pads a bordered row against the larger figure, so an emoji title renders a
   * column wider and the corner is lost). `stripAnsi(...).length` cannot see
   * that and passes with the glyph in place — measured; only `stringWidth` can.
   */
  it('renders every row of the frame at one width', () => {
    const frame = show(matchSlashCommands('/'));
    const widths = new Set(frame.split('\n').map((line) => stringWidth(line)));
    expect([...widths]).toHaveLength(1);
  });

  it('scrolls to the offset it is given and says what is hidden', () => {
    const all = matchSlashCommands('/');
    const size = slashPickerListRows(MAX_ROWS);
    const frame = show(all, { offset: 5, selectedIndex: 5 });
    expect(frame).toContain(`> ${all[5].name}`);
    expect(frame).not.toContain(all[0].name);
    expect(frame).toContain(`commands 6\u2013${5 + size} of ${all.length}`);
  });

  /**
   * `OverlayFooter`'s rule: the position row is reserved unconditionally, so
   * the popover's height never depends on the budget deciding what is hidden.
   * `listPosition` returning `null` IS the suppression rule — the row degrades
   * to the bare noun rather than disappearing.
   */
  it('keeps the header row when nothing is hidden', () => {
    const frame = show(matchSlashCommands('/ex'));
    expect(frame).toContain('commands');
    expect(frame).not.toContain(' of ');
    expect(rowsOf(frame)).toBe(SLASH_PICKER_CHROME_ROWS + 1);
  });

  it('draws a frame around itself rather than floating under the prompt', () => {
    // The whole user-visible ask: a contained popover, not loose indented rows.
    const lines = show(matchSlashCommands('/ex')).split('\n');
    expect(lines[0]).toMatch(/^\u256d\u2500+\u256e$/);
    expect(lines.at(-1)).toMatch(/^\u2570\u2500+\u256f$/);
  });
});
