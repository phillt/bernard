import { describe, it, expect } from 'vitest';
import type { Key } from 'ink';
import {
  isAcknowledgeKey,
  isDismissKey,
  isDismissKeyWithQ,
  isShellOwnedKey,
} from '../overlays/overlay-contract.js';

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

  // `c` joins the chord list rather than getting a case of its own: as of #360
  // Ctrl-C is not an overlay key at all. See `overlay-contract.ts`'s header for
  // why — it is the one place that rationale is written down.
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
  });

  it('leaves every other character alone', () => {
    for (const ch of ['a', 'Q', 'z', '1', ' ']) {
      expect(isDismissKeyWithQ(ch, key())).toBe(false);
    }
  });
});

/**
 * The #360 decision, pinned across every predicate rather than argued once in a
 * doc comment. Two of these four had NO test at all before this — and they are
 * the ones with the widest surface: `isAcknowledgeKey` backs `/help` and
 * `InfoOverlay`, `isShellOwnedKey` backs `SettingsOverlay`.
 *
 * That is the shape of the original defect. Ctrl-C branches sat in the overlay
 * layer for months reading as covered, because the only thing asserting them
 * was `ink-testing-library`, which configures Ink differently from the app.
 * A predicate nothing tests is exactly where that recurs, so the rule gets an
 * assertion per predicate instead of a sentence.
 */
describe('no overlay predicate claims Ctrl-C (#360)', () => {
  const predicates = {
    isDismissKey,
    isDismissKeyWithQ,
    isAcknowledgeKey,
    isShellOwnedKey,
  } as const;

  for (const [name, predicate] of Object.entries(predicates)) {
    it(`${name} declines Ctrl-C`, () => {
      expect(predicate('c', key({ ctrl: true }))).toBe(false);
    });
  }

  // …while each still claims the key it exists for, so the assertion above
  // cannot pass by the predicate having stopped working altogether.
  it('but each still claims its own dismiss key', () => {
    expect(isDismissKey('', key({ escape: true }))).toBe(true);
    expect(isDismissKeyWithQ('q', key())).toBe(true);
    expect(isAcknowledgeKey('', key({ return: true }))).toBe(true);
    expect(isShellOwnedKey('', key({ shift: true, tab: true }))).toBe(true);
  });
});
