import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Text } from 'ink';
import { ESC, ARROW_DOWN, ARROW_UP, SHIFT_TAB, PAGE_DOWN, tick } from './_keys.js';
import { ScrollableOverlay, type OverlayLine } from '../overlays/ScrollableOverlay.js';

// ink-testing-library's stdout reports columns:100 and no `rows` getter, so
// ScrollableOverlay falls back to rows:24 → viewport = 24 - 4 chrome = 20.
const VIEWPORT = 20;

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
      title: 'Test Panel',
      lines,
      onClose,
      onCycleTab,
    }),
  );
  return { ...utils, onClose, onCycleTab };
}

describe('<ScrollableOverlay>', () => {
  it('renders the title and only the first viewport of rows', () => {
    const { lastFrame } = renderOverlay(makeLines(30));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Test Panel');
    expect(frame).toContain('entry-00');
    expect(frame).toContain(`entry-${VIEWPORT - 1}`); // entry-19, last visible
    expect(frame).not.toContain(`entry-${VIEWPORT}`); // entry-20, first hidden
    expect(frame).not.toContain('entry-29');
  });

  it('shows a position indicator only when content overflows', () => {
    expect(renderOverlay(makeLines(30)).lastFrame()).toContain('rows 1–20 of 30');
    // A short list that fits shows the legend without the indicator.
    const frame = renderOverlay(makeLines(3)).lastFrame() ?? '';
    expect(frame).toContain('Esc to close · Shift-Tab to switch tabs');
    expect(frame).not.toContain('rows ');
  });

  it('scrolls down with the down arrow and clamps at the end', async () => {
    const { stdin, lastFrame } = renderOverlay(makeLines(30));
    await tick(); // let useInput subscribe before writing
    stdin.write(ARROW_DOWN);
    await tick();
    let frame = lastFrame() ?? '';
    // Window shifted by one: entry-00 gone, entry-20 now visible.
    expect(frame).not.toContain('entry-00');
    expect(frame).toContain('entry-20');
    // Page down jumps a viewport and clamps at the last page (maxOffset = 10).
    stdin.write(PAGE_DOWN);
    await tick();
    stdin.write(PAGE_DOWN);
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).toContain('entry-29');
    expect(frame).toContain('rows 11–30 of 30');
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
    expect(lastFrame()).toContain('rows 1–20 of 30');
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
