import { describe, it, expect } from 'vitest';
import { APPLET_COLOR_TOKENS, APPLET_SCALE_TOKENS, APPLET_STYLED_SELECTORS, TOKENS_PATH, tokensStylesheet } from './tokens.js';
import { contrastOver, HEX_LITERAL_RE } from '../color.js';
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
    expect(outsideRoot.match(HEX_LITERAL_RE)).toBeNull();
    expect(outsideRoot).not.toMatch(/\brgba?\(/);
  });

  it('declares every colour it uses in the record the table reads', () => {
    const inRoot = rootBlock.match(HEX_LITERAL_RE) ?? [];
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

  /**
   * The file's own rule, applied to the file.
   *
   * `tokens.ts` says a scale nothing in the floor uses is a framework rather
   * than a floor. That was a comment claiming something nothing checked — and
   * it was briefly false, with five tokens shipped ahead of any consumer. The
   * exemptions are named here so adding an unused token is a decision someone
   * writes down, not a thing that happens.
   */
  it('uses every token it declares, or names the exception', () => {
    const declared = [...sheet.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]);
    const body = sheet.slice(sheet.indexOf('}') + 1);
    const UNUSED_BY_DESIGN = new Set([
      // A tint for an author's own fill. Measured by the table above, over
      // both backgrounds, so it is covered even though the floor paints it
      // nowhere.
      '--accent-dim',
      // The two ends of the scales the floor never reaches for, kept so an
      // author is not pushed off-scale at the edges.
      '--space-1',
      '--text-xs',
    ]);
    const unused = declared.filter((d) => !body.includes(`var(${d})`) && !UNUSED_BY_DESIGN.has(d));
    expect(unused).toEqual([]);
  });
});

/**
 * The floor and the prompt that describes it, bound in both directions.
 *
 * `applet-styler.json` lists what is "already styled" so a model writes no CSS
 * in the common case. That list had drifted from the sheet by ten selectors,
 * with nothing to catch it — the same class of drift #424 built the served
 * stylesheet to end, one level up.
 */
describe('the styled-selector record tracks the sheet', () => {
  const sheet = tokensStylesheet();

  /** Selectors the sheet declares, read off the artefact rather than restated. */
  function declaredSelectors(css: string): string[] {
    const out = new Set<string>();
    // Rule heads only: a line ending in `{` that is not an at-rule.
    for (const line of css.split('\n')) {
      const m = /^([^{}@/*][^{}]*)\{/.exec(line.trim());
      if (!m) continue;
      for (const part of m[1].split(',')) {
        const sel = part.trim();
        if (sel) out.add(sel);
      }
    }
    return [...out];
  }

  /**
   * Selectors that are real but must not be advertised.
   *
   * `:root` and `*` are plumbing; the pseudo-classes are the focus contract an
   * applet is told NOT to override. Naming them in the prompt would invite
   * exactly the override #465 forbids.
   */
  const NOT_ADVERTISED = new Set([':root', '*', ':focus-visible', ':focus:not(:focus-visible)']);

  const declared = declaredSelectors(sheet);

  it('the record and the sheet name exactly the same selectors', () => {
    // BOTH directions. Sheet → record catches a rule added and not recorded,
    // which is the mistake actually made. Record → sheet catches a rule REMOVED
    // and left in the prompt, which nothing caught before and which ships the
    // model a class that no longer exists.
    //
    // Compared on the LEADING simple selector: `.cards > li` is reached through
    // `.cards`, and `button:hover` through `button`, so a prompt naming the
    // base has told the model everything it can act on.
    //
    // The record stays hand-written rather than derived from this parse, even
    // though the two sets are identical today. Deriving would move a CSS regex
    // into production, where a miss ships a wrong list to a model silently; as
    // a test it fails loudly instead. It also keeps the prompt's order curated
    // — structure, then text, then forms, then utilities — rather than
    // whatever order the sheet happens to declare things in.
    const base = (sel: string): string => sel.split(/[\s>+~:]/)[0];
    const fromSheet = new Set(declared.filter((sel) => !NOT_ADVERTISED.has(sel)).map(base));
    expect([...fromSheet].sort()).toEqual([...APPLET_STYLED_SELECTORS].sort());
  });

  it('finds a non-trivial number of selectors — a scan over nothing passes', () => {
    expect(declared.length).toBeGreaterThan(20);
  });
});

describe('the scale record (#465 follow-up)', () => {
  const sheet = tokensStylesheet();
  const root = sheet.slice(sheet.indexOf(':root {'), sheet.indexOf('\n}'));

  it('declares every scale token the record names, with the same value', () => {
    // Record → sheet. Catches a token named in the doc that the sheet stopped
    // serving: an applet writes `var(--space-3)` and gets nothing.
    for (const [name, value] of Object.entries(APPLET_SCALE_TOKENS)) {
      expect(root, `${name} missing`).toContain(`  ${name}: ${value};`);
    }
  });

  it('names every non-colour token the sheet declares', () => {
    // Sheet → record, the direction the mistake is made in. A scale token
    // added to the stylesheet and not to the record is one `applet-styling`
    // cannot document, which is exactly how the whole scale went unmentioned.
    const declared = [...root.matchAll(/^ {2}(--[a-z0-9-]+):/gm)].map((m) => m[1]);
    for (const name of declared) {
      if (name in APPLET_COLOR_TOKENS) continue;
      expect(APPLET_SCALE_TOKENS, `${name} is served but unrecorded`).toHaveProperty(name);
    }
  });

  it('keeps the two records disjoint, so a token has exactly one home', () => {
    for (const name of Object.keys(APPLET_SCALE_TOKENS)) {
      expect(APPLET_COLOR_TOKENS).not.toHaveProperty(name);
    }
  });
});
