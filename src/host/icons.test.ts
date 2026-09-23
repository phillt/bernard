import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as vm from 'node:vm';
import { ICON_NAMES, ICON_SIZES, isIconName, LUCIDE_VERSION } from './icons.js';
import { ICON_PATHS } from './icon-data.js';
import { appletSdkScript } from './sdk.js';
import { APPLET_STYLED_SELECTORS, tokensStylesheet } from './tokens.js';

/**
 * The icon set (#610 §3).
 *
 * Before this there was none, and the gap was invisible: the three applet
 * prompts never mentioned icons, so a model had no vocabulary to reach for
 * and every applet shipped as unadorned text. Nobody had to decide against
 * icons for that to happen.
 */
/**
 * The renderer a page actually runs, loaded from the served client. There is
 * no TypeScript twin to test against — one was written and it held the a11y
 * rule in a second place — so these assert against the bytes that ship.
 */
const icon = ((): ((name: string, opts?: unknown) => string) => {
  const ctx: Record<string, unknown> = {
    window: {},
    addEventListener() {},
    document: { getElementById: () => null },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  };
  vm.createContext(ctx);
  new vm.Script(appletSdkScript()).runInContext(ctx);
  return (ctx.window as { bernard: { icon: (n: string, o?: unknown) => string } }).bernard.icon;
})();

