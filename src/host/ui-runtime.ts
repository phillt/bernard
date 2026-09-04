import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `/__bernard/ui.js` — Preact + htm, for the applets that need a runtime (#466).
 *
 * ## Why this one, and why the others are out
 *
 * The applet CSP is `script-src 'self' 'unsafe-inline'` with **no**
 * `'unsafe-eval'`, `style-src 'self'` with no inline, and there is no build
 * step. That is not a preference, it eliminates most of the field — and the
 * eliminations were verified in the shipped bundles rather than taken from
 * docs:
 *
 * - **Vue 3's full global build calls `Function(l)()`** in `compileToFunction`.
 *   Its runtime-only build is clean but has no template compiler, so it needs
 *   the build step we do not have, at 41 KB.
 * - **Alpine** hides the same constructor behind
 *   `Object.getPrototypeOf(async function(){}).constructor`, so grepping for
 *   `new Function` misses it; its own docs concede it violates
 *   `'unsafe-eval'`. `@alpinejs/csp` gives up arrow functions, template
 *   literals, property assignment and globals.
 * - **Shoelace is end-of-life**, and its successor shipped four components
 *   emitting inline `style="…"` — this exact policy failing in the wild.
 *
 * **htm and Preact contain no dynamic code evaluation at all.** htm is a
 * tagged-template parser: it walks the template strings array at runtime and
 * builds a vdom tree. `ui-runtime.test.ts` asserts that against the bytes this
 * module actually serves, so an upgrade that introduced `eval` would fail here
 * rather than at a browser that silently refuses to run it.
 *
 * ## Resolved through npm, not vendored
 *
 * `sdk.ts` and `tokens.ts` are template literals because they are ours and
 * short. Its stated reason — "a real file would add a `readFileSync`, a
 * `package.json` files entry and a dependency on the dist layout for no gain" —
 * inverts for 13 KB of third-party source: pasting it in means re-pasting it on
 * every upgrade, and the licence stops being visible where licences live.
 *
 * `createRequire(...).resolve` rather than a build-time copy, which is what an
 * earlier cut planned: resolution works identically under `tsx` in development
 * and in a global install, so there is no dist layout to depend on and no copy
 * step to forget. The same idiom `permissions/shell-ast.ts` and `apps/store.ts`
 * already use.
 */

/** Where a page loads the runtime from. */
export const UI_RUNTIME_PATH = '/__bernard/ui.js';

/** The global the UMD bundle attaches: `html`, `render`, `h`, and the hooks. */
export const UI_RUNTIME_GLOBAL = 'htmPreact';

/** The bundle, relative to htm's package root. Exported so the test agrees. */
export const UI_RUNTIME_FILE = 'preact/standalone.umd.js';

let cached: string | undefined;

/**
 * The bundle's bytes.
 *
 * Read on first request rather than at module load: a process that never serves
 * an applet — every `bernard script`, every cron run — should not pay a 13 KB
 * synchronous read for a route it will not answer.
 */
export function uiRuntimeScript(): string {
  return (cached ??= fs.readFileSync(uiRuntimePath(), 'utf-8'));
}

/**
 * Resolves the installed bundle. Throws if the dependency is missing.
 *
 * Resolved from htm's main entry and walked up, rather than asking for the
 * subpath directly: htm's `exports` map covers `./preact/standalone` (the CJS
 * and ESM builds) but reaches the UMD file only through the deprecated `"./"`
 * catch-all, which modern Node refuses with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 * The UMD build is the one that works as a classic `<script src>`, so it is the
 * one we want.
 */
export function uiRuntimePath(): string {
  const entry = createRequire(import.meta.url).resolve('htm');
  return path.join(path.dirname(entry), '..', UI_RUNTIME_FILE);
}

/** Test seam: forget the memoised bytes. */
export function resetUiRuntimeCache(): void {
  cached = undefined;
}
