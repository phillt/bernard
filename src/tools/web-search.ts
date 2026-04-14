import { tool } from 'ai';
import { z } from 'zod';
import { parse } from 'node-html-parser';

/** One search result. Kept minimal so the LLM can cheaply decide which URLs to `web_read`. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Try Brave Search API. Returns `undefined` when the provider is unavailable or errors. */
async function searchBrave(query: string, limit: number): Promise<SearchResult[] | undefined> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return undefined;
  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { web?: { results?: Array<Record<string, string>> } };
    const results = data.web?.results ?? [];
    return results.slice(0, limit).map((r) => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      snippet: String(r.description ?? ''),
    }));
  } catch {
    return undefined;
  }
}

/** Try Tavily search API. Returns `undefined` when the provider is unavailable or errors. */
async function searchTavily(query: string, limit: number): Promise<SearchResult[] | undefined> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return undefined;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: limit,
        search_depth: 'basic',
      }),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { results?: Array<Record<string, string>> };
    const results = data.results ?? [];
    return results.slice(0, limit).map((r) => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      snippet: String(r.content ?? r.snippet ?? ''),
    }));
  } catch {
    return undefined;
  }
}

/**
 * DuckDuckGo HTML scrape. No API key required but output is fragile to layout
 * changes. Used as a last-resort fallback so specialist-creator can still do
 * rough research without any paid API.
 */
async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[] | undefined> {
  try {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok) return undefined;
    const html = await res.text();
    const root = parse(html);
    const results: SearchResult[] = [];
    const nodes = root.querySelectorAll('.result');
    for (const node of nodes) {
      if (results.length >= limit) break;
      const anchor = node.querySelector('a.result__a');
      const snippetEl = node.querySelector('.result__snippet');
      const title = anchor?.text.trim() ?? '';
      let href = anchor?.getAttribute('href') ?? '';
      // DuckDuckGo wraps results in a redirect like //duckduckgo.com/l/?uddg=<encoded>
      if (href.startsWith('//duckduckgo.com/l/') || href.includes('duckduckgo.com/l/')) {
        try {
          const parsed = new URL(href.startsWith('//') ? `https:${href}` : href);
          const uddg = parsed.searchParams.get('uddg');
          if (uddg) href = decodeURIComponent(uddg);
        } catch {
          /* leave as-is */
        }
      }
      const snippet = snippetEl?.text.trim() ?? '';
      if (title && href) results.push({ title, url: href, snippet });
    }
    return results;
  } catch {
    return undefined;
  }
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : ''}`,
    )
    .join('\n\n');
}

/**
 * Creates the `web_search` tool.
 *
 * Provider chain: Brave (`BRAVE_API_KEY`) → Tavily (`TAVILY_API_KEY`) →
 * DuckDuckGo HTML scrape (no key). When every provider fails, the tool
 * returns a diagnostic message and suggests calling `web_read` with a known
 * URL instead — this keeps the specialist-creator meta-agent productive even
 * without API keys.
 */
export function createWebSearchTool() {
  return tool({
    description:
      'Search the web and return a ranked list of {title, url, snippet} results. Use before web_read when you do not yet know the right URL. Provider chain: Brave → Tavily → DuckDuckGo (no API key required for the fallback).',
    parameters: z.object({
      query: z
        .string()
        .describe('The search query. Prefer specific phrasing over generic keywords.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Maximum results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
    }),
    execute: async ({ query, limit }): Promise<string> => {
      const cappedLimit = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);
      const attempts: Array<[string, () => Promise<SearchResult[] | undefined>]> = [
        ['brave', () => searchBrave(query, cappedLimit)],
        ['tavily', () => searchTavily(query, cappedLimit)],
        ['duckduckgo', () => searchDuckDuckGo(query, cappedLimit)],
      ];
      const failures: string[] = [];
      for (const [name, fn] of attempts) {
        const results = await fn();
        if (results && results.length > 0) {
          return `Provider: ${name}\n\n${formatResults(results)}`;
        }
        failures.push(name);
      }
      return (
        `web_search returned no results (tried: ${failures.join(', ')}). ` +
        'If you know a likely documentation URL, call web_read directly. ' +
        'To enable higher-quality search, set BRAVE_API_KEY or TAVILY_API_KEY.'
      );
    },
  });
}
