import { parse } from 'node-html-parser';
import TurndownService from 'turndown';

/**
 * HTML → markdown, shared by `web_read` and by corpus ingestion (#517).
 *
 * Extracted from `tools/web.ts` rather than copied, and rather than having
 * `knowledge/` import a tool module: the strip list is the accumulated answer to
 * "what on a page is not content", and a second copy of it drifts silently —
 * one caller learns about a new wrapper element and the other does not, which
 * shows up as a corpus full of navigation chrome nobody can explain.
 *
 * Deliberately does NOT fetch. `web_read` owns the network — its timeout, its
 * user agent, its size cap and its provenance registration — and ingestion has
 * its own reasons about redirects and retries. This is the pure half, so it is
 * testable with a string.
 */

/** Elements stripped before conversion: chrome, scripts, and decoration. */
export const STRIP_SELECTORS = [
  'script',
  'style',
  'nav',
  'footer',
  'header',
  'iframe',
  'noscript',
  'svg',
  '[role="navigation"]',
  '[role="banner"]',
  '[aria-hidden="true"]',
];

export interface HtmlText {
  /** The document's `<title>`, or an empty string. */
  title: string;
  /** Markdown, with the title as an H1 when there is one. */
  markdown: string;
}

/**
 * Convert a page to markdown.
 *
 * `selector` picks a subtree; without one the `<body>` is used. An unmatched
 * selector falls back to the whole document rather than returning nothing —
 * a page whose layout changed should degrade to "too much" rather than to
 * silence.
 */
export function htmlToMarkdown(html: string, selector?: string): HtmlText {
  const root = parse(html);
  for (const sel of STRIP_SELECTORS) {
    root.querySelectorAll(sel).forEach((el) => el.remove());
  }

  const title = root.querySelector('title')?.text.trim() ?? '';

  let content: string;
  if (selector) {
    const selected = root.querySelector(selector);
    content = selected ? selected.innerHTML : root.innerHTML;
  } else {
    const body = root.querySelector('body');
    content = body ? body.innerHTML : root.innerHTML;
  }

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = turndown.turndown(content);
  return { title, markdown: title ? `# ${title}\n\n${markdown}` : markdown };
}
