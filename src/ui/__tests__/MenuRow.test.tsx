import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { MenuRow, MENU_MARKER } from '../overlays/MenuRow.js';

describe('<MenuRow>', () => {
  it('prefixes the selected row with the shared marker', () => {
    const frame = render(createElement(MenuRow, { selected: true, label: 'Alpha' })).lastFrame() ?? '';
    expect(frame).toContain(`${MENU_MARKER}Alpha`);
  });

  it('uses a blank gutter (no marker) when not selected', () => {
    const frame = render(createElement(MenuRow, { selected: false, label: 'Beta' })).lastFrame() ?? '';
    expect(frame).toContain('Beta');
    expect(frame).not.toContain(`${MENU_MARKER}Beta`);
  });

  it('renders trailing content after the label', () => {
    const frame =
      render(createElement(MenuRow, { selected: false, label: '/help', trailing: ' — Show command list' })).lastFrame() ??
      '';
    expect(frame).toContain('/help — Show command list');
  });

  it('exports a single marker constant so every selectable surface stays in sync', () => {
    expect(MENU_MARKER).toBe('> ');
  });
});
