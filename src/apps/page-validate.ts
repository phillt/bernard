import { MANIFEST_PATH } from '../host/webmanifest.js';
import { SDK_PATH } from '../host/sdk.js';
import { TOKENS_PATH, APPLET_COLOR_TOKENS } from '../host/tokens.js';
import { nearestToken, HEX_LITERAL_RE } from '../color.js';

/**
 * Refusing to write an applet page that cannot work.
 *
 * Serving `/__bernard/applet.js` makes the protocol impossible to get wrong;
 * it does not make a generated page USE it. #424 made the token stylesheet
 * mandatory by removing the alternative — `style-src` dropped
 * `'unsafe-inline'` — and that move is not available here: every applet writes
 * its own event handlers, so inline script must stay legal. The CSP therefore
 * cannot police this, and enforcement moves to the write path.
 *
 * ## refuse vs warn is CERTAINTY, not severity
 *
 * This is the rule a future check gets classified by, so it is written down
 * rather than left to taste. A missing `<script src>` is a page that cannot
 * work, decidable with certainty from the string. A dangling `getElementById`
 * may target an element created at runtime, so it is a warning — reported, and
 * not a refusal.
 *
 * Everything here is substring and regex over the HTML string. There is no
 * parser and this will not grow one: the checks that need a DOM (does the page
 * render anything, are the handlers wired) are not attempted, and saying so is
 * better than a check that is sometimes wrong.
 */

export interface PageIssue {
  level: 'refuse' | 'warn';
  message: string;
}

/** The literals that mean a page is speaking the wire protocol itself. */
const HAND_ROLLED = ['/__bernard/invoke', '/__bernard/store', '/__bernard/bootstrap.json'];
const TOKEN_HEADER = 'x-bernard-token';

