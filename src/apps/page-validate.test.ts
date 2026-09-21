import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { validateAppletPage, refusalFor, warningsFor } from './page-validate.js';
import { defaultAppletPage } from './page-template.js';
import { ARG_TYPES } from './arg-types.js';
import type { RawAppAction } from './manifest.js';
import { contrastOver } from '../color.js';
import { APPLET_COLOR_TOKENS } from '../host/tokens.js';

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

  /**
   * Each type's control comes from its own entry in `ARG_TYPES` (#588), and
   * the page script decodes on one generic rule keyed to what the entry
   * declared.
   *
   * This also fixes a defect that predates nesting: `el.value` is always a
   * string, so a `number` argument was sent as `"5"` and a `boolean` as
   * whatever the user typed — both refused by the action's own schema, with a
   * scaffold that looked complete and a button that could not work.
   */
  it('renders a control the page can actually decode, per argument type', () => {
    const typed: Record<string, RawAppAction> = {
      go: {
        args: {
          text: { type: 'string' },
          n: { type: 'number' },
          flag: { type: 'boolean' },
          mode: { type: 'enum', values: ['a', 'b'] },
          rows: { type: 'list', of: { type: 'number' } },
        },
        dispatch: { kind: 'agent', specialistId: 'x', instructions: 'y' },
        toolAllowlist: [],
        toolMode: 'read-only',
        confirmMode: 'auto',
      } as unknown as RawAppAction,
    };
    const html = defaultAppletPage('T', undefined, typed);
    expect(html).toContain('<input id="arg-go-text" data-decode="text" />');
    expect(html).toContain('<input id="arg-go-n" type="number" data-decode="number" />');
    expect(html).toContain('<input id="arg-go-flag" type="checkbox" data-decode="checkbox" />');
    // An enum gets a real picker, so the control cannot produce a value the
    // action would reject.
    expect(html).toContain('<select id="arg-go-mode" data-decode="text">');
    expect(html).toContain('<option>a</option><option>b</option>');
    // A list has no single input, so it gets a JSON textarea that starts valid.
    expect(html).toContain('<textarea id="arg-go-rows" rows="3" data-decode="json">[]</textarea>');

    // Every decoder the TABLE declares has an arm in the generated script —
    // derived, not a hand-listed three, so a type added with a new decoder
    // fails here rather than rendering a control the page silently sends as a
    // string. `text` is the fall-through and has no arm by construction.
    for (const { control } of ARG_TYPES) {
      if (control.decode === 'text') continue;
      expect(html, `the page script has no arm for ${control.decode}`).toContain(
        `=== '${control.decode}'`,
      );
    }
    // And the scaffold still satisfies the validator with all five in it.
    expect(validateAppletPage(html, ['go'])).toEqual([]);
  });

  it('falls back to a text input for a type it does not recognise', () => {
    // A manifest is user-editable, and this renders before anything validates
    // it. A missing field is a button that cannot work; a text input at least
    // reaches `validateActionArgs`, which says what was wrong.
    const odd: Record<string, RawAppAction> = {
      go: {
        args: { x: { type: 'quaternion' } },
        dispatch: { kind: 'agent', specialistId: 'x', instructions: 'y' },
        toolAllowlist: [],
        toolMode: 'read-only',
        confirmMode: 'auto',
      } as unknown as RawAppAction,
    };
    expect(defaultAppletPage('T', undefined, odd)).toContain(
      '<input id="arg-go-x" data-decode="text" />',
    );
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

/**
 * The coverage gap the `args.page` gate created.
 *
 * Validation used to run only when a page was supplied, so an update that
 * shipped a stylesheet and nothing else — replacing `app.css`, an ordinary
 * edit — reached the store unchecked. That is the call most likely to
 * introduce exactly what the `.css` refusals exist to catch.
 */
describe('a stylesheet-only change is still checked', () => {
  it('sees a hex in a shipped .css against the page already on disk', () => {
    const existing = [
      '<link rel="stylesheet" href="/__bernard/tokens.css" />',
      '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
      '<script src="/__bernard/applet.js"></script>',
      '<link rel="stylesheet" href="app.css" />',
    ].join('\n');
    const issues = validateAppletPage(existing, [], {
      files: { 'app.css': 'p { color: #ff0000; }' },
    });
    expect(issues.some((i) => i.level === 'warn' && i.message.includes('app.css'))).toBe(true);
  });
});

describe('inline style: refused in markup, warned inside a script (#466)', () => {
  const HEAD = [
    '<title>T</title>',
    '<link rel="stylesheet" href="/__bernard/tokens.css" />',
    '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
    '<script src="/__bernard/applet.js"></script>',
  ].join('\n');

  it('accepts an htm template that writes style= inside a script, with a warning', () => {
    // An htm page writes html`<div style="…">` in an inline script. Refusing
    // that rejects every correct page to catch a case the browser already
    // reports by looking wrong.
    const page = `${HEAD}
<script src="/__bernard/ui.js"></script>
<main id="root"></main>
<script>
  const { html, render } = htmPreact;
  render(html\`<div style="color:red">hi</div>\`, document.getElementById('root'));
</script>`;
    const issues = validateAppletPage(page, []);

    expect(refusalFor(issues)).toBeNull();
    expect(warningsFor(issues)).toContain('style="..."');
  });

  it('does not warn about a script that sets the property instead', () => {
    // `el.style.color = …` is the form the CSP actually allows, so the warning
    // must not fire on the remedy it recommends.
    const page = `${HEAD}
<script>document.getElementById('x').style.color = 'red';</script>`;
    const issues = validateAppletPage(page, []);

    expect(refusalFor(issues)).toBeNull();
    expect(warningsFor(issues)).not.toContain('style="..."');
  });

  it('masks only script bodies, not the whole page', () => {
    // Masking too much is how a real inline style slips through: a page with
    // BOTH must still refuse.
    const page = `${HEAD}
<main><p style="color:red">x</p></main>
<script>const t = html\`<b style="color:blue">y</b>\`;</script>`;
    expect(refusalFor(validateAppletPage(page, []))).toContain('inline `style="..."`');
  });
});

describe('a <form> cannot work, so it is refused', () => {
  const page = (body: string) =>
    [
      '<title>T</title>',
      '<link rel="stylesheet" href="/__bernard/tokens.css" />',
      '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
      '<script src="/__bernard/applet.js"></script>',
      body,
    ].join('\n');

  const refusals = (html: string) =>
    validateAppletPage(html, ['go']).filter((i) => i.level === 'refuse');

  it('is bound to the policy that makes it impossible', async () => {
    // The premise, asserted rather than assumed — and this is what earns a
    // REFUSAL instead of a warning. If `allow-forms` ever becomes grantable,
    // this fails and forces the refusal to be reconsidered, which is the right
    // coupling: warn when a grant could fix it, refuse when nothing can.
    const { cspFor } = await import('../host/csp.js');
    const { GRANTABLE_SANDBOX_TOKENS } = await import('../host/csp-grant.js');
    expect(GRANTABLE_SANDBOX_TOKENS as readonly string[]).not.toContain('allow-forms');
    expect(cspFor({ sandbox: [...GRANTABLE_SANDBOX_TOKENS] } as never)).toContain(
      "form-action 'none'",
    );
  });

  it('refuses a form in the markup', () => {
    const out = refusals(page('<form><input id="a" /><button>Save</button></form>'));
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain('never submit');
    expect(out[0].message).toContain('click listener');
  });

  it('refuses a form written from inside a script', () => {
    // Pins the non-masking decision. A `<form` in an htm template renders a
    // real form element and is dead for the same reason, so masking scripts
    // here would silently exempt every UI-runtime page — the population most
    // likely to write one. A later "tidy-up" that masks scripts fails this.
    expect(
      refusals(
        page(
          '<div id="root"></div><script>render(html`<form><button>Go</button></form>`)</script>',
        ),
      ),
    ).toHaveLength(1);
  });

  it('leaves a field-and-button page alone', () => {
    // The false-positive guard, and the shape the docs and the scaffold teach.
    expect(
      refusals(
        page(
          '<div class="field"><label for="a">A</label><input id="a" /></div><button id="go">Go</button>',
        ),
      ),
    ).toHaveLength(0);
  });
  /**
   * The one design property that is genuinely decidable, decided for the one
   * file a person actually writes.
   *
   * `color.ts` has computed real ratios since #465 and only for the SERVED
   * floor; an applet's own `.css` got a nearest-token hint and no arithmetic.
   */
  describe("contrast in an applet's own CSS", () => {
    const page = [
      '<link rel="stylesheet" href="/__bernard/tokens.css" />',
      '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
      '<link rel="stylesheet" href="app.css" />',
      '<main>hi</main>',
    ].join('\n');
    const run = (css: string) =>
      validateAppletPage(page, [], { files: { 'app.css': css } })
        .filter((i) => i.level === 'warn')
        .map((i) => i.message)
        .join(' ');

    it('warns about text that fails against every background the floor has', () => {
      // #6a6a6a on #0d1117 and on #161b22 is under 4.5:1 either way, so it
      // fails wherever the floor put it — which is what makes the claim sound
      // without a CSS parser.
      const out = run('.note { color: #6a6a6a; }');
      expect(out).toContain('fails WCAG AA');
      expect(out).toContain('#6a6a6a');
      // A real ratio, not a resemblance.
      expect(out).toMatch(/\d\.\d{2}:1/);
      expect(out).toContain('var(--text)');
    });

    it('says nothing about a colour that passes', () => {
      expect(run('.note { color: #ffffff; }')).not.toContain('fails WCAG AA');
    });

    it("takes the best of the floor's backgrounds — unobservable today, and that is asserted", () => {
      // The rule is that a foreground fails only if it fails against BOTH,
      // because checking one would flag a colour that is fine on the surface
      // it is actually used on.
      //
      // It cannot currently be caught by a case, and mutating `Math.max(...)`
      // to `ratios[0]` duly survives the whole file. The reason is a property
      // of the palette, not a gap in the tests: both floor backgrounds are
      // dark and close together, so for any light foreground `--bg` gives the
      // higher ratio and `max` IS `ratios[0]`, while a foreground dark enough
      // to invert that fails against both by a mile. For the two to straddle
      // 4.5 a colour would need a luminance below zero.
      //
      // So the condition is asserted instead — the `argSpecsSince` precedent
      // — and the day `tokens.test.ts`'s one-entry palette list gains a light
      // mode, this fails and a real case becomes writable.
      const fg = '#888888';
      const a = contrastOver(fg, [APPLET_COLOR_TOKENS['--bg']]) ?? 0;
      const b = contrastOver(fg, [APPLET_COLOR_TOKENS['--surface']]) ?? 0;
      expect(a).toBeGreaterThan(b); // --bg is the darker of the two
      // Both on the same side of the threshold, for every colour: that is
      // what makes the max unobservable rather than merely untested.
      expect(a >= 4.5).toBe(b >= 4.5);
    });

    it('ignores a value it cannot parse rather than inventing a ratio', () => {
      // `#12345` is five digits: `HEX_LITERAL_RE` matches 3-8 so it gets this
      // far, and `parseColor` rejects it because only 3, 4, 6 and 8 are real.
      // Without the null guard it scores 0 and is reported as the worst
      // failure on the page — a confident number about a colour nobody parsed,
      // which is the one thing `color.ts` returns null to avoid.
      expect(run('.note { color: #12345; }')).not.toContain('fails WCAG AA');
      // A named colour and a var() never reach the ratio at all: no hex, so
      // the scan skips them earlier.
      expect(run('.a { color: var(--muted); } .b { color: rebeccapurple; }')).not.toContain(
        'fails WCAG AA',
      );
    });

    it('is a warning, because the applet may have painted its own background', () => {
      // The module's certainty rule: strong evidence, not proof.
      const issues = validateAppletPage(page, [], {
        files: { 'app.css': '.note { color: #6a6a6a; }' },
      });
      expect(issues.some((i) => i.level === 'refuse' && i.message.includes('WCAG'))).toBe(false);
    });
  });
});
