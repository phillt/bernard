/**
 * The theme question shows you the theme (#447).
 *
 * Arrowing down the Theme step repaints the entire wizard — border, rail,
 * header, rows, footer — in the highlighted row's theme, and the row you leave
 * selected is what the rest of the walk is drawn in.
 *
 * ## What these assert, and why the obvious assertion is not enough
 *
 * The cheap implementation is `setTheme(key)` on cursor move, and it repaints
 * the ROWS and nothing else: the cursor lives in `WizardChoiceStep`, a child of
 * `WizardCard`, so the border, the rail, the header and the footer keep the old
 * theme. A test that only looks at the highlighted row passes with that defect
 * fully present. So the assertions here are on the CARD BORDER, which is
 * painted by `WizardCard` from `colors.muted`, and on the header accent.
 *
 * The second thing the cheap version gets wrong is that it writes a process
 * global, so Esc, Back and an abandoned `/setup` each have to put the real
 * theme back. "The global is never written" is therefore an assertion here
 * rather than a claim in a comment.
 *
 * ## Two mechanics of the harness, both load-bearing
 *
 * `_force-color.js` is imported FIRST, before the dynamic imports below reach
 * chalk, which caches its level at construction. Under `vitest run` stdout is
 * not a TTY, so without it Ink emits no ANSI and every assertion here passes on
 * bare text.
 *
 * And the ticks are long. A preview takes TWO renders — the keypress moves the
 * cursor, and the effect that reports it then sets state at the root — while
 * Ink throttles writes at 32 ms. At the suite's usual 10 ms tick the second
 * render has not been flushed and the frame still carries the old theme, which
 * reads exactly like the feature being broken.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import './_force-color.js';
import { restoreForceColor } from './_force-color.js';
import { CTRL_N, ARROW_DOWN, ENTER, ESC, tick } from './_keys.js';

const { createElement } = await import('react');
const { render } = await import('ink-testing-library');
const stripAnsi = (await import('strip-ansi')).default;
const { DimensionsProvider } = await import('../DimensionsContext.js');
const { WizardOverlay } = await import('../overlays/WizardOverlay.js');
const { getThemeColorsFor, getActiveThemeKey, setTheme, DEFAULT_THEME } =
  await import('../../theme.js');
const { useThemeColors } = await import('../ThemeContext.js');
const { getThemeColors } = await import('../../theme.js');

afterAll(() => {
  restoreForceColor();
  // `setTheme` writes a process global and vitest reuses workers across files.
  // Nothing here should have moved it — the case below asserts exactly that —
  // but restoring is what keeps a future failure local to this file.
  setTheme(DEFAULT_THEME);
});

/**
 * The 24-bit SGR a theme's colour renders as, derived from the theme record.
 *
 * Written down as a hex-to-triple conversion rather than as the escape itself,
 * so the expectation cannot drift from `theme.ts` — and so these read as "ocean
 * is on screen" rather than as six magic numbers. `_force-color.ts`'s own
 * constants are bernard-specific (`gray` → SGR 90) and cannot serve.
 */
const sgrOf = (hex: string): string => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `\u001b[38;2;${r};${g};${b}m`;
};

const OCEAN = getThemeColorsFor('ocean');
const BERNARD = getThemeColorsFor('bernard');

/** A theme step whose labels are the values, as the real registry builds it. */
const themeStep = (over: Record<string, unknown> = {}) => ({
  id: 'theme',
  section: 'Output',
  question: 'Theme',
  hint: 'Which colours the terminal uses.',
  field: {
    kind: 'choice' as const,
    choices: ['bernard', 'ocean', 'forest'],
    values: ['bernard', 'ocean', 'forest'],
  },
  initial: 'bernard',
  preview: 'theme' as const,
  ...over,
});

function mount(spec: unknown) {
  const onResolve = vi.fn();
  const r = render(
    createElement(
      DimensionsProvider,
      null,
      createElement(WizardOverlay as never, { spec, onResolve } as never),
    ),
  );
  return { ...r, onResolve };
}

/** The card's top border row, which only `WizardCard` paints. */
const borderRow = (frame: string): string =>
  frame.split('\n').find((l) => stripAnsi(l).includes('╭')) ?? '';