export function validateAppletPage(
  html: string,
  actions: string[],
  opts: {
    declaresLinkPermission?: boolean;
    /**
     * The other files written alongside `index.html` (#465).
     *
     * A `.css` shipped here is the one legal route to real CSS — `style-src
     * 'self'` refuses every inline form — and until now it was written
     * completely unchecked, because this function only ever saw the HTML.
     */
    files?: Record<string, string>;
  } = {},
): PageIssue[] {
  const issues: PageIssue[] = [];
  const refuse = (message: string) => issues.push({ level: 'refuse', message });
  const warn = (message: string) => issues.push({ level: 'warn', message });

  if (!html.includes(TOKENS_PATH)) {
    refuse(
      `The page must link the served stylesheet: <link rel="stylesheet" href="${TOKENS_PATH}" />. ` +
        "The CSP is `style-src 'self'`, so a page that styles itself any other way renders unstyled.",
    );
  }

  if (!html.includes(MANIFEST_PATH)) {
    refuse(
      `The page must link its web manifest: <link rel="manifest" href="${MANIFEST_PATH}" />. ` +
        'Without it the browser never offers to install the applet.',
    );
  }

  // Both inline forms, refused together. They were split — a `<style>` block
  // refused, a `style="..."` attribute merely warned — which contradicts this
  // module's own rule, because `style-src 'self'` discards both, equally
  // silently, and both are equally decidable from the string.
  //
  // The honest caveat: a regex cannot tell markup from the same characters
  // inside a JS string literal, so neither check is certain in the strict
  // sense. They are refused anyway because the failure they prevent is
  // invisible — an unstyled page with no error anywhere — and the message
  // names the remedy. Being wrong here costs one rewritten page; being silent
  // costs an applet that looks broken for reasons nobody can see.
  //
  // Script bodies are masked first, and that split is what the caveat above
  // demanded once a template-literal runtime existed (#466): an htm page writes
  // ``html`<div style="…">` `` inside an inline <script>, which matches both
  // regexes and is not markup. The same masking `colourIssues` already does for
  // comments and href/id/name, applied one level up.
  //
  // Outside a script the finding is certain and the failure invisible, so it
  // refuses. Inside one it is uncertain — and if it IS emitted as markup the
  // CSP drops it and the element renders visibly wrong, which is the module's
  // own warn case. Refusing there would reject every correct htm page to catch
  // a case the browser already reports by looking wrong.
  const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  const markup = html.replace(SCRIPT_BLOCK, '');
  const scripts = [...html.matchAll(SCRIPT_BLOCK)].map((m) => m[1]).join('\n');
  if (/<style[\s>]/i.test(markup)) {
    refuse(
      "The page has an inline <style> block, which the CSP (`style-src 'self'`) discards silently. " +
        `Style it with the variables from ${TOKENS_PATH}, or ship a .css file alongside index.html.`,
    );
  }
  if (/\sstyle\s*=\s*["']/i.test(markup)) {
    refuse(
      'The page uses inline `style="..."` attributes, which the CSP discards exactly as it ' +
        `discards a <style> block. Use the variables from ${TOKENS_PATH}, or a .css file.`,
    );
  }
  if (/\sstyle\s*=\s*["']/i.test(scripts)) {
    warn(
      'A script writes a `style="..."` attribute. If that string is rendered as markup the CSP ' +
        'drops it and the element loses its styling — set the property instead ' +
        '(`el.style.color = …`, which the CSP does allow) or use a class.',
    );
  }

  // The load-bearing check: the SDK is only the one door if hand-rolling is
  // refused, and this is the one place that can be enforced.
  const rolled = HAND_ROLLED.filter((needle) => html.includes(needle));
  // A regex, not `toLowerCase().includes` — that copies the whole page to
  // answer one boolean.
  if (new RegExp(TOKEN_HEADER, 'i').test(html)) rolled.push(TOKEN_HEADER);
  if (rolled.length > 0) {
    refuse(
      `The page speaks the host protocol itself (${rolled.join(', ')}). Use the served client ` +
        `instead — <script src="${SDK_PATH}"></script>, then \`await bernard.invoke('action', args)\` ` +
        'and `bernard.store.get/set/list/delete`. Hand-rolled requests omit the session header and get a 403.',
    );
  }

  // Only when there is something to invoke. A page with no actions is a static
  // page, and requiring a client it never calls would be ceremony.
  // The path is escaped — an unescaped `.` is a wildcard, so `appletXjs`
  // matched. A trailing quote is NOT required: `server.ts` resolves its route
  // on `url.split('?')[0]`, so `applet.js?v=2` is a legitimate cache-busted
  // load, and demanding the quote refuses it.
  if (
    actions.length > 0 &&
    !new RegExp(`src=["']${escapeForRegExp(SDK_PATH)}(?:[?#][^"']*)?["']`).test(html)
  ) {
    refuse(
      `The page must load the applet client: <script src="${SDK_PATH}"></script> in <head>. ` +
        'Use a plain <script>, never type="module" — a module is deferred, so an inline script ' +
        'calling `bernard` would run first and fail.',
    );
  }

  const declared = new Set(actions);
  for (const [, name] of html.matchAll(/bernard\.invoke\(\s*['"]([^'"]+)['"]/g)) {
    if (!declared.has(name)) {
      refuse(
        `The page invokes "${name}", which this applet does not declare. Declared: ` +
          `${actions.length ? actions.join(', ') : '(none)'}.`,
      );
    }
  }

  const ids = new Set(Array.from(html.matchAll(/\sid=["']([^"']+)["']/g), (m) => m[1]));
  // The closing paren is required, so only a COMPLETE literal is checked. A
  // concatenation — `getElementById('arg-' + name)` — is a computed id, which
  // is not statically knowable and would otherwise be reported as its own
  // prefix. That is the same reason this whole check is a warning.
  for (const [, ref] of html.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!ids.has(ref)) warn(`getElementById("${ref}") matches no id in the markup.`);
  }

  // Links off the applet's own origin (#468).
  //
  // A warning rather than a refusal, on this module's own certainty rule: an
  // external link is legitimate, and whether the applet MEANT it to be
  // clickable is not decidable from the string. What is decidable is that
  // without a declared link permission the click does nothing at all — the
  // `sandbox` header grants neither `allow-popups` nor `allow-top-navigation`,
  // so `target="_blank"` silently no-ops and the reader is left thinking the
  // page is broken rather than unpermitted. That is exactly the failure the
  // news-feed applet hit, and it is invisible in devtools.
  const externalLinks = [
    ...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/gi),
  ];
  if (externalLinks.length > 0 && !opts.declaresLinkPermission) {
    warn(
      `This page links ${externalLinks.length} external URL(s), and a click on one will do ` +
        'nothing: an applet is sandboxed, so it may not open a window or navigate away until ' +
        'the user permits it. Declare it — `permissions: { sandbox: { tokens: ["links"], ' +
        'reason: "..." } }` — and the user is asked when the applet is built.',
    );
  }

  // `window.opener` stays live in a popup that escaped the sandbox, which is
  // what makes reverse tabnabbing possible. Cheap to fix and easy to forget.
  const blankNoOpener = [
    ...html.matchAll(
      /<a\b(?![^>]*\brel\s*=\s*["'][^"']*noopener)[^>]*\btarget\s*=\s*["']_blank["'][^>]*>/gi,
    ),
  ];
  if (blankNoOpener.length > 0) {
    warn(
      'A `target="_blank"` link without `rel="noopener"` leaves the opened page able to reach ' +
        'back through `window.opener`. Add `rel="noopener noreferrer"`.',
    );
  }

  colourIssues(html, 'the page', warn);
  cssIssues(html, opts.files ?? {}, refuse, warn);

  return issues;
}

/**
 * Colour literals, wherever they appear.
 *
 * **A warning, not a refusal — and #465 asks for a refusal.** Applying this
 * module's own rule (certainty, not severity) honestly, the two grounds that
 * license the inline-`<style>` refusals both fail here.
 *
 * The false-positive surface is broad and legitimate: `href="#a1b2c3"`, an id
 * or fragment, `<meta name="theme-color">`, a colour array driving a `<canvas>`
 * (which takes no `var()`). And the failure is **visible** — a hard-coded
 * colour renders. It looks off-palette and it will not follow a future theme,
 * but nobody is left staring at a page that is broken for reasons they cannot
 * see. That invisibility is exactly what the inline-style refusals turn on,
 * and it is absent.
 *
 * What makes the warning worth acting on instead is the remedy: the nearest
 * token, named. "Use `--danger`" gets fixed; "avoid hex colours" does not.
 */
function colourIssues(source: string, where: string, warn: (m: string) => void): void {
  // Masked before matching, or every fragment link and every element id is a
  // false positive. This is what keeps the warning high-signal enough to
  // carry the acceptance criterion without a refusal.
  const masked = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\b(?:href|id|name)\s*=\s*["'][^"']*["']/gi, '');

  const literals = new Set<string>();
  for (const m of masked.matchAll(HEX_LITERAL_RE)) literals.add(m[0]);
  // The obvious evasion once hexes are flagged. Same certainty, same level.
  const functional = /\b(?:rgba?|hsla?)\(/i.test(masked);
  if (literals.size === 0 && !functional) return;

  const named = [...literals]
    .slice(0, 3)
    .map((hex) => {
      const near = nearestToken(hex, APPLET_COLOR_TOKENS);
      return near ? `${hex} (closest token: ${near})` : hex;
    })
    .join(', ');
  const more = literals.size > 3 ? `, and ${literals.size - 3} more` : '';
  warn(
    `${where} sets colours directly${named ? `: ${named}${more}` : ''}. ` +
      `The served tokens at ${TOKENS_PATH} are what make two applets look like siblings, ` +
      'and a literal will not follow a theme change.',
  );
}

/**
 * The files shipped beside `index.html`.
 *
 * These earn a refusal where a colour does not, and for the reason this module
 * already states: the failure is silent and invisible. A stylesheet nothing
 * links is written, served, and never loaded; an off-origin `@import` is
 * dropped by `style-src 'self'` with no error anywhere. In both cases the page
 * just looks wrong.
 */
function cssIssues(
  html: string,
  files: Record<string, string>,
  refuse: (m: string) => void,
  warn: (m: string) => void,
): void {
  for (const [name, content] of Object.entries(files)) {
    if (!name.toLowerCase().endsWith('.css')) continue;

    if (!html.includes(name)) {
      refuse(
        `The page ships \`${name}\` but never links it, so it is served and never loaded. ` +
          `Add <link rel="stylesheet" href="${name}" /> to index.html, or drop the file.`,
      );
    }
    if (/@import\s+(?:url\()?["']?https?:/i.test(content)) {
      refuse(
        `\`${name}\` @imports an off-origin stylesheet, which the CSP (\`style-src 'self'\`) ` +
          'drops silently. Inline what you need, or ship it as another file.',
      );
    }
    // `img-src` IS grantable per applet since #467, so this is conditionally
    // legal — a warning naming the command, not a refusal.
    if (/url\(\s*["']?https?:/i.test(content)) {
      warn(
        `\`${name}\` loads a remote resource with url(). That is blocked until the user ` +
          'grants it: `bernard app csp <id> --img-src <origin>`.',
      );
    }
    colourIssues(content, `\`${name}\``, warn);
  }
}

/** The refusal text, with every problem at once — a model that fixes one at a time burns a turn per defect. */
export function refusalFor(issues: PageIssue[]): string | null {
  const refusals = issues.filter((i) => i.level === 'refuse');
  if (refusals.length === 0) return null;
  return (
    `Error: this page would not work, so it was not written (${refusals.length} problem(s)):\n` +
    refusals.map((i) => `  - ${i.message}`).join('\n')
  );
}

/** Warnings, appended to a successful write rather than blocking it. */
export function warningsFor(issues: PageIssue[]): string {
  return formatWarnings(issues.filter((i) => i.level === 'warn').map((i) => i.message));
}

/**
 * The one warning block.
 *
 * Shared with the applet tool's own non-page warnings, which had grown an
 * identical copy — two hand-maintained renderings of the same rule, either of
 * which could change its bullet or its heading alone.
 */
export function formatWarnings(messages: string[]): string {
  if (messages.length === 0) return '';
  return `\nWarnings:\n${messages.map((m) => `  - ${m}`).join('\n')}`;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
