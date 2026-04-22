import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  countMenuItems,
  getMenuItem,
  selectFromMenu,
  promptValue,
  renderMenuLines,
  buildLegacyLines,
  MENU_REGION_ID,
  type MenuEntry,
} from './menu.js';

// ── Mock output + theme ──────────────────────────────────

const mockPrintInfo = vi.fn();
const mockPrintDim = vi.fn();
const mockSetPinnedRegion = vi.fn();
const mockClearPinnedRegion = vi.fn();
vi.mock('./output.js', () => ({
  printInfo: (...args: any[]) => mockPrintInfo(...args),
  printDim: (...args: any[]) => mockPrintDim(...args),
  setPinnedRegion: (...args: any[]) => mockSetPinnedRegion(...args),
  clearPinnedRegion: (...args: any[]) => mockClearPinnedRegion(...args),
}));

vi.mock('./theme.js', () => ({
  getTheme: () => ({
    ansi: { prompt: '', reset: '' },
    accent: (s: string) => s,
    accentBold: (s: string) => s,
    muted: (s: string) => s,
    dim: (s: string) => s,
  }),
}));

// readline.emitKeypressEvents has real side effects on process.stdin
// (attaches data listeners). Neutralize it so tests emit 'keypress' directly.
vi.mock('node:readline', async () => {
  const actual = await vi.importActual<typeof import('node:readline')>('node:readline');
  return {
    ...actual,
    emitKeypressEvents: vi.fn(),
  };
});

// ── Helpers ──────────────────────────────────────────────

function makeRl() {
  const emitter = new EventEmitter() as any;
  emitter.question = vi.fn();
  emitter.pause = vi.fn();
  emitter.resume = vi.fn();
  return emitter;
}

// ── Test data ────────────────────────────────────────────

const simpleEntries: MenuEntry[] = [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }];

const groupedEntries: MenuEntry[] = [
  { label: 'Red', active: true, value: 'r' },
  { label: 'Green', value: 'g' },
  { type: 'section', title: 'Cool colors:' },
  { label: 'Blue', value: 'b' },
  { label: 'Purple', annotation: '(new)', value: 'p' },
];

// ── Tests ────────────────────────────────────────────────

describe('countMenuItems', () => {
  it('counts items, skipping sections', () => {
    expect(countMenuItems(groupedEntries)).toBe(4);
  });

  it('returns 0 for empty entries', () => {
    expect(countMenuItems([])).toBe(0);
  });

  it('counts items-only entries', () => {
    expect(countMenuItems(simpleEntries)).toBe(3);
  });
});

describe('getMenuItem', () => {
  it('returns the correct item by index, skipping sections', () => {
    const item = getMenuItem(groupedEntries, 2);
    expect(item).toBeDefined();
    expect(item!.label).toBe('Blue');
  });

  it('returns first item at index 0', () => {
    expect(getMenuItem(simpleEntries, 0)!.label).toBe('Alpha');
  });

  it('returns undefined for out-of-bounds index', () => {
    expect(getMenuItem(simpleEntries, 10)).toBeUndefined();
  });

  it('returns undefined for empty entries', () => {
    expect(getMenuItem([], 0)).toBeUndefined();
  });
});

// ── selectFromMenu: fallback (non-TTY / BERNARD_PLAIN_MENU) ─

describe('selectFromMenu (fallback path)', () => {
  let rl: any;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    rl = makeRl();
    mockPrintInfo.mockClear();
    mockPrintDim.mockClear();
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it('returns the selected item on valid input', async () => {
    rl.question.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      cb('2');
    });

    const result = await selectFromMenu(rl, simpleEntries);
    expect(result).toEqual({
      cancelled: false,
      index: 1,
      item: { label: 'Beta' },
    });
  });

  it('returns cancelled on empty input', async () => {
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1](''));

    const result = await selectFromMenu(rl, simpleEntries);
    expect(result).toEqual({ cancelled: true });
    expect(mockPrintInfo).toHaveBeenCalledWith('  Cancelled.');
  });

  it('returns cancelled on non-numeric input', async () => {
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1]('abc'));
    const result = await selectFromMenu(rl, simpleEntries);
    expect(result).toEqual({ cancelled: true });
  });

  it('returns cancelled on out-of-range input (too high)', async () => {
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1]('99'));
    const result = await selectFromMenu(rl, simpleEntries);
    expect(result).toEqual({ cancelled: true });
  });

  it('returns cancelled on out-of-range input (zero)', async () => {
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1]('0'));
    const result = await selectFromMenu(rl, simpleEntries);
    expect(result).toEqual({ cancelled: true });
  });

  it('skips section entries when resolving index', async () => {
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1]('3'));
    const result = await selectFromMenu(rl, groupedEntries);
    expect(result).toEqual({
      cancelled: false,
      index: 2,
      item: expect.objectContaining({ label: 'Blue', value: 'b' }),
    });
  });

  it('uses custom promptLabel', async () => {
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1]('1'));
    await selectFromMenu(rl, simpleEntries, { promptLabel: 'Pick one' });
    const promptStr = rl.question.mock.calls[0][0] as string;
    expect(promptStr).toContain('Pick one');
  });

  it('renders title when provided', async () => {
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1](''));
    await selectFromMenu(rl, simpleEntries, { title: 'My Menu' });
    const calls = mockPrintInfo.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('My Menu'))).toBe(true);
  });

  it('returns cancelled on pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await selectFromMenu(rl, simpleEntries, {}, ac.signal);
    expect(result).toEqual({ cancelled: true });
    expect(rl.question).not.toHaveBeenCalled();
  });

  it('returns cancelled when signal is aborted during prompt', async () => {
    const ac = new AbortController();
    rl.question.mockImplementation(() => {});
    const resultPromise = selectFromMenu(rl, simpleEntries, {}, ac.signal);
    ac.abort();
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: true });
  });
});

