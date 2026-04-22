import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  countMenuItems,
  getMenuItem,
  printMenuList,
  selectFromMenu,
  promptValue,
  type MenuEntry,
} from './menu.js';

// ── Mock output + theme ──────────────────────────────────

const mockPrintInfo = vi.fn();
const mockPrintDim = vi.fn();
vi.mock('./output.js', () => ({
  printInfo: (...args: any[]) => mockPrintInfo(...args),
  printDim: (...args: any[]) => mockPrintDim(...args),
}));

vi.mock('./theme.js', () => ({
  getTheme: () => ({
    ansi: { prompt: '', reset: '' },
  }),
}));

// ── Helpers ──────────────────────────────────────────────

function makeRl() {
  const emitter = new EventEmitter() as any;
  emitter.question = vi.fn();
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

const entriesWithDescription: MenuEntry[] = [
  { label: 'max-tokens', annotation: '= 4096 (default)', description: 'Max response tokens' },
  { label: 'shell-timeout', annotation: '= 30000 (custom)', description: 'Shell command timeout' },
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

describe('printMenuList', () => {
  beforeEach(() => {
    mockPrintInfo.mockClear();
    mockPrintDim.mockClear();
  });

  it('prints numbered items', () => {
    printMenuList(simpleEntries);
    expect(mockPrintInfo).toHaveBeenCalledWith('    1. Alpha');
    expect(mockPrintInfo).toHaveBeenCalledWith('    2. Beta');
    expect(mockPrintInfo).toHaveBeenCalledWith('    3. Gamma');
  });

  it('prints section headers without consuming a number', () => {
    printMenuList(groupedEntries);
    const calls = mockPrintInfo.mock.calls.map((c) => c[0]);
    expect(calls).toContain('\n  Cool colors:');
    expect(calls).toContain('    1. Red (active)');
    expect(calls).toContain('    2. Green');
    expect(calls).toContain('    3. Blue');
    expect(calls).toContain('    4. Purple (new)');
  });

  it('prints descriptions on a second line via printDim (dimmer than labels)', () => {
    printMenuList(entriesWithDescription);
    expect(mockPrintDim).toHaveBeenCalledWith('       Max response tokens');
    expect(mockPrintDim).toHaveBeenCalledWith('       Shell command timeout');
    // Descriptions must not land on printInfo (same color as labels defeats the purpose).
    expect(mockPrintInfo).not.toHaveBeenCalledWith('       Max response tokens');
  });

  it('handles empty entries without error', () => {
    printMenuList([]);
    expect(mockPrintInfo).not.toHaveBeenCalled();
  });
});

describe('selectFromMenu', () => {
  let rl: any;

  beforeEach(() => {
    rl = makeRl();
    mockPrintInfo.mockClear();
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
    // groupedEntries has: Red(0), Green(1), [section], Blue(2), Purple(3)
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

  it('returns cancelled on pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await selectFromMenu(rl, simpleEntries, {}, ac.signal);
    expect(result).toEqual({ cancelled: true });
    expect(rl.question).not.toHaveBeenCalled();
  });

  it('returns cancelled when signal is aborted during prompt', async () => {
    const ac = new AbortController();

    // Don't call callback immediately — simulate waiting for user input
    rl.question.mockImplementation(() => {});

    const resultPromise = selectFromMenu(rl, simpleEntries, {}, ac.signal);

    // Abort while "waiting"
    ac.abort();

    const result = await resultPromise;
    expect(result).toEqual({ cancelled: true });
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
