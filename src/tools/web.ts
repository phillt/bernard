import { tool } from 'ai';
import { z } from 'zod';
import { htmlToMarkdown } from '../html-text.js';
import { normalizeToolText } from '../text.js';
import { attachMeta } from '../framework/tools/adapter.js';
import type { ProvenanceStore } from '../provenance.js';

/** Maximum raw HTML size accepted before truncation (1 MB). */
const MAX_HTML_BYTES = 1_000_000;
/** Maximum character length of the returned markdown output. */
const MAX_OUTPUT_CHARS = 20_000;
/** HTTP fetch timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Creates the web-read tool that fetches a URL and converts its HTML to markdown.
 *
 * Non-content elements (nav, footer, scripts, etc.) are stripped before conversion.
 * Output is truncated to {@link MAX_OUTPUT_CHARS} characters.
 */
export function createWebReadTool(provenance?: ProvenanceStore) {
  return attachMeta(
    tool({
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
          // `normalizeToolText` on the way in, which this path was missing. A page
          // whose bytes are already mojibake — very common on older sites, and on
          // anything that mangled its own content the way the motivating Gmail bug
          // did — otherwise entered context verbatim, and the model reproduced it
          // faithfully in whatever it wrote next. That is the real reason corrupt
          // characters have shown up in GitHub issue bodies: not the model
          // inventing them, the model quoting them.
          const raw =
            buffer.byteLength > MAX_HTML_BYTES
              ? new TextDecoder().decode(buffer.slice(0, MAX_HTML_BYTES))
              : new TextDecoder().decode(buffer);
          html = normalizeToolText(raw);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return `Error: Failed to read response body — ${message}`;
        }

        // HTML → markdown lives in `html-text.ts` so corpus ingestion shares
        // the strip list rather than growing a second copy that drifts.
        const extracted = htmlToMarkdown(html, selector);
        const title = extracted.title;
        let markdown = extracted.markdown;

        // Truncate
        if (markdown.length > MAX_OUTPUT_CHARS) {
          markdown = markdown.slice(0, MAX_OUTPUT_CHARS) + '\n\n… (truncated)';
        }

        // Register the source so the model can cite it as [^S<id>] and so
        // the REPL's Shift+Tab viewer can list it.
        if (provenance) {
          const id = provenance.add({
            kind: 'web',
            label: title || url,
            contentPreview: markdown,
            // The SELECTOR is part of the ref, because it is part of the
            // identity. The dedup key is `${kind}:${rawRef}`, so with a bare
            // url `web_read(url, 'main')` and `web_read(url, 'article')`
            // collided into one entry and the longer body silently won — two
            // different extractions presented as one source, with a quote
            // checkable against text the caller never saw.
            rawRef: selector ? `${url}#selector=${selector}` : url,
            // The same text, retained in full for quote checking. The preview
            // is capped at 2,000 chars because it is re-sent to the model every
            // turn; this is not sent at all, so a quote from the middle of the
            // page can still be checked against what the page actually said.
            verifyText: markdown,
          });
          markdown = `[Source: ${id} — ${url}]\n\n${markdown}`;
        }

        return markdown;
      },
    }),
    {
      name: 'web_read',
      kind: 'read',
      // A URL and an optional selector (#445).
      directInvocable: true,
      deterministic: false,
      sideEffect: 'network',
      cacheable: false,
    },
  );
}
