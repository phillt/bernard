import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { ModelGridOverlay } from '../overlays/ModelGridOverlay.js';
import { DimensionsProvider } from '../DimensionsContext.js';
import { FALLBACK_DIMENSIONS } from '../useDimensions.js';
import stripAnsi from 'strip-ansi';
import {
  ESC,
  ENTER,
  ARROW_UP,
  ARROW_DOWN,
  ARROW_LEFT,
  ARROW_RIGHT,
  CTRL_C,
  tick,
} from './_keys.js';

const ITEMS = [
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'gpt-5.2',
  'gpt-4.1',
  'gpt-4.1-mini',
];

function mountGrid(opts: {
  items?: string[];
  onSelect?: ReturnType<typeof vi.fn>;
  onCancel?: ReturnType<typeof vi.fn>;
  title?: string;
  footer?: string;
  initialIndex?: number;
  currentItem?: string;
}) {
  const onSelect = opts.onSelect ?? vi.fn();
  const onCancel = opts.onCancel ?? vi.fn();
  const harness = render(
    createElement(ModelGridOverlay, {
      items: opts.items ?? ITEMS,
      onSelect,
      onCancel,
      title: opts.title,
      footer: opts.footer,
      initialIndex: opts.initialIndex,
      currentItem: opts.currentItem,
    }),
  );
  return { ...harness, onSelect, onCancel };
}

describe('<ModelGridOverlay>', () => {
  it('renders title, footer, and every item', () => {
    const { lastFrame } = mountGrid({
      title: 'Pick model',
      footer: 'catalog footer',
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Pick model');
    expect(frame).toContain('catalog footer');
    for (const item of ITEMS) {
      expect(frame).toContain(item);
    }
  });

  it('marks the current item with an asterisk', () => {
    const { lastFrame } = mountGrid({ currentItem: 'gpt-4.1' });
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/gpt-4\.1\s*\*/);
  });

  it('Enter commits the highlighted index', async () => {
    const { stdin, onSelect } = mountGrid({ initialIndex: 2 });
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(2);
  });

  it('right/left arrows move highlight ±1 and clamp at boundaries', async () => {
    const { stdin, onSelect } = mountGrid({ initialIndex: 0 });
    await tick();
    stdin.write(ARROW_LEFT); // clamp at 0
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect.mock.calls[0][0]).toBe(1);
  });

  it('down arrow jumps by column count', async () => {
    const { stdin, onSelect } = mountGrid({ initialIndex: 0 });
    await tick();
    // We don't know the exact column count from outside, but down then enter
    // must land at an index >= 1 (since columns is at least 1) and < items.length.
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    const idx = onSelect.mock.calls[0][0];
    expect(idx).toBeGreaterThanOrEqual(1);
    expect(idx).toBeLessThan(ITEMS.length);
  });

  it('down arrow clamps at last item', async () => {
    const { stdin, onSelect } = mountGrid({ initialIndex: 0 });
    await tick();
    for (let i = 0; i < 50; i++) stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect.mock.calls[0][0]).toBe(ITEMS.length - 1);
  });

  it('up arrow clamps at first item', async () => {
    const { stdin, onSelect } = mountGrid({ initialIndex: ITEMS.length - 1 });
    await tick();
    for (let i = 0; i < 50; i++) stdin.write(ARROW_UP);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect.mock.calls[0][0]).toBe(0);
  });

  it('Esc, q, and Ctrl-C cancel', async () => {
    for (const keystroke of [ESC, 'q', CTRL_C]) {
      const { stdin, onCancel } = mountGrid({});
      await tick();
      stdin.write(keystroke);
      await tick();
      expect(onCancel).toHaveBeenCalledTimes(1);
    }
  });

  it('empty items list still allows Esc to cancel', async () => {
    const { stdin, onCancel } = mountGrid({ items: [] });
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the keymap hint line', () => {
    const { lastFrame } = mountGrid({});
    const frame = lastFrame() ?? '';
    const plain = stripAnsi(frame);
    expect(plain).toContain('↵ select');
    expect(plain).toContain('esc back');
  });
});

/**
 * Windowing (#266) — the reported symptom. A provider with 58 models whose
 * names are long enough to force a single column rendered 58 rows into a frame
 * that has at most `rows - 1`, which is every lineup-slot edit on a narrow
 * terminal. Every grid row is exactly one terminal line by construction, so
 * `clampOffset` / `listPosition` apply verbatim over grid-row indices.
 *
 * Wrapped in `DimensionsProvider` as in production. Note the two axes resolve
 * from different places under the test renderer: `columns` comes from
 * ink-testing-library's stdout (100), `rows` from `FALLBACK_DIMENSIONS` (24)
 * because that stdout declares none. The names are padded to 50 so the width
 * arithmetic yields ONE column either way — the single-column case is the
 * reported bug, and pinning it removes the harness's column count from the
 * assertions.
 */
const LONG_ITEMS = Array.from({ length: 58 }, (_, i) =>
  `model-${String(i + 1).padStart(2, '0')}`.padEnd(50, '-'),
);

function mountLongGrid(opts: { onSelect?: ReturnType<typeof vi.fn> } = {}) {
  const onSelect = opts.onSelect ?? vi.fn();
  const harness = render(
    createElement(
      DimensionsProvider,
      null,
      createElement(ModelGridOverlay, {
        items: LONG_ITEMS,
        onSelect,
        onCancel: vi.fn(),
      }),
    ),
  );
  return { ...harness, onSelect };
}

describe('<ModelGridOverlay> windowing (#266)', () => {
  it('shows the scroll position when the grid overflows', async () => {
    const { lastFrame } = mountLongGrid();
    await tick();
    expect(stripAnsi(lastFrame() ?? '')).toMatch(/rows 1–\d+ of 58/);
  });

  it('reserves the position row (blank) when everything fits', async () => {
    const { lastFrame } = mountGrid({});
    await tick();
    expect(stripAnsi(lastFrame() ?? '')).not.toMatch(/rows \d+–\d+ of \d+/);
  });

  it('keeps the highlight rendered when ArrowDown walks past the viewport', async () => {
    const { stdin, lastFrame } = mountLongGrid();
    await tick();
    for (let i = 0; i < 30; i++) stdin.write(ARROW_DOWN);
    await tick();
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain(LONG_ITEMS[30]);
    expect(plain).not.toContain(LONG_ITEMS[0]);
  });

  it('Enter still returns the ABSOLUTE index after scrolling', async () => {
    const { stdin, onSelect } = mountLongGrid();
    await tick();
    for (let i = 0; i < 30; i++) stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith(30);
  });

  it('never renders more rows than the frame has — the reported symptom', async () => {
    const { lastFrame } = mountLongGrid();
    await tick();
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(FALLBACK_DIMENSIONS.rows - 1);
  });
});
