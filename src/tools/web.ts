import { tool } from 'ai';
import { z } from 'zod';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const STRIP_SELECTORS = [
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

const MAX_HTML_BYTES = 1_000_000; // 1MB
const MAX_OUTPUT_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function createWebReadTool() {
  return tool({
    description:
      'Fetch a web page by URL and return its content as markdown. Useful for reading documentation, articles, Stack Overflow answers, GitHub pages, or any URL.',
    parameters: z.object({
      url: z.string().describe('The URL to fetch (must start with http:// or https://)'),
      selector: z
        .string()
        .optional()
        .describe(
          'Optional CSS selector to extract specific content (e.g., "article", "main", ".post-body")',
        ),
    }),
    execute: async ({ url, selector }): Promise<string> => {
      // Validate URL
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return 'Error: URL must start with http:// or https://';
      }

      let response: Response;
      try {
        response = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html',
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error: Failed to fetch URL — ${message}`;
      }

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`;
      }

      const contentType = response.headers.get('content-type') || '';
      if (
        !contentType.includes('text/html') &&
        !contentType.includes('text/plain') &&
        !contentType.includes('application/xhtml')
      ) {
        return `Error: Non-HTML content type (${contentType}). This tool only reads web pages.`;
      }

      let html: string;
      try {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_HTML_BYTES) {
          html = new TextDecoder().decode(buffer.slice(0, MAX_HTML_BYTES));
        } else {
          html = new TextDecoder().decode(buffer);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error: Failed to read response body — ${message}`;
      }

      const $ = cheerio.load(html);

      // Strip junk elements
      for (const sel of STRIP_SELECTORS) {
        $(sel).remove();
      }

      // Get page title
      const title = $('title').text().trim();

      // Select content
      let content: string;
      if (selector) {
        const selected = $(selector);
        content = selected.length > 0 ? selected.html() || '' : $.root().html() || '';
      } else {
        // Try common content containers, fall back to body
        const body = $('body');
        content = body.length > 0 ? body.html() || '' : $.root().html() || '';
      }

      // Convert to markdown
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
      });
      let markdown = turndown.turndown(content);

      // Prepend title
      if (title) {
        markdown = `# ${title}\n\n${markdown}`;
      }

      // Truncate
      if (markdown.length > MAX_OUTPUT_CHARS) {
        markdown = markdown.slice(0, MAX_OUTPUT_CHARS) + '\n\n… (truncated)';
      }

      return markdown;
    },
  });
}
