import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastRatio } from './color.js';

/** A representative dark terminal — the ground `host/tokens.ts` also assumes. */
const DARK_TERMINAL = '#0d1117';
import {
  THEMES,
  DEFAULT_THEME,
  setTheme,
  getThemeKeys,
  getActiveThemeKey,
  getThemeColors,
  getThemeColorsFor,
} from './theme.js';

describe('theme', () => {
  beforeEach(() => {
    setTheme(DEFAULT_THEME);
  });

  describe('DEFAULT_THEME', () => {
    it('is "bernard"', () => {
      expect(DEFAULT_THEME).toBe('bernard');
    });

    it('is the active theme on module load', () => {
      expect(getActiveThemeKey()).toBe('bernard');
    });
  });

  describe('setTheme', () => {
    it('returns true for a valid theme key', () => {
      expect(setTheme('ocean')).toBe(true);
    });

    it('returns false for an invalid theme key', () => {
      expect(setTheme('nonexistent')).toBe(false);
    });

    it('updates active theme when valid', () => {
      setTheme('forest');
      expect(getActiveThemeKey()).toBe('forest');
    });

    it('does not change active theme when invalid', () => {
      setTheme('ocean');
      setTheme('bogus');
      expect(getActiveThemeKey()).toBe('ocean');
    });
  });

  /**
   * The keys of `THEME_COLORS`, read out of the source.
   *
   * That record is module-private and should stay so — exporting it to satisfy a
   * test widens the API for one assertion. `settings-coverage.test.ts` makes the
   * same move against `profiles.ts` for the same reason: the file is the only
   * place to ask, and reading it is cheaper than a new accessor nothing else
   * wants.
   */
  function paletteKeys(): string[] {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'theme.ts'),
      'utf-8',
    );
    const start = src.indexOf('const THEME_COLORS');
    expect(start, 'the record this reads has moved').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n};', start));
    // Two-space indent is the record's own top level; anything deeper is a
    // colour field. Guarded below by comparing against `getThemeKeys()`, so a
    // regex that matched nothing could not pass quietly.
    return [...body.matchAll(/(?:^|\n) {2}'?([a-z-]+)'?: \{/g)].map((m) => m[1]);
  }

  describe('getThemeKeys', () => {
    it('keeps the themes every other surface names', () => {
      // A count was here, and a count is what a new theme breaks while telling
      // you nothing. What must not silently go missing is the DEFAULT, which
      // `index.ts` falls back to, and the accessibility pair, which `/theme`
      // splits its menu on by name — losing one of those reshapes that menu
      // with no other test noticing.
      const keys = getThemeKeys();
      expect(keys).toContain(DEFAULT_THEME);
      expect(keys).toContain('high-contrast');
      expect(keys).toContain('colorblind');
      expect(keys.length).toBeGreaterThanOrEqual(3);
    });

    it('has a palette for every theme, and no palette without one', () => {
      // Both directions, because they fail differently: a named theme with no
      // palette silently renders as `bernard` via `getThemeColorsFor`'s
      // fallback, and a palette with no name is unreachable — no menu offers
      // it, no `setTheme` accepts it. The count this replaced caught neither.
      expect(paletteKeys().sort()).toEqual(getThemeKeys().sort());
    });

    it('never makes the accent brighter than the body text', () => {
      // The invariant that would have caught `graphite`'s first cut, which
      // paired a near-white accent (17.27 against a `#0d1117` terminal, more
      // than double any other theme's) with dim text at 7.38 — inverted, and
      // the reason it read as `high-contrast` rather than as a dark theme.
      //
      // Every theme built on hex puts text brighter than accent, and that is a
      // property rather than a coincidence: the accent marks a few characters
      // and the text is the page. A theme that inverts it is one where the
      // chrome shouts over the prose.
      //
      // Named-colour themes (`bernard`, `high-contrast`) are skipped because
      // `contrastRatio` cannot resolve 'white' or 'gray' — hence the floor
      // below, so a version that measured nothing could not pass quietly.
      let measured = 0;
      for (const key of getThemeKeys()) {
        const c = getThemeColorsFor(key);
        const accent = contrastRatio(c.accent, DARK_TERMINAL);
        const text = contrastRatio(c.text, DARK_TERMINAL);
        if (accent === null || text === null) continue;
        measured++;
        expect(text, `${key}: accent must not outshine the prose`).toBeGreaterThan(accent);
      }
      expect(measured, 'no theme was actually measured').toBeGreaterThanOrEqual(5);
    });

    it('never paints an error in the accent colour', () => {
      // A real constraint once themes are built around one hue: `blossom` is
      // pink and `ember` is red, and an error picked from the accent's own
      // family stops reading as an error — the one colour that must never
      // blend into the chrome. Both records say so in a comment; this is what
      // makes a later "tidy-up" toward each other fail.
      for (const key of getThemeKeys()) {
        const c = getThemeColorsFor(key);
        expect(c.error, key).not.toBe(c.accent);
      }
    });
  });

  describe('theme structure', () => {
    const requiredColorKeys = [
      'accent',
      'muted',
      'text',
      'toolCall',
      'error',
      'success',
      'warning',
    ] as const;

    for (const key of getThemeKeys()) {
      describe(`theme "${key}"`, () => {
        beforeEach(() => setTheme(key));

        it('has a name string', () => {
          expect(typeof THEMES[key].name).toBe('string');
          expect(THEMES[key].name.length).toBeGreaterThan(0);
        });

        for (const colorKey of requiredColorKeys) {
          it(`has ${colorKey} as a string`, () => {
            const c = getThemeColors();
            expect(typeof c[colorKey]).toBe('string');
            expect(c[colorKey].length).toBeGreaterThan(0);
          });
        }

        it('has prefixColors as a non-empty array', () => {
          const c = getThemeColors();
          expect(Array.isArray(c.prefixColors)).toBe(true);
          expect(c.prefixColors.length).toBeGreaterThan(0);
        });
      });
    }
  });
});
