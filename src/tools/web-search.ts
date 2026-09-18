import { tool } from 'ai';
import { z } from 'zod';
import { parse } from 'node-html-parser';
import { attachMeta } from '../framework/tools/adapter.js';
import type { ProvenanceStore } from '../provenance.js';

/** One search result. Kept minimal so the LLM can cheaply decide which URLs to `web_read`. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /**
   * Publication date as the provider reported it, when it reported one.
   *
   * Brave and Tavily both return this and it was previously discarded in the
   * mappers below — recovering it is a mapper change, not new infrastructure.
   * Formats differ per provider and are passed through verbatim rather than
   * normalised: a date we cannot parse is still information a reader can use,
   * and guessing at an ambiguous format is worse than showing what was said.
   * DuckDuckGo's scrape has no date to recover.
   */
  publishedAt?: string;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * What one provider did — three states, not two (#565).
 *
 * These functions used to return `undefined` for both "there is no key for this
 * provider" and "it was tried and it failed", and the caller had no way to tell
 * them apart. With neither key set that made a search report `brave` and
 * `tavily` as providers it had *tried*, and — once the DuckDuckGo fallback then
 * answered with nothing — discard them entirely and tell the model to rephrase.
 * It rephrased four times in one observed turn, including with a `site:`
 * operator, against the one provider that was never going to improve.
 *
 * The distinction is the caller's to report, so it has to survive the return.
 * Same shape and same reasoning as `KnowledgeSearchResult.skipped`, which
 * separates "nothing matched" from "that library could not be read" so the
 * difference is legible to the model and not just to a human.
 *
 * `answered` carries an empty array for a genuine zero-match: whether that is
 * interesting is the caller's question, not the provider's.
 */
type ProviderOutcome =
  | { status: 'answered'; results: SearchResult[] }
  | { status: 'unconfigured' }
  | { status: 'failed' };

/**
 * A SEARCH provider that needs a key, and the variable that holds it. Keyless
 * providers are absent, which is what makes "could any real provider have run?"
 * answerable from the table rather than from a hard-coded provider name.
 *
 * Named apart from `config.ts`'s `PROVIDER_ENV_VARS`, which is the same idea for
 * LLM providers and shares none of these entries. The two are deliberately not
 * merged: that one feeds `bernard add-key` and the provider lineup, this one
 * only decides what a failed search should advise.
 */
const SEARCH_PROVIDER_ENV_VAR: Record<string, string> = {
  brave: 'BRAVE_API_KEY',
  tavily: 'TAVILY_API_KEY',
};

/**
 * `a`, `a and b`, `a, b or c` — the conjunction is the caller's, because the two
 * uses here mean opposite things. A list of providers that are all missing is a
 * statement of fact about every one of them ("brave and tavily are not
 * configured"); a list of variables is a menu of remedies, any one of which
 * helps ("set BRAVE_API_KEY or TAVILY_API_KEY"). Getting that backwards tells
 * the reader to do both, or that only one provider is really missing.
 *
 * Local rather than a fourth entry in `text.ts`: `nameList` truncates and
 * `scopeList` is comma-joined with an empty-set sentinel, so neither fits, and
 * a shared helper with one caller is the worse trade.
 */
function conjoin(items: readonly string[], word: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

/** Try Brave Search API. */
async function searchBrave(query: string, limit: number): Promise<ProviderOutcome> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return { status: 'unconfigured' };
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
    if (!res.ok) return { status: 'failed' };
    const data = (await res.json()) as { web?: { results?: Array<Record<string, string>> } };
    const results = data.web?.results ?? [];
    const mapped = results.slice(0, limit).map((r) => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      snippet: String(r.description ?? ''),
      // Brave reports `page_age` as an ISO timestamp and `age` as prose
      // ("2 days ago"); prefer the machine-readable one.
      ...(r.page_age || r.age ? { publishedAt: String(r.page_age ?? r.age) } : {}),
    }));
    return { status: 'answered', results: mapped };
  } catch {
    return { status: 'failed' };
  }
}

/** Try Tavily search API. */
async function searchTavily(query: string, limit: number): Promise<ProviderOutcome> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return { status: 'unconfigured' };
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
    if (!res.ok) return { status: 'failed' };
    const data = (await res.json()) as { results?: Array<Record<string, string>> };
    const results = data.results ?? [];
    return {
      status: 'answered',
      results: results.slice(0, limit).map((r) => ({
        title: String(r.title ?? ''),
        url: String(r.url ?? ''),
        snippet: String(r.content ?? r.snippet ?? ''),
        ...(r.published_date ? { publishedAt: String(r.published_date) } : {}),
      })),
    };
  } catch {
    return { status: 'failed' };
  }
}

/**
 * DuckDuckGo HTML scrape. No API key required but output is fragile to layout
 * changes. Used as a last-resort fallback so specialist-creator can still do
 * rough research without any paid API.
 */
async function searchDuckDuckGo(query: string, limit: number): Promise<ProviderOutcome> {
  try {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok) return { status: 'failed' };
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
    return { status: 'answered', results };
  } catch {
    return { status: 'failed' };
  }
}

