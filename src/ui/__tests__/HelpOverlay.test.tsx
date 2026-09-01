import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Text, useInput } from 'ink';
import { HelpOverlay, EDITING_ROWS, helpLines } from '../overlays/HelpOverlay.js';
import { DimensionsProvider } from '../DimensionsContext.js';
import { FALLBACK_DIMENSIONS } from '../useDimensions.js';
import { useLineEditor } from '../use-line-editor.js';
import { SLASH_COMMANDS } from '../slash-commands.js';
import {
  ESC,
  ENTER,
  ARROW_DOWN,
  ARROW_LEFT,
  CTRL_A,
  CTRL_B,
  CTRL_D,
  CTRL_E,
  CTRL_F,
  CTRL_J,
  CTRL_K,
  CTRL_LEFT,
  CTRL_RIGHT,
  CTRL_U,
  CTRL_W,
  ALT_B,
  ALT_BACKSPACE,
  ALT_F,
  ALT_LEFT,
  ALT_RIGHT,
  META_ENTER,
  tick,
  frameRows,
} from './_keys.js';
import stripAnsi from 'strip-ansi';

/**
 * Wrapped in `DimensionsProvider` as in production. Under the test renderer
 * that yields 100 columns (ink-testing-library's stdout) × 24 rows
 * (`FALLBACK_DIMENSIONS`, since that stdout declares none) — so the row budget
 * the assertions below use is the real one, while the width is generous. The
 * narrow case, where a description has to be cut, gets its own mount that
 * deliberately omits the provider.
 */
function mountHelp(onClose: () => void = () => {}) {
  return render(createElement(DimensionsProvider, null, createElement(HelpOverlay, { onClose })));
}

describe('helpLines()', () => {
  /**
   * The catalogue assertion runs against the pure row list, with no renderer
   * and no terminal size — the `line-geometry.ts` doctrine. It used to read the
   * rendered frame, which stopped working the moment the screen was windowed
   * (#392): a 24-row terminal gives `viewerFrameHeight(24) = 23`, less 4 rows of
   * chrome, so 19 lines are visible — of which the first two are the `Commands`
   * header and its blank. That leaves 17 of the 34 commands on screen and 17
   * below the fold on any given render. Weakening it to "appears after
   * scrolling" would have tested the scrollbar, not the catalogue.
   */
  it('lists every documented slash command', () => {
    const commands = helpLines().filter((l) => l.kind === 'command');
    for (const cmd of SLASH_COMMANDS) {
      // Derived from the catalogue, not retyped (#390). The list that stood
      // here was the third copy of it and had gone stale on its own terms — it
      // omitted eight live commands, and its `/model` entry passed only as a
      // SUBSTRING of the rendered `/models`, so it asserted a command the help
      // screen has never shown. An exact match on the source list cannot drift
      // that way.
      const row = commands.find((l) => l.kind === 'command' && l.command === cmd.name);
      expect(row, `no help row for ${cmd.name}`).toBeDefined();
      expect(row).toMatchObject({ description: cmd.detail ?? cmd.description });
    }
  });

  it('carries both section headers, each followed by a blank', () => {
    const lines = helpLines();
    const sections = lines.filter((l) => l.kind === 'section');
    expect(sections).toEqual([
      { kind: 'section', title: 'Commands' },
      { kind: 'section', title: 'Editing' },
    ]);
    for (const [i, line] of lines.entries()) {
      if (line.kind === 'section') expect(lines[i + 1]).toEqual({ kind: 'blank' });
    }
  });

  it('is longer than the frame it renders into — the reason windowing exists', () => {
    // 34 commands + 6 chords + 2 headers + 4 blanks = 46, against the 23 rows
    // `viewerFrameHeight(24)` allows. Pinned so the bound below is understood
    // as load-bearing rather than incidentally satisfied.
    expect(helpLines().length).toBeGreaterThan(FALLBACK_DIMENSIONS.rows);
  });
});

