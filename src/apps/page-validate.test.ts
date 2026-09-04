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

  it('refuses both inline-style forms, not just the block', () => {
    // They were split — block refused, attribute warned — while the comment
    // admitted the CSP discards both. Equally decidable, equally silent.
    expect(refusals(`${OK}\n<p style="color:red">x</p>`)).toHaveLength(1);
    expect(refusals(`${OK}\n<p STYLE = "color:red">x</p>`)).toHaveLength(1);
    expect(refusals(`${OK}\n<style>p{color:red}</style>`)).toHaveLength(1);
  });

  it('refuses a near-miss client path', () => {
    const wrongClient = OK.replace('/__bernard/applet.js', '/__bernard/appletxjs');
    const out = refusals(wrongClient);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain('/__bernard/applet.js');
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

describe('the client-script check is exact but not brittle', () => {
  const withSrc = (src: string) =>
    OK.replace('<script src="/__bernard/applet.js"></script>', `<script src="${src}"></script>`);

  it('accepts a cache-busted load', () => {
    // `server.ts` resolves its routes on `url.split('?')[0]`, so `?v=2` is a
    // legitimate load. Requiring a quote immediately after `.js` refuses it.
    expect(refusals(withSrc('/__bernard/applet.js?v=2'))).toEqual([]);
  });

  it('does not treat the dot as a wildcard', () => {
    // An unescaped `.` in the path matched any character, so a page loading
    // `appletXjs` — or nothing like the client at all — passed.
    expect(refusals(withSrc('/__bernard/appletXjs'))).toHaveLength(1);
    expect(refusals(withSrc('/__bernard/applet.js.evil'))).toHaveLength(1);
  });
});

/**
 * External links (#468).
 *
 * The failure these describe is invisible: the sandbox header grants no
 * navigation token, so a click on an external link does nothing at all — no
 * error, no console entry — and the page reads as broken rather than as
 * unpermitted.
 */
describe('external links', () => {
  const page = (body: string) =>
    [
      '<link rel="stylesheet" href="/__bernard/tokens.css" />',
      '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
      '<script src="/__bernard/applet.js"></script>',
      body,
    ].join('\n');

  it('warns that a click will do nothing when no link permission is declared', () => {
    const issues = validateAppletPage(page('<a href="https://example.com/story">Story</a>'), []);
    const warning = issues.find((i) => i.message.includes('will do'));
    expect(warning?.level).toBe('warn');
    expect(warning?.message).toContain('sandbox');
  });

  it('says nothing once the applet declares it', () => {
    const issues = validateAppletPage(page('<a href="https://example.com/s">S</a>'), [], {
      declaresLinkPermission: true,
    });
    expect(issues.some((i) => i.message.includes('will do nothing'))).toBe(false);
  });

  it('leaves a same-origin link alone', () => {
    const issues = validateAppletPage(page('<a href="/about">About</a>'), []);
    expect(issues.some((i) => i.message.includes('will do nothing'))).toBe(false);
  });

  it('warns about a _blank link with no noopener, and not about one with it', () => {
    const bad = validateAppletPage(page('<a href="https://e.com" target="_blank">x</a>'), [], {
      declaresLinkPermission: true,
    });
    expect(bad.some((i) => i.message.includes('window.opener'))).toBe(true);
    const good = validateAppletPage(
      page('<a href="https://e.com" target="_blank" rel="noopener noreferrer">x</a>'),
      [],
      { declaresLinkPermission: true },
    );
    expect(good.some((i) => i.message.includes('window.opener'))).toBe(false);
  });

  it('never refuses a page for a link', () => {
    // Certainty, not severity: an external link is legitimate and whether the
    // author meant it to be clickable is not decidable from the string.
    const issues = validateAppletPage(page('<a href="https://e.com" target="_blank">x</a>'), []);
    expect(issues.every((i) => i.level === 'warn')).toBe(true);
  });
});

/**
 * Colour literals and the files shipped beside the page (#465).
 *
 * The levels here are the whole argument: a colour WARNS because the failure
 * is visible — an off-palette page still renders — while an unlinked or
 * off-origin stylesheet is REFUSED because it fails silently, which is the
 * property this module's inline-`<style>` refusals already turn on.
 */
describe('colour literals and shipped files', () => {
  const page = (body: string) =>
    [
      '<link rel="stylesheet" href="/__bernard/tokens.css" />',
      '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
      '<script src="/__bernard/applet.js"></script>',
      body,
    ].join('\n');

  it('warns about a hard-coded colour, and names the nearest token', () => {
    const issues = validateAppletPage(page('<p>hello</p><!--x--><div>#f85149</div>'), []);
    const colour = issues.find((i) => i.message.includes('sets colours directly'));
    expect(colour?.level).toBe('warn');
    // The remedy is what makes a warning act-on-able: "use --danger" gets
    // fixed, "avoid hex colours" does not.
    expect(colour?.message).toContain('--danger');
  });

  it('does not warn about a fragment link, an id, or a hex in a comment', () => {
    // The false-positive surface that disqualifies a refusal here.
    const clean = page('<a href="#a1b2c3">x</a><div id="deadbeef"></div><!-- #ffffff -->');
    expect(validateAppletPage(clean, []).some((i) => i.message.includes('sets colours'))).toBe(
      false,
    );
  });

  it('warns about the functional forms too, which are the obvious evasion', () => {
    const issues = validateAppletPage(page('<script>c="rgb(1,2,3)"</script>'), []);
    expect(issues.some((i) => i.message.includes('sets colours directly'))).toBe(true);
  });

  it('refuses a stylesheet the page never links — written, served, never loaded', () => {
    const issues = validateAppletPage(page('<p>x</p>'), [], {
      files: { 'app.css': 'p { color: var(--text); }' },
    });
    const refusal = issues.find((i) => i.message.includes('never links it'));
    expect(refusal?.level).toBe('refuse');
  });

  it('accepts a stylesheet the page does link', () => {
    const issues = validateAppletPage(
      page('<link rel="stylesheet" href="app.css" /><p>x</p>'),
      [],
      { files: { 'app.css': 'p { color: var(--text); }' } },
    );
    expect(issues).toEqual([]);
  });

  it('refuses an off-origin @import, which style-src drops with no error', () => {
    const issues = validateAppletPage(page('<link rel="stylesheet" href="app.css" />'), [], {
      files: { 'app.css': '@import url("https://cdn.example.com/x.css");' },
    });
    expect(issues.find((i) => i.message.includes('@imports'))?.level).toBe('refuse');
  });

  it('warns about a remote url(), which a grant can legalise', () => {
    // `img-src` is grantable per applet since #467, so this is conditionally
    // legal — a warning naming the command, not a refusal.
    const issues = validateAppletPage(page('<link rel="stylesheet" href="app.css" />'), [], {
      files: { 'app.css': 'body { background: url(https://cdn.example.com/x.png); }' },
    });
    const warning = issues.find((i) => i.message.includes('url()'));
    expect(warning?.level).toBe('warn');
    expect(warning?.message).toContain('bernard app csp');
  });

  it('warns about a hex inside a shipped stylesheet', () => {
    const issues = validateAppletPage(page('<link rel="stylesheet" href="app.css" />'), [], {
      files: { 'app.css': 'p { color: #ff0000; }' },
    });
    expect(issues.some((i) => i.message.includes('app.css') && i.level === 'warn')).toBe(true);
  });

  it('behaves exactly as before when no files are passed', () => {
    const body = '<p>x</p>';
    expect(validateAppletPage(page(body), [])).toEqual(
      validateAppletPage(page(body), [], { files: {} }),
    );
  });
});
