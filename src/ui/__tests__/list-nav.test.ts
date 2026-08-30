import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import { listNavIntent } from '../overlays/list-nav.js';

// Same idiom as `overlay-contract.test.ts`: the cast removes the type check, and
// `listNavIntent` tests every flag with `=== true`, so an absent field already
// reads false. A stale full literal behind a cast would look authoritative
// while compiling regardless.
const key = (over: Partial<Key> = {}): Key => over as Key;

const UP = key({ upArrow: true });
const DOWN = key({ downArrow: true });
const LEFT = key({ leftArrow: true });
const RIGHT = key({ rightArrow: true });
const ENTER = key({ return: true });

describe('listNavIntent', () => {
  it('maps Enter to a commit', () => {
    expect(listNavIntent('', ENTER, { total: 3 })).toEqual({ kind: 'commit' });
  });

  it('maps ↑/↓ to ∓1 by default', () => {
    expect(listNavIntent('', UP, { total: 3 })).toEqual({ kind: 'move', delta: -1 });
    expect(listNavIntent('', DOWN, { total: 3 })).toEqual({ kind: 'move', delta: 1 });
  });

  it('scales ↑/↓ by `step` — the grid moves a whole row', () => {
    expect(listNavIntent('', UP, { total: 20, step: 4 })).toEqual({ kind: 'move', delta: -4 });
    expect(listNavIntent('', DOWN, { total: 20, step: 4 })).toEqual({ kind: 'move', delta: 4 });
  });

  it('maps a digit to a 0-based index', () => {
    expect(listNavIntent('1', key(), { total: 3 })).toEqual({ kind: 'digit', index: 0 });
    expect(listNavIntent('3', key(), { total: 3 })).toEqual({ kind: 'digit', index: 2 });
  });

  it('returns null for an out-of-range digit rather than a rejected intent', () => {
    expect(listNavIntent('4', key(), { total: 3 })).toBeNull();
    expect(listNavIntent('9', key(), { total: 3 })).toBeNull();
  });

  it('bounds the digit on selectable rows, so interleaved sections cannot shift it', () => {
    // Five menu *entries* with two section headers is three selectable items —
    // `total` is the item count, never the entry count.
    expect(listNavIntent('3', key(), { total: 3 })).toEqual({ kind: 'digit', index: 2 });
    expect(listNavIntent('5', key(), { total: 3 })).toBeNull();
  });

  it('honours `digits: false` (the grid types no numbers)', () => {
    expect(listNavIntent('2', key(), { total: 9, digits: false })).toBeNull();
  });

  it('gates Space on `toggleOnSpace`', () => {
    expect(listNavIntent(' ', key(), { total: 3 })).toBeNull();
    expect(listNavIntent(' ', key(), { total: 3, toggleOnSpace: true })).toEqual({
      kind: 'toggle',
    });
  });

  describe('the horizontal axis', () => {
    it("returns null under 'none' so the caller does NOT swallow ←/→", () => {
      expect(listNavIntent('', LEFT, { total: 3 })).toBeNull();
      expect(listNavIntent('', RIGHT, { total: 3 })).toBeNull();
    });

    it("emits an axis delta under 'axis'", () => {
      expect(listNavIntent('', LEFT, { total: 3, horizontal: 'axis' })).toEqual({
        kind: 'axis',
        delta: -1,
      });
      expect(listNavIntent('', RIGHT, { total: 3, horizontal: 'axis' })).toEqual({
        kind: 'axis',
        delta: 1,
      });
    });

    it("moves the cursor by ±1 under 'move', independent of `step`", () => {
      expect(listNavIntent('', LEFT, { total: 20, step: 4, horizontal: 'move' })).toEqual({
        kind: 'move',
        delta: -1,
      });
      expect(listNavIntent('', RIGHT, { total: 20, step: 4, horizontal: 'move' })).toEqual({
        kind: 'move',
        delta: 1,
      });
    });
  });

  describe('total === 0', () => {
    // Property 2: this is what subsumes ModelGridOverlay's empty-list early-out
    // and SettingsOverlay's extra lower clamp — with nothing to point at, the
    // arithmetic that could go negative is never reached.
    const KEYS: Array<[string, Key]> = [
      ['Enter', ENTER],
      ['↑', UP],
      ['↓', DOWN],
      ['←', LEFT],
      ['→', RIGHT],
      ['a digit', key()],
      ['Space', key()],
    ];
    it.each(KEYS)('yields nothing for %s', (label, k) => {
      const input = label === 'a digit' ? '1' : label === 'Space' ? ' ' : '';
      expect(
        listNavIntent(input, k, {
          total: 0,
          horizontal: 'move',
          toggleOnSpace: true,
        }),
      ).toBeNull();
    });
  });

  describe('never claims a dismissal or shell key', () => {
    // The SettingsOverlay-safety invariant. It belongs pinned in a file rather
    // than inferred from four components: this module runs INSIDE a ViewerShell
    // whose Esc / Shift+Tab / Ctrl-C are the shell's, and `q` cancels every
    // menu. Every option combination is exercised, because a future branch
    // could claim one of these only under some flag.
    const OPTIONS = [
      { total: 5 },
      { total: 5, horizontal: 'move' as const, toggleOnSpace: true },
      { total: 5, horizontal: 'axis' as const, digits: false, step: 3 },
    ];
    const FORBIDDEN: Array<[string, string, Key]> = [
      ['Esc', '', key({ escape: true })],
      ['Ctrl-C', 'c', key({ ctrl: true })],
      ['q', 'q', key()],
      ['Shift+Tab', '', key({ tab: true, shift: true })],
      ['Tab', '\t', key({ tab: true })],
    ];
    for (const opts of OPTIONS) {
      it.each(FORBIDDEN)(`leaves %s alone (${JSON.stringify(opts)})`, (_label, input, k) => {
        expect(listNavIntent(input, k, opts)).toBeNull();
      });
    }
  });
});
