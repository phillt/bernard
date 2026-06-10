import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Text } from 'ink';
import { ESC, ARROW_DOWN, ARROW_UP, SHIFT_TAB, PAGE_DOWN, tick } from './_keys.js';
import { ScrollableOverlay, type OverlayLine } from '../overlays/ScrollableOverlay.js';

// ink-testing-library's stdout reports columns:100 and no `rows` getter, so
// ScrollableOverlay falls back to rows:24. frameHeight = rows-1 = 23; the tabs
// render as a single horizontal row, so the chrome below the viewport is
// scroll-line(1) + 2 rules + key-hints(1) + tab-row(1) = 5 → viewport = 23 - 5 = 18.
const VIEWPORT = 18;

const TABS = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
];

function makeLines(n: number): OverlayLine[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `entry-${String(i).padStart(2, '0')}`;
    return { key: id, node: createElement(Text, null, id) };
  });
}

function renderOverlay(lines: OverlayLine[]) {
  const onClose = vi.fn();
  const onCycleTab = vi.fn();
  const utils = render(
    createElement(ScrollableOverlay, {
      tabs: TABS,
      activeTab: 'alpha',
      lines,
      onClose,
      onCycleTab,
    }),
  );
  return { ...utils, onClose, onCycleTab };
}

describe('<ScrollableOverlay>', () => {
  it('renders the bottom tab menu (active marked, others muted) and only the first viewport of rows', () => {
    const { lastFrame } = renderOverlay(makeLines(30));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('> Alpha'); // active tab marked
    expect(frame).toContain('Beta'); // other tab present
    expect(frame).not.toContain('> Beta'); // but not marked active
    expect(frame).toContain('entry-00');
    expect(frame).toContain(`entry-${VIEWPORT - 1}`); // entry-16, last visible
    expect(frame).not.toContain(`entry-${VIEWPORT}`); // entry-17, first hidden
    expect(frame).not.toContain('entry-29');
  });

  it('shows a position indicator only when content overflows', () => {
    expect(renderOverlay(makeLines(30)).lastFrame()).toContain(`rows 1–${VIEWPORT} of 30`);
    // A short list that fits shows the legend without the indicator.
    const frame = renderOverlay(makeLines(3)).lastFrame() ?? '';
    expect(frame).toContain('esc close');
    expect(frame).not.toContain('rows ');
  });

  it('scrolls down with the down arrow and clamps at the end', async () => {
    const { stdin, lastFrame } = renderOverlay(makeLines(30));
    await tick(); // let useInput subscribe before writing
    stdin.write(ARROW_DOWN);
    await tick();
    let frame = lastFrame() ?? '';
    // Window shifted by one: entry-00 gone, entry-19 (first previously-hidden) now visible.
    expect(frame).not.toContain('entry-00');
    expect(frame).toContain(`entry-${VIEWPORT}`);
    // Page down jumps a viewport and clamps at the last page (maxOffset = 30-18 = 12).
    stdin.write(PAGE_DOWN);
    await tick();
    stdin.write(PAGE_DOWN);
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('entry-29');
    expect(frame).toContain('rows 13–30 of 30');
  });

  it('jumps to top/bottom with g/G', async () => {
    const { stdin, lastFrame } = renderOverlay(makeLines(30));
    await tick();
    stdin.write('G');
    await tick();
    expect(lastFrame()).toContain('entry-29');
    stdin.write('g');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('entry-00');
    expect(frame).not.toContain('entry-29');
  });

  it('does not scroll above the top', async () => {
    const { stdin, lastFrame } = renderOverlay(makeLines(30));
    await tick();
    stdin.write(ARROW_UP);
    await tick();
    expect(lastFrame()).toContain(`rows 1–${VIEWPORT} of 30`);
  });

  it('forwards Esc to onClose and Shift-Tab to onCycleTab', async () => {
    const { stdin, onClose, onCycleTab } = renderOverlay(makeLines(5));
    await tick();
    stdin.write(SHIFT_TAB);
    await tick();
    expect(onCycleTab).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    stdin.write(ESC);
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
