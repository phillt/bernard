import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createElement } from 'react';

/**
 * Colour assertions for `MenuRow` (#320) — deliberately its own file.
 *
 * Under `vitest run` stdout is not a TTY, so Ink emits no ANSI at all and
 * `lastFrame()` returns bare text. That is why every other MenuRow test passes
 * identically with `dimColor` or with a theme colour, and why this bug survived:
 * the existing suite structurally cannot see it.
 *
 * Forcing colour has to happen before Ink's chalk instance is constructed, and
 * chalk caches its level at import — so this file sets the env var in a
 * top-level `beforeAll` and imports Ink dynamically afterwards. Doing that
 * inside a test alongside the plain-text assertions leaked colour into them;
 * a separate file is the only clean scope.
 */
const SGR_THEME_MUTED = '\u001b[90m';
const SGR_DIM = '\u001b[2m';

describe('<MenuRow> theming', () => {
  let render: typeof import('ink-testing-library').render;
  let MenuRow: typeof import('../overlays/MenuRow.js').MenuRow;

  const originalForceColor = process.env.FORCE_COLOR;

  beforeAll(async () => {
    process.env.FORCE_COLOR = '3';
    ({ render } = await import('ink-testing-library'));
    ({ MenuRow } = await import('../overlays/MenuRow.js'));
  });

  // `process.env` is per-WORKER, not per-file, and vitest reuses workers across
  // files — so leaving this set makes every other Ink test in the same worker
  // start emitting ANSI and fail its plain-text assertions. Restore it.
  afterAll(() => {
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
  });

  it('renders trailing text in the active theme, not raw dimColor', () => {
    const frame =
      render(
        createElement(MenuRow, {
          selected: false,
          label: '/help',
          trailing: ' — Show command list',
        }),
      ).lastFrame() ?? '';

    // `colors.muted` is 'gray' in the default theme -> SGR 90. Ink's `dimColor`
    // is SGR 2, which ignores the active theme — the whole point of the fix,
    // and what the high-contrast and colorblind themes exist to override.
    expect(frame).toContain(SGR_THEME_MUTED + ' — Show command list');
    expect(frame).not.toContain(SGR_DIM);
  });
});
