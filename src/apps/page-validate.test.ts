import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { validateAppletPage, refusalFor, warningsFor } from './page-validate.js';
import { defaultAppletPage } from './page-template.js';
import type { RawAppAction } from './manifest.js';

const OK = [
  '<title>T</title>',
  '<link rel="stylesheet" href="/__bernard/tokens.css" />',
  '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
  '<script src="/__bernard/applet.js"></script>',
  '<main><button id="go">Go</button></main>',
  "<script>document.getElementById('go').onclick = () => bernard.invoke('hello');</script>",
].join('\n');

const refusals = (html: string, actions: string[] = ['hello']) =>
  validateAppletPage(html, actions).filter((i) => i.level === 'refuse');

describe('validateAppletPage', () => {
  it('passes a page that meets the contract', () => {
    expect(validateAppletPage(OK, ['hello'])).toEqual([]);
    expect(refusalFor([])).toBeNull();
  });

  it('refuses a page that omits the client — the 403 this exists to prevent', () => {
    const out = refusals(OK.replace('<script src="/__bernard/applet.js"></script>', ''));
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain('/__bernard/applet.js');
  });

  it('refuses a hand-rolled protocol call even when the client IS loaded', () => {
    // The load-bearing check. Serving the client makes the protocol impossible
    // to get wrong; only refusing the alternative makes it the ONLY door, and
    // the CSP cannot do that for scripts the way it does for styles.
    const out = refusals(`${OK}\n<script>fetch('/__bernard/invoke', {method:'POST'})</script>`);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain('bernard.invoke');
  });

  it('refuses a page setting the session header itself', () => {
    expect(refusals(`${OK}\n<script>h['x-bernard-token'] = t;</script>`)).toHaveLength(1);
  });

  it('refuses an inline <style>, which the CSP discards in silence', () => {
    const out = refusals(`${OK}\n<style>body{color:red}</style>`);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain('silently');
  });

  it('refuses a page missing either required link', () => {
    expect(refusals(OK.replace(/<link rel="stylesheet"[^>]*>/, ''))).toHaveLength(1);
    expect(refusals(OK.replace(/<link rel="manifest"[^>]*>/, ''))).toHaveLength(1);
  });

  it('refuses a page invoking an action the applet does not declare', () => {
    const out = refusals(OK, ['something-else']);
    expect(out.some((i) => i.message.includes('"hello"'))).toBe(true);
  });

  it('does not demand the client of a page with no actions', () => {
    // A static applet is a legitimate thing; requiring a client it never calls
    // would be ceremony, not safety.
    const staticPage = OK.replace('<script src="/__bernard/applet.js"></script>', '').replace(
      /<script>document[\s\S]*<\/script>/,
      '',
    );
    expect(refusals(staticPage, [])).toEqual([]);
  });

  it('reports every problem at once, not the first', () => {
    // A model that fixes one and resubmits burns a turn per defect.
    const out = refusals('<h1>nothing</h1>');
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(refusalFor(out)).toContain('3 problem(s)');
  });

  it('warns rather than refuses where the fact is uncertain', () => {
    // The boundary is CERTAINTY, not severity: the element may be created at
    // runtime, so this must not block a write.
    const issues = validateAppletPage(`${OK}\n<script>getElementById('nope')</script>`, ['hello']);
    expect(issues.filter((i) => i.level === 'refuse')).toEqual([]);
    expect(warningsFor(issues)).toContain('nope');
  });
});

describe('defaultAppletPage', () => {
  const actions: Record<string, RawAppAction> = {
    hello: {
      description: 'Say hello',
      args: { who: { type: 'string', required: false } },
      dispatch: { kind: 'agent', specialistId: 'x', instructions: 'y' },
      toolAllowlist: [],
      toolMode: 'read-only',
      confirmMode: 'auto',
    } as unknown as RawAppAction,
  };

  it('passes the validator it exists to satisfy', () => {
    // The fixture that keeps the rule and the example from disagreeing — the
    // same anti-drift argument as serving the stylesheet rather than copying it.
    expect(validateAppletPage(defaultAppletPage('T', 'd', actions), ['hello'])).toEqual([]);
  });

  it('renders a control per action and an input per declared arg', () => {
    const html = defaultAppletPage('T', undefined, actions);
    expect(html).toContain('id="run-hello"');
    expect(html).toContain('id="arg-hello-who"');
  });

  it('escapes manifest text, which is user-editable on disk', () => {
    const html = defaultAppletPage('<img src=x onerror=alert(1)>', undefined, {});
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('the bundled demo', () => {
  it('satisfies the same rules a generated page is held to', () => {
    // It is the one worked example. If it can break the rule, the rule is a
    // suggestion — and the next generated page copies whatever it does.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const html = fs.readFileSync(
      path.join(here, '..', 'builtin-apps', 'demo', 'index.html'),
      'utf-8',
    );
    expect(validateAppletPage(html, ['search', 'web_answer'])).toEqual([]);
  });
});