// ── selectFromMenu: interactive TTY path ─────────────────

describe('selectFromMenu (interactive path)', () => {
  let rl: any;
  let originalStdoutIsTTY: boolean | undefined;
  let originalStdinIsTTY: boolean | undefined;
  let originalSetRawMode: any;
  let originalIsRaw: any;
  let originalPlainMenu: string | undefined;

  beforeEach(() => {
    rl = makeRl();
    mockPrintInfo.mockClear();
    mockSetPinnedRegion.mockClear();
    mockClearPinnedRegion.mockClear();

    originalStdoutIsTTY = process.stdout.isTTY;
    originalStdinIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    originalPlainMenu = process.env.BERNARD_PLAIN_MENU;
    delete process.env.BERNARD_PLAIN_MENU;

    originalSetRawMode = (process.stdin as any).setRawMode;
    (process.stdin as any).setRawMode = vi.fn();
    originalIsRaw = (process.stdin as any).isRaw;
    (process.stdin as any).isRaw = false;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true,
    });
    if (originalPlainMenu !== undefined) process.env.BERNARD_PLAIN_MENU = originalPlainMenu;
    (process.stdin as any).setRawMode = originalSetRawMode;
    (process.stdin as any).isRaw = originalIsRaw;
  });

  // Wait a microtask so the menu's `repaint()` and keypress handler register
  // before we synthesize input.
  const tick = () => new Promise((r) => setImmediate(r));

  it('commits the highlighted item on Enter', async () => {
    const resultPromise = selectFromMenu(rl, simpleEntries);
    await tick();
    process.stdin.emit('keypress', '', { name: 'return' });
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: false, index: 0, item: { label: 'Alpha' } });
    expect(mockPrintInfo).toHaveBeenCalledWith('  Selected: Alpha');
  });

  it('down-arrow then Enter selects the next item', async () => {
    const resultPromise = selectFromMenu(rl, simpleEntries);
    await tick();
    process.stdin.emit('keypress', '', { name: 'down' });
    process.stdin.emit('keypress', '', { name: 'return' });
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: false, index: 1, item: { label: 'Beta' } });
  });

  it('up-arrow clamps at the first item', async () => {
    const resultPromise = selectFromMenu(rl, simpleEntries);
    await tick();
    process.stdin.emit('keypress', '', { name: 'up' });
    process.stdin.emit('keypress', '', { name: 'up' });
    process.stdin.emit('keypress', '', { name: 'return' });
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: false, index: 0, item: { label: 'Alpha' } });
  });

  it('down-arrow clamps at the last item', async () => {
    const resultPromise = selectFromMenu(rl, simpleEntries);
    await tick();
    for (let i = 0; i < 10; i++) process.stdin.emit('keypress', '', { name: 'down' });
    process.stdin.emit('keypress', '', { name: 'return' });
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: false, index: 2, item: { label: 'Gamma' } });
  });

  it('arrow navigation skips over sections implicitly (index counts only items)', async () => {
    // groupedEntries items in order: Red, Green, Blue, Purple. Press down
    // twice to land on Blue (item index 2).
    const resultPromise = selectFromMenu(rl, groupedEntries);
    await tick();
    process.stdin.emit('keypress', '', { name: 'down' });
    process.stdin.emit('keypress', '', { name: 'down' });
    process.stdin.emit('keypress', '', { name: 'return' });
    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    if (!result.cancelled) expect(result.item.label).toBe('Blue');
  });

  it('Escape cancels', async () => {
    const resultPromise = selectFromMenu(rl, simpleEntries);
    await tick();
    process.stdin.emit('keypress', '', { name: 'escape' });
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: true });
    // No "Selected:" line on cancel.
    expect(mockPrintInfo).not.toHaveBeenCalledWith(expect.stringContaining('Selected:'));
  });

  it('q cancels', async () => {
    const resultPromise = selectFromMenu(rl, simpleEntries);
    await tick();
    process.stdin.emit('keypress', 'q', { name: 'q' });
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: true });
  });

  it('Ctrl-C cancels', async () => {
    const resultPromise = selectFromMenu(rl, simpleEntries);
    await tick();
    process.stdin.emit('keypress', '', { ctrl: true, name: 'c' });
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: true });
  });

  it('digits 1-9 commit the corresponding item immediately', async () => {
    const resultPromise = selectFromMenu(rl, simpleEntries);
    await tick();
    process.stdin.emit('keypress', '3', { name: '3' });
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: false, index: 2, item: { label: 'Gamma' } });
  });

  it('ignores digits beyond the item count', async () => {
    const resultPromise = selectFromMenu(rl, simpleEntries);
    await tick();
    process.stdin.emit('keypress', '9', { name: '9' }); // only 3 items
    // Still waiting — commit with Enter.
    process.stdin.emit('keypress', '', { name: 'return' });
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: false, index: 0, item: { label: 'Alpha' } });
  });

  it('pre-aborted signal short-circuits without entering raw mode', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await selectFromMenu(rl, simpleEntries, {}, ac.signal);
    expect(result).toEqual({ cancelled: true });
    expect((process.stdin as any).setRawMode).not.toHaveBeenCalled();
    expect(mockSetPinnedRegion).not.toHaveBeenCalled();
  });

  it('external signal abort cancels the menu', async () => {
    const ac = new AbortController();
    const resultPromise = selectFromMenu(rl, simpleEntries, {}, ac.signal);
    await tick();
    ac.abort();
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: true });
  });

  it('pins a menu region and clears it on exit', async () => {
    const resultPromise = selectFromMenu(rl, simpleEntries, { title: 'Pick' });
    await tick();
    expect(mockSetPinnedRegion).toHaveBeenCalledWith(MENU_REGION_ID, expect.any(Array));
    const lines = mockSetPinnedRegion.mock.calls[0][1] as string[];
    expect(lines.some((l) => l.includes('Pick'))).toBe(true);
    expect(lines.some((l) => l.includes('Alpha'))).toBe(true);
    process.stdin.emit('keypress', '', { name: 'return' });
    await resultPromise;
    expect(mockClearPinnedRegion).toHaveBeenCalledWith(MENU_REGION_ID);
  });

  it('returns cancelled when entries have no selectable items', async () => {
    const noItems: MenuEntry[] = [{ type: 'section', title: 'Header only' }];
    const result = await selectFromMenu(rl, noItems);
    expect(result).toEqual({ cancelled: true });
    // No pin/raw-mode either.
    expect(mockSetPinnedRegion).not.toHaveBeenCalled();
    expect((process.stdin as any).setRawMode).not.toHaveBeenCalled();
  });

  it('BERNARD_PLAIN_MENU=1 forces the fallback path', async () => {
    process.env.BERNARD_PLAIN_MENU = '1';
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1]('2'));
    const result = await selectFromMenu(rl, simpleEntries);
    expect(result).toEqual({ cancelled: false, index: 1, item: { label: 'Beta' } });
    // Interactive path would have called setRawMode; fallback path should not.
    expect((process.stdin as any).setRawMode).not.toHaveBeenCalled();
  });
});

