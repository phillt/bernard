import { describe, it, expect, beforeEach } from 'vitest';
import {
  THEMES,
  DEFAULT_THEME,
  setTheme,
  getThemeKeys,
  getActiveThemeKey,
  getThemeColors,
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
