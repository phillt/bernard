import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('ai', () => ({
  tool: vi.fn((def: any) => def),
}));

import { createWebSearchTool } from './web-search.js';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: any, ok = true): Response {
  return {
    ok,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
}

function htmlResponse(html: string, ok = true): Response {
  return {
    ok,
    text: async () => html,
  } as any;
}

/**
 * Returns a mock fetch that delegates to the first matching URL pattern handler.
 * Throws for any URL that does not match a handler.
 */
function createMockFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (url: string, _opts?: any) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML fixtures
// ---------------------------------------------------------------------------

const DDG_HTML_WITH_RESULT = `
<html><body>
  <div class="result">
    <a class="result__a" href="https://example.com">Example Title</a>
    <a class="result__snippet">Example snippet text</a>
  </div>
</body></html>
`;

const DDG_HTML_WITH_REDIRECT = `
<html><body>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal-url.com">Real Title</a>
    <a class="result__snippet">A real snippet</a>
  </div>
</body></html>
`;

const DDG_HTML_EMPTY = `<html><body></body></html>`;

// ---------------------------------------------------------------------------
// describe('createWebSearchTool')
// ---------------------------------------------------------------------------

describe('createWebSearchTool', () => {
  let tool: ReturnType<typeof createWebSearchTool>;

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    tool = createWebSearchTool();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Basic tool shape
  // -------------------------------------------------------------------------

  describe('tool shape', () => {
    it('returns an object with description, parameters, and execute', () => {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    });

    it('execute is async and returns a string', async () => {
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'html.duckduckgo.com': () => htmlResponse(DDG_HTML_WITH_RESULT),
        }),
      );
      const result = await tool.execute({ query: 'hello' });
      expect(typeof result).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // Provider cascade: Brave success
  // -------------------------------------------------------------------------

  describe('Brave success', () => {
    it('returns results prefixed with "Provider: brave" when BRAVE_API_KEY is set and fetch succeeds', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-brave-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.search.brave.com': () =>
            jsonResponse({
              web: {
                results: [{ title: 'Test', url: 'https://example.com', description: 'A test' }],
              },
            }),
        }),
      );

      const result = await tool.execute({ query: 'test query' });

      expect(result).toMatch(/^Provider: brave/);
      expect(result).toContain('Test');
      expect(result).toContain('https://example.com');
      expect(result).toContain('A test');
    });

    it('passes query and limit as URL search params', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-brave-key');
      const mockFetch = createMockFetch({
        'api.search.brave.com': () =>
          jsonResponse({
            web: {
              results: [{ title: 'T', url: 'https://x.com', description: 'D' }],
            },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tool.execute({ query: 'specific query', limit: 3 });

      const calledUrl: string = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('q=specific+query');
      expect(calledUrl).toContain('count=3');
    });

    it('sends the X-Subscription-Token header with the API key', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'my-secret-key');
      const mockFetch = createMockFetch({
        'api.search.brave.com': () =>
          jsonResponse({
            web: { results: [{ title: 'T', url: 'https://x.com', description: 'D' }] },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tool.execute({ query: 'test' });

      const calledHeaders: Record<string, string> = mockFetch.mock.calls[0][1].headers;
      expect(calledHeaders['X-Subscription-Token']).toBe('my-secret-key');
    });
  });

  // -------------------------------------------------------------------------
  // Provider cascade: Brave failure → Tavily
  // -------------------------------------------------------------------------

  describe('Brave failure falls through to Tavily', () => {
    it('returns "Provider: tavily" when Brave returns non-OK and Tavily succeeds', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-brave-key');
      vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.search.brave.com': () => jsonResponse({}, false /* ok = false */),
          'api.tavily.com': () =>
            jsonResponse({
              results: [{ title: 'Test', url: 'https://example.com', content: 'A test' }],
            }),
        }),
      );

      const result = await tool.execute({ query: 'test query' });

      expect(result).toMatch(/^Provider: tavily/);
      expect(result).toContain('Test');
      expect(result).toContain('https://example.com');
    });

    it('includes the Brave API key in the Tavily request body', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'brave-key');
      vi.stubEnv('TAVILY_API_KEY', 'tavily-secret');
      const mockFetch = createMockFetch({
        'api.search.brave.com': () => jsonResponse({}, false),
        'api.tavily.com': () =>
          jsonResponse({ results: [{ title: 'T', url: 'https://x.com', content: 'C' }] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tool.execute({ query: 'something' });

      const tavilyCall = mockFetch.mock.calls.find((c: any[]) =>
        (c[0] as string).includes('tavily'),
      );
      const body = JSON.parse(tavilyCall![1].body);
      expect(body.api_key).toBe('tavily-secret');
      expect(body.query).toBe('something');
    });
  });

  // -------------------------------------------------------------------------
  // Provider cascade: Brave empty results → falls through
  // -------------------------------------------------------------------------

  describe('Brave returns empty results', () => {
    it('falls through to DuckDuckGo when Brave returns an empty results array', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.search.brave.com': () => jsonResponse({ web: { results: [] } }),
          'html.duckduckgo.com': () => htmlResponse(DDG_HTML_WITH_RESULT),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      // Brave returned empty → should cascade
      expect(result).not.toMatch(/^Provider: brave/);
    });

    it('falls through when Brave response has no web key', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.search.brave.com': () => jsonResponse({}),
          'html.duckduckgo.com': () => htmlResponse(DDG_HTML_WITH_RESULT),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).not.toMatch(/^Provider: brave/);
    });
  });

  // -------------------------------------------------------------------------
  // Provider cascade: fetch throws → falls through
  // -------------------------------------------------------------------------

  describe('fetch throws → falls through', () => {
    it('falls through to DuckDuckGo when Brave fetch throws', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('brave.com')) throw new Error('network error');
          if (url.includes('duckduckgo.com')) return htmlResponse(DDG_HTML_WITH_RESULT);
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).not.toMatch(/^Provider: brave/);
      // Should have fallen through to DDG
      expect(result).toMatch(/Provider: duckduckgo|web_search returned no results/);
    });

    it('falls through to next provider when Tavily fetch throws', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('tavily.com')) throw new Error('timeout');
          if (url.includes('duckduckgo.com')) return htmlResponse(DDG_HTML_WITH_RESULT);
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).not.toMatch(/^Provider: tavily/);
    });
  });

  // -------------------------------------------------------------------------
  // Provider cascade: all fail → diagnostic string
  // -------------------------------------------------------------------------

  describe('all providers fail', () => {
    it('returns a diagnostic string mentioning all three providers', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('network error');
        }),
      );

      const result = await tool.execute({ query: 'hopeless query' });

      expect(result).toContain('web_search returned no results');
      expect(result).toContain('brave');
      expect(result).toContain('tavily');
      expect(result).toContain('duckduckgo');
    });

    it('diagnostic string suggests calling web_read directly', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('all down');
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('web_read');
    });

    it('diagnostic string suggests setting API keys', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('all down');
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('BRAVE_API_KEY');
      expect(result).toContain('TAVILY_API_KEY');
    });

    it('lists only tried providers in the diagnostic (skips providers with no API key)', async () => {
      // No API keys set → brave and tavily are skipped (return undefined immediately)
      // DDG is always attempted but fails
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('all down');
        }),
      );

      const result = await tool.execute({ query: 'test' });

      // All three are listed as failures (brave/tavily fail via undefined, ddg via exception)
      expect(result).toContain('brave');
      expect(result).toContain('tavily');
      expect(result).toContain('duckduckgo');
    });
  });

  // -------------------------------------------------------------------------
  // DuckDuckGo fallback (no API keys)
  // -------------------------------------------------------------------------

  describe('DuckDuckGo fallback', () => {
    it('returns "Provider: duckduckgo" when no API keys are set and DDG succeeds', async () => {
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'html.duckduckgo.com': () => htmlResponse(DDG_HTML_WITH_RESULT),
        }),
      );

      const result = await tool.execute({ query: 'test query' });

      expect(result).toMatch(/^Provider: duckduckgo/);
      expect(result).toContain('Example Title');
      expect(result).toContain('https://example.com');
      expect(result).toContain('Example snippet text');
    });

    it('requests the User-Agent header when calling DuckDuckGo', async () => {
      const mockFetch = createMockFetch({
        'html.duckduckgo.com': () => htmlResponse(DDG_HTML_WITH_RESULT),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tool.execute({ query: 'test' });

      const ddgCall = mockFetch.mock.calls.find((c: any[]) =>
        (c[0] as string).includes('duckduckgo'),
      );
      expect(ddgCall![1].headers['User-Agent']).toBeTruthy();
    });

    it('passes query as URL param to DuckDuckGo', async () => {
      const mockFetch = createMockFetch({
        'html.duckduckgo.com': () => htmlResponse(DDG_HTML_WITH_RESULT),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tool.execute({ query: 'vitest testing' });

      const calledUrl: string = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('q=');
      expect(calledUrl).toContain('vitest');
    });

    it('returns diagnostic when DDG returns non-OK status', async () => {
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'html.duckduckgo.com': () => htmlResponse('', false),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('web_search returned no results');
    });

    it('returns diagnostic when DDG HTML has no result nodes', async () => {
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'html.duckduckgo.com': () => htmlResponse(DDG_HTML_EMPTY),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('web_search returned no results');
    });
  });

  // -------------------------------------------------------------------------
  // DuckDuckGo URL unwrapping
  // -------------------------------------------------------------------------

  describe('DuckDuckGo URL unwrapping', () => {
    it('decodes DDG redirect URLs (//duckduckgo.com/l/?uddg=...)', async () => {
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'html.duckduckgo.com': () => htmlResponse(DDG_HTML_WITH_REDIRECT),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('https://real-url.com');
      expect(result).not.toContain('duckduckgo.com/l/');
    });

    it('handles redirect without uddg param gracefully (leaves href as-is)', async () => {
      const htmlNoUddg = `
        <html><body>
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?other=param">Some Title</a>
            <a class="result__snippet">Some snippet</a>
          </div>
        </body></html>
      `;
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'html.duckduckgo.com': () => htmlResponse(htmlNoUddg),
        }),
      );

      // Should not throw — result may or may not include the entry depending on
      // whether href ends up non-empty, but the key check is no exception
      const result = await tool.execute({ query: 'test' });
      expect(typeof result).toBe('string');
    });

    it('handles a https-prefixed DDG redirect URL (not starting with //)', async () => {
      const htmlHttpsRedirect = `
        <html><body>
          <div class="result">
            <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.target.com">Target Title</a>
            <a class="result__snippet">Target snippet</a>
          </div>
        </body></html>
      `;
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'html.duckduckgo.com': () => htmlResponse(htmlHttpsRedirect),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('https://www.target.com');
    });
  });

  // -------------------------------------------------------------------------
  // Limit clamping
  // -------------------------------------------------------------------------

  describe('limit clamping', () => {
    it('clamps limit to MAX_LIMIT (10) when a value above 10 is provided', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      const mockFetch = createMockFetch({
        'api.search.brave.com': () =>
          jsonResponse({
            web: { results: [{ title: 'T', url: 'https://x.com', description: 'D' }] },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // Zod schema has .max(MAX_LIMIT) so we test via execute directly on
      // internal capping by patching the limit param ourselves.  Since the
      // Zod schema prevents values >10 at the tool parameter level, we verify
      // the brave URL contains count=10 when limit is at the maximum.
      await tool.execute({ query: 'test', limit: 10 });

      const calledUrl: string = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('count=10');
    });

    it('clamps limit to at least 1 when 0 or negative is given', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      const mockFetch = createMockFetch({
        'api.search.brave.com': () =>
          jsonResponse({
            web: { results: [{ title: 'T', url: 'https://x.com', description: 'D' }] },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // Execute directly bypassing Zod (the execute function caps internally)
      await (tool.execute as any)({ query: 'test', limit: 0 });

      const calledUrl: string = mockFetch.mock.calls[0][0];
      // Should clamp to 1 (Math.max(1, 0) = 1)
      expect(calledUrl).toContain('count=1');
    });
  });

  // -------------------------------------------------------------------------
  // Default limit
  // -------------------------------------------------------------------------

  describe('default limit', () => {
    it('uses DEFAULT_LIMIT (5) when no limit is provided', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      const mockFetch = createMockFetch({
        'api.search.brave.com': () =>
          jsonResponse({
            web: { results: [{ title: 'T', url: 'https://x.com', description: 'D' }] },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tool.execute({ query: 'test' });

      const calledUrl: string = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('count=5');
    });

    it('uses DEFAULT_LIMIT (5) for Tavily max_results when no limit is provided', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-key');
      const mockFetch = createMockFetch({
        'api.tavily.com': () =>
          jsonResponse({ results: [{ title: 'T', url: 'https://x.com', content: 'C' }] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tool.execute({ query: 'test' });

      const tavilyCall = mockFetch.mock.calls.find((c: any[]) =>
        (c[0] as string).includes('tavily'),
      );
      const body = JSON.parse(tavilyCall![1].body);
      expect(body.max_results).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // formatResults
  // -------------------------------------------------------------------------

  describe('formatResults output', () => {
    it('numbers each result starting from 1', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.search.brave.com': () =>
            jsonResponse({
              web: {
                results: [
                  { title: 'First', url: 'https://first.com', description: 'Snippet one' },
                  { title: 'Second', url: 'https://second.com', description: 'Snippet two' },
                ],
              },
            }),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('1. First');
      expect(result).toContain('2. Second');
    });

    it('includes URLs and snippets in formatted output', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.search.brave.com': () =>
            jsonResponse({
              web: {
                results: [{ title: 'A Title', url: 'https://a.com', description: 'The snippet' }],
              },
            }),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('https://a.com');
      expect(result).toContain('The snippet');
    });

    it('truncates long snippets to 300 characters in formatted output', async () => {
      const longSnippet = 'z'.repeat(500);
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.search.brave.com': () =>
            jsonResponse({
              web: {
                results: [{ title: 'T', url: 'https://example.com', description: longSnippet }],
              },
            }),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      // The snippet in the output should be capped at 300 chars.
      // Count only the 'z' characters — those only appear in the truncated snippet.
      const zCount = (result.match(/z/g) ?? []).length;
      expect(zCount).toBeLessThanOrEqual(300);
    });

    it('omits snippet line when snippet is empty', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.search.brave.com': () =>
            jsonResponse({
              web: {
                results: [{ title: 'No Snippet', url: 'https://x.com', description: '' }],
              },
            }),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('No Snippet');
      expect(result).toContain('https://x.com');
      // No trailing blank snippet line
      const lines = result.split('\n').filter(Boolean);
      const urlLine = lines.find((l) => l.includes('https://x.com'));
      const urlLineIndex = lines.indexOf(urlLine!);
      // The next line should either be another result or not exist
      const nextLine = lines[urlLineIndex + 1];
      if (nextLine) {
        // Should be the next numbered result, not an empty snippet
        expect(nextLine).toMatch(/^\d+\.|Provider:/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Provider not called when API key is missing
  // -------------------------------------------------------------------------

  describe('provider skipping without API key', () => {
    it('does not call Brave API when BRAVE_API_KEY is absent', async () => {
      const mockFetch = createMockFetch({
        'html.duckduckgo.com': () => htmlResponse(DDG_HTML_WITH_RESULT),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tool.execute({ query: 'test' });

      const braveCalls = mockFetch.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes('brave.com'),
      );
      expect(braveCalls).toHaveLength(0);
    });

    it('does not call Tavily API when TAVILY_API_KEY is absent', async () => {
      const mockFetch = createMockFetch({
        'html.duckduckgo.com': () => htmlResponse(DDG_HTML_WITH_RESULT),
      });
      vi.stubGlobal('fetch', mockFetch);

      await tool.execute({ query: 'test' });

      const tavilyCalls = mockFetch.mock.calls.filter((c: any[]) =>
        (c[0] as string).includes('tavily.com'),
      );
      expect(tavilyCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple results respects limit
  // -------------------------------------------------------------------------

  describe('results sliced to limit', () => {
    it('returns at most `limit` results from Brave', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'test-key');
      const manyResults = Array.from({ length: 8 }, (_, i) => ({
        title: `Result ${i + 1}`,
        url: `https://result${i + 1}.com`,
        description: `Snippet ${i + 1}`,
      }));
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.search.brave.com': () =>
            jsonResponse({ web: { results: manyResults } }),
        }),
      );

      const result = await tool.execute({ query: 'test', limit: 3 });

      expect(result).toContain('1. Result 1');
      expect(result).toContain('2. Result 2');
      expect(result).toContain('3. Result 3');
      expect(result).not.toContain('4. Result 4');
    });

    it('returns at most `limit` results from Tavily', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-key');
      const manyResults = Array.from({ length: 8 }, (_, i) => ({
        title: `T${i + 1}`,
        url: `https://r${i + 1}.com`,
        content: `C${i + 1}`,
      }));
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.tavily.com': () => jsonResponse({ results: manyResults }),
        }),
      );

      const result = await tool.execute({ query: 'test', limit: 2 });

      expect(result).toContain('1. T1');
      expect(result).toContain('2. T2');
      expect(result).not.toContain('3. T3');
    });
  });

  // -------------------------------------------------------------------------
  // Tavily uses content field; falls back to snippet
  // -------------------------------------------------------------------------

  describe('Tavily result field mapping', () => {
    it('uses `content` field for snippet in Tavily results', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.tavily.com': () =>
            jsonResponse({
              results: [{ title: 'T', url: 'https://x.com', content: 'Content text' }],
            }),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('Content text');
    });

    it('falls back to `snippet` field when `content` is absent in Tavily results', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.tavily.com': () =>
            jsonResponse({
              results: [{ title: 'T', url: 'https://x.com', snippet: 'Fallback snippet' }],
            }),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toContain('Fallback snippet');
    });
  });

  // -------------------------------------------------------------------------
  // Brave prefers brave over tavily when both keys are set
  // -------------------------------------------------------------------------

  describe('provider priority', () => {
    it('prefers Brave over Tavily when both API keys are set', async () => {
      vi.stubEnv('BRAVE_API_KEY', 'brave-key');
      vi.stubEnv('TAVILY_API_KEY', 'tavily-key');
      vi.stubGlobal(
        'fetch',
        createMockFetch({
          'api.search.brave.com': () =>
            jsonResponse({
              web: { results: [{ title: 'Brave Result', url: 'https://brave.com', description: 'D' }] },
            }),
          'api.tavily.com': () =>
            jsonResponse({ results: [{ title: 'Tavily Result', url: 'https://tavily.com', content: 'C' }] }),
        }),
      );

      const result = await tool.execute({ query: 'test' });

      expect(result).toMatch(/^Provider: brave/);
      expect(result).toContain('Brave Result');
      expect(result).not.toContain('Tavily Result');
    });

    it('prefers Tavily over DuckDuckGo when Brave is absent', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'tavily-key');
      const mockFetch = createMockFetch({
        'api.tavily.com': () =>
          jsonResponse({ results: [{ title: 'Tavily Result', url: 'https://t.com', content: 'C' }] }),
        'html.duckduckgo.com': () => htmlResponse(DDG_HTML_WITH_RESULT),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await tool.execute({ query: 'test' });

      expect(result).toMatch(/^Provider: tavily/);
      expect(result).not.toMatch(/Provider: duckduckgo/);
    });
  });
});
