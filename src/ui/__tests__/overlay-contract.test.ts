import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import { isDismissKey, isDismissKeyWithQ } from '../overlays/overlay-contract.js';

// The enumeration a fuller literal would carry buys nothing here: the cast
// removes the type check, and both predicates test `=== true` explicitly, so
// an absent field already reads false. A stale literal behind a cast would
// still compile while looking authoritative.
const key = (over: Partial<Key> = {}): Key => over as Key;

/**
 * The keybinding contract (#266). Pure predicates, so the rules can be pinned
 * here rather than inferred from twelve overlays' frames.
 */
describe('isDismissKey', () => {
  it('accepts Esc', () => {
    expect(isDismissKey('', key({ escape: true }))).toBe(true);
  });

  it('does NOT accept q — a text field must be able to receive it', () => {
    expect(isDismissKey('q', key())).toBe(false);
  });

  // `c` joins the chord list rather than getting a case of its own, which is
  // the rule as of #360: Ctrl-C is not an overlay key. Ink's `exitOnCtrlC`
  // default quits the app before `useInput` runs, so a predicate claiming it
  // could only ever be dead code that reads as covered — which is exactly what
  // it was, since `ink-testing-library` hardcodes `exitOnCtrlC: false`.
  it('does not fire on a bare c, or on any Ctrl chord', () => {
    expect(isDismissKey('c', key())).toBe(false);
    for (const ch of ['a', 'c', 'e', 'w', 'u', 'k', 'd']) {
      expect(isDismissKey(ch, key({ ctrl: true }))).toBe(false);
    }
  });
});

describe('isDismissKeyWithQ', () => {
  it('adds q on top of Esc', () => {
    expect(isDismissKeyWithQ('q', key())).toBe(true);
    expect(isDismissKeyWithQ('', key({ escape: true }))).toBe(true);
    expect(isDismissKeyWithQ('c', key({ ctrl: true }))).toBe(false);
  });

  it('leaves every other character alone', () => {
    for (const ch of ['a', 'Q', 'z', '1', ' ']) {
      expect(isDismissKeyWithQ(ch, key())).toBe(false);
    }
  });
});