describe('the theme question shows you the theme', () => {
  it('repaints the whole card, not just the highlighted row', async () => {
    const { stdin, lastFrame } = mount({ steps: [themeStep()] });
    await tick(120);
    stdin.write(ARROW_DOWN);
    await tick(120);

    const frame = lastFrame() ?? '';
    // The border is the assertion that matters: it is drawn by `WizardCard`,
    // the PARENT of the component holding the cursor, so a preview that only
    // reached the rows leaves it on the old theme.
    expect(borderRow(frame)).toContain(sgrOf(OCEAN.muted));
    expect(borderRow(frame)).not.toContain(sgrOf(BERNARD.accent));
    // …and the header accent, painted by the same parent.
    expect(frame).toContain(sgrOf(OCEAN.accent));
  });

  it('opens on the theme already in force', async () => {
    // Guard the guard: without this, an assertion that ocean appears after an
    // arrow press would pass on a frame that was ocean from the start.
    const { lastFrame } = mount({ steps: [themeStep()] });
    await tick(120);
    expect(lastFrame() ?? '').not.toContain(sgrOf(OCEAN.accent));
    expect(borderRow(lastFrame() ?? '')).toContain('\u001b[90m'); // bernard's `gray`
  });

  it('reads the row VALUE, not its label', async () => {
    // The one field that previews today has `value === label`, so a renderer
    // reading the label works by coincidence. Here they differ, which is what
    // makes this case able to fail.
    const { stdin, lastFrame } = mount({
      steps: [
        themeStep({
          field: {
            kind: 'choice' as const,
            choices: ['Bernard orange', 'Deep blue', 'Pine'],
            values: ['bernard', 'ocean', 'forest'],
          },
          initial: 'Bernard orange',
        }),
      ],
    });
    await tick(120);
    stdin.write(ARROW_DOWN);
    await tick(120);
    expect(borderRow(lastFrame() ?? '')).toContain(sgrOf(OCEAN.muted));
  });

  it('never writes the active theme, not even on the way out', async () => {
    // The whole safety argument. Nothing global moves, so Esc, Back and an
    // abandoned `/setup` need no restore path — there is nothing to restore.
    const before = getActiveThemeKey();
    const { stdin, onResolve } = mount({ steps: [themeStep()] });
    await tick(120);
    stdin.write(ARROW_DOWN);
    await tick(120);
    expect(getActiveThemeKey(), 'while previewing').toBe(before);
    stdin.write(ESC);
    await tick(120);
    expect(onResolve).toHaveBeenCalled();
    expect(getActiveThemeKey(), 'after cancelling').toBe(before);
  });

  it('keeps the chosen theme for the rest of the walk', async () => {
    // Derived from the step's recorded ANSWER once it has one, which is also
    // what makes arrowing to ocean and back to bernard before continuing land
    // on bernard.
    const { stdin, lastFrame } = mount({
      steps: [
        themeStep(),
        {
          id: 'after',
          section: 'Output',
          question: 'Anything else',
          field: { kind: 'choice' as const, choices: ['yes', 'no'], values: ['yes', 'no'] },
          initial: 'yes',
        },
      ],
    });
    await tick(120);
    stdin.write(ARROW_DOWN); // onto ocean
    await tick(120);
    // Enter MARKS, Continue commits the marked row — this wizard's own rule.
    // Without the Enter the answer is still `bernard`, which is the case below.
    stdin.write(ENTER);
    await tick(120);
    stdin.write(CTRL_N);
    await tick(160);

    const frame = lastFrame() ?? '';
    expect(stripAnsi(frame)).toContain('Anything else');
    expect(borderRow(frame), 'the next question is still ocean').toContain(sgrOf(OCEAN.muted));
  });

  it('reverts when you pass a theme without choosing it', async () => {
    // The other half of the same rule, and the surprising-looking half: the
    // screen goes ocean as the cursor passes, and Continue without an Enter
    // keeps bernard — because bernard is still the answer, which the tick on
    // its row has been saying the whole time.
    const { stdin, lastFrame } = mount({
      steps: [
        themeStep(),
        {
          id: 'after',
          section: 'Output',
          question: 'Anything else',
          field: { kind: 'choice' as const, choices: ['yes', 'no'], values: ['yes', 'no'] },
          initial: 'yes',
        },
      ],
    });
    await tick(120);
    stdin.write(ARROW_DOWN);
    await tick(120);
    expect(borderRow(lastFrame() ?? ''), 'previewing').toContain(sgrOf(OCEAN.muted));
    stdin.write(CTRL_N);
    await tick(160);
    expect(borderRow(lastFrame() ?? ''), 'back on the real answer').toContain('\u001b[90m');
  });

  it('leaves a step that declares no preview exactly as it was', async () => {
    // The regression guard: every other question in the walk must render as it
    // did before this existed, whatever the cursor is doing.
    const { stdin, lastFrame } = mount({
      steps: [themeStep({ preview: undefined })],
    });
    await tick(120);
    const before = lastFrame() ?? '';
    stdin.write(ARROW_DOWN);
    await tick(120);
    const after = lastFrame() ?? '';
    // The highlight moved…
    expect(stripAnsi(after)).not.toBe(stripAnsi(before));
    // …and not one colour changed.
    const codes = (s: string) => [...new Set(s.match(/\u001b\[[0-9;]*m/g) ?? [])].sort();
    expect(codes(after)).toEqual(codes(before));
  });
});

describe('useThemeColors outside a provider', () => {
  it('is the active theme, by identity', async () => {
    // What lets a shared component like `MenuRow` be converted without any of
    // its other callers noticing — and what keeps `markdown.ts`'s cache, which
    // uses `cachedColors === colors` as its key, honest.
    let seen: unknown;
    function Probe() {
      seen = useThemeColors();
      return null;
    }
    render(createElement(Probe));
    await tick(40);
    expect(seen).toBe(getThemeColors());
  });
});