describe('<HelpOverlay>', () => {
  it('fits the frame', () => {
    const { lastFrame } = mountHelp();
    expect(frameRows(lastFrame())).toBeLessThanOrEqual(FALLBACK_DIMENSIONS.rows - 1);
  });

  it('closes on Esc, Enter, and q', async () => {
    for (const keystroke of [ESC, ENTER, 'q']) {
      const onClose = vi.fn();
      const { stdin } = mountHelp(onClose);
      await tick();
      stdin.write(keystroke);
      await tick();
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });

  it('advertises both scrolling and closing', () => {
    const { lastFrame } = mountHelp();
    const plain = stripAnsi(lastFrame() ?? '');
    // The shared `HintRow` vocabulary (#266): one compound entry rather than
    // three rows each saying "close", plus the scroll hint #392 added.
    expect(plain).toContain('↑/↓ scroll');
    expect(plain).toContain('↵/esc/q close');
    expect(plain).toMatch(/lines \d+–\d+ of \d+/);
  });

  it('scrolls the window without outgrowing the frame', async () => {
    const { stdin, lastFrame } = mountHelp();
    await tick();
    const first = stripAnsi(lastFrame() ?? '');
    expect(first).toContain('Commands');
    expect(first).not.toContain('Editing');

    // Far enough to reach the second section: 46 lines, ~19 visible.
    for (let i = 0; i < 30; i++) stdin.write(ARROW_DOWN);
    await tick();
    const scrolled = stripAnsi(lastFrame() ?? '');
    expect(scrolled).toContain('Editing');
    expect(scrolled).not.toContain('Commands');
    expect(frameRows(lastFrame())).toBeLessThanOrEqual(FALLBACK_DIMENSIONS.rows - 1);
  });

  it('truncates a description rather than letting the row wrap', async () => {
    // No provider, so `useDimensionsCtx` returns its documented 80×24 fallback
    // — the ordinary terminal, and the width where `/options`' 73-character
    // detail no longer fits beside a 20-column gutter. Windowing counts
    // ENTRIES, not wrapped height, so one row that becomes two desyncs the
    // scroll position from the frame; this is the horizontal half of #392.
    const { stdin, lastFrame } = render(createElement(HelpOverlay, { onClose: () => {} }));
    await tick();
    // `/options` sits below the first window, so scroll to it: it is the
    // longest `detail` in the catalogue (73 chars) and the row that made this
    // wrap in the first place.
    for (let i = 0; i < 12; i++) stdin.write(ARROW_DOWN);
    await tick();
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('/options');
    expect(plain).not.toContain('shell-timeout, token-window');
    expect(plain).toContain('…');
    for (const line of plain.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(FALLBACK_DIMENSIONS.columns);
    }
    expect(frameRows(lastFrame())).toBeLessThanOrEqual(FALLBACK_DIMENSIONS.rows - 1);
  });
});

/**
 * Every chord {@link EDITING_ROWS} advertises, mapped to the byte sequences the
 * row names — the primary spelling AND every alternate in its description.
 * Read from the exported list rather than retyped, so adding a row without a
 * mapping fails the coverage assertion below (#390's anti-drift move applied to
 * the chord table).
 *
 * `⇧↵` is excluded, explicitly rather than silently: it is the one row that
 * `useLineEditor.handleKey` never sees. `Prompt.tsx` recognises it in its own
 * `newlineIntent` and calls `editor.insert('\n')` directly, so it is a PROMPT
 * binding, not an editor one — which is why the row now says so (#361).
 */
const CHORD_KEYS: Record<string, readonly string[]> = {
  '⌥←  ⌥→': [ALT_LEFT, ALT_RIGHT, CTRL_LEFT, CTRL_RIGHT, ALT_B, ALT_F, CTRL_B, CTRL_F],
  '⌃A  ⌃E': [CTRL_A, CTRL_E],
  '⌃W': [CTRL_W, ALT_BACKSPACE],
  '⌃U  ⌃K': [CTRL_U, CTRL_K],
  '⌃D': [CTRL_D],
};
const PROMPT_ONLY_CHORDS = ['⇧↵'];

/**
 * Renders the shared editor and logs `handleKey`'s BOOLEAN return, the way
 * `use-list-cursor.test.tsx` probes `useListCursor` — "inert" and "swallowed"
 * look identical in a rendered frame, and `Prompt.test.tsx`'s chord tests prove
 * EFFECT on one component rather than consumption by the editor, so they
 * structurally cannot catch this class of drift.
 *
 * The state is rendered too, because the boolean alone turned out not to be
 * sufficient: `handleKey` claims `⌃J` and ESC+CR as printable input and then
 * `insert()` strips the newline, so an inert chord still reports `true`. Both
 * halves are asserted — claimed AND it moved something.
 */
function EditorProbe({ log }: { log: boolean[] }) {
  const editor = useLineEditor('alpha beta gamma');
  useInput((input, key) => {
    log.push(editor.handleKey(input, key));
  });
  return createElement(Text, null, `state=${JSON.stringify(editor.buffer)}@${editor.cursor}`);
}

/** Puts the cursor mid-buffer so no advertised chord is a no-op by position. */
async function pressChord(sequence: string) {
  const log: boolean[] = [];
  const { stdin, lastFrame } = render(createElement(EditorProbe, { log }));
  await tick();
  for (let i = 0; i < 5; i++) stdin.write(ARROW_LEFT);
  await tick();
  const before = lastFrame();
  log.length = 0;
  stdin.write(sequence);
  await tick();
  return { claimed: log, before, after: lastFrame() };
}

describe('EDITING_ROWS (#361)', () => {
  it('covers every advertised row', () => {
    expect([...Object.keys(CHORD_KEYS), ...PROMPT_ONLY_CHORDS].sort()).toEqual(
      EDITING_ROWS.map((row) => row.command).sort(),
    );
  });

  it('names the one prompt-only chord as prompt-only', () => {
    const row = EDITING_ROWS.find((r) => r.command === '⇧↵');
    expect(row?.description).toContain('prompt only');
  });

  for (const [command, sequences] of Object.entries(CHORD_KEYS)) {
    for (const sequence of sequences) {
      it(`${command} — ${JSON.stringify(sequence)} is consumed by the line editor`, async () => {
        const { claimed, before, after } = await pressChord(sequence);
        expect(claimed).toEqual([true]);
        expect(after).not.toBe(before);
      });
    }
  }

  it('⇧↵ is not the editor’s — its encodings reach handleKey and do nothing', async () => {
    // The reason the row is excluded above, asserted rather than asserted-by-
    // omission. Ctrl-J arrives as a bare `\n` and ESC+CR as a bare `\r` (Ink
    // strips the ESC and sets no flags on either), so both fall into the
    // printable branch, `insert()` strips the newline for a single-line
    // editor, and the call reports `true` having changed nothing.
    for (const sequence of [CTRL_J, META_ENTER]) {
      const { claimed, before, after } = await pressChord(sequence);
      expect(claimed).toEqual([true]);
      expect(after).toBe(before);
    }
  });
});
