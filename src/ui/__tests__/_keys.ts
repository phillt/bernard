/**
 * Keystroke and timing helpers for ink-testing-library tests.
 *
 * `ink-testing-library` writes to a synthetic stdin synchronously, but Ink's
 * `useInput` subscription needs a microtask tick before the handler fires.
 * `tick()` yields the event loop just long enough for that.
 */

export const ESC = '';
export const ARROW_UP = '[A';
export const ARROW_DOWN = '[B';
export const ARROW_LEFT = '[D';
export const ARROW_RIGHT = '[C';
export const CTRL_A = '\x01';
export const CTRL_E = '\x05';
export const CTRL_J = '\n';
export const ENTER = '\r';
/** Shift+Enter as transmitted by kitty/foot/ghostty (CSI-u encoding). */
export const SHIFT_ENTER_CSIU = '\x1b[13;2u';
/** Shift/Alt+Enter as transmitted by configured iTerm2 / VS Code (ESC+CR). */
export const META_ENTER = '\x1b\r';
export const BACKSPACE = '';

export const SPACE = ' ';

/** Shift+Tab (CSI Z) — Ink decodes this to `{ tab: true, shift: true }`. */
export const SHIFT_TAB = '\x1b[Z';
export const PAGE_UP = '\x1b[5~';
export const PAGE_DOWN = '\x1b[6~';

export const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Readline-style editing chords (#356). Byte sequences verified against Ink's
 * key parser — Alt-* arrive as `{meta}`, Ctrl-arrows as `{leftArrow, ctrl}`.
 * Home/End are deliberately absent: Ink surfaces them as empty input with no
 * flags, so they cannot be bound through `useInput`.
 */
export const CTRL_W = '\x17';
export const CTRL_U = '\x15';
export const CTRL_K = '\x0b';
export const CTRL_D = '\x04';
export const ALT_B = '\x1bb';
export const ALT_F = '\x1bf';
export const ALT_BACKSPACE = '\x1b\x7f';
export const ALT_LEFT = '\x1b[1;3D';
export const ALT_RIGHT = '\x1b[1;3C';
export const CTRL_LEFT = '\x1b[1;5D';
export const CTRL_RIGHT = '\x1b[1;5C';
