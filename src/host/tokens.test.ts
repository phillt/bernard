import { describe, it, expect } from 'vitest';
import { APPLET_COLOR_TOKENS, tokensStylesheet, TOKENS_PATH } from './tokens.js';
import { getThemeColors, setTheme, DEFAULT_THEME } from '../theme.js';

describe('applet design tokens (#424)', () => {
  it('serves every declared token', () => {
    const css = tokensStylesheet();
    for (const [name, value] of Object.entries(APPLET_COLOR_TOKENS)) {
      expect(css).toContain(`${name}: ${value};`);
    }
  });

  /**
   * `--accent` is the one token that already spanned the TUI and the web
   * before this existed — `bernard.accent` in `src/theme.ts` and `--accent` in
   * all four `docs/*.html` are the same orange. Pinning it means a change to
   * one is a visible decision about the other rather than a silent divergence.
   */
  it('shares its accent with the bernard TUI theme', () => {
    setTheme(DEFAULT_THEME);
    expect(getThemeColors().accent).toBe(APPLET_COLOR_TOKENS['--accent']);
  });

  it('lives in the host-reserved namespace, so it cannot shadow an applet file', () => {
    expect(TOKENS_PATH.startsWith('/__bernard/')).toBe(true);
  });

  // A floor, not a framework: an applet that styles nothing still looks like
  // one product, which is what lets `style-src` refuse inline CSS.
  it('styles the elements a generated applet actually uses', () => {
    const css = tokensStylesheet();
    for (const selector of ['body', 'button', 'input', 'pre']) {
      expect(css).toMatch(new RegExp(`(^|[,\\s])${selector}[\\s,{]`, 'm'));
    }
  });
});
