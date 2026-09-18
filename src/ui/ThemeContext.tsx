/**
 * @module ui/ThemeContext
 *
 * Theme colours for a subtree, so one can be PREVIEWED without being chosen.
 *
 * Every component in the tree reads `getThemeColors()` directly, which returns
 * whatever `theme.ts`'s module-level `activeThemeKey` currently says — 85 call
 * sites, no context, no provider. That is fine for a setting that changes when
 * you commit it, and wrong for the wizard's theme question (#447), which wants
 * to show you a theme as the cursor passes it.
 *
 * The one-line alternative is `setTheme(key)` on every cursor move, and it
 * fails twice. It writes a process global, so Esc, Back and an abandoned
 * `/setup` each have to put the real theme back and a missed restore leaves the
 * REPL somewhere the user never chose. And it would repaint the wrong half of
 * the frame: the cursor lives inside `WizardChoiceStep`, a CHILD of
 * `WizardCard`, so moving it re-renders the rows and not the border, the rail,
 * the header or the footer.
 *
 * A provider fixes both at once — it sits above the card, and reverting is not
 * doing anything, because it unmounts with the overlay.
 *
 * Shaped exactly like {@link module:ui/DimensionsContext}: a private context, a
 * `Provider` wrapper, and one exported reader. The difference is the default —
 * that one has a sane constant, this one has `null` and falls through to the
 * global, which is what makes adoption piecemeal.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { getThemeColors, type ThemeColors } from '../theme.js';

const ThemeContext = createContext<ThemeColors | null>(null);

/**
 * Paints its children in `colors`, or leaves them on the active theme.
 *
 * `null` is a supported value rather than a reason not to render the provider:
 * the wizard wraps its card unconditionally and passes `null` on every step but
 * the one that previews, so the provider's presence is not a second thing to
 * keep in step with the preview state.
 */
export function ThemePreviewProvider({
  colors,
  children,
}: {
  colors: ThemeColors | null;
  children: ReactNode;
}) {
  return <ThemeContext.Provider value={colors}>{children}</ThemeContext.Provider>;
}

/**
 * The colours this component should paint with.
 *
 * **Outside a provider it is `getThemeColors()`, identically** — the same
 * object, not an equal one. That is what lets a shared component like `MenuRow`
 * be converted without any of its other callers noticing, and what keeps
 * `markdown.ts`'s reference-equality cache honest.
 */
export function useThemeColors(): ThemeColors {
  return useContext(ThemeContext) ?? getThemeColors();
}
