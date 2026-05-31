import chalk from 'chalk';

/** A function that applies a chalk color/style to a string and returns the styled result. */
type ColorFn = (text: string) => string;

/**
 * Defines the color palette and styling functions for a terminal theme.
 *
 * Each theme provides semantic color functions for different UI elements
 * and raw ANSI escape codes for use in readline prompts where chalk cannot be used.
 */
export interface Theme {
  /** Human-readable display name for the theme. */
  name: string;
  /** Primary accent color for branding and highlights. */
  accent: ColorFn;
  /** Bold variant of the primary accent color. */
  accentBold: ColorFn;
  /** Subdued color for secondary or less important text. */
  muted: ColorFn;
  /** Default color for regular body text. */
  text: ColorFn;
  /** Color for tool invocation labels. */
  toolCall: ColorFn;
  /** Color for error messages. */
  error: ColorFn;
  /** Color for success indicators. */
  success: ColorFn;
  /** Dimmed color for de-emphasized content like conversation replays. */
  dim: ColorFn;
  /** Dimmed italic variant, used for secondary blocks like the `think` tool output. */
  dimItalic: ColorFn;
  /** Color for warning messages. */
  warning: ColorFn;
  /** Rotating palette of colors assigned to sub-agent prefixes. */
  prefixColors: readonly ColorFn[];

  /**
   * Raw ANSI escape sequences for contexts where chalk is unavailable
   * (e.g. readline prompt strings).
   */
  ansi: {
    prompt: string;
    hintCmd: string;
    hintDesc: string;
    warning: string;
    reset: string;
  };
}

/**
 * Registry of all available color themes, keyed by slug.
 *
 * Includes: `bernard` (default orange), `ocean`, `forest`, `synthwave`,
 * `high-contrast`, and `colorblind` (IBM-safe palette).
 */
export const THEMES: Record<string, Theme> = {
  /** Default theme with warm orange accents. */
  bernard: {
    name: 'Bernard',
    accent: chalk.hex('#f97316'),
    accentBold: chalk.bold.hex('#f97316'),
    muted: chalk.gray,
    text: chalk.white,
    toolCall: chalk.yellow,
    error: chalk.red,
    success: chalk.green,
    dim: chalk.dim,
    dimItalic: chalk.dim.italic,
    warning: chalk.yellow,
    prefixColors: [chalk.magenta, chalk.blue, chalk.green, chalk.yellow],
    ansi: {
      prompt: '\x1b[38;2;249;115;22m',
      hintCmd: '\x1b[1;38;2;249;115;22m',
      hintDesc: '\x1b[22;38;2;115;115;115m',
      warning: '\x1b[33m',
      reset: '\x1b[0m',
    },
  },

  /** Cool blue-cyan palette inspired by the sea. */
  ocean: {
    name: 'Ocean',
    accent: chalk.hex('#06b6d4'),
    accentBold: chalk.bold.hex('#06b6d4'),
    muted: chalk.hex('#94a3b8'),
    text: chalk.hex('#e2e8f0'),
    toolCall: chalk.hex('#38bdf8'),
    error: chalk.hex('#f87171'),
    success: chalk.hex('#34d399'),
    dim: chalk.dim,
    dimItalic: chalk.dim.italic,
    warning: chalk.hex('#fbbf24'),
    prefixColors: [
      chalk.hex('#38bdf8'),
      chalk.hex('#818cf8'),
      chalk.hex('#34d399'),
      chalk.hex('#06b6d4'),
    ],
    ansi: {
      prompt: '\x1b[38;2;6;182;212m',
      hintCmd: '\x1b[1;38;2;6;182;212m',
      hintDesc: '\x1b[22;38;2;115;125;140m',
      warning: '\x1b[38;2;251;191;36m',
      reset: '\x1b[0m',
    },
  },

  /** Earthy green palette for a natural look. */
  forest: {
    name: 'Forest',
    accent: chalk.hex('#22c55e'),
    accentBold: chalk.bold.hex('#22c55e'),
    muted: chalk.hex('#a3a3a3'),
    text: chalk.hex('#e5e5e5'),
    toolCall: chalk.hex('#86efac'),
    error: chalk.hex('#ef4444'),
    success: chalk.hex('#4ade80'),
    dim: chalk.dim,
    dimItalic: chalk.dim.italic,
    warning: chalk.hex('#facc15'),
    prefixColors: [
      chalk.hex('#4ade80'),
      chalk.hex('#a78bfa'),
      chalk.hex('#fbbf24'),
      chalk.hex('#22d3ee'),
    ],
    ansi: {
      prompt: '\x1b[38;2;34;197;94m',
      hintCmd: '\x1b[1;38;2;34;197;94m',
      hintDesc: '\x1b[22;38;2;115;115;115m',
      warning: '\x1b[38;2;250;204;21m',
      reset: '\x1b[0m',
    },
  },

  /** Retro neon purple and pink palette. */
  synthwave: {
    name: 'Synthwave',
    accent: chalk.hex('#c084fc'),
    accentBold: chalk.bold.hex('#c084fc'),
    muted: chalk.hex('#a78bfa'),
    text: chalk.hex('#f0abfc'),
    toolCall: chalk.hex('#f472b6'),
    error: chalk.hex('#fb7185'),
    success: chalk.hex('#34d399'),
    dim: chalk.dim,
    dimItalic: chalk.dim.italic,
    warning: chalk.hex('#fde68a'),
    prefixColors: [
      chalk.hex('#f472b6'),
      chalk.hex('#818cf8'),
      chalk.hex('#22d3ee'),
      chalk.hex('#c084fc'),
    ],
    ansi: {
      prompt: '\x1b[38;2;192;132;252m',
      hintCmd: '\x1b[1;38;2;192;132;252m',
      hintDesc: '\x1b[22;38;2;130;130;150m',
      warning: '\x1b[38;2;253;230;138m',
      reset: '\x1b[0m',
    },
  },

  /** Maximum contrast using bold bright whites and system colors. */
  'high-contrast': {
    name: 'High Contrast',
    accent: chalk.bold.white,
    accentBold: chalk.bold.whiteBright,
    muted: chalk.whiteBright,
    text: chalk.whiteBright,
    toolCall: chalk.bold.yellowBright,
    error: chalk.bold.redBright,
    success: chalk.bold.greenBright,
    dim: chalk.white,
    dimItalic: chalk.white.italic,
    warning: chalk.bold.yellowBright,
    prefixColors: [
      chalk.bold.magentaBright,
      chalk.bold.cyanBright,
      chalk.bold.greenBright,
      chalk.bold.yellowBright,
    ],
    ansi: {
      prompt: '\x1b[1;97m',
      hintCmd: '\x1b[1;93m',
      hintDesc: '\x1b[22;37m',
      warning: '\x1b[1;93m',
      reset: '\x1b[0m',
    },
  },

  /** Palette using IBM's colorblind-safe color scheme for accessibility. */
  colorblind: {
    name: 'Colorblind',
    accent: chalk.hex('#648FFF'),
    accentBold: chalk.bold.hex('#648FFF'),
    muted: chalk.hex('#b0b0b0'),
    text: chalk.hex('#e0e0e0'),
    toolCall: chalk.hex('#DC267F'),
    error: chalk.hex('#DC267F'),
    success: chalk.hex('#648FFF'),
    dim: chalk.dim,
    dimItalic: chalk.dim.italic,
    warning: chalk.hex('#FFB000'),
    prefixColors: [
      chalk.hex('#785EF0'),
      chalk.hex('#DC267F'),
      chalk.hex('#FFB000'),
      chalk.hex('#648FFF'),
    ],
    ansi: {
      prompt: '\x1b[38;2;100;143;255m',
      hintCmd: '\x1b[1;38;2;100;143;255m',
      hintDesc: '\x1b[22;38;2;130;130;130m',
      warning: '\x1b[38;2;255;176;0m',
      reset: '\x1b[0m',
    },
  },
};

