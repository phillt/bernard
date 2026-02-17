import { describe, it, expect, beforeEach } from 'vitest';
import {
  THEMES,
  DEFAULT_THEME,
  getTheme,
  setTheme,
  getThemeKeys,
  getActiveThemeKey,
  type Theme,
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
      expect(getTheme()).toBe(THEMES['bernard']);
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
      expect(getTheme()).toBe(THEMES['forest']);
      expect(getActiveThemeKey()).toBe('forest');
    });

    it('does not change active theme when invalid', () => {
      setTheme('ocean');
      setTheme('bogus');
      expect(getActiveThemeKey()).toBe('ocean');
      expect(getTheme()).toBe(THEMES['ocean']);
    });
  });

  describe('getThemeKeys', () => {
    it('returns all 6 theme keys', () => {
      const keys = getThemeKeys();
      expect(keys).toHaveLength(6);
      expect(keys).toContain('bernard');
      expect(keys).toContain('ocean');
      expect(keys).toContain('forest');
      expect(keys).toContain('synthwave');
      expect(keys).toContain('high-contrast');
      expect(keys).toContain('colorblind');
    });
  });

  describe('theme structure', () => {
    const requiredColorFns: (keyof Theme)[] = [
      'accent',
      'accentBold',
      'muted',
      'text',
      'toolCall',
      'error',
      'success',
      'dim',
      'warning',
    ];

    const requiredAnsiKeys: (keyof Theme['ansi'])[] = [
      'prompt',
      'hintCmd',
      'hintDesc',
      'warning',
      'reset',
    ];

    for (const key of getThemeKeys()) {
      describe(`theme "${key}"`, () => {
        const theme = THEMES[key];

        it('has a name string', () => {
          expect(typeof theme.name).toBe('string');
          expect(theme.name.length).toBeGreaterThan(0);
        });

        for (const fn of requiredColorFns) {
          it(`has ${fn} as a function`, () => {
            expect(typeof theme[fn]).toBe('function');
          });
        }

        it('has prefixColors as a non-empty array', () => {
          expect(Array.isArray(theme.prefixColors)).toBe(true);
          expect(theme.prefixColors.length).toBeGreaterThan(0);
        });

        for (const ansiKey of requiredAnsiKeys) {
          it(`has ansi.${ansiKey} as a string`, () => {
            expect(typeof theme.ansi[ansiKey]).toBe('string');
            expect(theme.ansi[ansiKey].length).toBeGreaterThan(0);
          });
        }
      });
    }
  });
});
