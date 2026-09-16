/**
 * @module theme
 *
 * Color palettes for the Ink UI. Phase D dropped the legacy chalk-callable
 * `Theme` interface — Ink's `<Text color="...">` takes hex strings or named
 * ANSI colors, so the per-theme entries here are plain-data records and the
 * `chalk` dependency is gone.
 */

export interface ThemeColors {
  accent: string;
  muted: string;
  text: string;
  toolCall: string;
  error: string;
  success: string;
  warning: string;
  prefixColors: readonly string[];
}

export interface ThemeMeta {
  name: string;
}

export const THEMES: Record<string, ThemeMeta> = {
  bernard: { name: 'Bernard' },
  ocean: { name: 'Ocean' },
  forest: { name: 'Forest' },
  synthwave: { name: 'Synthwave' },
  blossom: { name: 'Blossom' },
  ember: { name: 'Ember' },
  graphite: { name: 'Graphite' },
  'high-contrast': { name: 'High Contrast' },
  colorblind: { name: 'Colorblind' },
};

export const DEFAULT_THEME = 'bernard';

const THEME_COLORS: Record<string, ThemeColors> = {
  bernard: {
    accent: '#f97316',
    muted: 'gray',
    text: 'white',
    toolCall: 'yellow',
    error: 'red',
    success: 'green',
    warning: 'yellow',
    prefixColors: ['magenta', 'blue', 'green', 'yellow'],
  },
  ocean: {
    accent: '#06b6d4',
    muted: '#94a3b8',
    text: '#e2e8f0',
    toolCall: '#38bdf8',
    error: '#f87171',
    success: '#34d399',
    warning: '#fbbf24',
    prefixColors: ['#38bdf8', '#818cf8', '#34d399', '#06b6d4'],
  },
  forest: {
    accent: '#22c55e',
    muted: '#a3a3a3',
    text: '#e5e5e5',
    toolCall: '#86efac',
    error: '#ef4444',
    success: '#4ade80',
    warning: '#facc15',
    prefixColors: ['#4ade80', '#a78bfa', '#fbbf24', '#22d3ee'],
  },
  synthwave: {
    accent: '#c084fc',
    muted: '#a78bfa',
    text: '#f0abfc',
    toolCall: '#f472b6',
    error: '#fb7185',
    success: '#34d399',
    warning: '#fde68a',
    prefixColors: ['#f472b6', '#818cf8', '#22d3ee', '#c084fc'],
  },
  // Pink. `error` is deliberately a plain red rather than a deeper pink: on a
  // theme whose accent IS pink, an error picked from the same family stops
  // reading as an error, which is the one colour that must never blend in.
  blossom: {
    accent: '#ec4899',
    muted: '#a1a1aa',
    text: '#fce7f3',
    toolCall: '#f9a8d4',
    error: '#ef4444',
    success: '#34d399',
    warning: '#fbbf24',
    prefixColors: ['#ec4899', '#a78bfa', '#38bdf8', '#fb923c'],
  },
  // Red, and the same tension one step worse — here the accent and the error
  // are the SAME hue, so they are separated by lightness instead: a deep ember
  // accent against a bright coral error, so the alarming one is the one that
  // jumps. Do not "tidy" these toward each other.
  ember: {
    accent: '#dc2626',
    muted: '#a8a29e',
    text: '#fee2e2',
    toolCall: '#fb923c',
    error: '#ff6b6b',
    success: '#4ade80',
    warning: '#fbbf24',
    prefixColors: ['#dc2626', '#fb923c', '#fbbf24', '#f472b6'],
  },
  // Dark, and the contrast runs the other way from every theme above it: a
  // three-step ladder of near-white accent, dim body text, dimmer chrome. The
  // first cut had accent and text a shade apart, which reads as restrained and
  // leaves the accent doing no work — a heading indistinguishable from the
  // paragraph under it.
  //
  // `error` / `success` / `warning` keep their colours on purpose: a restrained
  // theme is a choice about chrome, not a reason to stop signalling. And
  // `toolCall` stays a hue rather than a fourth grey, so tool output is still
  // tellable from prose — as is `prefixColors`, which four greys would make
  // useless for what it is actually for, telling sub-agents apart.
  graphite: {
    accent: '#f1f5f9',
    muted: '#64748b',
    text: '#94a3b8',
    toolCall: '#a5b4fc',
    error: '#f87171',
    success: '#4ade80',
    warning: '#fbbf24',
    prefixColors: ['#f1f5f9', '#a5b4fc', '#94a3b8', '#64748b'],
  },
  'high-contrast': {
    accent: 'whiteBright',
    muted: 'white',
    text: 'whiteBright',
    toolCall: 'yellowBright',
    error: 'redBright',
    success: 'greenBright',
    warning: 'yellowBright',
    prefixColors: ['magentaBright', 'cyanBright', 'greenBright', 'yellowBright'],
  },
  colorblind: {
    accent: '#648FFF',
    muted: '#b0b0b0',
    text: '#e0e0e0',
    toolCall: '#DC267F',
    error: '#DC267F',
    success: '#648FFF',
    warning: '#FFB000',
    prefixColors: ['#785EF0', '#DC267F', '#FFB000', '#648FFF'],
  },
};

let activeThemeKey: string = DEFAULT_THEME;

export function setTheme(key: string): boolean {
  if (!THEMES[key]) return false;
  activeThemeKey = key;
  return true;
}

export function getThemeKeys(): string[] {
  return Object.keys(THEMES);
}

export function getActiveThemeKey(): string {
  return activeThemeKey;
}

/**
 * One theme's colours, without touching the active one.
 *
 * The pure half of {@link getThemeColors}, added for the wizard's live theme
 * preview (#447): showing you a theme you have not chosen must not involve
 * choosing it, or every way out of that question — Esc, Back, an abandoned
 * `/setup` — has to remember to put the real one back.
 *
 * Returns the module literal itself, never a copy, which is what preserves the
 * per-theme **reference stability** `markdown.ts` uses as a parser cache key
 * (`cachedColors === colors`). An unknown key falls back rather than throwing:
 * this is reached from a render path, and a stored theme that no longer exists
 * should look wrong, not take the frame down.
 */
export function getThemeColorsFor(key: string): ThemeColors {
  return THEME_COLORS[key] ?? THEME_COLORS[DEFAULT_THEME];
}

export function getThemeColors(): ThemeColors {
  return getThemeColorsFor(activeThemeKey);
}