describe('promptValue', () => {
  let rl: any;

  beforeEach(() => {
    rl = makeRl();
    mockPrintInfo.mockClear();
  });

  it('returns the raw value on non-empty input', async () => {
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1]('  42  '));
    const result = await promptValue(rl, { label: 'Enter value' });
    expect(result).toEqual({ cancelled: false, raw: '42' });
  });

  it('returns cancelled on empty input', async () => {
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1](''));
    const result = await promptValue(rl, { label: 'Enter value' });
    expect(result).toEqual({ cancelled: true });
    expect(mockPrintInfo).toHaveBeenCalledWith('  Cancelled.');
  });

  it('returns cancelled on pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await promptValue(rl, { label: 'Enter value' }, ac.signal);
    expect(result).toEqual({ cancelled: true });
    expect(rl.question).not.toHaveBeenCalled();
  });

  it('returns cancelled when signal is aborted during prompt', async () => {
    const ac = new AbortController();
    rl.question.mockImplementation(() => {});
    const resultPromise = promptValue(rl, { label: 'Enter value' }, ac.signal);
    ac.abort();
    const result = await resultPromise;
    expect(result).toEqual({ cancelled: true });
  });

  it('includes label in prompt string', async () => {
    rl.question.mockImplementation((...args: any[]) => args[args.length - 1]('x'));
    await promptValue(rl, { label: 'New threshold' });
    const promptStr = rl.question.mock.calls[0][0] as string;
    expect(promptStr).toContain('New threshold');
  });
});