/** Key of the theme used when no user preference is set. */
export const DEFAULT_THEME = 'bernard';

let activeThemeKey: string = DEFAULT_THEME;
let activeTheme: Theme = THEMES[DEFAULT_THEME];

/**
 * Returns the currently active {@link Theme} object.
 * @returns The active theme, defaulting to the `bernard` theme at startup.
 */
export function getTheme(): Theme {
  return activeTheme;
}

/**
 * Switches the active theme by its slug key.
 *
 * @param key - Theme slug (e.g. `"ocean"`, `"forest"`).
 * @returns `true` if the theme was found and activated, `false` if the key is unknown.
 */
export function setTheme(key: string): boolean {
  const theme = THEMES[key];
  if (!theme) return false;
  activeThemeKey = key;
  activeTheme = theme;
  return true;
}

/** Returns an array of all registered theme slug keys. */
export function getThemeKeys(): string[] {
  return Object.keys(THEMES);
}

/** Returns the slug key of the currently active theme (e.g. `"bernard"`). */
export function getActiveThemeKey(): string {
  return activeThemeKey;
}

/**
 * Raw color tokens for Ink components. Ink's `<Text color={...}>` takes hex
 * strings or named ANSI colors, not chalk callables, so the migration to Ink
 * needs a parallel palette derived from the same per-theme values as
 * {@link Theme}.
 *
 * Components should use the `<Text dimColor>` prop for ANSI dim styling rather
 * than reaching for a separate "dim" color token — that maps cleanly onto the
 * legacy `chalk.dim` usage without an extra entry here.
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

/**
 * Returns the Ink-friendly color palette for the active theme. Mirrors the
 * {@link Theme} returned by {@link getTheme}; the two stay in sync because
 * {@link setTheme} updates `activeThemeKey` and both lookups read it.
 */
export function getThemeColors(): ThemeColors {
  return THEME_COLORS[activeThemeKey] ?? THEME_COLORS[DEFAULT_THEME];
}
