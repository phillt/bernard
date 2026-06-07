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
export const CTRL_C = '';
export const CTRL_A = '\x01';
export const CTRL_E = '\x05';
export const CTRL_J = '\n';
export const ENTER = '\r';
/** Shift+Enter as transmitted by kitty/foot/ghostty (CSI-u encoding). */
export const SHIFT_ENTER_CSIU = '\x1b[13;2u';
/** Shift/Alt+Enter as transmitted by configured iTerm2 / VS Code (ESC+CR). */
export const META_ENTER = '\x1b\r';
export const BACKSPACE = '';

export const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
