import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmbeddingProvider } from './embeddings.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '[]'),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

const fs = await import('node:fs');

// Create a deterministic fake embedding provider
let mockProvider: EmbeddingProvider | null = null;

vi.mock('./embeddings.js', () => ({
  // The stamp constants the store writes with (#520). A module mock must
  // export every name the module under test imports, or the import throws.
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
  getEmbeddingProvider: vi.fn(async () => mockProvider),
  cosineSimilarity: vi.fn((a: number[], b: number[]) => {
    // Real cosine similarity for deterministic fake embeddings
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }),
}));

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
}));

// Hash-based fake embeddings for deterministic testing
// Uses 16 dimensions and a simple hash to spread values for better discrimination
function fakeEmbed(texts: string[]): number[][] {
  return texts.map((text) => {
    const dims = 16;
    const embedding = new Array(dims).fill(0);
    // Use a simple hash to distribute values across dimensions
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      embedding[(i * 7 + Math.abs(hash)) % dims] += hash & 1 ? 1 : -1;
    }
    // Normalize
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? embedding.map((v) => v / norm) : embedding;
  });
}

/**
 * The records inside the persisted payload.
 *
 * The store is stamped since #520 — `{version, model, dimensions, memories}`
 * rather than a bare array — so the three tests that inspect what was written
 * unwrap it here rather than each learning the shape.
 */
function persistedRecords(raw: string): any[] {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.memories;
}

function createFakeProvider(): EmbeddingProvider {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return fakeEmbed(texts);
    },
    dimensions(): number {
      return 16;
    },
    modelId(): string {
      return 'Xenova/all-MiniLM-L6-v2';
    },
  };
}

/** Writes to the store file, ignoring the session-date sidecar. */
function storeWrites(): number {
  return vi
    .mocked(fs.writeFileSync)
    .mock.calls.filter((c) => String(c[0]).includes('memories.json')).length;
}

/**
 * A fresh store over reset `node:fs` mocks. Three top-level suites need one and
 * each had grown its own copy, which is how they drifted apart on
 * `similarityThreshold` without any of them saying so.
 */
async function createStore(config?: import('./rag.js').RAGStoreConfig) {
  const { RAGStore } = await import('./rag.js');
  return new RAGStore({ maxMemories: 100, ...config });
}

/** Puts the `node:fs` mocks back to "no store on disk". */
function resetFsMocks(): void {
  vi.clearAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockReturnValue('[]');
  mockProvider = createFakeProvider();
}

describe('default limits', () => {
  it('exports expected default limits', async () => {
    const { DEFAULT_TOP_K_PER_DOMAIN, DEFAULT_MAX_RESULTS } = await import('./rag.js');
    expect(DEFAULT_TOP_K_PER_DOMAIN).toBe(5);
    expect(DEFAULT_MAX_RESULTS).toBe(15);
  });
});

