import { APPLET_COLOR_TOKENS } from './tokens.js';
import type { AppManifest } from '../apps/manifest.js';

/**
 * The web app manifest and icon an applet is installed from (#429).
 *
 * Both are **generated**, not shipped. A static file in the asset directory
 * cannot know its own `start_url` — the port is assigned at runtime by
 * `HostRegistry` — and `AppManifest` has no icon field, which
 * `AppManifestSchema` being `.strict()` makes a schema-version decision rather
 * than a free addition. A letter on the accent colour costs nothing and is one
 * fewer thing a generated applet has to get right.
 *
 * **Whether install is actually offered is unverified.** `http://127.0.0.1` is
 * a potentially trustworthy origin, so the secure-context requirement should be
 * satisfied without TLS — but the applet CSP also sets a `sandbox` header, and
 * a sandboxed top-level document may not be installable. That header is #421's
 * and is not being relaxed on a guess. Serving a correct manifest costs nothing
 * either way; if a browser refuses, the fallback is a per-user shortcut file,
 * which is its own change.
 */

export const MANIFEST_PATH = '/__bernard/manifest.webmanifest';
export const ICON_PATH = '/__bernard/icon.svg';

export function webManifest(manifest: AppManifest, port: number): Record<string, unknown> {
  return {
    name: manifest.name,
    short_name: manifest.name.slice(0, 12),
    ...(manifest.description ? { description: manifest.description } : {}),
    // Absolute, because the installed app window navigates here from outside
    // any page context.
    start_url: `http://127.0.0.1:${port}/`,
    scope: '/',
    display: 'standalone',
    background_color: APPLET_COLOR_TOKENS['--bg'],
    theme_color: APPLET_COLOR_TOKENS['--accent'],
    icons: [
      // One SVG rather than the conventional 192/512 PNG pair: `purpose: any`
      // with a scalable type is accepted by Chromium's installability check,
      // and generating two rasters would mean shipping an encoder.
      { src: ICON_PATH, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}

/** A letter on the accent colour — identity with nothing for an author to choose. */
export function appletIcon(name: string): string {
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  const escaped = letter.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="96" fill="${APPLET_COLOR_TOKENS['--accent']}"/>
  <text x="256" y="256" fill="#ffffff" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif"
        font-size="288" font-weight="600" text-anchor="middle" dominant-baseline="central">${escaped}</text>
</svg>
`;
}
