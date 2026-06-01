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
export const ENTER = '\r';
export const BACKSPACE = '';

export const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