describe('RAGStore', () => {
  beforeEach(resetFsMocks);

  /**
   * A read must not rewrite the store (#533).
   *
   * `search()` ended with `persist()`, and `persist()` is a `JSON.stringify` of
   * the whole array plus a write — measured at 188 ms on a real 3,664-record /
   * 31 MB store, synchronous, on the turn's critical path, to record an
   * `accessCount++`. These pin that the write is deferred and that the
   * bookkeeping still survives.
   */
  describe('debounced access bookkeeping', () => {
    it('a search that hits does not write', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode with testing keywords'], 'test');
      const before = storeWrites();

      const results = await store.search('User prefers dark mode with testing keywords');

      expect(results.length).toBeGreaterThan(0);
      expect(storeWrites()).toBe(before);
    });

    it('flushes once for many dirtying searches', async () => {
      // The whole point: a fan-out of dispatches coalesces into one write
      // rather than front-loading one 31 MB rewrite each.
      const store = await createStore();
      await store.addFacts(['fact one with testing keywords'], 'test');
      const before = storeWrites();

      for (let i = 0; i < 5; i++) {
        store.clearTurnCache(); // otherwise the per-turn cache short-circuits
        await store.search('fact one with testing keywords');
      }
      expect(storeWrites()).toBe(before);

      store.flush();
      expect(storeWrites()).toBe(before + 1);
    });

    it('a flush with nothing pending is a no-op', async () => {
      const store = await createStore();
      const before = storeWrites();
      store.flush();
      store.flush();
      expect(storeWrites()).toBe(before);
    });

    it('keeps writing content eagerly — only bookkeeping is deferred', async () => {
      // `addFacts` writes a FACT. A crash must not lose it, only the note that
      // a fact was useful.
      const store = await createStore();
      const before = storeWrites();
      await store.addFacts(['a brand new fact'], 'test');
      expect(storeWrites()).toBeGreaterThan(before);
    });

    it('does not hold the process open for bookkeeping', async () => {
      // `unref`ed, so the debounce can never be why Bernard will not exit —
      // which is also why every exit path flushes explicitly rather than
      // trusting the timer.
      const unref = vi.fn();
      const spy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref } as never);
      try {
        const store = await createStore();
        await store.addFacts(['fact one with testing keywords'], 'test');
        await store.search('fact one with testing keywords');
        expect(unref).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('writes to a unique temp path, not a shared one', async () => {
      // Four processes write this file. A fixed `.tmp` suffix means two
      // concurrent persists share one temp path and rename it twice;
      // debouncing widens the window that makes it matter.
      const store = await createStore();
      await store.addFacts(['another fact'], 'test');
      const temps = vi
        .mocked(fs.writeFileSync)
        .mock.calls.map((c) => String(c[0]))
        .filter((p) => p.endsWith('.tmp'));
      expect(temps.length).toBeGreaterThan(0);
      for (const t of temps) expect(t).not.toMatch(/memories\.json\.tmp$/);
      expect(temps[0]).toContain(String(process.pid));
    });
  });

  /**
   * A model swap must not silently destroy retrieval (#520).
   *
   * `cosineSimilarity` returns `0` for vectors of different lengths, `0` is
   * below every threshold, so the old behaviour was `search()` returning `[]`
   * with no error and no log — a store of thousands of facts reading as empty.
   * `dimensions()` existed to catch exactly this and had zero production
   * callers.
   */
  describe('embedding model stamp', () => {
    function lastPayload(): any {
      const call = vi
        .mocked(fs.writeFileSync)
        .mock.calls.filter((c) => String(c[0]).includes('memories.json'))
        .at(-1);
      return JSON.parse(String(call![1]));
    }

    function seed(raw: unknown): void {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(raw));
    }

    const record = {
      id: '1',
      fact: 'a stored fact with testing keywords',
      embedding: fakeEmbed(['a stored fact with testing keywords'])[0],
      source: 'test',
      domain: 'general',
      createdAt: new Date().toISOString(),
      accessCount: 0,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };

    it('stamps what wrote the store', async () => {
      const store = await createStore();
      await store.addFacts(['a brand new fact'], 'test');
      const payload = lastPayload();
      expect(payload.model).toBe('Xenova/all-MiniLM-L6-v2');
      expect(payload.dimensions).toBe(384);
      expect(Array.isArray(payload.memories)).toBe(true);
    });

    it('adopts a legacy bare array and stamps it in place', async () => {
      // Every existing install has this shape. It must load, keep its facts,
      // and gain a stamp — not be refused, and above all not be discarded.
      seed([record]);
      const store = await createStore();
      expect(store.listMemories()).toHaveLength(1);
      expect(lastPayload().model).toBe('Xenova/all-MiniLM-L6-v2');
    });

    it('refuses to search a store another model wrote, and says why', async () => {
      seed({
        version: 1,
        model: 'some-other/embedder',
        dimensions: 768,
        memories: [record],
      });
      const store = await createStore();
      // The facts are still THERE — the whole point of refusing rather than
      // discarding. Only retrieval stops.
      expect(store.listMemories()).toHaveLength(1);
      expect(await store.search('a stored fact with testing keywords')).toEqual([]);
      // Asserted on the STATE, not on a print. This module deliberately does
      // not `console.error`: search runs mid-turn, and a raw stderr write into
      // Ink's alternate screen buffer corrupts the frame and is overwritten on
      // the next render — so the warning would be invisible in exactly the
      // session it matters in. Each front end reads this and surfaces it in its
      // own channel.
      const said = store.retrievalDisabledReason() ?? '';
      expect(said).toContain('some-other/embedder');
      expect(said).toContain('Xenova/all-MiniLM-L6-v2');
      expect(said).toContain('intact');
    });

    it('never prints, so it cannot corrupt the REPL frame it would land in', async () => {
      seed({ version: 1, model: 'other', dimensions: 768, memories: [record] });
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const store = await createStore();
        for (let i = 0; i < 3; i++) {
          store.clearTurnCache();
          await store.search('a stored fact with testing keywords');
        }
        expect(err).not.toHaveBeenCalled();
        expect(out).not.toHaveBeenCalled();
        // …and the state is latched, so a front end announces it once however
        // many searches ran.
        expect(store.retrievalDisabledReason()).toContain('other');
      } finally {
        err.mockRestore();
        out.mockRestore();
      }
    });

    it('refuses on the searchWithIds path too', async () => {
      // Both read paths go through `embedQuery`, so the refusal is written
      // once rather than at each entry point.
      seed({ version: 1, model: 'other', dimensions: 768, memories: [record] });
      const store = await createStore();
      expect(await store.searchWithIds('a stored fact with testing keywords')).toEqual([]);
      expect(store.retrievalDisabledReason()).not.toBeNull();
    });

    it('refuses on dimensionality alone, with the same model name', async () => {
      // The realistic swap #520 names: a Matryoshka model truncated to fewer
      // dimensions keeps its id and changes its vector length. Comparing the
      // name alone would let that through, and the vectors would score zero.
      seed({
        version: 1,
        model: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 768,
        memories: [record],
      });
      const store = await createStore();
      expect(await store.search('a stored fact with testing keywords')).toEqual([]);
      expect(store.retrievalDisabledReason()).toContain('768');
    });

    it('does not refuse when the stamp matches', async () => {
      seed({
        version: 1,
        model: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 16,
        memories: [record],
      });
      const store = await createStore();
      expect((await store.search('a stored fact with testing keywords')).length).toBeGreaterThan(0);
    });
  });

  describe('addFacts', () => {
    it('stores facts with embeddings', async () => {
      const store = await createStore();
      const added = await store.addFacts(
        ['User prefers dark mode', 'Project uses TypeScript'],
        'compression',
      );
      // Both, not one: an unguarded throw would abandon the second fact — and would
      // reject, with the first already written.
      expect(added).toBe(2);
      expect(store.count()).toBe(2);
    });

    it('defaults domain to general when not specified', async () => {
      const store = await createStore();
      await store.addFacts(['some fact'], 'test');
      const facts = store.listFacts();
      expect(facts[0]).toContain('[general]');
    });

    it('stores facts with specified domain', async () => {
      const store = await createStore();
      await store.addFacts(['npm run build compiles TypeScript'], 'test', 'tool-usage');
      const facts = store.listFacts();
      expect(facts[0]).toContain('[tool-usage]');
    });

    it('returns 0 when provider is unavailable', async () => {
      mockProvider = null;
      const store = await createStore();
      const added = await store.addFacts(['some fact'], 'compression');
      expect(added).toBe(0);
    });

    it('returns 0 for empty facts array', async () => {
      const store = await createStore();
      const added = await store.addFacts([], 'compression');
      expect(added).toBe(0);
    });

    it('deduplicates identical facts', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode'], 'compression');
      const added = await store.addFacts(['User prefers dark mode'], 'compression');
      expect(added).toBe(0);
      expect(store.count()).toBe(1);
    });

    it('persists to disk after adding', async () => {
      const store = await createStore();
      await store.addFacts(['new fact'], 'compression');
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });

    it('prunes when over max capacity', async () => {
      const store = await createStore();
      // Use unique-enough facts so they don't deduplicate
      const facts = Array.from(
        { length: 110 },
        (_, i) =>
          `Fact number ${i} about topic ${String.fromCharCode(65 + (i % 26))} with extra details ${i * 7}`,
      );
      await store.addFacts(facts, 'compression');
      expect(store.count()).toBeLessThanOrEqual(100);
    });
  });

  describe('search', () => {
    it('returns empty when no memories', async () => {
      const store = await createStore();
      const results = await store.search('anything');
      expect(results).toEqual([]);
    });

    it('returns empty when provider is unavailable', async () => {
      const store = await createStore();
      await store.addFacts(['some fact'], 'test');
      mockProvider = null;
      const results = await store.search('some fact');
      expect(results).toEqual([]);
    });

    it('returns matching results sorted by similarity', async () => {
      const store = await createStore();
      await store.addFacts(
        [
          'User prefers dark mode for all editors',
          'Project is built with TypeScript and Node.js',
          'The cat sat on the mat',
        ],
        'test',
      );

      const results = await store.search('User prefers dark mode for all editors');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].fact).toContain('dark mode');
      // Results should be sorted descending by similarity
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
      }
    });

    it('returns domain field in results', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode'], 'test', 'user-preferences');
      const results = await store.search('User prefers dark mode');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].domain).toBe('user-preferences');
    });

    it('respects topKPerDomain limit', async () => {
      const store = await createStore({ topKPerDomain: 2, maxResults: 10 });

      // Add 5 facts to the same domain
      const facts = [
        'Build step one for project alpha',
        'Build step two for project alpha',
        'Build step three for project alpha',
        'Build step four for project alpha',
        'Build step five for project alpha',
      ];
      await store.addFacts(facts, 'test', 'tool-usage');

      const results = await store.search('Build step for project alpha');
      // Should be capped at 2 per domain
      const toolUsageResults = results.filter((r) => r.domain === 'tool-usage');
      expect(toolUsageResults.length).toBeLessThanOrEqual(2);
    });

    it('caps total results at maxResults', async () => {
      const store = await createStore({ topKPerDomain: 5, maxResults: 3 });

      await store.addFacts(
        [
          'Fact A about building software',
          'Fact B about building software',
          'Fact C about building software',
          'Fact D about building software',
          'Fact E about building software',
        ],
        'test',
        'general',
      );

      const results = await store.search('building software');
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('updates access count on search hit', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode'], 'test');
      await store.search('User prefers dark mode');
      // Persist should be called again to save access metadata
      const persistCalls = vi.mocked(fs.writeFileSync).mock.calls.length;
      expect(persistCalls).toBeGreaterThan(1);
    });
  });

  describe('searchWithIds overrides (recall-filter widening)', () => {
    // Threshold 0 includes every fact, so the assertions isolate the per-domain
    // and total caps from embedding-score noise.
    it('honors a wider topKPerDomain than the store default', async () => {
      const store = await createStore();
      await store.addFacts(
        [
          'The user prefers dark mode in their editor',
          'Deployments run on Kubernetes in us-east-1',
          'The project uses pnpm as its package manager',
          'Unit tests are written with Vitest',
          'The primary database is Postgres 16',
          'CI is configured through GitHub Actions',
        ],
        'test',
        'general',
      );
      const stored = store.listMemories().length;

      const narrow = await store.searchWithIds('x', {
        threshold: -1,
        topKPerDomain: 2,
        maxResults: 24,
      });
      const wide = await store.searchWithIds('x', {
        threshold: -1,
        topKPerDomain: 8,
        maxResults: 24,
      });

      // topK 2 caps the single domain to 2; topK 8 surfaces every stored fact.
      expect(stored).toBeGreaterThan(2);
      expect(narrow.length).toBe(2);
      expect(wide.length).toBe(stored);
    });

    it('honors a maxResults cap in the overrides', async () => {
      const store = await createStore();
      await store.addFacts(
        [
          'The user prefers dark mode in their editor',
          'Deployments run on Kubernetes in us-east-1',
          'The project uses pnpm as its package manager',
          'Unit tests are written with Vitest',
        ],
        'test',
        'general',
      );
      expect(store.listMemories().length).toBeGreaterThanOrEqual(3);

      const capped = await store.searchWithIds('x', {
        threshold: -1,
        topKPerDomain: 8,
        maxResults: 3,
      });

      expect(capped.length).toBe(3);
    });

    it('does not mutate access metadata (read-only)', async () => {
      const store = await createStore();
      await store.addFacts(['some fact'], 'test');
      const before = vi.mocked(fs.writeFileSync).mock.calls.length;

      await store.searchWithIds('some fact', { threshold: -1 });

      expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(before);
    });

    it('shares the per-turn embedding cache with search() (no re-embed on fallback)', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode for all editors'], 'test');

      const embedSpy = vi.spyOn(mockProvider!, 'embed');
      // recall-filter widens via searchWithIds; on a noop the agent falls back
      // to search() with the SAME query string. The second call must reuse the
      // cached embedding rather than re-embedding.
      await store.searchWithIds('same query string', { threshold: -1 });
      await store.search('same query string');

      expect(embedSpy).toHaveBeenCalledTimes(1);
    });

    it('re-embeds after the turn boundary clears the cache', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode for all editors'], 'test');

      const embedSpy = vi.spyOn(mockProvider!, 'embed');
      await store.searchWithIds('same query string', { threshold: -1 });
      store.clearTurnCache();
      await store.search('same query string');

      expect(embedSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('recordAccess', () => {
    it('bumps access count and extends TTL for the given ids, deferring the write', async () => {
      // It used to persist here — a 31 MB rewrite once per turn to record that
      // the curator endorsed some facts (#533). It shares the debounce now
      // rather than being the one bookkeeping path that still writes eagerly.
      const store = await createStore();
      await store.addFacts(['User prefers dark mode'], 'test');
      const [before] = store.listMemories();
      const persistsBefore = vi.mocked(fs.writeFileSync).mock.calls.length;

      store.recordAccess([before.id]);

      const [after] = store.listMemories();
      expect(after.accessCount).toBe(before.accessCount + 1);
      expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(persistsBefore);

      store.flush();
      expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBeGreaterThan(persistsBefore);
    });

    it('is a no-op for an empty id list', async () => {
      const store = await createStore();
      await store.addFacts(['some fact'], 'test');
      const persistsBefore = vi.mocked(fs.writeFileSync).mock.calls.length;

      store.recordAccess([]);

      expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(persistsBefore);
    });

    it('is a no-op for unknown ids', async () => {
      const store = await createStore();
      await store.addFacts(['some fact'], 'test');
      const persistsBefore = vi.mocked(fs.writeFileSync).mock.calls.length;

      store.recordAccess(['does-not-exist']);

      expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(persistsBefore);
    });
  });

  describe('per-turn search cache (#171)', () => {
    it('does not re-embed the same query within a turn', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode for all editors'], 'test');

      const embedSpy = vi.spyOn(mockProvider!, 'embed');
      await store.search('dark mode preference');
      await store.search('dark mode preference');

      // Only the first call should embed the query; the second hits the cache.
      expect(embedSpy).toHaveBeenCalledTimes(1);
    });

    it('clearTurnCache forces re-embedding on the next search', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode for all editors'], 'test');

      const embedSpy = vi.spyOn(mockProvider!, 'embed');
      await store.search('dark mode preference');
      store.clearTurnCache();
      await store.search('dark mode preference');

      expect(embedSpy).toHaveBeenCalledTimes(2);
    });

    it('addFacts invalidates the turn cache so new facts are visible', async () => {
      const store = await createStore();
      await store.addFacts(['Fact one about dark mode preference'], 'test');

      const first = await store.search('dark mode preference');
      // Add a new fact — should clear the per-turn cache.
      await store.addFacts(['Fact two about dark mode preference also'], 'test');
      const second = await store.search('dark mode preference');

      expect(second.length).toBeGreaterThanOrEqual(first.length);
    });

    it('respects BERNARD_CACHE_ENABLED=false', async () => {
      const original = process.env.BERNARD_CACHE_ENABLED;
      process.env.BERNARD_CACHE_ENABLED = 'false';
      try {
        const store = await createStore();
        await store.addFacts(['User prefers dark mode for all editors'], 'test');

        const embedSpy = vi.spyOn(mockProvider!, 'embed');
        await store.search('dark mode preference');
        await store.search('dark mode preference');

        // Cache disabled — both calls embed.
        expect(embedSpy).toHaveBeenCalledTimes(2);
      } finally {
        if (original === undefined) delete process.env.BERNARD_CACHE_ENABLED;
        else process.env.BERNARD_CACHE_ENABLED = original;
      }
    });
  });

  describe('persistence', () => {
    it('loads memories on construction', async () => {
      const memories = [
        {
          id: '1',
          fact: 'test fact',
          embedding: Array(16)
            .fill(0)
            .map((_, i) => (i === 0 ? 1 : 0)),
          source: 'test',
          domain: 'general',
          createdAt: new Date().toISOString(),
          accessCount: 0,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(memories));

      const store = await createStore();
      expect(store.count()).toBe(1);
    });

    it('backfills general domain for legacy entries without domain', async () => {
      const memories = [
        {
          id: '1',
          fact: 'legacy fact',
          embedding: Array(16)
            .fill(0)
            .map((_, i) => (i === 0 ? 1 : 0)),
          source: 'test',
          createdAt: new Date().toISOString(),
          accessCount: 0,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(memories));

      const store = await createStore();
      const facts = store.listFacts();
      expect(facts[0]).toContain('[general]');
    });

    it('handles missing file gracefully', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const store = await createStore();
      expect(store.count()).toBe(0);
    });

    it('handles corrupted file gracefully', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');

      const store = await createStore();
      expect(store.count()).toBe(0);
    });
  });

  describe('Float32Array embedding serialization', () => {
    function createFloat32Provider(): EmbeddingProvider {
      return {
        async embed(texts: string[]): Promise<number[][]> {
          // Simulate fastembed returning Float32Array
          return fakeEmbed(texts).map((e) => new Float32Array(e) as unknown as number[]);
        },
        dimensions(): number {
          return 16;
        },
      };
    }

    it('addFacts converts Float32Array embeddings to plain arrays for persistence', async () => {
      mockProvider = createFloat32Provider();
      const store = await createStore();
      await store.addFacts(['User prefers dark mode'], 'test');

      // Grab the JSON written to disk
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls.at(-1);
      expect(writeCall).toBeDefined();
      const persisted = persistedRecords(writeCall![1] as string);
      expect(Array.isArray(persisted[0].embedding)).toBe(true);
      // Verify it serializes as a real array, not {"0":...,"1":...}
      const reserialized = JSON.parse(JSON.stringify(persisted[0].embedding));
      expect(Array.isArray(reserialized)).toBe(true);
    });

    it('search works when provider returns Float32Array embeddings', async () => {
      mockProvider = createFloat32Provider();
      const store = await createStore();
      await store.addFacts(['User prefers dark mode for all editors'], 'test');
      const results = await store.search('User prefers dark mode for all editors');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].similarity).not.toBeNaN();
      expect(results[0].fact).toContain('dark mode');
    });

    it('searchWithIds works when provider returns Float32Array embeddings', async () => {
      mockProvider = createFloat32Provider();
      const store = await createStore();
      await store.addFacts(['User prefers dark mode for all editors'], 'test');
      const results = await store.searchWithIds('User prefers dark mode for all editors');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].similarity).not.toBeNaN();
    });

    it('load() converts object-shaped embeddings back to arrays', async () => {
      // Simulate a corrupted file where Float32Array was serialized as {"0":...}
      const objectEmbedding: Record<string, number> = {};
      for (let i = 0; i < 16; i++) {
        objectEmbedding[String(i)] = i === 0 ? 1 : 0;
      }
      const memories = [
        {
          id: '1',
          fact: 'test fact',
          embedding: objectEmbedding,
          source: 'test',
          domain: 'general',
          createdAt: new Date().toISOString(),
          accessCount: 0,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(memories));

      const store = await createStore();
      expect(store.count()).toBe(1);

      // Search should work against the repaired embedding
      const results = await store.search('test fact');
      for (const r of results) {
        expect(r.similarity).not.toBeNaN();
      }
    });

    it('load() preserves already-correct array embeddings', async () => {
      const memories = [
        {
          id: '1',
          fact: 'test fact',
          embedding: Array(16)
            .fill(0)
            .map((_, i) => (i === 0 ? 1 : 0)),
          source: 'test',
          domain: 'general',
          createdAt: new Date().toISOString(),
          accessCount: 0,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(memories));

      const store = await createStore();
      const results = await store.search('test fact');
      for (const r of results) {
        expect(r.similarity).not.toBeNaN();
      }
    });
  });

  describe('listFacts', () => {
    it('returns formatted fact list with domain and expiration', async () => {
      const memories = [
        {
          id: '1',
          fact: 'test fact',
          embedding: Array(16)
            .fill(0)
            .map((_, i) => (i === 0 ? 1 : 0)),
          source: 'test',
          domain: 'tool-usage',
          createdAt: '2025-01-15T00:00:00.000Z',
          accessCount: 3,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(memories));

      const store = await createStore();
      const facts = store.listFacts();
      expect(facts).toHaveLength(1);
      expect(facts[0]).toContain('2025-01-15');
      expect(facts[0]).toContain('[tool-usage]');
      expect(facts[0]).toContain('3x');
      expect(facts[0]).toContain('test fact');
      expect(facts[0]).toMatch(/expires in \d+d/);
    });
  });

  describe('countByDomain', () => {
    it('returns correct counts per domain', async () => {
      const store = await createStore();
      await store.addFacts(['fact A', 'fact B'], 'test', 'general');
      await store.addFacts(['tool fact'], 'test', 'tool-usage');

      const counts = store.countByDomain();
      expect(counts['general']).toBe(2);
      expect(counts['tool-usage']).toBe(1);
    });

    it('returns empty object when no memories', async () => {
      const store = await createStore();
      const counts = store.countByDomain();
      expect(counts).toEqual({});
    });
  });

  describe('clear', () => {
    it('removes all memories', async () => {
      const store = await createStore();
      await store.addFacts(['fact 1', 'fact 2'], 'test');
      store.clear();
      expect(store.count()).toBe(0);
    });
  });

  describe('searchWithIds', () => {
    it('returns results with id, createdAt, and accessCount', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode for all editors'], 'test', 'user-preferences');
      const results = await store.searchWithIds('User prefers dark mode for all editors');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('id');
      expect(results[0]).toHaveProperty('createdAt');
      expect(results[0]).toHaveProperty('accessCount');
      expect(results[0].domain).toBe('user-preferences');
      expect(results[0].fact).toContain('dark mode');
    });

    it('does NOT update accessCount', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode'], 'test');

      // Clear mocks to track only searchWithIds calls
      vi.mocked(fs.writeFileSync).mockClear();
      vi.mocked(fs.renameSync).mockClear();

      const results = await store.searchWithIds('User prefers dark mode');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].accessCount).toBe(0);

      // persist should NOT be called (no access metadata update)
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('returns empty when no memories', async () => {
      const store = await createStore();
      const results = await store.searchWithIds('anything');
      expect(results).toEqual([]);
    });

    it('returns empty when provider is unavailable', async () => {
      const store = await createStore();
      await store.addFacts(['some fact'], 'test');
      mockProvider = null;
      const results = await store.searchWithIds('some fact');
      expect(results).toEqual([]);
    });
  });

  describe('listMemories', () => {
    it('returns all memories with correct fields', async () => {
      const store = await createStore();
      await store.addFacts(['fact A'], 'test', 'general');
      await store.addFacts(['fact B'], 'test', 'tool-usage');

      const memories = store.listMemories();
      expect(memories).toHaveLength(2);
      expect(memories[0]).toHaveProperty('id');
      expect(memories[0]).toHaveProperty('fact');
      expect(memories[0]).toHaveProperty('domain');
      expect(memories[0]).toHaveProperty('createdAt');
      expect(memories[0]).toHaveProperty('accessCount');
      expect(memories[0].similarity).toBe(1.0);
    });

    it('returns empty array when no memories', async () => {
      const store = await createStore();
      const memories = store.listMemories();
      expect(memories).toEqual([]);
    });
  });

  describe('expiration', () => {
    it('addFacts sets expiresAt ~90 days in the future', async () => {
      const store = await createStore();
      await store.addFacts(['User prefers dark mode'], 'test');

      // Inspect the persisted data
      const writeCall = vi
        .mocked(fs.writeFileSync)
        .mock.calls.find((c) => /memories\.json\..*\.tmp$/.test(String(c[0])));
      expect(writeCall).toBeDefined();
      const persisted = persistedRecords(writeCall![1] as string);
      expect(persisted[0].expiresAt).toBeDefined();

      const expiresAt = new Date(persisted[0].expiresAt).getTime();
      const expectedMin = Date.now() + 89 * 86400000;
      const expectedMax = Date.now() + 91 * 86400000;
      expect(expiresAt).toBeGreaterThan(expectedMin);
      expect(expiresAt).toBeLessThan(expectedMax);
    });

    it('removes expired facts on startup', async () => {
      const pastExpiry = new Date(Date.now() - 86400000).toISOString();
      const futureExpiry = new Date(Date.now() + 30 * 86400000).toISOString();
      const memories = [
        {
          id: '1',
          fact: 'expired fact',
          embedding: Array(16)
            .fill(0)
            .map((_, i) => (i === 0 ? 1 : 0)),
          source: 'test',
          domain: 'general',
          createdAt: new Date(Date.now() - 100 * 86400000).toISOString(),
          accessCount: 0,
          expiresAt: pastExpiry,
        },
        {
          id: '2',
          fact: 'valid fact',
          embedding: Array(16)
            .fill(0)
            .map((_, i) => (i === 1 ? 1 : 0)),
          source: 'test',
          domain: 'general',
          createdAt: new Date().toISOString(),
          accessCount: 0,
          expiresAt: futureExpiry,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(memories));

      const store = await createStore();
      expect(store.count()).toBe(1);
      const facts = store.listFacts();
      expect(facts[0]).toContain('valid fact');
    });

    it('backfill gives at least 14 days grace for old legacy facts', async () => {
      const memories = [
        {
          id: '1',
          fact: 'old legacy fact',
          embedding: Array(16)
            .fill(0)
            .map((_, i) => (i === 0 ? 1 : 0)),
          source: 'test',
          domain: 'general',
          createdAt: new Date(Date.now() - 200 * 86400000).toISOString(),
          accessCount: 5,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(memories));

      const store = await createStore();
      expect(store.count()).toBe(1);

      // 200 days old with 90d TTL → remaining is negative → 14d grace period
      const facts = store.listFacts();
      expect(facts[0]).toMatch(/expires in 1[34]d/);
    });

    it('backfill gives remaining TTL for recent legacy facts', async () => {
      const memories = [
        {
          id: '1',
          fact: 'recent legacy fact',
          embedding: Array(16)
            .fill(0)
            .map((_, i) => (i === 0 ? 1 : 0)),
          source: 'test',
          domain: 'general',
          createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
          accessCount: 0,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(memories));

      const store = await createStore();
      expect(store.count()).toBe(1);

      // 10 days old with 90d TTL → ~80 days remaining
      const facts = store.listFacts();
      expect(facts[0]).toMatch(/expires in (79|80|81)d/);
    });

    it('search extends expiresAt when fact is close to expiring', async () => {
      const nearExpiry = new Date(Date.now() + 3 * 86400000).toISOString();
      const memories = [
        {
          id: '1',
          fact: 'fact about to expire with testing keywords',
          embedding: fakeEmbed(['fact about to expire with testing keywords'])[0],
          source: 'test',
          domain: 'general',
          createdAt: new Date(Date.now() - 87 * 86400000).toISOString(),
          accessCount: 0,
          expiresAt: nearExpiry,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(memories));

      const store = await createStore();

      // Clear write mocks to only see search-triggered writes
      vi.mocked(fs.writeFileSync).mockClear();

      const originalExpiry = new Date(memories[0].expiresAt).getTime();
      await store.search('fact about to expire with testing keywords');
      // The bump is in memory until something flushes it (#533) — the whole
      // point of the change. Asserting the extension still lands proves the
      // debounce defers the write without losing the bookkeeping.
      store.flush();

      // Get the persisted data after search
      const writeCall = vi
        .mocked(fs.writeFileSync)
        .mock.calls.find((c) => /memories\.json\..*\.tmp$/.test(String(c[0])));
      expect(writeCall).toBeDefined();
      const updatedData = persistedRecords(writeCall![1] as string);

      // **The count still lands; the extension deliberately does not (#372).**
      // This test previously asserted the opposite, and that contract WAS the
      // entrenchment loop: `search` fires on every returned hit with no
      // judgment involved, so extending here let a fact live forever by being
      // topically adjacent to something. Observed on a real store: 31 stale
      // facts at `accessCount` up to 40, due to expire in Sept–Oct and renewing
      // indefinitely.
      //
      // The retrieval is still recorded — it is true, and the count feeds the
      // prune score. What it no longer buys is life. Endorsement does, and
      // arrives through `recordAccess` with the ids a curator kept after seeing
      // every candidate; re-observation does too (#525).
      expect(updatedData[0].accessCount).toBe(1);
      expect(new Date(updatedData[0].expiresAt).getTime()).toBe(originalExpiry);
    });

    it('recordAccess still extends, because endorsement is a judgment', async () => {
      // The other half of the split. `recall-filter` calls this with the ids a
      // curator explicitly KEPT after seeing all ~24 candidates in one prompt —
      // no position bias, no unexposed-vs-negative entanglement — so it is a
      // relevance judgment rather than topical adjacency, and it earns a TTL.
      const soon = new Date(Date.now() + 3 * 86400000).toISOString();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify([
          {
            id: 'endorsed',
            fact: 'a fact the curator kept',
            embedding: fakeEmbed(['a fact the curator kept'])[0],
            source: 'compression',
            domain: 'general',
            createdAt: new Date().toISOString(),
            accessCount: 0,
            expiresAt: soon,
          },
        ]),
      );
      const store = await createStore();
      store.recordAccess(['endorsed']);
      store.flush();
      const call = vi
        .mocked(fs.writeFileSync)
        .mock.calls.filter((c) => /memories\.json\..*\.tmp$/.test(String(c[0])))
        .at(-1)!;
      const rec = persistedRecords(call[1] as string)[0];
      expect(new Date(rec.expiresAt).getTime()).toBeGreaterThan(new Date(soon).getTime());
    });

    it('listFacts shows expiration in output', async () => {
      const store = await createStore();
      await store.addFacts(['some fact about expiration display'], 'test');

      const facts = store.listFacts();
      expect(facts[0]).toMatch(/expires in \d+d/);
      expect(facts[0]).toContain('expires in 90d');
    });

    it('idle days shift expiresAt forward', async () => {
      const expiresIn30Days = new Date(Date.now() + 30 * 86400000).toISOString();
      const memories = [
        {
          id: '1',
          fact: 'a fact',
          embedding: Array(16)
            .fill(0)
            .map((_, i) => (i === 0 ? 1 : 0)),
          source: 'test',
          domain: 'general',
          createdAt: new Date(Date.now() - 60 * 86400000).toISOString(),
          accessCount: 2,
          expiresAt: expiresIn30Days,
        },
      ];

      // Last session was 31 days ago → 30 idle days
      const lastSession = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);

      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.includes('memories.json')) return true;
        if (pathStr.includes('last-session.txt')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.includes('memories.json')) return JSON.stringify(memories);
        if (pathStr.includes('last-session.txt')) return lastSession;
        return '';
      });

      const store = await createStore();
      expect(store.count()).toBe(1);

      // Original: 30 days from now → after 30 idle days shift: ~60 days from now
      const facts = store.listFacts();
      expect(facts[0]).toMatch(/expires in (59|60|61)d/);
    });

    it('consecutive days (no idle gap) does not shift expiresAt', async () => {
      const expiresIn30Days = new Date(Date.now() + 30 * 86400000).toISOString();
      const memories = [
        {
          id: '1',
          fact: 'a fact',
          embedding: Array(16)
            .fill(0)
            .map((_, i) => (i === 0 ? 1 : 0)),
          source: 'test',
          domain: 'general',
          createdAt: new Date(Date.now() - 60 * 86400000).toISOString(),
          accessCount: 0,
          expiresAt: expiresIn30Days,
        },
      ];

      // Last session was yesterday → 0 idle days
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.includes('memories.json')) return true;
        if (pathStr.includes('last-session.txt')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.includes('memories.json')) return JSON.stringify(memories);
        if (pathStr.includes('last-session.txt')) return yesterday;
        return '';
      });

      const store = await createStore();
      expect(store.count()).toBe(1);

      // No shift — should still be ~30 days
      const facts = store.listFacts();
      expect(facts[0]).toMatch(/expires in (29|30|31)d/);
    });

    it('saves session date on first use so idle compensation works later', async () => {
      // First run: no memories, no session file
      const store = await createStore();
      await store.addFacts(['brand new fact'], 'test');

      // saveSessionDate should have been called in constructor
      const sessionWriteCall = vi
        .mocked(fs.writeFileSync)
        .mock.calls.find((c) => String(c[0]).includes('last-session.txt'));
      expect(sessionWriteCall).toBeDefined();

      const dateWritten = sessionWriteCall![1] as string;
      expect(dateWritten).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('deleteByIds', () => {
    it('deletes matching memories and persists', async () => {
      const store = await createStore();
      await store.addFacts(['fact A', 'fact B', 'fact C'], 'test');

      const all = store.listMemories();
      expect(all).toHaveLength(3);

      vi.mocked(fs.writeFileSync).mockClear();
      vi.mocked(fs.renameSync).mockClear();

      const deleted = store.deleteByIds([all[0].id, all[2].id]);
      expect(deleted).toBe(2);
      expect(store.count()).toBe(1);
      expect(store.listMemories()[0].id).toBe(all[1].id);

      // Should persist after deletion
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });

    it('returns 0 for empty ids array', async () => {
      const store = await createStore();
      await store.addFacts(['fact A'], 'test');
      const deleted = store.deleteByIds([]);
      expect(deleted).toBe(0);
      expect(store.count()).toBe(1);
    });

    it('returns 0 for non-existent ids', async () => {
      const store = await createStore();
      await store.addFacts(['fact A'], 'test');

      vi.mocked(fs.writeFileSync).mockClear();

      const deleted = store.deleteByIds(['nonexistent-id']);
      expect(deleted).toBe(0);
      expect(store.count()).toBe(1);

      // Should NOT persist when nothing was deleted
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});

/**
 * The knowledge fence (#511).
 *
 * The `domain` axis has been populated and RANKED on since day one and never
 * once filtered on — `scoreAndRank` already groups by it. So a scoped search is
 * the same ranking over a smaller corpus, not a truncation of a wider result,
 * and that distinction is what these pin: the filter has to go in FRONT of the
 * grouping, or a scoped search returns whatever survived an unscoped top-k.
 */
describe('RAGStore domain scope (#511)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('[]');
    mockProvider = createFakeProvider();
  });

  async function seeded() {
    const store = await createStore({ similarityThreshold: -1 });
    await store.addFacts(['shared vocabulary alpha'], 'test', 'general');
    await store.addFacts(['shared vocabulary beta'], 'test', 'user-preferences');
    return store;
  }

  it('a scoped view retrieves only from the domains it was granted', async () => {
    const store = await seeded();
    const view = store.scoped(['general']);
    const hits = await view.search('shared vocabulary');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.domain === 'general')).toBe(true);
  });

  it('the unscoped store still sees everything', async () => {
    const store = await seeded();
    const domains = new Set((await store.search('shared vocabulary')).map((h) => h.domain));
    expect(domains).toEqual(new Set(['general', 'user-preferences']));
  });

  it('an empty scope retrieves nothing', async () => {
    const store = await seeded();
    expect(await store.scoped([]).search('shared vocabulary')).toEqual([]);
  });

  it('narrowing is monotone — a second scope cannot widen the first', async () => {
    const store = await seeded();
    const view = store.scoped(['general']).scoped(['general', 'user-preferences']);
    // Through what the view RETRIEVES rather than a scope accessor: the effect
    // is the property, and the bookkeeping is not public.
    const hits = await view.search('shared vocabulary');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.domain === 'general')).toBe(true);
  });

  /**
   * The two PRs in this wave interact here, and the interaction is silent.
   *
   * `scoped()` is a shallow clone, so a per-FIELD `dirty` flag would be copied
   * into the view: the view's search marks the view dirty, the exit hooks call
   * `flush()` on the ROOT, whose flag is still false, and #533's explicit-flush
   * half stops applying to every scoped dispatch. Holding the state in one
   * object shared by reference is what makes that unrepresentable.
   */
  it("a view's pending bookkeeping is flushed by the root store", async () => {
    const store = await seeded();
    store.flush();
    const before = storeWrites();
    await store.scoped(['general']).search('shared vocabulary');
    expect(storeWrites()).toBe(before);
    store.flush();
    expect(storeWrites()).toBeGreaterThan(before);
  });

  it('scoped(null) is the identity', async () => {
    const store = await seeded();
    expect(store.scoped(null)).toBe(store);
  });

  /**
   * The fail-open hazard neither #511 nor the audit had named.
   *
   * `turnSearchCache` is keyed on the query STRING alone. `main` searches
   * "deployment process" unscoped and caches fifteen results; a scoped child
   * searching the same string would get the UNSCOPED results straight out of
   * the cache, with no code path ever consulting a domain. So a view carries no
   * search cache — the embedding cache, where the real cost is, stays shared.
   */
  it('does not inherit the parent turn-search cache', async () => {
    const store = await seeded();
    // Warm the parent's cache with the unscoped answer for this exact query.
    const unscoped = await store.search('shared vocabulary');
    expect(unscoped.length).toBe(2);
    const scoped = await store.scoped(['general']).search('shared vocabulary');
    expect(scoped.every((h) => h.domain === 'general')).toBe(true);
  });
});

