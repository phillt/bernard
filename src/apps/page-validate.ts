import { MANIFEST_PATH } from '../host/webmanifest.js';
import { SDK_PATH } from '../host/sdk.js';
import { TOKENS_PATH } from '../host/tokens.js';

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

export function validateAppletPage(html: string, actions: string[]): PageIssue[] {
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
  if (/<style[\s>]/i.test(html)) {
    refuse(
      "The page has an inline <style> block, which the CSP (`style-src 'self'`) discards silently. " +
        `Style it with the variables from ${TOKENS_PATH}, or ship a .css file alongside index.html.`,
    );
  }
  if (/\sstyle=["']/.test(html)) {
    refuse(
      'The page uses inline `style="..."` attributes, which the CSP discards exactly as it ' +
        `discards a <style> block. Use the variables from ${TOKENS_PATH}, or a .css file.`,
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
  if (actions.length > 0 && !new RegExp(`src=["']${SDK_PATH}`).test(html)) {
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

  return issues;
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