describe('the served icon set', () => {
  it('is one family at one weight, with the wrapper owning every dimension', () => {
    // The property the whole set is chosen for. Mixed stroke weights or a
    // stray viewBox is not a thing a reader reports as a bug — it just looks
    // unfinished — so it is asserted rather than eyeballed.
    for (const name of ICON_NAMES) {
      const svg = icon(name);
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain('stroke-width="2"');
      expect(svg).toContain('stroke="currentColor"');
      // A per-icon override would silently win over the wrapper.
      expect(ICON_PATHS[name]).not.toMatch(/stroke-width=/);
      expect(ICON_PATHS[name]).not.toMatch(/<svg/i);
    }
  });

  it('draws in currentColor, so it themes for free and needs no palette entry', () => {
    // The floor's own rule is "never a hex value". An icon set that carried
    // its own colours would be the largest possible violation of it.
    for (const name of ICON_NAMES) {
      expect(ICON_PATHS[name]).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it('offers three named sizes and nothing else', () => {
    // A free pixel value is how a set ends up with a 17px icon beside an
    // 18px one, which is the drift the named scale exists to prevent.
    expect(ICON_SIZES).toEqual({ sm: 16, md: 20, lg: 24 });
    expect(icon('search', { size: 'sm' })).toContain('width="16"');
    expect(icon('search', { size: 'lg' })).toContain('width="24"');
    // Unrecognised falls back rather than throwing: an icon is decoration on
    // a control that already works.
    expect(icon('search', { size: 'enormous' })).toContain('width="20"');
  });

  it('hides itself from assistive tech unless it is given a label', () => {
    // The common case is an icon beside its own text, where announcing it
    // reads as a stutter. An icon-ONLY control must pass a title, and the
    // planners are told to demand one there.
    expect(icon('search')).toContain('aria-hidden="true"');
    expect(icon('search')).not.toContain('role="img"');
    const titled = icon('search', { title: 'Search readings' });
    expect(titled).toContain('role="img"');
    expect(titled).toContain('aria-label="Search readings"');
    expect(titled).not.toContain('aria-hidden');
  });

  it('escapes a caller-supplied title', () => {
    // `title` is the one input here that is not ours — it comes from a page
    // attribute, and this markup is written straight into the DOM.
    const svg = icon('search', { title: '"><script>x</script>' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('renders nothing for a name it does not have, rather than throwing', () => {
    expect(icon('definitely-not-an-icon')).toBe('');
    expect(isIconName('definitely-not-an-icon')).toBe(false);
    expect(isIconName('search')).toBe(true);
    // `hasOwnProperty`, not `in`: a bare `ICON_PATHS[name]` lookup would
    // answer for `constructor` and `toString` and emit prototype junk.
    expect(isIconName('constructor')).toBe(false);
    expect(icon('toString')).toBe('');
  });

  it('covers the actions an applet actually has', () => {
    // Curated, not exhaustive — 2,112 names is a catalogue nobody can hold in
    // a prompt. But a set missing `trash-2` or `search` would send an author
    // to another family, which is the one thing the set exists to prevent.
    for (const need of ['search', 'plus', 'trash-2', 'pencil', 'check', 'x', 'settings']) {
      expect(ICON_NAMES).toContain(need);
    }
  });
});

describe('how the set reaches a page', () => {
  it('rides in the SDK, so it cannot be reached for and found missing', () => {
    // There is deliberately no second script tag. `page-validate` refuses a
    // page that omits `applet.js`, so icons are present by the same guarantee
    // that makes `bernard.invoke` present.
    const sdk = appletSdkScript();
    expect(sdk).toContain('icon: icon');
    expect(sdk).toContain('data-icon');
    for (const name of ['search', 'trash-2', 'circle-check']) {
      expect(sdk).toContain(JSON.stringify(name));
    }
  });

  it('needs no CSP grant, which is what makes icons the cheap part of #610', () => {
    // Inline markup, so `img-src` is never consulted and `style-src` has
    // nothing to discard. No `<img>`, no `url(`, no external reference.
    const sdk = appletSdkScript();
    expect(sdk).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    for (const name of ICON_NAMES) {
      expect(ICON_PATHS[name]).not.toMatch(/url\(|href=|xlink/i);
    }
  });

  it('is styled by the floor, and the record knows it', () => {
    // `.icon` is a served class like any other, so it is bound by the
    // both-directions record check in `tokens.test.ts` rather than being a
    // class the sheet styles and nothing advertises.
    expect(APPLET_STYLED_SELECTORS).toContain('.icon');
    expect(tokensStylesheet()).toContain('.icon');
  });
});

/**
 * The committed data against the installed package.
 *
 * `src/host/icon-data.ts` is generated and checked in, because `lucide-static`
 * is 65 MB for 2,112 icons and an applet needs about fifty — putting that in
 * `dependencies` makes every user install 65 MB to draw a magnifying glass.
 * The cost of committing it is that it can rot, so this is the thing that
 * stops it doing so silently.
 */
describe('the committed subset against lucide-static', () => {
  const require = createRequire(import.meta.url);
  let pkgRoot: string | null = null;
  try {
    pkgRoot = path.dirname(require.resolve('lucide-static/package.json'));
  } catch {
    pkgRoot = null;
  }

  it.runIf(pkgRoot)('matches the upstream markup exactly', () => {
    const { version } = JSON.parse(
      fs.readFileSync(path.join(pkgRoot!, 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(
      LUCIDE_VERSION,
      `lucide-static is ${version} but the committed data says ${LUCIDE_VERSION}. ` +
        'Run `npm run generate-icons`.',
    ).toBe(version);

    for (const name of ICON_NAMES) {
      const raw = fs.readFileSync(path.join(pkgRoot!, 'icons', `${name}.svg`), 'utf-8');
      const body = raw
        .slice(raw.indexOf('>', raw.indexOf('<svg')) + 1, raw.lastIndexOf('</svg>'))
        .replace(/\s+/g, ' ')
        .trim();
      expect(ICON_PATHS[name], `${name} drifted from upstream`).toBe(body);
    }
  });

  it.runIf(pkgRoot)('names only icons the package actually ships', () => {
    // The direction the mistake is made in: adding a name to the generator's
    // list that upstream renamed. Lucide does rename — `alert-circle` became
    // `circle-alert` — so a stale name is a plausible edit, and it would
    // render as nothing with no error.
    for (const name of ICON_NAMES) {
      expect(
        fs.existsSync(path.join(pkgRoot!, 'icons', `${name}.svg`)),
        `${name} is not in lucide-static`,
      ).toBe(true);
    }
  });
});
