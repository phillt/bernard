import { describe, it, expect } from 'vitest';
import { APPLET_COLOR_TOKENS, tokensStylesheet, TOKENS_PATH } from './tokens.js';
import { contrastOver } from '../color.js';
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

/**
 * The floor meets WCAG AA, and a test says so (#465).
 *
 * Contrast is the one design property that is decidable — arithmetic over two
 * colours — where hierarchy, balance and rhythm are not. So it moves out of
 * prompt-space entirely: `applet-styler` can be told to compose from these
 * tokens because the tokens themselves are held to a threshold here, on the
 * served artefact, rather than asserted in an instruction nothing checks.
 */
describe('the served floor meets WCAG AA', () => {
  const sheet = tokensStylesheet();
  const rootBlock = sheet.slice(sheet.indexOf(':root'), sheet.indexOf('}'));
  const outsideRoot = sheet.slice(sheet.indexOf('}'));
  const t = (name: string) => {
    const value = APPLET_COLOR_TOKENS[name];
    if (!value) throw new Error(`no such token: ${name}`);
    return value;
  };

  /**
   * Palettes to hold to the table below.
   *
   * A list with one entry, deliberately: light mode (#465, deferred) arrives
   * as a `@media (prefers-color-scheme: light)` block, which appends an object
   * here and changes no assertion. That is what makes deferring it cheap.
   */
  const PALETTES = [{ name: 'dark', tokens: APPLET_COLOR_TOKENS }];

  it('has exactly one palette — the seam light mode slots into', () => {
    expect(PALETTES).toHaveLength(1);
  });

  /**
   * No colour literal outside `:root`.
   *
   * This is the assertion that would have caught both of the hexes that were
   * in this file: `#ffffff` on `button` and `#f85149` on `.error`. It is also
   * what makes the pair table below *sufficient* — a rule body cannot paint a
   * colour the table never measured.
   */
  it('paints no colour that is not a token', () => {
    expect(outsideRoot.match(/#[0-9a-f]{3,8}\b/gi)).toBeNull();
    expect(outsideRoot).not.toMatch(/\brgba?\(/);
  });

  it('declares every colour it uses in the record the table reads', () => {
    const inRoot = rootBlock.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    const declared = Object.values(APPLET_COLOR_TOKENS)
      .filter((v) => v.startsWith('#'))
      .map((v) => v.toLowerCase());
    expect([...inRoot].map((h) => h.toLowerCase()).sort()).toEqual([...declared].sort());
  });

  /**
   * Every pair that is painted, and the threshold it answers to.
   *
   * `[foreground, layers (bottom last), minimum, why]`. 4.5 is AA normal text;
   * 3.0 is 1.4.11 for a non-text UI boundary.
   */
  const PAIRS: [string, string[], number, string][] = [
    ['--text', ['--bg'], 4.5, 'body text'],
    ['--text', ['--surface'], 4.5, 'text on a panel'],
    ['--text-secondary', ['--bg'], 4.5, 'muted text'],
    ['--text-secondary', ['--surface'], 4.5, 'muted text on a panel'],
    // The defect #465 exists for, asserted against BOTH backgrounds so a
    // future `--surface` change cannot silently break it.
    ['--border', ['--bg'], 3.0, 'an input boundary on the page'],
    ['--border', ['--surface'], 3.0, 'an input boundary on a panel'],
    // One foreground token covers all five solid fills, which is why there
    // are no per-state companions.
    ['--accent-fg', ['--accent'], 4.5, 'button label'],
    ['--accent-fg', ['--danger'], 4.5, 'destructive button label'],
    ['--accent-fg', ['--success'], 4.5, 'success fill label'],
    ['--accent-fg', ['--warning'], 4.5, 'warning fill label'],
    ['--accent-fg', ['--info'], 4.5, 'info fill label'],
    ['--accent', ['--bg'], 3.0, 'the focus ring'],
    ['--danger', ['--bg'], 4.5, 'error text'],
    ['--danger', ['--surface'], 4.5, 'error text on a panel'],
    ['--success', ['--bg'], 4.5, 'success text'],
    ['--warning', ['--bg'], 4.5, 'warning text'],
    ['--info', ['--bg'], 4.5, 'info text'],
    // The alpha token is composited rather than waved through — a translucent
    // colour has no ratio of its own, and exempting it would be the one place
    // the table stopped meaning what it says.
    ['--text', ['--accent-dim', '--bg'], 4.5, 'text over a dim accent fill'],
    ['--text', ['--accent-dim', '--surface'], 4.5, 'the same fill on a panel'],
  ];

  it.each(PAIRS)('%s over %s clears %s:1 — %s', (fg, layers, min) => {
    const ratio = contrastOver(t(fg), layers.map(t));
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThanOrEqual(min);
  });

  /**
   * The row that makes the table self-maintaining.
   *
   * Walks the RECORD to the table, which is the direction the mistake is made
   * in — the same argument `bundled-manifest.test.ts` makes for walking the
   * files on disk to the constant. A new token forces either a row or a
   * written-down reason.
   */
  it('measures every colour token, or names why not', () => {
    const EXEMPT = new Set<string>();
    const covered = new Set(PAIRS.flatMap(([fg, layers]) => [fg, ...layers]));
    const unmeasured = Object.keys(APPLET_COLOR_TOKENS).filter(
      (name) => !covered.has(name) && !EXEMPT.has(name),
    );
    expect(unmeasured).toEqual([]);
  });

  it('serves the accessibility rules an applet cannot add for itself', () => {
    // `:focus-visible` and not just `:focus`: buttons had no ring at all, and
    // keyboard focus was indistinguishable from mouse focus.
    expect(sheet).toContain(':focus-visible');
    expect(sheet).toContain('prefers-reduced-motion');
    // Without this, native scrollbars and `<select>` popups render light.
    expect(sheet).toContain('color-scheme: dark');
  });

  it('is a pure function of module constants, so the memo cannot go stale', () => {
    expect(tokensStylesheet()).toBe(tokensStylesheet());
  });
});