/**
 * The lexical index is per-(store, scope), and that is a correctness property
 * rather than a cache optimisation (#526 + #511).
 *
 * BM25 postings hold indices into the array the index was built from. A scoped
 * view searches `this.memories.filter(...)` — a different, shorter array — so a
 * cache shared with the unscoped store would map document 900 of the root
 * corpus onto element 900 of a 40-element scope. The original identity key hid
 * this by never hitting for a view (a fresh `filter` array each call), at the
 * cost of rebuilding ~77 ms of index per query; keying on
 * `(memories, domainScope)` makes it both correct and built once.
 */
describe('lexical index scoping (#526)', () => {
  beforeEach(() => {
    resetFsMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(
        [
          ['general', 'the resolveSiteModel helper lives in the policy layer'],
          ['tool-usage', 'a different note that also mentions resolveSiteModel'],
          ['conversations', 'unrelated chatter about lunch'],
        ].map(([domain, fact], i) => ({
          id: `r${i}`,
          fact,
          embedding: fakeEmbed([String(fact)])[0],
          source: 'test',
          domain,
          createdAt: new Date().toISOString(),
          accessCount: 0,
          expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
        })),
      ),
    );
  });

  it('a scoped view never returns a record outside its scope', async () => {
    const { RAGStore } = await import('./rag.js');
    const store = new RAGStore({ maxMemories: 100 });
    // Warm the UNSCOPED index first — this is what a real session does before
    // any scoped dispatch runs, and it is what a scope-blind cache would reuse.
    const all = await store.searchWithIds('resolveSiteModel', { threshold: 0 });
    expect(all.length).toBeGreaterThan(1);

    const scoped = await store.scoped(['general']).searchWithIds('resolveSiteModel', {
      threshold: 0,
    });
    expect(scoped.length).toBeGreaterThan(0);
    for (const hit of scoped) {
      expect(hit.domain, 'a scoped search returned an out-of-scope record').toBe('general');
    }
  });
});

