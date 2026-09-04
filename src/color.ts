/**
 * Colour arithmetic, so a contrast claim can be checked rather than argued
 * (#465).
 *
 * A pure leaf — no imports, no I/O — following `src/text.ts`. Two consumers
 * sit in different packages (`src/host/tokens.test.ts` proves the served floor
 * meets WCAG, `src/apps/page-validate.ts` names the nearest token in a
 * warning), so a top-level leaf is the neutral home.
 *
 * Nothing like this existed. That is the opportunity as much as the cost:
 * contrast is the one design property that is decidable — arithmetic over two
 * colours — where hierarchy, balance and rhythm are not. Everything checkable
 * moves here; everything else stays an opinion and is labelled as one.
 */

/** A colour with straight (non-premultiplied) alpha, channels 0-255, alpha 0-1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Parses the CSS colour forms Bernard's own artefacts use.
 *
 * **Returns `null` for anything it does not understand** — a named colour
 * (`red`), a `color-mix()`, a `var()`, garbage. That null is the honesty
 * boundary of this module: a caller must handle it rather than receive a
 * plausible number for a colour nobody parsed. `page-validate.ts` uses it to
 * stay silent rather than guess, and the token test uses it to fail loudly.
 */
export function parseColor(css: string): Rgba | null {
  const raw = css.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,8})$/.exec(raw);
  if (hex) {
    const h = hex[1];
    const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16);
    if (h.length === 3 || h.length === 4) {
      return {
        r: expand(h[0]),
        g: expand(h[1]),
        b: expand(h[2]),
        a: h.length === 4 ? expand(h[3]) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: expand(h.slice(0, 2)),
        g: expand(h.slice(2, 4)),
        b: expand(h.slice(4, 6)),
        a: h.length === 8 ? expand(h.slice(6, 8)) / 255 : 1,
      };
    }
    // 5 or 7 digits: a typo, not a colour.
    return null;
  }

  // `rgb(1,2,3)`, `rgba(1,2,3,.5)` and the space-separated `rgb(1 2 3 / 50%)`
  // form, which is what a modern generator is as likely to emit.
  const fn = /^rgba?\(([^)]*)\)$/.exec(raw);
  if (!fn) return null;
  const [rgbPart, alphaPart] = fn[1].split('/');
  const parts = rgbPart
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const channel = (s: string): number | null => {
    const pct = s.endsWith('%');
    const n = Number.parseFloat(pct ? s.slice(0, -1) : s);
    if (!Number.isFinite(n)) return null;
    return clamp(pct ? (n / 100) * 255 : n, 0, 255);
  };
  const [r, g, b] = [channel(parts[0]), channel(parts[1]), channel(parts[2])];
  if (r === null || g === null || b === null) return null;
  const alphaText = (alphaPart ?? parts[3])?.trim();
  let a = 1;
  if (alphaText !== undefined) {
    const pct = alphaText.endsWith('%');
    const n = Number.parseFloat(pct ? alphaText.slice(0, -1) : alphaText);
    if (!Number.isFinite(n)) return null;
    a = clamp(pct ? n / 100 : n, 0, 1);
  }
  return { r, g, b, a };
}

/** WCAG 2.x relative luminance. Alpha is ignored — composite first. */
export function relativeLuminance(color: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b);
}

/**
 * WCAG contrast between two opaque colours, 1–21.
 *
 * Returns `null` when either colour cannot be parsed or carries alpha —
 * a translucent colour has no ratio of its own, and silently treating it as
 * opaque is how a checker reports a pass it did not measure. Use
 * {@link contrastOver} for those.
 */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb || ca.a !== 1 || cb.a !== 1) return null;
  const [hi, lo] = [relativeLuminance(ca), relativeLuminance(cb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Paints `over` onto `onto` (source-over), returning an opaque colour. */
export function composite(over: Rgba, onto: Rgba): Rgba {
  const mix = (o: number, u: number) => o * over.a + u * (1 - over.a);
  return { r: mix(over.r, onto.r), g: mix(over.g, onto.g), b: mix(over.b, onto.b), a: 1 };
}

/**
 * Contrast of `color` against a stack of layers, flattened bottom-last.
 *
 * `contrastOver('#e6edf3', ['rgba(249,115,22,0.15)', '#0d1117'])` is text on a
 * dim accent fill on the page background.
 *
 * Returns `null` when the BOTTOM layer is itself translucent: what is beneath
 * it is a fact about a paint stack this module cannot see, and inventing an
 * opaque backdrop would be measuring something that is not on screen.
 */
export function contrastOver(color: string, layers: string[]): number | null {
  if (layers.length === 0) return null;
  const parsed = layers.map(parseColor);
  if (parsed.some((p) => p === null)) return null;
  const stack = parsed as Rgba[];
  if (stack[stack.length - 1].a !== 1) return null;
  let backdrop = stack[stack.length - 1];
  for (let i = stack.length - 2; i >= 0; i--) backdrop = composite(stack[i], backdrop);
  const fg = parseColor(color);
  if (!fg) return null;
  const flat = fg.a === 1 ? fg : composite(fg, backdrop);
  const [hi, lo] = [relativeLuminance(flat), relativeLuminance(backdrop)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * OKLab coordinates, for perceptual distance.
 *
 * Björn Ottosson's matrices. Used only by {@link nearestToken}, and only
 * because sRGB-Euclidean distance is wrong on the case that matters: it maps
 * `#f85149` — the exact red Bernard itself hard-coded — to `--accent` (an
 * orange) rather than to `--danger`. A suggestion that names the wrong token
 * is worse than none, because it will be taken.
 */
function oklab(c: Rgba): [number, number, number] {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * The palette entry closest to `hex`, or `null` if nothing parses.
 *
 * A **hint in a warning**, never an input to a refusal: the point is that
 * "use `--danger`" is actionable where "avoid hex colours" is not. The caller
 * must word it as the closest token rather than the right one — this function
 * knows nothing about what the colour was for.
 */
export function nearestToken(hex: string, palette: Record<string, string>): string | null {
  const target = parseColor(hex);
  if (!target) return null;
  const t = oklab(target);
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const [name, value] of Object.entries(palette)) {
    const candidate = parseColor(value);
    // A translucent token has no fixed appearance, so it is not a suggestion.
    if (!candidate || candidate.a !== 1) continue;
    const c = oklab(candidate);
    const d = (t[0] - c[0]) ** 2 + (t[1] - c[1]) ** 2 + (t[2] - c[2]) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  return best;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
