import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { Text } from 'ink';
import { MenuOverlay } from '../overlays/MenuOverlay.js';
import { DimensionsProvider } from '../DimensionsContext.js';
import { FALLBACK_DIMENSIONS } from '../useDimensions.js';
import type { MenuEntry } from '../menu-types.js';
import { ESC, ENTER, ARROW_UP, ARROW_DOWN, CTRL_C, SPACE, tick } from './_keys.js';
import stripAnsi from 'strip-ansi';

const ENTRIES: MenuEntry[] = [
  { type: 'section', title: 'Built-in' },
  { label: 'anthropic', active: true },
  { label: 'openai', annotation: '(default)' },
  { type: 'section', title: 'Custom' },
  { label: 'ollama', description: 'Local Llama via OpenAI shim' },
];

/**
 * Wrapped in `DimensionsProvider` as in production — but that is belt-and-
 * braces, not coverage: without it `useDimensionsCtx` silently falls back to
 * 80×24 instead of failing, so a missing provider would change which value the
 * overlay read and no assertion here would notice. (The two axes even come from
 * different places under the test renderer: `columns` from ink-testing-library's
 * stdout, 100; `rows` from `FALLBACK_DIMENSIONS`, 24, since that stdout declares
 * none.) The real answer to that trap is that the interesting assertions live in
 * the pure `menu-geometry.test.ts` / `list-nav.test.ts`, which need no
 * dimensions at all; the window here is driven by the PRODUCTION `reserveRows`
 * prop rather than a test-only height override.
 */
function mountMenu(opts: {
  entries?: MenuEntry[];
  onSelect?: ReturnType<typeof vi.fn>;
  onCancel?: ReturnType<typeof vi.fn>;
  options?: Parameters<typeof MenuOverlay>[0]['options'];
  reserveRows?: number;
}) {
  const onSelect = opts.onSelect ?? vi.fn();
  const onCancel = opts.onCancel ?? vi.fn();
  const harness = render(
    createElement(
      DimensionsProvider,
      null,
      createElement(MenuOverlay, {
        entries: opts.entries ?? ENTRIES,
        onSelect,
        onCancel,
        options: opts.options,
        reserveRows: opts.reserveRows,
      }),
    ),
  );
  return { ...harness, onSelect, onCancel };
}

describe('<MenuOverlay>', () => {
  it('renders sections, items, active marker, and annotations', () => {
    const { lastFrame } = mountMenu({});
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Built-in');
    expect(frame).toContain('Custom');
    expect(frame).toContain('1. anthropic (active)');
    expect(frame).toContain('2. openai (default)');
    expect(frame).toContain('3. ollama');
    // first item highlighted by default — only its description should NOT
    // appear (it has none); the third item's description should NOT appear
    // either because it's not the highlighted row.
    expect(frame).not.toContain('Local Llama via OpenAI shim');
  });

  it('renders highlighted item description only', async () => {
    const { lastFrame, stdin } = mountMenu({});
    await tick();
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Local Llama via OpenAI shim');
  });

  it('Enter commits the highlighted item', async () => {
    const { stdin, onSelect } = mountMenu({});
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [idx, item] = onSelect.mock.calls[0];
    expect(idx).toBe(0);
    expect(item.label).toBe('anthropic');
  });

  it('Arrow keys move highlight and clamp at boundaries', async () => {
    const { stdin, onSelect, lastFrame } = mountMenu({});
    await tick();
    stdin.write(ARROW_UP); // already at 0; should clamp
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect.mock.calls[0][0]).toBe(0);

    const { stdin: stdin2, onSelect: onSelect2 } = mountMenu({});
    await tick();
    for (let i = 0; i < 10; i++) stdin2.write(ARROW_DOWN);
    await tick();
    stdin2.write(ENTER);
    await tick();
    // 3 items, so max index is 2.
    expect(onSelect2.mock.calls[0][0]).toBe(2);

    // smoke: a frame still renders
    expect(lastFrame()).toBeTruthy();
  });

  it('digit shortcut commits matching item immediately', async () => {
    const { stdin, onSelect } = mountMenu({});
    await tick();
    stdin.write('2');
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(1);
    expect(onSelect.mock.calls[0][1].label).toBe('openai');
  });

  it('out-of-range digits are ignored', async () => {
    const { stdin, onSelect, onCancel } = mountMenu({});
    await tick();
    stdin.write('9');
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Esc, q, and Ctrl-C cancel', async () => {
    for (const keystroke of [ESC, 'q', CTRL_C]) {
      const { stdin, onCancel } = mountMenu({});
      await tick();
      stdin.write(keystroke);
      await tick();
      expect(onCancel).toHaveBeenCalledTimes(1);
    }
  });

  it('headerLines render above the title and items', () => {
    const { lastFrame } = mountMenu({
      options: { headerLines: ['Question 2 of 3', '--'], title: 'Pick one' },
    });
    const frame = lastFrame() ?? '';
    const qIdx = frame.indexOf('Question 2 of 3');
    const titleIdx = frame.indexOf('Pick one');
    const itemIdx = frame.indexOf('anthropic');
    expect(qIdx).toBeGreaterThanOrEqual(0);
    expect(qIdx).toBeLessThan(titleIdx);
    expect(titleIdx).toBeLessThan(itemIdx);
  });
});

