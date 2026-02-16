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
  getEmbeddingProvider: vi.fn(async () => mockProvider),
  cosineSimilarity: vi.fn((a: number[], b: number[]) => {
    // Real cosine similarity for deterministic fake embeddings
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
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
      embedding[(i * 7 + Math.abs(hash)) % dims] += (hash & 1) ? 1 : -1;
    }
    // Normalize
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? embedding.map((v) => v / norm) : embedding;
  });
}

function createFakeProvider(): EmbeddingProvider {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return fakeEmbed(texts);
    },
    dimensions(): number {
      return 16;
    },
  };
}

describe('RAGStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('[]');
    mockProvider = createFakeProvider();
  });

  async function createStore(config?: import('./rag.js').RAGStoreConfig) {
    const { RAGStore } = await import('./rag.js');
    return new RAGStore({ maxMemories: 100, ...config });
  }

  describe('addFacts', () => {
    it('stores facts with embeddings', async () => {
      const store = await createStore();
      const added = await store.addFacts(['User prefers dark mode', 'Project uses TypeScript'], 'compression');
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
      const facts = Array.from({ length: 110 }, (_, i) =>
        `Fact number ${i} about topic ${String.fromCharCode(65 + (i % 26))} with extra details ${i * 7}`
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
      await store.addFacts([
        'User prefers dark mode for all editors',
        'Project is built with TypeScript and Node.js',
        'The cat sat on the mat',
      ], 'test');

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
      const toolUsageResults = results.filter(r => r.domain === 'tool-usage');
      expect(toolUsageResults.length).toBeLessThanOrEqual(2);
    });

    it('caps total results at maxResults', async () => {
      const store = await createStore({ topKPerDomain: 5, maxResults: 3 });

      await store.addFacts([
        'Fact A about building software',
        'Fact B about building software',
        'Fact C about building software',
        'Fact D about building software',
        'Fact E about building software',
      ], 'test', 'general');

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

  describe('persistence', () => {
    it('loads memories on construction', async () => {
      const memories = [
        { id: '1', fact: 'test fact', embedding: Array(16).fill(0).map((_, i) => i === 0 ? 1 : 0), source: 'test', domain: 'general', createdAt: new Date().toISOString(), accessCount: 0 },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(memories));

      const store = await createStore();
      expect(store.count()).toBe(1);
    });

    it('backfills general domain for legacy entries without domain', async () => {
      const memories = [
        { id: '1', fact: 'legacy fact', embedding: Array(16).fill(0).map((_, i) => i === 0 ? 1 : 0), source: 'test', createdAt: new Date().toISOString(), accessCount: 0 },
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

  describe('listFacts', () => {
    it('returns formatted fact list with domain', async () => {
      const memories = [
        { id: '1', fact: 'test fact', embedding: Array(16).fill(0).map((_, i) => i === 0 ? 1 : 0), source: 'test', domain: 'tool-usage', createdAt: '2025-01-15T00:00:00.000Z', accessCount: 3 },
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
