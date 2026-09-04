import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `/__bernard/ui.js` — Preact + htm, for the applets that need a runtime (#466).
 *
 * **Why this one:** the CSP has no `'unsafe-eval'`, which eliminates most of
 * the field — Vue's full build, Alpine, and (for inline `style=` attributes in
 * its own components) Shoelace. htm and Preact contain no dynamic evaluation at
 * all, asserted by `ui-runtime.test.ts` over the bytes this module serves, so
 * an upgrade that introduced `eval` fails here rather than at a browser that
 * silently declines to run it. The measurements behind those eliminations are
 * in CLAUDE.md; repeating them here would be a third copy.
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

/**
 * When a page should load the runtime, in one sentence.
 *
 * Two prompts state this rule — the `applet` tool's `page` description and
 * `applet-styler` — and nothing bound them, which is precisely the drift the
 * styled-selector record on this same branch exists to stop. A test asserts
 * both name it.
 */
export const UI_RUNTIME_RULE = 'a LIST that changes, or has more than about four controls';

/** The bundle, relative to htm's package root. */
const UI_RUNTIME_FILE = 'preact/standalone.umd.js';

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
  const resolved = path.join(path.dirname(entry), '..', UI_RUNTIME_FILE);
  // Checked, because the join assumes htm's `main` sits one directory down: if
  // that ever moved to the package root, `..` would address a SIBLING package
  // and this would serve whatever it found. Failing loudly here beats serving
  // the wrong bytes with a correct Content-Type.
  if (!fs.existsSync(resolved)) {
    throw new Error(`The applet UI runtime is missing at ${resolved}. Reinstall dependencies.`);
  }
  return resolved;
}
