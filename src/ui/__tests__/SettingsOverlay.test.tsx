import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { ENTER, ARROW_DOWN, SHIFT_TAB, ESC, tick } from './_keys.js';
import { SettingsOverlay } from '../overlays/SettingsOverlay.js';
import { DimensionsProvider } from '../DimensionsContext.js';
import type { MenuEntry } from '../menu-types.js';

const OPTIONS: MenuEntry[] = [
  { label: 'max-steps', annotation: '= 25 (default)', description: 'Max loop iterations.' },
  { label: 'max-tokens', annotation: '= 4096 (default)', description: 'Response token cap.' },
];
const AGENT: MenuEntry[] = [
  { type: 'section', title: 'System' },
  { label: 'Concise mode', annotation: '= off', description: 'Smallest sufficient size.' },
];

function renderOverlay(overrides: Partial<Parameters<typeof SettingsOverlay>[0]> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    createElement(
      DimensionsProvider,
      null,
      createElement(SettingsOverlay, {
        initialTab: 'options',
        initialIndex: 0,
        optionsEntries: OPTIONS,
        agentEntries: AGENT,
        onSelect,
        onClose,
        ...overrides,
      }),
    ),
  );
  return { ...utils, onSelect, onClose };
}

describe('SettingsOverlay', () => {
  it('renders the initial tab items and the tab strip', () => {
    const frame = renderOverlay().lastFrame() ?? '';
    expect(frame).toContain('1. max-steps');
    expect(frame).toContain('2. max-tokens');
    // Both tabs appear in the bottom strip.
    expect(frame).toContain('Options');
    expect(frame).toContain('Agent options');
  });

  it('Enter commits the highlighted item with the active tab + item index', async () => {
    const { stdin, onSelect } = renderOverlay();
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe('options');
    expect(onSelect.mock.calls[0][1]).toBe(1); // second item
    expect(onSelect.mock.calls[0][2].label).toBe('max-tokens');
  });

  it('Shift+Tab cycles to the Agent options tab in place (no close, no select)', async () => {
    const { stdin, lastFrame, onSelect, onClose } = renderOverlay();
    await tick();
    stdin.write(SHIFT_TAB);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('System'); // agent-options section header
    expect(frame).toContain('1. Concise mode');
    expect(frame).not.toContain('max-steps'); // options tab no longer shown
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('selecting after a cycle reports the cycled tab', async () => {
    const { stdin, onSelect } = renderOverlay();
    await tick();
    stdin.write(SHIFT_TAB);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect.mock.calls[0][0]).toBe('agent-options');
    expect(onSelect.mock.calls[0][2].label).toBe('Concise mode');
  });

  it('Esc closes without selecting', async () => {
    const { stdin, onSelect, onClose } = renderOverlay();
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('restores the cursor onto initialIndex', async () => {
    const { stdin, onSelect } = renderOverlay({ initialIndex: 1 });
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect.mock.calls[0][1]).toBe(1);
  });
});