/**
 * Dedup reinforces the survivor instead of discarding the observation (#525).
 *
 * On a collision `addFacts` used to `continue`: the newcomer was dropped and
 * the record it collided with gained NOTHING — no counter, no TTL refresh, no
 * source update. So re-learning a fact across ten sessions was indistinguishable
 * from learning it once, and repetition — the strongest available evidence that
 * a fact is durable — was invisible to the prune score.
 *
 * The measurement that bounds this: against the real provider at
 * `DEDUP_THRESHOLD = 0.92`, no contradicting pair reaches the threshold (the
 * highest measured is `deploy.sh` vs `release.sh` at 0.8759). So a collision
 * really is a near-restatement and reinforcing it is safe. The literature's
 * "treat a collision as supersession" advice answers a problem this embedder
 * does not have — that is #373's territory, which shipped separately.
 */
describe('dedup reinforcement (#525)', () => {
  /** Reads a field off the record as persisted — the store exposes no record accessor. */
  function persisted(s: { flush: () => void }, i: number): Record<string, unknown> {
    s.flush();
    const call = vi
      .mocked(fs.writeFileSync)
      .mock.calls.filter((c) => String(c[0]).includes('memories.json'))
      .at(-1)!;
    return persistedRecords(String(call[1]))[i];
  }
  const sourceOf = (s: any, i: number) => persisted(s, i).source as string;
  /** Days-to-expiry off the LIVE record, via `listFacts`' own rendering. */
  const daysLeft = (s: { listFacts: () => string[] }, i: number): number =>
    Number(/expires in (\d+)d/.exec(s.listFacts()[i])![1]);

  beforeEach(resetFsMocks);

  it('counts a re-observation instead of dropping it silently', async () => {
    const s = await createStore();
    expect(await s.addFacts(['the deploy script is deploy.sh'], 'compression')).toBe(1);
    // Identical text embeds identically, so this is a guaranteed collision.
    expect(await s.addFacts(['the deploy script is deploy.sh'], 'exit')).toBe(0);

    expect(s.listFacts()[0], 'the survivor gained nothing on the collision').toContain(
      'observed 1x',
    );
  });

  it('keeps the newer source, because the later observation is better evidenced', async () => {
    const s = await createStore();
    await s.addFacts(['a durable fact'], 'compression');
    await s.addFacts(['a durable fact'], 'exit');
    expect(sourceOf(s, 0)).toBe('exit');
  });

  it('extends a near-expiry survivor, so repetition keeps a fact alive', async () => {
    // Seeded close to expiry on purpose. A FRESH record already has the full
    // TTL, and the extension is monotone — it never shortens — so reinforcing
    // one changes nothing. The extension exists for the record that has been
    // sitting for months and is about to be pruned, which is precisely the case
    // where "it was learned again" should matter.
    const soon = new Date(Date.now() + 2 * 86400000).toISOString();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        {
          id: 'old',
          fact: 'a durable fact',
          embedding: fakeEmbed(['a durable fact'])[0],
          source: 'compression',
          domain: 'general',
          createdAt: new Date(Date.now() - 88 * 86400000).toISOString(),
          accessCount: 0,
          expiresAt: soon,
        },
      ]),
    );
    const s = await createStore();
    expect(daysLeft(s, 0)).toBeLessThanOrEqual(2);
    await s.addFacts(['a durable fact'], 'exit');
    expect(daysLeft(s, 0), 'a near-expiry record was not extended').toBeGreaterThan(2);
  });

  it('never shortens an expiry it was going to outlive anyway', async () => {
    // The monotone guard. Without it, reinforcing a fresh record would pull its
    // 90-day expiry back to the ~52 days one observation earns — so being
    // learned again would make a fact die SOONER.
    const s = await createStore();
    await s.addFacts(['a durable fact'], 'compression');
    const before = daysLeft(s, 0);
    expect(before).toBeGreaterThan(80);
    await s.addFacts(['a durable fact'], 'exit');
    expect(daysLeft(s, 0), 'reinforcement pulled the expiry backwards').toBe(before);
  });

  it('does not count a reinforcement as an addition', async () => {
    // `addFacts` returns the number ADDED. Reporting a reinforcement as an add
    // would make the exit worker and `compressHistory` claim work they did not
    // do, and would trip the eager `prune`/`persist` path below.
    const s = await createStore();
    await s.addFacts(['a durable fact'], 'compression');
    expect(await s.addFacts(['a durable fact'], 'exit')).toBe(0);
    expect(s.count()).toBe(1);
  });

  it('takes the debounced write path, not the eager one', async () => {
    // Reinforcement is decay metadata, not content: a crash must not lose a
    // fact, but losing the note that one was observed again costs a single TTL
    // extension. `addFacts` persists eagerly when it ADDS; this must not.
    const s = await createStore();
    await s.addFacts(['a durable fact'], 'compression');
    const before = vi
      .mocked(fs.writeFileSync)
      .mock.calls.filter((c) => String(c[0]).includes('memories.json')).length;
    await s.addFacts(['a durable fact'], 'exit');
    expect(
      vi.mocked(fs.writeFileSync).mock.calls.filter((c) => String(c[0]).includes('memories.json'))
        .length,
      'reinforcement wrote eagerly',
    ).toBe(before);
    s.flush();
    expect(
      vi.mocked(fs.writeFileSync).mock.calls.filter((c) => String(c[0]).includes('memories.json'))
        .length,
    ).toBeGreaterThan(before);
  });

  it('bumpAccess never shortens an expiry either', async () => {
    // Not strictly #525 — `bumpAccess` carries the identical monotone guard and
    // had no test at all, which is how a mutation aimed at `reinforce` landed
    // there instead and reported a false survivor. Same invariant, same cost:
    // a retrieval that pulls a fact's expiry BACKWARDS would make being useful
    // a reason to die sooner.
    const s = await createStore();
    await s.addFacts(['a durable fact'], 'compression');
    const before = daysLeft(s, 0);
    await s.search('a durable fact');
    expect(daysLeft(s, 0), 'a search pulled the expiry backwards').toBe(before);
  });

  it('gives repetition weight in the prune score, so the field is not write-only', async () => {
    // The load-bearing half. `source` and `lastAccessed` are both written by
    // this store and read by nothing; a third write-only field would record the
    // observation and still fail to save the record from a prune.
    // **Alpha is seeded OLDEST on purpose.** Created in the same millisecond as
    // its rivals it has identical recency, a stable sort keeps insertion order,
    // and the test passes whether or not `observedCount` carries any weight —
    // which is how the first cut of this passed with the term mutated to zero.
    // Aged, alpha loses on recency and can only survive on repetition.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(
        [
          ['alpha fact one', 80],
          ['beta fact two', 1],
        ].map(([fact, ageDays]) => ({
          id: String(fact),
          fact,
          embedding: fakeEmbed([String(fact)])[0],
          source: 'compression',
          domain: 'general',
          createdAt: new Date(Date.now() - (ageDays as number) * 86400000).toISOString(),
          accessCount: 0,
          expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
        })),
      ),
    );
    const { RAGStore } = await import('./rag.js');
    const s = new RAGStore({ maxMemories: 2 });
    // Re-observe alpha twice, then push the store over its cap.
    await s.addFacts(['alpha fact one'], 'exit');
    await s.addFacts(['alpha fact one'], 'exit');
    await s.addFacts(['gamma fact three'], 'compression');

    const kept = s.listFacts();
    expect(
      kept.some((f) => f.includes('alpha fact one')),
      'the repeatedly observed fact was pruned',
    ).toBe(true);
    expect(kept).toHaveLength(2);
  });

  it('reads a legacy record with no observedCount as zero', async () => {
    // Every record written before this lacks the field; absent must not be NaN,
    // which would poison the prune sort for the whole store.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        {
          id: 'legacy',
          fact: 'a fact from before the field existed',
          embedding: fakeEmbed(['a fact from before the field existed'])[0],
          source: 'compression',
          domain: 'general',
          createdAt: new Date().toISOString(),
          accessCount: 3,
        },
      ]),
    );
    const s = await createStore();
    expect(s.count()).toBe(1);
    expect(s.listFacts()[0], 'a legacy record should show no observation').not.toContain(
      'observed',
    );
    // And it still reinforces cleanly from absent, rather than yielding NaN —
    // which would poison the prune sort for the whole store.
    await s.addFacts(['a fact from before the field existed'], 'exit');
    expect(s.listFacts()[0]).toContain('observed 1x');
  });
});

