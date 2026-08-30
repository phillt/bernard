import type { Key } from 'ink';

/**
 * The one list-navigation keymap every selectable overlay obeys (#266).
 *
 * Four overlays hand-rolled the same twenty lines — clamped ↑/↓ plus a
 * `/^[1-9]$/` digit commit — and they had already drifted in ways only a diff
 * shows: `SettingsOverlay`'s down-arrow carried an extra `Math.max(0, …)` lower
 * clamp the others lacked (a tab whose entries are all section headers drives
 * `items.length - 1` to `-1`), and `ConfirmDialog` seeded its highlight from an
 * unclamped `useState(0)`. Three copies of one rule is three chances to fix a
 * bug once.
 *
 * Pure, and in a `.ts` with a **type-only** `Key` import (erased at compile), so
 * its tests drag in neither React nor Ink — the split `mouse.ts` /
 * `useMouseWheel.ts` and `line-geometry.ts` / `use-line-editor.tsx` already use.
 * The stateful half is {@link useListCursor} in `use-list-cursor.ts`.
 *
 * Three properties are load-bearing, each pinned by a test:
 *
 * 1. **It never claims `Esc`, `Ctrl-C`, `q` or Shift+Tab.** That is what makes
 *    it safe inside `SettingsOverlay`, whose dismissal keys belong to the
 *    wrapping `ViewerShell`. Dismissal stays in `overlay-contract.ts`; the two
 *    modules compose and are never merged — an overlay decides *first* whether a
 *    key dismisses, and only then asks what it means for the list. `Ctrl-C`
 *    belongs to no overlay at all — Ink quits on it before any `useInput` runs
 *    (#360) — and is asserted here anyway, so no future branch can start
 *    swallowing the one key that always leaves the program.
 * 2. **`total === 0` yields `null` for every key.** This subsumes
 *    `ModelGridOverlay`'s empty-list early-out and `SettingsOverlay`'s extra
 *    lower clamp: with nothing to point at there is no navigation to do, so the
 *    question never reaches arithmetic that could go negative.
 * 3. **An out-of-range digit returns `null`, not a rejected intent** — the
 *    caller sees "not a navigation key", which is exactly today's observable
 *    behaviour (a `9` on a three-item menu does nothing at all).
 */

/** What the user's keystroke means for a list. `null` means "not ours". */
export type ListNavIntent =
  /** Move the cursor by `delta` (already scaled by `step` for grids). */
  | { kind: 'move'; delta: number }
  /** Commit the row the cursor is on. */
  | { kind: 'commit' }
  /** Toggle the row the cursor is on (multi-select). */
  | { kind: 'toggle' }
  /** The user named a row by number. 0-based, and ALREADY bounds-checked. */
  | { kind: 'digit'; index: number }
  /**
   * A second, orthogonal axis the overlay owns (`ConfirmDialog`'s ←/→ breadth
   * ladder). The keymap lives here; the state it drives does not.
   */
  | { kind: 'axis'; delta: number };

export interface ListNavOptions {
  /** Number of selectable rows. `0` disables the whole keymap — see property 2. */
  total: number;
  /** Rows a single ↑/↓ moves: `1` for a list, `columns` for a grid. Default 1. */
  step?: number;
  /**
   * What ←/→ mean. `'none'` (default) returns `null` so the caller does **not**
   * swallow them — `ConfirmDialog` used to early-return on left/right even with
   * no breadth ladder, claiming a key it did not act on. `'axis'` emits
   * {@link ListNavIntent} `axis`; `'move'` treats them as ±1 cursor movement
   * (the grid, where a row is a wrap of one flat list).
   */
  horizontal?: 'none' | 'axis' | 'move';
  /** Whether Space toggles the cursor row. Default false. */
  toggleOnSpace?: boolean;
  /** Whether digits 1-9 name a row. Default true; the grid opts out. */
  digits?: boolean;
}

/**
 * Map one keystroke to a list-navigation intent, or `null` when the key is not
 * this module's business — including every key {@link isShellOwnedKey} and
 * {@link isDismissKeyWithQ} claim, which are tested here explicitly rather than
 * left to fall through the branches below by luck.
 */
export function listNavIntent(input: string, key: Key, opts: ListNavOptions): ListNavIntent | null {
  const { total, step = 1, horizontal = 'none', toggleOnSpace = false, digits = true } = opts;

  // Property 1. Explicit, not incidental: `q` would otherwise reach no branch
  // anyway, but stating it here is what lets a test pin the guarantee that
  // SettingsOverlay depends on rather than re-deriving it from three callers.
  if (key.escape === true) return null;
  if (key.ctrl === true) return null;
  if (key.tab === true) return null;
  if (input === 'q') return null;

  // Property 2. Nothing to point at, so nothing to navigate.
  if (total <= 0) return null;

  if (key.return === true) return { kind: 'commit' };
  if (key.upArrow === true) return { kind: 'move', delta: -step };
  if (key.downArrow === true) return { kind: 'move', delta: step };

  if (key.leftArrow === true || key.rightArrow === true) {
    const delta = key.leftArrow === true ? -1 : 1;
    if (horizontal === 'axis') return { kind: 'axis', delta };
    if (horizontal === 'move') return { kind: 'move', delta };
    return null;
  }

  if (toggleOnSpace && input === ' ') return { kind: 'toggle' };

  if (digits && /^[1-9]$/.test(input)) {
    const index = Number.parseInt(input, 10) - 1;
    // Property 3: out of range is "not a navigation key", not a rejection the
    // caller has to know how to swallow.
    return index < total ? { kind: 'digit', index } : null;
  }

  return null;
}
