import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
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
    // Matched as an assignment, not a substring: `html` alone is satisfied by
    // any `innerHTML`-adjacent token in 13 KB of minified code.
    for (const name of ['html', 'render', 'useState', 'useEffect']) {
      expect(script, `missing ${name}`).toMatch(new RegExp(`\\b${name}\\s*[=:]`));
    }
  });

  it('serves the bytes npm resolved, so an upgrade cannot silently not arrive', () => {
    // Asserted INDEPENDENTLY of how `uiRuntimePath` computes it. Re-deriving
    // the join here made the second half a tautology: a wrong `..` moved both
    // sides together and the test still passed.
    const resolved = uiRuntimePath();
    expect(resolved).toContain(`node_modules${path.sep}htm${path.sep}`);
    expect(fs.existsSync(resolved)).toBe(true);
    expect(script).toBe(fs.readFileSync(resolved, 'utf-8'));
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
