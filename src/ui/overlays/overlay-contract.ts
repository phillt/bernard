import type { Key } from 'ink';

/**
 * The one keybinding contract every overlay obeys (#266).
 *
 * Before this, the twelve overlays disagreed in ways a user feels immediately:
 * `q` cancelled a menu but was ignored by a confirm dialog and typed a literal
 * `q` into a text field. The rules:
 *
 * - **`Esc` always dismisses.** Already near-universal; unchanged.
 * - **`q` dismisses surfaces with no text field.** It cannot be universal — a
 *   text field must be able to receive the character — so it is opt-in per
 *   overlay via {@link isDismissKeyWithQ} rather than folded into
 *   {@link isDismissKey}.
 * - **`Ctrl-C` quits Bernard and is not an overlay key at all** (#360).
 *
 * That last rule is a decision, not an omission. #266 shipped a
 * `Ctrl-C`-also-dismisses clause and it was dead the day it landed: `render()`
 * defaults to `exitOnCtrlC: true` and `src/index.ts` passes no options object,
 * so Ink unmounts on Ctrl-C *before* dispatching to any `useInput` — its own
 * source says so, *"If app is not supposed to exit on Ctrl+C, then let input
 * listener handle it"*. Eight production branches across the overlay layer were
 * unreachable and passed their tests anyway, because `ink-testing-library`
 * hardcodes `exitOnCtrlC: false`: the harness configured Ink differently from
 * the app, which is exactly what let dead code read as covered.
 *
 * #360 resolved it in favour of the terminal rather than the codebase — Ctrl-C
 * keeps quitting Bernard, and the branches are gone. Quitting on Ctrl-C is
 * universal CLI muscle memory; the alternative (`exitOnCtrlC: false`, with
 * `<App>` owning quit itself) is a significant change to the most reflexive key
 * in the terminal, bought for a *second* way to do what `Esc` already does
 * under this contract.
 *
 * Two costs are real and are recorded here so the decision reads as taken
 * rather than defaulted into. Ctrl-C leaves through Ink's unmount, so `onExit()`
 * runs fire-and-forget (`void`, in `<App>`'s unmount effect) where `/exit`
 * awaits it — the other option would have put Ctrl-C on the graceful path. And
 * the deleted `ViewerShell` branch justified itself with "there must still be
 * one key that always leaves", which was already false for the two viewers
 * passing `escClosesViewer={false}` (`ContextViewer`, `SourcesViewer`), where
 * leaving is a level-by-level walk of repeated Esc. It stays false; the comment
 * went rather than persisting as a promise nothing keeps.
 */

/**
 * `Esc` — the key that dismisses every overlay, text fields included.
 *
 * One term, and still worth a name: this is where the contract's central rule
 * is written down, {@link isDismissKeyWithQ} and {@link isAcknowledgeKey} are
 * defined by extending it, and `TextInputOverlay` reads it to cede the
 * keystream before its editor claims six Ctrl chords. Inlining `key.escape` at
 * those sites would put the rule back inside components, which is the drift
 * this module exists to close.
 *
 * `_input` goes unread and stays in the signature so every predicate here takes
 * the same `(input, key)` pair `useInput` hands its handler — a caller can swap
 * one for another without touching the call.
 */
export function isDismissKey(_input: string, key: Key): boolean {
  return key.escape === true;
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
 * The keys a wrapping {@link ViewerShell} claims for itself: `Esc` (close) and
 * `Shift+Tab` (cycle tab). Content layered *inside* the shell —
 * `SettingsOverlay` — must return early on these so the shell's own `useInput`
 * is the only handler that acts, Ink having no stop-propagation.
 *
 * Spelled out term-by-term rather than composed from {@link isDismissKey}: this
 * mirrors the shell's own handler, and the two are free to diverge — the shell
 * gates its Esc on `escClosesViewer` while every dismissible overlay does not.
 * Named rather than open-coded at its one call site because it has to name what
 * the shell *actually* claims: a predicate that is a subset of the real thing is
 * the kind that silently stops being true when the shell grows a key.
 */
export function isShellOwnedKey(_input: string, key: Key): boolean {
  return key.escape === true || (key.shift === true && key.tab === true);
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
