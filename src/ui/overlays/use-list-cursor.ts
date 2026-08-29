import { useEffect, useState } from 'react';
import type { Key } from 'ink';
import { listNavIntent, type ListNavOptions } from './list-nav.js';
import { clamp, clampOffset } from './viewer-util.js';

/**
 * The stateful half of the shared list keystream (#266) — cursor plus, for the
 * windowed overlays, the scroll offset. Pairs with the pure `list-nav.ts` the
 * way `use-line-editor.tsx` pairs with `line-geometry.ts`.
 *
 * **The hook returns `handleKey`; it deliberately does NOT own a `useInput`.**
 * Three reasons, in order of force:
 *
 * 1. Ink broadcasts every keypress to ALL mounted `useInput` handlers with no
 *    stop-propagation (documented at length on `ViewerShell.escClosesViewer`).
 *    A hook-owned `useInput` would add a *second* subscriber inside a component
 *    that already has one, and the precedence every overlay depends on —
 *    "dismiss beats digit" — would stop being a readable if-chain and become an
 *    accident of subscription order.
 * 2. `SettingsOverlay` must *ignore* Esc and Shift+Tab (they belong to the
 *    wrapping `ViewerShell`). That is a pre-condition, not a handler: with
 *    `handleKey` it is one `isShellOwnedKey` line at the top of the component's
 *    own `useInput`, where a reader can see it.
 * 3. `use-line-editor.tsx` made exactly this call, and both `Prompt.tsx` and
 *    `TextInputOverlay.tsx` consume it that way.
 */
export interface ListCursorOptions extends Omit<ListNavOptions, 'total'> {
  total: number;
  /** Starting row, clamped into `[0, total-1]` (and `0` when `total` is 0). */
  initialIndex?: number;
  /** Enter, and — unless {@link onDigit} overrides — a digit. Receives an INDEX. */
  onCommit: (index: number) => void;
  /**
   * What naming a row by number means here. Defaults to {@link onCommit}.
   *
   * This is where multi-select's difference lives: a digit TOGGLES rather than
   * commits. Expressed as the *value* of a callback, never as a mode flag in
   * the shared module — `list-nav.ts` answers "which index did the user name?",
   * and the overlay answers "what does naming an index mean here?".
   */
  onDigit?: (index: number) => void;
  /** Space, when `toggleOnSpace` is set. */
  onToggle?: (index: number) => void;
  /** ←/→, when `horizontal: 'axis'`. The state it drives stays with the caller. */
  onAxis?: (delta: number) => void;
}

export interface ListCursor {
  /** The current row — already clamped for this render's `total`. */
  index: number;
  setIndex: (i: number | ((prev: number) => number)) => void;
  /** `true` when the key was claimed, so the caller stops processing it. */
  handleKey: (input: string, key: Key) => boolean;
}

export function useListCursor(opts: ListCursorOptions): ListCursor {
  const { total, initialIndex = 0, onCommit, onDigit, onToggle, onAxis, ...nav } = opts;
  const last = Math.max(0, total - 1);
  const [stored, setIndex] = useState(() => clamp(initialIndex, 0, last));

  // Clamped at RENDER, not only in the setter — the `ScrollableOverlay.tsx`
  // discipline. `total` is not constant: SettingsOverlay swaps entry lists on a
  // tab cycle and a caller can re-show a shorter list, either of which strands a
  // stale index that a setter-only clamp never revisits. Applying the rule once,
  // here, is also what subsumes the two hand-rolled variants this replaced:
  // ConfirmDialog's unclamped initial highlight and SettingsOverlay's extra
  // lower clamp both disappear into `clamp(raw, 0, max(0, total-1))`.
  const index = clamp(stored, 0, last);

  const handleKey = (input: string, key: Key): boolean => {
    const intent = listNavIntent(input, key, { total, ...nav });
    if (!intent) return false;
    switch (intent.kind) {
      case 'move':
        // A FUNCTIONAL updater, not `index + delta`. Ink can deliver two
        // keystrokes inside one React batch (every existing test that writes
        // `ARROW_DOWN` twice before a `tick()` does exactly that), and reading
        // the render-closure `index` would collapse both moves into one. The
        // inner clamp re-applies the render rule to `prev`, which is the raw
        // stored value and may be stale-out-of-range.
        setIndex((prev) => clamp(clamp(prev, 0, last) + intent.delta, 0, last));
        return true;
      case 'commit':
        onCommit(index);
        return true;
      case 'digit':
        (onDigit ?? onCommit)(intent.index);
        return true;
      case 'toggle':
        onToggle?.(index);
        return true;
      case 'axis':
        // Claimed even with no handler: the keymap said this overlay owns ←/→
        // (`horizontal: 'axis'`), and an unhandled-but-owned key must not fall
        // through to whatever the caller checks next.
        onAxis?.(intent.delta);
        return true;
    }
  };

  return { index, setIndex, handleKey };
}

/**
 * Scroll offset for a windowed list, wrapping `viewer-util.clampOffset`.
 *
 * `useState` holds the raw offset but the DERIVED value is recomputed from
 * `clampOffset` on every render, so a resize or a shrinking list can never
 * strand the window past the end. The `useEffect` write-back is **not**
 * optional: with a permanently-zero stored offset, `clampOffset` re-derives the
 * minimum window containing the cursor every render, which pins the cursor to
 * the bottom edge and re-scrolls on every single upward keypress.
 */
export function useListWindow(cursor: number, size: number, total: number): { offset: number } {
  const [stored, setStored] = useState(0);
  const offset = clampOffset(cursor, stored, size, total);
  useEffect(() => {
    if (offset !== stored) setStored(offset);
  }, [offset, stored]);
  return { offset };
}
