import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import {
  UI_RUNTIME_FILE,
  UI_RUNTIME_GLOBAL,
  UI_RUNTIME_PATH,
  uiRuntimePath,
  uiRuntimeScript,
} from './ui-runtime.js';

describe('the served UI runtime (#466)', () => {
  const script = uiRuntimeScript();

  it('contains no dynamic code evaluation, asserted on the bytes it serves', () => {
    // The whole reason this library was chosen over Vue, Alpine and Shoelace.
    // `script-src` has no `'unsafe-eval'`, so an upgrade that introduced
    // `Function` would break every applet at the browser, silently from the
    // agent's side. Note Alpine hides the same constructor behind
    // `Object.getPrototypeOf(async function(){}).constructor`, so this checks
    // the indirect spelling too.
    expect(script).not.toMatch(/\beval\s*\(/);
    expect(script).not.toMatch(/\bnew\s+Function\b/);
    expect(script).not.toMatch(/[^.\w]Function\s*\(/);
    expect(script).not.toContain('async function(){}).constructor');
  });

  it('is a classic script that attaches its global, not an ES module', () => {
    // `type="module"` is always deferred, so a page's own inline script would
    // run first and the global would be undefined — the same trap `sdk.ts`
    // records for the client.
    expect(script).not.toMatch(/^\s*export\s/m);
    expect(script).toContain(UI_RUNTIME_GLOBAL);
  });

  it('exposes the API a page actually needs', () => {
    for (const name of ['html', 'render', 'useState', 'useEffect']) {
      expect(script, `missing ${name}`).toContain(name);
    }
  });

  it('serves the bytes npm resolved, so an upgrade cannot silently not arrive', () => {
    const entry = createRequire(import.meta.url).resolve('htm');
    const resolved = path.join(path.dirname(entry), '..', UI_RUNTIME_FILE);
    expect(script).toBe(fs.readFileSync(resolved, 'utf-8'));
    expect(uiRuntimePath()).toBe(resolved);
  });

  it('stays small enough to serve uncached on every load', () => {
    // Every response carries `Cache-Control: no-store`, so this is re-sent on
    // each page load. It is loopback, but the number is worth pinning: a
    // tenfold jump on an upgrade should be a decision, not a surprise.
    expect(script.length).toBeLessThan(40_000);
  });

  it('is served under the reserved namespace', () => {
    expect(UI_RUNTIME_PATH.startsWith('/__bernard/')).toBe(true);
  });
});