describe('renderMenuLines', () => {
  it('renders the title as the first line when provided', () => {
    const lines = renderMenuLines(simpleEntries, 0, { title: 'Pick one' });
    expect(lines[0]).toContain('Pick one');
  });

  it('omits the title block when none is provided', () => {
    const lines = renderMenuLines(simpleEntries, 0, undefined);
    expect(lines[0]).not.toContain('Pick one');
    expect(lines[0]).toContain('1. Alpha');
  });

  it('marks only the highlighted row with the > cursor', () => {
    const lines = renderMenuLines(simpleEntries, 1, undefined);
    const alpha = lines.find((l) => l.includes('Alpha'))!;
    const beta = lines.find((l) => l.includes('Beta'))!;
    const gamma = lines.find((l) => l.includes('Gamma'))!;
    expect(alpha).not.toMatch(/^\s*>/);
    expect(beta).toMatch(/^\s*>\s/);
    expect(gamma).not.toMatch(/^\s*>/);
  });

  it('shows the description only under the highlighted item', () => {
    const entries: MenuEntry[] = [
      { label: 'One', description: 'first desc' },
      { label: 'Two', description: 'second desc' },
    ];
    const lines = renderMenuLines(entries, 1, undefined);
    expect(lines.some((l) => l.includes('second desc'))).toBe(true);
    expect(lines.some((l) => l.includes('first desc'))).toBe(false);
  });

  it('renders section headers as unselectable rows', () => {
    const lines = renderMenuLines(groupedEntries, 0, undefined);
    expect(lines.some((l) => l.includes('Cool colors:'))).toBe(true);
  });

  it('appends active and annotation markers on item labels', () => {
    const lines = renderMenuLines(groupedEntries, 0, undefined);
    const redLine = lines.find((l) => l.includes('Red'))!;
    expect(redLine).toContain('(active)');
    const purpleLine = lines.find((l) => l.includes('Purple'))!;
    expect(purpleLine).toContain('(new)');
  });

  it('includes the footer hint as the last line', () => {
    const lines = renderMenuLines(simpleEntries, 0, undefined);
    const footer = lines[lines.length - 1];
    expect(footer).toContain('Enter');
    expect(footer).toContain('Esc');
  });

  it('numbers items from 1 skipping sections', () => {
    const lines = renderMenuLines(groupedEntries, 0, undefined);
    expect(lines.some((l) => /1\. Red/.test(l))).toBe(true);
    expect(lines.some((l) => /2\. Green/.test(l))).toBe(true);
    expect(lines.some((l) => /3\. Blue/.test(l))).toBe(true);
    expect(lines.some((l) => /4\. Purple/.test(l))).toBe(true);
  });
});

describe('buildLegacyLines', () => {
  it('numbers items and skips sections in numbering', () => {
    const out = buildLegacyLines(groupedEntries);
    const texts = out.map((l) => l.text);
    expect(texts.some((t) => /1\. Red/.test(t))).toBe(true);
    expect(texts.some((t) => /2\. Green/.test(t))).toBe(true);
    expect(texts.some((t) => /3\. Blue/.test(t))).toBe(true);
    expect(texts.some((t) => /4\. Purple/.test(t))).toBe(true);
  });

  it('includes section headers verbatim', () => {
    const out = buildLegacyLines(groupedEntries);
    expect(out.some((l) => l.text.includes('Cool colors:'))).toBe(true);
  });

  it('appends (active) and annotation markers', () => {
    const out = buildLegacyLines(groupedEntries);
    expect(out.some((l) => l.text.includes('Red (active)'))).toBe(true);
    expect(out.some((l) => l.text.includes('Purple (new)'))).toBe(true);
  });

  it('tags description rows as dim', () => {
    const entries: MenuEntry[] = [{ label: 'One', description: 'more info' }];
    const out = buildLegacyLines(entries);
    const desc = out.find((l) => l.text.includes('more info'))!;
    expect(desc.dim).toBe(true);
  });

  it('does not tag label rows as dim', () => {
    const out = buildLegacyLines(simpleEntries);
    for (const line of out) {
      expect(line.dim).toBeFalsy();
    }
  });

  it('returns an empty array for empty entries', () => {
    expect(buildLegacyLines([])).toEqual([]);
  });
});
