import type { Key } from 'ink';
import type { KeyHint } from '../hints.js';

/**
 * The one keybinding contract every overlay obeys (#266).
 *
 * Before this, the twelve overlays disagreed in ways a user feels immediately:
 * `q` cancelled a menu but was ignored by a confirm dialog and typed a literal
 * `q` into a text field; `Ctrl-C` was handled by four overlays and silently
 * dropped by the other eight, including every Shift+Tab viewer. The rules:
 *
 * - **`Esc` always dismisses.** Already near-universal; unchanged.
 * - **`Ctrl-C` always dismisses.** The reflex for "get me out of here" should
 *   never depend on which overlay happens to be open.
 * - **`q` dismisses surfaces with no text field.** It cannot be universal — a
 *   text field must be able to receive the character — so it is opt-in per
 *   overlay via {@link isDismissKeyWithQ} rather than folded into
 *   {@link isDismissKey}.
 */

/** `Esc` or `Ctrl-C` — the two that dismiss every overlay, text fields included. */
export function isDismissKey(input: string, key: Key): boolean {
  return key.escape === true || (key.ctrl === true && input === 'c');
}

/**
 * {@link isDismissKey} plus `q`, for any surface with **no text field** — menus,
 * dialogs, viewers, help. Not "read-only": `MenuOverlay` and `ConfirmDialog`
 * both commit a choice and both take `q`. The question `q` turns on is only
 * ever "can a character land in a buffer here?".
 *
 * Deliberately a separate function rather than a flag on `isDismissKey`, so a
 * caller has to say which kind of surface it is — that is what stops `q`
 * silently becoming un-typeable in an input field.
 */
export function isDismissKeyWithQ(input: string, key: Key): boolean {
  return isDismissKey(input, key) || input === 'q';
}

/**
 * The shared hint vocabulary (#266).
 *
 * One spelling per key, because five coexisted: `Esc`/`esc`, `Enter`/`↵`,
 * `shift+tab`/`⇧⇥`, and `cancel`/`back`/`close` for the same physical key.
 * Lowercase glyph style wins because seven of the eight surfaces already
 * rendering through `HintRow` used it — the odd one out was `TextInputOverlay`,
 * which is converted here.
 */
export const KEY = {
  esc: 'esc',
  enter: '↵',
  shiftTab: '⇧⇥',
  space: 'space',
  arrows: '↑/↓',
  arrowsAll: '←/→/↑/↓',
  leftRight: '←/→',
  pageKeys: '⇞⇟',
} as const;

/** `esc close` — the dismiss hint for a read-only surface. */
export const HINT_CLOSE: KeyHint = { key: KEY.esc, label: 'close' };
/** `esc cancel` — the dismiss hint for a surface that commits something. */
export const HINT_CANCEL: KeyHint = { key: KEY.esc, label: 'cancel' };
/** `⇧⇥ switch tab` — the viewer tab-cycle hint. */
export const HINT_SWITCH_TAB: KeyHint = { key: KEY.shiftTab, label: 'switch tab' };
/** `↑/↓ move` — selection movement, as distinct from `scroll`. */
export const HINT_MOVE: KeyHint = { key: KEY.arrows, label: 'move' };
/** `↑/↓ scroll` — viewport movement, as distinct from `move`. */
export const HINT_SCROLL: KeyHint = { key: KEY.arrows, label: 'scroll' };
/** `↵ select` — commit the highlighted row. */
export const HINT_SELECT: KeyHint = { key: KEY.enter, label: 'select' };
