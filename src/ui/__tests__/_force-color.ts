/**
 * Shared harness for the colour-assertion test files (#266, #320).
 *
 * Why these files exist at all: under `vitest run` stdout is not a TTY, so Ink
 * emits no ANSI and `lastFrame()` returns bare text. Every plain-text
 * assertion therefore passes identically with `dimColor` or with a theme
 * colour — the suite is structurally blind to the whole class of bug, which is
 * how a raw `dimColor` footer survived #320's sweep.
 *
 * Why a module rather than a copied prologue: forcing colour has to happen
 * before Ink's chalk instance is constructed, because chalk caches its level at
 * import. A static `import './_force-color.js'` is evaluated before the
 * importing file's own top-level `await import(...)` calls, which is exactly
 * the ordering the hand-rolled version relied on — so this preserves the
 * constraint while removing the duplication.
 *
 * It also fixes a bug both copies shared: they captured the "original" value on
 * the line *after* setting it, so the restore wrote `'3'` back instead of
 * deleting it — leaking forced colour into every later Ink test in the same
 * worker, which is the precise failure their own comments warned about
 * (`process.env` is per-worker, and vitest reuses workers across files).
 */

/** Captured BEFORE the assignment below — that ordering is the point. */
const ORIGINAL_FORCE_COLOR = process.env.FORCE_COLOR;

process.env.FORCE_COLOR = '3';

/** Ink's `dimColor` — SGR 2, the attribute that ignores the active theme. */
export const SGR_DIM = '\u001b[2m';

/** `colors.muted` is 'gray' in the default theme. */
export const SGR_THEME_MUTED = '\u001b[90m';

/** Pass to `afterAll` so the forced colour does not outlive the file. */
export function restoreForceColor(): void {
  if (ORIGINAL_FORCE_COLOR === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = ORIGINAL_FORCE_COLOR;
}