function formatResults(results: SearchResult[], ids?: string[]): string {
  return results
    .map((r, i) => {
      const idTag = ids?.[i] ? `[${ids[i]}] ` : '';
      // The date is on the URL line rather than its own, so a result stays
      // three lines whether or not the provider reported one.
      const dated = r.publishedAt ? `${r.url} (published ${r.publishedAt})` : r.url;
      return `${i + 1}. ${idTag}${r.title}\n   ${dated}${r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : ''}`;
    })
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
export function createWebSearchTool(provenance?: ProvenanceStore) {
  return attachMeta(
    tool({
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
        const attempts: Array<[string, () => Promise<ProviderOutcome>]> = [
          ['brave', () => searchBrave(query, cappedLimit)],
          ['tavily', () => searchTavily(query, cappedLimit)],
          ['duckduckgo', () => searchDuckDuckGo(query, cappedLimit)],
        ];
        // Which of the attempted providers need a key, derived from the chain
        // rather than from `SEARCH_PROVIDER_ENV_VAR`'s size. A provider added to that
        // table and not to this chain would otherwise make the
        // "nothing real ran" test permanently false — a dead branch that fails
        // in the wrong direction, telling the model to rephrase when no real
        // provider was ever available.
        const keyedProviders = attempts
          .map(([name]) => name)
          .filter((n) => n in SEARCH_PROVIDER_ENV_VAR);

        // Three states, not two (#565). `empty` is the only one that says
        // anything about the QUERY; the other two are facts about this install
        // and are the difference between advice that can work and advice that
        // cannot.
        const empty: string[] = [];
        const failed: string[] = [];
        const unconfigured: string[] = [];
        for (const [name, run] of attempts) {
          const outcome = await run();
          if (outcome.status === 'answered' && outcome.results.length > 0) {
            const results = outcome.results;
            const ids = provenance
              ? results.map((r) =>
                  provenance.add({
                    kind: 'web',
                    label: r.title || r.url,
                    contentPreview: r.snippet,
                    rawRef: r.url,
                    publishedAt: r.publishedAt,
                  }),
                )
              : undefined;
            return `Provider: ${name}\n\n${formatResults(results, ids)}`;
          }
          if (outcome.status === 'answered') empty.push(name);
          else if (outcome.status === 'unconfigured') unconfigured.push(name);
          else failed.push(name);
        }

        // Named here rather than inlined twice: both messages below owe the
        // user the variable to set, and the exact variable — telling someone to
        // set BRAVE_API_KEY when it is Tavily that is missing is the same class
        // of wrong advice this change exists to remove.
        const missingKeys = unconfigured
          .map((name) => SEARCH_PROVIDER_ENV_VAR[name])
          .filter((v): v is string => v !== undefined);
        const keyHint =
          missingKeys.length > 0 ? ` Set ${conjoin(missingKeys, 'or')} to enable it.` : '';

        // A provider answered and the web simply has nothing. That is a real,
        // citable observation and a successful call — deliberately NOT
        // `Error:`-prefixed (#364). Marking it a failure would teach the tool
        // profile that an obscure query is a usage mistake, and would suppress
        // evidence registration for a search that genuinely ran.
        if (empty.length > 0) {
          const head = `No results for "${query}" (searched: ${empty.join(', ')}).`;
          // Whether rephrasing is worth trying depends on whether a provider
          // that could plausibly have answered ever ran. With every keyed
          // provider unconfigured the only thing that searched was the
          // unauthenticated scrape, and no wording of the query changes that —
          // so the advice has to name the install, not the query.
          if (keyedProviders.length > 0 && unconfigured.length === keyedProviders.length) {
            return (
              `${head} Only the keyless DuckDuckGo fallback ran — ` +
              `${conjoin(unconfigured, 'and')} ${unconfigured.length === 1 ? 'is' : 'are'} not configured, ` +
              'so this is a gap in search coverage rather than a bad query.' +
              `${keyHint} Rephrasing is unlikely to help; if you know a likely URL, call web_read directly.`
            );
          }
          const alsoFailed =
            failed.length > 0 ? ` (${conjoin(failed, 'and')} could not be reached.)` : '';
          return (
            `${head}${alsoFailed} ` +
            'Try different or broader terms, or call web_read with a known URL.'
          );
        }
        // Nothing answered at all. Retrying is pointless, so say so.
        //
        // `tried` lists only what was actually attempted. It used to include
        // providers that were skipped for want of a key, which named the wrong
        // problem — the fix for an unconfigured provider is a key, not a retry.
        const notConfigured =
          unconfigured.length > 0 ? ` ${conjoin(unconfigured, 'and')} not configured.` : '';
        return (
          `Error: web_search could not reach any provider (tried: ${failed.join(', ')}).` +
          `${notConfigured}${keyHint} ` +
          'If you know a likely documentation URL, call web_read directly.'
        );
      },
    }),
    {
      name: 'web_search',
      kind: 'read',
      // A query string and a limit (#445). The query is free-form and is
      // sent to a search API — data, not something this machine executes.
      directInvocable: true,
      deterministic: false,
      sideEffect: 'network',
      cacheable: false,
    },
  );
}
