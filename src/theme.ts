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

export function getThemeColors(): ThemeColors {
  return THEME_COLORS[activeThemeKey] ?? THEME_COLORS[DEFAULT_THEME];
}
