import { describe, it, expect, afterAll } from 'vitest';
import { createElement } from 'react';
// Static import, so the FORCE_COLOR assignment inside runs before the dynamic
// imports below construct Ink's chalk instance. See `_force-color.ts`.
import { SGR_DIM, restoreForceColor } from './_force-color.js';

const { render } = await import('ink-testing-library');
const { HelpOverlay } = await import('../overlays/HelpOverlay.js');
const { InfoOverlay } = await import('../overlays/InfoOverlay.js');
const { MenuOverlay } = await import('../overlays/MenuOverlay.js');
const { ModelGridOverlay } = await import('../overlays/ModelGridOverlay.js');
const { TextInputOverlay } = await import('../overlays/TextInputOverlay.js');

/**
 * Every overlay whose footer this PR converted off raw `dimColor` (#266).
 *
 * Covering the whole converted set matters more than it looks: the plain-text
 * suite cannot see this defect at all, so an overlay missing from here has no
 * colour coverage whatsoever and can silently regress to `dimColor`.
 */
const CASES: readonly [string, () => string][] = [
  [
    'HelpOverlay',
    () => render(createElement(HelpOverlay, { onClose: () => {} })).lastFrame() ?? '',
  ],
  [
    'InfoOverlay',
    () =>
      render(
        createElement(InfoOverlay, { title: 'T', lines: ['a'], onClose: () => {} }),
      ).lastFrame() ?? '',
  ],
  [
    'MenuOverlay',
    () =>
      render(
        createElement(MenuOverlay, {
          entries: [{ label: 'A' }, { label: 'B' }],
          onSelect: () => {},
          onCancel: () => {},
        }),
      ).lastFrame() ?? '',
  ],
  [
    'ModelGridOverlay',
    () =>
      render(
        createElement(ModelGridOverlay, {
          title: 'Models',
          items: ['gpt-4o', 'gpt-4.1'],
          onSelect: () => {},
          onCancel: () => {},
        }),
      ).lastFrame() ?? '',
  ],
  [
    'TextInputOverlay',
    () =>
      render(
        createElement(TextInputOverlay, {
          options: { label: 'Name' },
          onResolve: () => {},
        }),
      ).lastFrame() ?? '',
  ],
];

describe('overlay footers use theme colours, never raw dimColor', () => {
  afterAll(restoreForceColor);

  it.each(CASES)('%s', (_name, renderFrame) => {
    expect(renderFrame()).not.toContain(SGR_DIM);
  });
});
