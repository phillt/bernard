import { ICON_PATHS, LUCIDE_VERSION } from './icon-data.js';

/**
 * The icon set an applet draws with (#610 §3).
 *
 * Before this there was none. The only SVG in the tree was `appletIcon()`, a
 * generated letter for the PWA install, so a model building an applet had no
 * vocabulary to reach for and every applet shipped as unadorned text.
 *
 * ## Inline SVG, served from our own origin
 *
 * The CSP decides the delivery and leaves almost no choice. `default-src
 * 'none'` with `style-src 'self'` and no `'unsafe-inline'` rules out every
 * icon font delivered the usual way (a CDN stylesheet) and everything that
 * injects a `<style>` at runtime. What remains is markup the page already
 * holds — which is also the fastest option, needs no second request, and
 * inherits `currentColor` so an icon is the colour of the text it sits in
 * rather than a hard-coded hex the theme cannot reach.
 *
 * It needs NO CSP grant: the markup is inline, so `img-src` is never
 * consulted. That is what makes icons the cheap part of #610 — the component
 * and CSS halves of that ticket are genuinely constrained; this one is not.
 *
 * ## One family, one weight
 *
 * Lucide, ISC, 24x24, `stroke-width: 2`, round caps and joins, throughout.
 * The wrapper below owns viewBox, stroke and size, and the generator refuses
 * an icon that carries its own — so a mixed-weight set is not something an
 * author can produce by accident. Mixing filled, outlined and geometric icons
 * is the single fastest way to make a UI feel unfinished, and it is precisely
 * the kind of drift nobody notices one icon at a time.
 *
 * ## Three sizes and no others
 *
 * 16 for dense controls, 20 for ordinary buttons and navigation, 24 for a
 * prominent action. A free pixel value is how a set ends up with a 17px icon
 * beside an 18px one, so the API takes a NAME. Anything unrecognised falls to
 * `md` rather than throwing: an icon is decoration on top of a working
 * control, and a page that dies because of one is a worse outcome than a
 * slightly wrong size.
 */

/**
 * There is deliberately no `/__bernard/icons.js` route.
 *
 * The set rides in `applet.js`, which `page-validate` already REFUSES a page
 * for omitting — so icons cannot be reached for and found missing. A second
 * script tag would be one more thing a generating model forgets, and the
 * whole reason the SDK is served rather than vendored is that a page which
 * gets the plumbing wrong fails opaquely. 8 KB on every applet is the price
 * of that, and it is the right one.
 */

/** 16 dense, 20 ordinary, 24 prominent. Named, never a raw pixel value. */
export const ICON_SIZES = Object.freeze({ sm: 16, md: 20, lg: 24 });
export type IconSize = keyof typeof ICON_SIZES;

/** Every name an applet may use. */
export const ICON_NAMES: readonly string[] = Object.freeze(Object.keys(ICON_PATHS).sort());

export { LUCIDE_VERSION };

/** True when `name` is one an applet may draw. */
export function isIconName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ICON_PATHS, name);
}

// There is deliberately no server-side renderer here. The one renderer of an
// icon's markup is `icon()` inside the served `applet.js` (`sdk.ts`), which is
// what a page actually runs; a TypeScript twin of it was written once, had no
// production caller, and held the a11y rule — hidden from assistive tech
// unless titled — in a second place that could drift from the one that ships.
// `icons.test.ts` asserts against the served bytes instead.
