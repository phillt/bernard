import { describe, it, expect, afterAll } from 'vitest';
import { createElement } from 'react';
// Static import — its FORCE_COLOR assignment must run before the dynamic
// imports below construct Ink's chalk instance. See `_force-color.ts`.
import { SGR_DIM, SGR_THEME_MUTED, restoreForceColor } from './_force-color.js';

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
const { render } = await import('ink-testing-library');
const { MenuRow } = await import('../overlays/MenuRow.js');

describe('<MenuRow> theming', () => {
  afterAll(restoreForceColor);

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
