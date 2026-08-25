import { describe, it, expect, afterAll } from 'vitest';
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
 * chalk caches its level at import — hence the top-level env assignment ahead
 * of top-level `await import`, the pattern this repo's tests already use.
 * Setting it inside a test, alongside the plain-text assertions, leaked colour
 * into them.
 */
process.env.FORCE_COLOR = '3';
const originalForceColor = process.env.FORCE_COLOR;
const { render } = await import('ink-testing-library');
const { MenuRow } = await import('../overlays/MenuRow.js');

/** `colors.muted` is 'gray' in the default theme. Ink's `dimColor` is SGR 2. */
const SGR_THEME_MUTED = '\u001b[90m';
const SGR_DIM = '\u001b[2m';

describe('<MenuRow> theming', () => {
  // `process.env` is per-WORKER, not per-file, and vitest reuses workers across
  // files — leaving this set makes every other Ink test in the same worker
  // emit ANSI and fail its plain-text assertions.
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

    expect(frame).toContain(SGR_THEME_MUTED + ' — Show command list');
    expect(frame).not.toContain(SGR_DIM);
  });
});