describe('<MenuOverlay> split layout', () => {
  const SPLIT_ENTRIES: MenuEntry[] = [
    { label: 'Orchestrator', description: 'left-list desc (should be hidden)', value: 'orch' },
    { label: 'Coder', value: 'coder' },
  ];
  const renderDetail = (item: { label: string; value?: unknown }) =>
    createElement(Text, null, `detail for ${String(item.value)}`);

  function mountSplit(extra?: Partial<Parameters<typeof MenuOverlay>[0]['options']>) {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const harness = render(
      createElement(MenuOverlay, {
        entries: SPLIT_ENTRIES,
        onSelect,
        onCancel,
        options: { layout: 'split', renderDetail, ...extra },
      }),
    );
    return { ...harness, onSelect, onCancel };
  }

  it('renders the detail card for the highlighted row and hides the left-list description', () => {
    const { lastFrame } = mountSplit();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1. Orchestrator');
    expect(frame).toContain('2. Coder');
    // The card title (label) + detail content for the first (highlighted) row.
    expect(frame).toContain('detail for orch');
    // The per-row highlight description is suppressed in split mode.
    expect(frame).not.toContain('left-list desc');
  });

  it('updates the detail card as the highlight moves', async () => {
    const { lastFrame, stdin } = mountSplit();
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('detail for coder');
    expect(frame).not.toContain('detail for orch');
  });

  it('falls back to the list layout when renderDetail is absent', () => {
    const { lastFrame } = mountSplit({ renderDetail: undefined });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1. Orchestrator');
    expect(frame).not.toContain('detail for');
  });

  it('Enter still commits the highlighted item in split mode', async () => {
    const { stdin, onSelect } = mountSplit();
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][1].value).toBe('orch');
  });
});

const MULTI_ENTRIES: MenuEntry[] = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];

function mountMulti(opts?: {
  entries?: MenuEntry[];
  onMultiSelect?: ReturnType<typeof vi.fn>;
  onCancel?: ReturnType<typeof vi.fn>;
  reserveRows?: number;
}) {
  const onMultiSelect = opts?.onMultiSelect ?? vi.fn();
  const onCancel = opts?.onCancel ?? vi.fn();
  const harness = render(
    createElement(
      DimensionsProvider,
      null,
      createElement(MenuOverlay, {
        entries: opts?.entries ?? MULTI_ENTRIES,
        multiSelect: true,
        onMultiSelect,
        onCancel,
        reserveRows: opts?.reserveRows,
      }),
    ),
  );
  return { ...harness, onMultiSelect, onCancel };
}

