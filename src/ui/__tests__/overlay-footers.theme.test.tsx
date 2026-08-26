import { describe, it, expect, afterAll } from 'vitest';
import { createElement } from 'react';

/**
 * Colour assertions for the converted overlay footers (#266) — its own file,
 * for the reason `MenuRow.theme.test.tsx` documents: under `vitest run` stdout
 * is not a TTY, Ink emits no ANSI, and a plain-text assertion cannot tell
 * `dimColor` from a theme colour. Every footer test in the main suite is
 * therefore structurally blind to the defect this PR fixes — which is exactly
 * how a `dimColor` footer survived #320's sweep.
 *
 * Forcing colour must happen before Ink's chalk instance is constructed (chalk
 * caches its level at import), hence the top-level assignment ahead of the
 * top-level `await import`s.
 */
process.env.FORCE_COLOR = '3';
const originalForceColor = process.env.FORCE_COLOR;
const { render } = await import('ink-testing-library');
const { HelpOverlay } = await import('../overlays/HelpOverlay.js');
const { InfoOverlay } = await import('../overlays/InfoOverlay.js');
const { MenuOverlay } = await import('../overlays/MenuOverlay.js');

/** Ink's `dimColor` is SGR 2 — the attribute that ignores the active theme. */
const SGR_DIM = '\u001b[2m';

describe('overlay footers use theme colours, never raw dimColor', () => {
  // `process.env` is per-WORKER, not per-file, and vitest reuses workers across
  // files — leaving this set makes every other Ink test in the same worker emit
  // ANSI and fail its plain-text assertions.
  afterAll(() => {
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
  });

  it('HelpOverlay', () => {
    const frame = render(createElement(HelpOverlay, { onClose: () => {} })).lastFrame() ?? '';
    expect(frame).not.toContain(SGR_DIM);
  });

  it('InfoOverlay', () => {
    const frame =
      render(
        createElement(InfoOverlay, { title: 'T', lines: ['a'], onClose: () => {} }),
      ).lastFrame() ?? '';
    expect(frame).not.toContain(SGR_DIM);
  });

  it('MenuOverlay', () => {
    const frame =
      render(
        createElement(MenuOverlay, {
          entries: [{ label: 'A' }, { label: 'B' }],
          onSelect: () => {},
          onCancel: () => {},
        }),
      ).lastFrame() ?? '';
    expect(frame).not.toContain(SGR_DIM);
  });
});