/**
 * Breaking the entrenchment loop (#372).
 *
 * `search()` bumped every returned hit unconditionally and extended its TTL, so
 * retrieval raised the score, a higher score meant a higher chance of
 * retrieval, and nothing ever consulted whether the retrieval helped. Observed
 * on a real store: 31 stale facts with `accessCount` up to 40, originally due
 * to expire Sept–Oct, renewing indefinitely.
 *
 * Rejection-as-a-signal is deliberately NOT here — see the PR. The curator's
 * drop is conditioned on the query rather than the fact, and the candidate pool
 * is deliberately widened (0.28 against the store's 0.35), so most rejections
 * are the widening working as designed.
 */
describe('scoring: the entrenchment loop (#372)', () => {
  beforeEach(resetFsMocks);

  /** Seeds records with explicit ages, access counts and last-access times. */
  function seed(
    rows: Array<{
      id: string;
      fact: string;
      ageDays: number;
      access?: number;
      observed?: number;
      lastAccessDays?: number;
    }>,
  ) {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          fact: r.fact,
          embedding: fakeEmbed([r.fact])[0],
          source: 'compression',
          domain: 'general',
          createdAt: new Date(Date.now() - r.ageDays * 86400000).toISOString(),
          accessCount: r.access ?? 0,
          observedCount: r.observed,
          lastAccessed:
            r.lastAccessDays === undefined
              ? undefined
              : new Date(Date.now() - r.lastAccessDays * 86400000).toISOString(),
          expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
        })),
      ),
    );
  }

  async function pruneTo(n: number): Promise<string[]> {
    const { RAGStore } = await import('./rag.js');
    const store = new RAGStore({ maxMemories: n });
    // `prune()` runs only from `addFacts` when something was added, so a
    // scoring change has no effect until the next write.
    await store.addFacts(['a brand new unrelated fact'], 'compression');
    return store.listFacts();
  }

  it('weighs an independent re-observation above a retrieval', async () => {
    // The ordering `OBSERVATION_WEIGHT` exists to produce, and the one thing
    // three separately-calibrated constants can silently stop producing. Both
    // records are the same age and past the newcomer window, so the only term
    // that differs is which counter carries the 2:
    //
    //   observed twice:  0.71 + 0.00 + log2(3)*2 = 3.88
    //   retrieved twice: 0.71 + log2(3)   + 0.00 = 2.29
    //
    // `accessCount` says a fact is adjacent to what gets asked; `observedCount`
    // says it was independently learned again. Without this, dropping the
    // weight to 1 passes every other test in this file.
    seed([
      {
        id: 'relearned',
        fact: 'a fact independently learned again across sessions',
        ageDays: 20,
        observed: 2,
      },
      {
        id: 'retrieved',
        fact: 'a fact that keeps turning up in adjacent searches',
        ageDays: 20,
        access: 2,
        lastAccessDays: 0,
      },
    ]);
    const kept = await pruneTo(2);
    expect(kept.join('\n'), 'repetition lost to adjacency').toContain('independently learned');
    expect(kept.join('\n')).not.toContain('adjacent searches');
  });

  it('caps access credit, so an incumbent cannot outrank on volume alone', async () => {
    // Uncapped, `log2(40 + 1)` is 5.36 against a recency term bounded at 1.0 —
    // by `accessCount` 40 recency is noise. Capped at 5 it tops out at ~2.58,
    // and recency decides between two facts that have both been used.
    //
    // **Both are well past the newcomer window on purpose.** An earlier version
    // compared against a 6-day-old fact, and the newcomer FLOOR rescued it
    // whether or not the cap existed — so uncapping the credit survived the
    // mutation check. Here the cap is the only thing that decides:
    //
    //   capped:   fresher 0.79 + 2.58 = 3.37   hoarder 0.63 + 2.58 = 3.21
    //   uncapped: fresher 0.79 + 2.58 = 3.37   hoarder 0.63 + 5.36 = 5.99
    seed([
      {
        id: 'hoarder',
        fact: 'an older fact retrieved constantly',
        ageDays: 60,
        access: 40,
        lastAccessDays: 0,
      },
      {
        id: 'fresher',
        fact: 'a newer fact used a few times',
        ageDays: 30,
        access: 5,
        lastAccessDays: 0,
      },
    ]);
    const kept = await pruneTo(1);
    expect(kept.some((f) => f.includes('a newer fact used a few times'))).toBe(true);
    expect(kept.some((f) => f.includes('an older fact retrieved constantly'))).toBe(false);
  });

  it('decays credit by how long ago the fact was last retrieved', async () => {
    // A fact retrieved fifty times in March kept that credit forever. Decayed,
    // an equally-accessed fact that has not been touched in six months loses to
    // one touched yesterday — which is what `lastAccessed` is for, and this is
    // that field's first reader.
    seed([
      { id: 'cold', fact: 'heavily used long ago', ageDays: 200, access: 5, lastAccessDays: 180 },
      { id: 'warm', fact: 'equally used but recently', ageDays: 200, access: 5, lastAccessDays: 1 },
    ]);
    const kept = await pruneTo(2);
    expect(kept.some((f) => f.includes('equally used but recently'))).toBe(true);
    expect(kept.some((f) => f.includes('heavily used long ago'))).toBe(false);
  });

  it('protects a newcomer from an established incumbent', async () => {
    // The observed asymmetry: five new facts at accessCount 0 against 31 at up
    // to 40. Recency alone cannot rescue them — it is bounded at 1.0 while the
    // access term was not.
    seed([
      {
        id: 'incumbent',
        fact: 'an entrenched old fact',
        ageDays: 120,
        access: 40,
        lastAccessDays: 0,
      },
      { id: 'correction', fact: 'a correction written today', ageDays: 0, access: 0 },
    ]);
    const kept = await pruneTo(2);
    expect(kept.some((f) => f.includes('a correction written today'))).toBe(true);
  });

  it('the newcomer window expires, so protection is not permanent', async () => {
    seed([
      {
        id: 'incumbent',
        fact: 'an entrenched old fact',
        ageDays: 120,
        access: 5,
        lastAccessDays: 0,
      },
      { id: 'stale-newcomer', fact: 'a fact past its window', ageDays: 30, access: 0 },
    ]);
    const kept = await pruneTo(2);
    expect(kept.some((f) => f.includes('a fact past its window'))).toBe(false);
  });
});

describe('the addFacts observer (#250)', () => {
  it('reports only facts that were actually stored', async () => {
    // The receipt's whole honesty rests on this: the extraction knows what it
    // proposed, and only the store knows what survived dedup.
    const store = await createStore();
    const seen: string[] = [];
    await store.addFacts(['a unique first fact about deployment'], 'test', 'general', (f) =>
      seen.push(f),
    );
    const before = seen.length;
    await store.addFacts(['a unique first fact about deployment'], 'test', 'general', (f) =>
      seen.push(f),
    );
    expect(before).toBe(1);
    expect(seen.length).toBe(1); // the duplicate reported nothing
  });

  it('survives a throwing observer with the facts still stored', async () => {
    // Mid-loop and AFTER the push, so an unguarded throw would abandon the
    // remaining facts and reject `addFacts` with records already written.
    const store = await createStore();
    const added = await store.addFacts(
      ['the deployment pipeline runs on Tuesdays', 'jalapeño harvest peaks in August'],
      'test',
      'general',
      () => {
        throw new Error('boom');
      },
    );
    expect(added).toBe(2);
  });
});
