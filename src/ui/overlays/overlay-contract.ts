import type { Key } from 'ink';

/**
 * The one keybinding contract every overlay obeys (#266).
 *
 * Before this, the twelve overlays disagreed in ways a user feels immediately:
 * `q` cancelled a menu but was ignored by a confirm dialog and typed a literal
 * `q` into a text field; `Ctrl-C` was handled by four overlays and silently
 * dropped by the other eight, including every Shift+Tab viewer. The rules:
 *
 * - **`Esc` always dismisses.** Already near-universal; unchanged.
 * - **`Ctrl-C` exits the app, and does NOT reach these predicates in
 *   production.** `render()` defaults to `exitOnCtrlC: true` and `src/index.ts`
 *   passes no options, so Ink swallows Ctrl-C before dispatching to any
 *   `useInput` — its source says so: *"If app is not supposed to exit on
 *   Ctrl+C, then let input listener handle it"*. The clause below is kept
 *   because `ink-testing-library` hardcodes `exitOnCtrlC: false`, so it is what
 *   the tests exercise, and because it is the correct behaviour the moment that
 *   default changes. But nothing here makes Ctrl-C close an overlay today, and
 *   claiming otherwise would be a guarantee the codebase cannot honour — see
 *   the `exitOnCtrlC` follow-up.
 * - **`q` dismisses surfaces with no text field.** It cannot be universal — a
 *   text field must be able to receive the character — so it is opt-in per
 *   overlay via {@link isDismissKeyWithQ} rather than folded into
 *   {@link isDismissKey}.
 */

/**
 * `Ctrl-C` alone. Exported because two callers need it *without* `Esc`:
 * `ViewerShell` gates Esc on `escClosesViewer` (a drilled-in viewer spends Esc
 * on "back one level") but must still close unconditionally on Ctrl-C, and
 * `ModelGridOverlay`'s empty-list branch has no rows to cancel out of. Without
 * this atom both hand-roll the comparison — which is what the module exists to
 * stop.
 */
export function isCtrlC(input: string, key: Key): boolean {
  return key.ctrl === true && input === 'c';
}

/** `Esc` or `Ctrl-C` — the two that dismiss every overlay, text fields included. */
export function isDismissKey(input: string, key: Key): boolean {
  return key.escape === true || isCtrlC(input, key);
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
 * {@link isDismissKeyWithQ} plus `Enter`, for a purely informational surface.
 *
 * `Enter` only closes where there is nothing to commit — on those screens it
 * reads as "acknowledge", whereas anywhere else it means "commit the
 * highlighted thing" and closing on it would discard a choice.
 */
export function isAcknowledgeKey(input: string, key: Key): boolean {
  return isDismissKeyWithQ(input, key) || key.return === true;
}