describe('<MenuOverlay> multi-select (#231)', () => {
  it('renders empty checkboxes and the multi-select footer hint', () => {
    const { lastFrame } = mountMulti();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[ ] 1. A');
    expect(frame).toContain('[ ] 2. B');
    // Footer routes through `HintRow` (#266), which colors the key token
    // separately from its label — so the raw frame never contains the pair as
    // a contiguous substring. Strip first, and expect the shared vocabulary
    // (`↵` not `Enter`) from `overlay-contract.ts`.
    const plain = stripAnsi(frame);
    expect(plain).toContain('space toggle');
    expect(plain).toContain('↵ confirm');
  });

  it('Space toggles the highlighted row without committing', async () => {
    const { stdin, lastFrame, onMultiSelect, onCancel } = mountMulti();
    await tick();
    stdin.write(SPACE);
    await tick();
    expect(lastFrame() ?? '').toContain('[x] 1. A');
    expect(onMultiSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    // toggling again clears it
    stdin.write(SPACE);
    await tick();
    expect(lastFrame() ?? '').toContain('[ ] 1. A');
  });

  it('a digit toggles the matching row instead of committing', async () => {
    const { stdin, lastFrame, onMultiSelect } = mountMulti();
    await tick();
    stdin.write('2');
    await tick();
    expect(lastFrame() ?? '').toContain('[x] 2. B');
    expect(lastFrame() ?? '').toContain('[ ] 1. A');
    expect(onMultiSelect).not.toHaveBeenCalled();
  });

  it('Enter commits the checked set in row order', async () => {
    const { stdin, onMultiSelect } = mountMulti();
    await tick();
    stdin.write('1');
    await tick();
    stdin.write('3');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onMultiSelect).toHaveBeenCalledTimes(1);
    expect(onMultiSelect.mock.calls[0][0].map((i: { label: string }) => i.label)).toEqual([
      'A',
      'C',
    ]);
  });

  it('Enter with nothing checked falls back to the highlighted row', async () => {
    const { stdin, onMultiSelect } = mountMulti();
    await tick();
    stdin.write(ARROW_DOWN); // highlight row 2 (B)
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onMultiSelect).toHaveBeenCalledTimes(1);
    expect(onMultiSelect.mock.calls[0][0].map((i: { label: string }) => i.label)).toEqual(['B']);
  });

  it('Esc still cancels in multi-select mode', async () => {
    const { stdin, onCancel, onMultiSelect } = mountMulti();
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onMultiSelect).not.toHaveBeenCalled();
  });

  it('Enter falls back to onCancel when onMultiSelect is missing (defensive)', async () => {
    // The props type requires onMultiSelect in multi mode; this guards an
    // untyped JS caller that forgot it, so Enter can never strand the overlay.
    const onCancel = vi.fn();
    const harness = render(
      createElement(MenuOverlay, {
        entries: MULTI_ENTRIES,
        multiSelect: true,
        onCancel,
      } as any),
    );
    await tick();
    harness.stdin.write(ENTER);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

/**
 * Windowing (#266). Unwindowed, a 40-item menu rendered 40 rows into a frame
 * that has at most `rows - 1`, pushing the footer — and on a long enough list
 * the highlighted row itself — off the screen.
 *
 * The budget is driven by the PRODUCTION `reserveRows` prop rather than a
 * test-only height override, because that is the knob App actually turns.
 */
const LONG_ENTRIES: MenuEntry[] = [
  { type: 'section', title: 'Group A' },
  ...Array.from({ length: 20 }, (_, i) => ({ label: `item-${i + 1}` })),
  { type: 'section', title: 'Group B' },
  ...Array.from({ length: 20 }, (_, i) => ({ label: `item-${i + 21}` })),
];

/** Squeezes the 80×24 fallback frame down to a five-row content window. */
const SQUEEZE = 13;

const POSITION_RE = /items \d+–\d+ of \d+/;

describe('<MenuOverlay> windowing (#266)', () => {
  it('renders the highlighted row and not the fortieth', async () => {
    const { lastFrame } = mountMenu({ entries: LONG_ENTRIES, reserveRows: SQUEEZE });
    await tick();
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('1. item-1');
    expect(plain).not.toContain('40. item-40');
  });

  it('keeps the highlight on screen as ArrowDown walks past the viewport', async () => {
    const { stdin, lastFrame } = mountMenu({ entries: LONG_ENTRIES, reserveRows: SQUEEZE });
    await tick();
    for (let i = 0; i < 30; i++) stdin.write(ARROW_DOWN);
    await tick();
    const plain = stripAnsi(lastFrame() ?? '');
    // Absolute numbering, not window-relative: the printed number is the item's
    // index in the whole menu, so a scrolled row still reads `31.`.
    expect(plain).toContain('31. item-31');
    expect(plain).not.toContain('1. item-1\n');
  });

  it('shows the scroll position, and reserves the row (blank) when the list fits', async () => {
    const long = mountMenu({ entries: LONG_ENTRIES, reserveRows: SQUEEZE });
    await tick();
    expect(stripAnsi(long.lastFrame() ?? '')).toMatch(/items 1–\d+ of 40/);

    const short = mountMenu({});
    await tick();
    expect(stripAnsi(short.lastFrame() ?? '')).not.toMatch(POSITION_RE);
  });

  it('digits still address ABSOLUTE indices after scrolling', async () => {
    const { stdin, onSelect } = mountMenu({ entries: LONG_ENTRIES, reserveRows: SQUEEZE });
    await tick();
    for (let i = 0; i < 30; i++) stdin.write(ARROW_DOWN);
    await tick();
    stdin.write('3');
    await tick();
    // `3` names item 3 of the whole menu, not the third visible row.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(2);
    expect(onSelect.mock.calls[0][1].label).toBe('item-3');
  });

  it('multi-select checkbox state survives scrolling', async () => {
    const { stdin, onMultiSelect } = mountMulti({
      entries: LONG_ENTRIES,
      reserveRows: SQUEEZE,
    });
    await tick();
    stdin.write('1');
    await tick();
    for (let i = 0; i < 25; i++) stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onMultiSelect).toHaveBeenCalledTimes(1);
    expect(onMultiSelect.mock.calls[0][0].map((i: { label: string }) => i.label)).toEqual([
      'item-1',
    ]);
  });

  it('pulls a section header back in above its first visible item', async () => {
    const { stdin, lastFrame } = mountMenu({ entries: LONG_ENTRIES, reserveRows: SQUEEZE });
    await tick();
    // Walk past the Group B boundary, then back up onto its first item: the
    // window now starts exactly on `item-21`, whose header would otherwise sit
    // one row above the top edge.
    for (let i = 0; i < 24; i++) stdin.write(ARROW_DOWN);
    await tick();
    for (let i = 0; i < 4; i++) stdin.write(ARROW_UP);
    await tick();
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('21. item-21');
    expect(plain).toContain('Group B');
  });

  it('never renders more rows than the frame has — the reported symptom', async () => {
    // No `reserveRows`: the real full-screen budget on an 80×24 terminal.
    const { lastFrame } = mountMenu({ entries: LONG_ENTRIES });
    await tick();
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(FALLBACK_DIMENSIONS.rows - 1);
  });

  it('stays in frame when the highlighted description soft-wraps', async () => {
    // The description renders at marginLeft={4} inside App's paddingX={2}, so
    // it wraps at columns - 8 = 72. Real menu content already exceeds that —
    // `domains.ts` and the profile wizard carry 76-79 char descriptions — so a
    // flat one-row reservation under-counts by exactly one and puts the frame
    // back over the budget this windowing exists to hold. Measured instead.
    const long = 'x'.repeat(150); // wraps to 3 rows at 72 columns
    const entries = Array.from({ length: 40 }, (_, i) => ({
      label: `item-${i + 1}`,
      description: long,
    }));
    const { lastFrame, stdin } = mountMenu({ entries });
    await tick();
    expect(stripAnsi(lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(
      FALLBACK_DIMENSIONS.rows - 1,
    );
    // …and still bounded once a description is actually on screen mid-list.
    for (let i = 0; i < 12; i++) stdin.write(ARROW_DOWN);
    await tick();
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain.split('\n').length).toBeLessThanOrEqual(FALLBACK_DIMENSIONS.rows - 1);
    expect(plain).toContain('13. item-13');
  });
});
