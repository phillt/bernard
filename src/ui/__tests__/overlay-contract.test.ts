import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import { isDismissKey, isDismissKeyWithQ } from '../overlays/overlay-contract.js';

const key = (over: Partial<Key> = {}): Key =>
  ({
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...over,
  }) as Key;

/**
 * The keybinding contract (#266). Pure predicates, so the rules can be pinned
 * here rather than inferred from twelve overlays' frames.
 */
describe('isDismissKey', () => {
  it('accepts Esc and Ctrl-C', () => {
    expect(isDismissKey('', key({ escape: true }))).toBe(true);
    expect(isDismissKey('c', key({ ctrl: true }))).toBe(true);
  });

  it('does NOT accept q — a text field must be able to receive it', () => {
    expect(isDismissKey('q', key())).toBe(false);
  });

  it('does not fire on a bare c, or on other Ctrl chords the editor claims', () => {
    expect(isDismissKey('c', key())).toBe(false);
    for (const ch of ['a', 'e', 'w', 'u', 'k', 'd']) {
      expect(isDismissKey(ch, key({ ctrl: true }))).toBe(false);
    }
  });
});

describe('isDismissKeyWithQ', () => {
  it('adds q on top of the universal pair', () => {
    expect(isDismissKeyWithQ('q', key())).toBe(true);
    expect(isDismissKeyWithQ('', key({ escape: true }))).toBe(true);
    expect(isDismissKeyWithQ('c', key({ ctrl: true }))).toBe(true);
  });

  it('leaves every other character alone', () => {
    for (const ch of ['a', 'Q', 'z', '1', ' ']) {
      expect(isDismissKeyWithQ(ch, key())).toBe(false);
    }
  });
});
