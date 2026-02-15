# How Domain-Specific Memory Works

Bernard's memory system learns from your conversations and organizes what it learns into three specialized domains. Instead of treating every fact the same, it categorizes knowledge so it can extract better facts and recall the right ones at the right time.

This document walks through the full lifecycle — from how facts get extracted, to how they're stored, to how they show up in future conversations. It covers both the conceptual design and the technical implementation.

---

## The Problem with Flat Memory

Before domain-specific memory, Bernard stored all extracted facts in a single undifferentiated pool. A command like `npm run build` would sit alongside "user prefers concise responses" and "project uses PostgreSQL." When Bernard searched for relevant context, it relied entirely on cosine similarity — a mathematical measure of how close two pieces of text are in meaning.

This created three problems:

1. **Generic extraction** — A single prompt tried to catch everything, which meant it wasn't great at catching anything specific. Tool usage patterns need different attention than user preferences.

2. **Domain starvation** — If Bernard accumulated 50 general project facts and only 3 tool usage facts, similarity search would almost never surface the tool facts, even when you were asking about build commands.

3. **Unstructured recall** — The system prompt presented recalled facts as a flat bullet list, giving Bernard no signal about what *kind* of knowledge each fact represented.

---

## The Three Domains

Domain-specific memory solves these problems by partitioning knowledge into three categories. Each has its own extraction prompt, storage tag, and retrieval budget.

### Tool Usage Patterns (`tool-usage`)

The extraction prompt steers the LLM toward things like:
- Shell command sequences that accomplished a task
- Which tools were used together and in what order
- Error messages and how they were resolved
- Build, test, and deploy workflows
- Git workflows and branching patterns

These are examples, not a fixed list — the LLM generalizes from them and will capture any operational knowledge that fits the domain's intent. Think of this as Bernard's "muscle memory" — the operational knowledge of *how to do things* on your system.

### User Preferences (`user-preferences`)

The extraction prompt steers the LLM toward things like:
- Communication style preferences (verbosity, format)
- Workflow conventions (commit style, branching strategy)
- Repeated instructions or corrections you've given
- Naming conventions and coding style
- Explicit "always do X" or "never do Y" directives

These aren't hard-coded categories — the LLM generalizes from them. If you said "always respond in Spanish" or "I hate tabs," those would be captured as user preferences even though they aren't listed above. The bullet points are guidance that tells the LLM what *kind* of thing this domain is about, not an exhaustive list.

This is Bernard's understanding of *how you like things done*.

### General Knowledge (`general`)

The extraction prompt steers the LLM toward things like:
- Project structure and architecture decisions
- Technical environment details (languages, frameworks, versions)
- Team context, roles, and relationships
- Business requirements and domain concepts
- API endpoints, database schemas, configuration details

Same as above — these are examples, not a fixed list. If your conversation covered database migration strategies or third-party vendor constraints, the LLM would extract those as general knowledge even though they aren't explicitly enumerated.

This is the factual knowledge about *what things are* in your environment.

---

## The Extraction Pipeline

Facts are extracted at two points during a session: when the conversation gets compressed (mid-session) and when you exit (end of session). Here's how each works.

### Mid-Session: Context Compression

Bernard monitors token usage as the conversation grows. When estimated usage exceeds 75% of the model's context window, it triggers compression:

1. The conversation is split into "old" messages and the 4 most recent exchanges
2. Old messages are serialized into plain text
3. Two parallel operations kick off:
   - **Summarization** — An LLM call condenses the old messages into a bullet-point summary
   - **Domain extraction** — Three parallel LLM calls extract facts (one per domain)
4. The summary replaces the old messages in the conversation
5. Extracted facts are stored in the RAG database, tagged by domain

The key detail: summarization and extraction happen simultaneously via `Promise.all`, so compression doesn't take 4x longer — it takes roughly the same wall-clock time as a single LLM call.

### End of Session: Background Worker

When you type `/exit` or Ctrl+D:

1. The REPL serializes the full conversation history into text
2. It writes a temporary JSON file (`.pending-*.json`) to `~/.bernard/rag/` containing the serialized conversation plus provider/model info
3. It spawns a **detached background process** (`rag-worker.ts`) and immediately exits — you don't have to wait
4. The background worker:
   - Reads the temp file
   - Runs domain-specific extraction (3 parallel LLM calls)
   - Stores extracted facts per domain in the RAG database
   - Deletes the temp file

This design means exit is instantaneous. The LLM extraction work happens after Bernard's process has already returned control to your terminal. If the worker crashes, stale temp files older than 1 hour are cleaned up automatically on the next session start.

### How Domain Extraction Works

Each domain has a specialized LLM prompt (defined in `src/domains.ts`). The prompts follow a complementary exclusion pattern:

- **Tool Usage** prompt says "Extract command sequences, error resolutions, build workflows" and "Do NOT extract user preferences or project architecture"
- **User Preferences** prompt says "Extract communication style, workflow conventions, repeated instructions" and "Do NOT extract shell commands or project structure"
- **General Knowledge** prompt says "Extract project structure, environment info, architecture decisions" and "Do NOT extract shell commands or user preferences"

Each domain's "Do NOT extract" section mirrors the other domains' "Extract" sections. This minimizes overlap without needing deduplication across domains.

All three extraction calls run in parallel via `Promise.allSettled`. If one domain's extraction fails (network error, invalid JSON response, etc.), the other two still succeed. Partial failure is handled gracefully.

The LLM returns a JSON array of strings. Each fact must be:
- Self-contained (understandable without the original conversation)
- At most 500 characters
- A non-empty string

---

## Storage

Facts are stored in `~/.bernard/rag/memories.json`. Each memory entry looks like:

```
{
  "id": "1707000000000-a1b2c3",
  "fact": "npm run build compiles TypeScript to dist/ directory",
  "embedding": [0.012, -0.045, ...],    // 384-dimension vector
  "source": "compression" | "exit",
  "domain": "tool-usage",
  "createdAt": "2025-02-14T10:00:00.000Z",
  "accessCount": 3,
  "lastAccessed": "2025-02-14T12:00:00.000Z"
}
```

### Embeddings

When a fact is stored, it's converted into a 384-dimensional vector using the `all-MiniLM-L6-v2` model from fastembed (runs locally, no API calls). This vector captures the *semantic meaning* of the text, so "npm run build compiles the project" and "how do I build this?" would have high similarity even though they share few words.

### Deduplication

Before adding a fact, Bernard checks if any existing memory has a cosine similarity above 0.92 (the dedup threshold). If so, the new fact is skipped as a duplicate. This prevents the same knowledge from accumulating over multiple sessions.

### Pruning

The store has a cap of 5,000 memories. When exceeded, memories are scored by:
- **Recency** — exponential decay with a 90-day half-life
- **Access frequency** — `log2(accessCount + 1)`

The lowest-scoring memories are pruned. This means frequently-accessed and recent facts survive; stale, unused facts get cleaned out.

### Backward Compatibility

When the store loads from disk, any memory entry missing a `domain` field (from before the domain system was added) is automatically assigned `domain: 'general'`. No migration script is needed.

---

## Retrieval: Per-Domain Top-K

When you send a message, Bernard searches the RAG store for relevant facts. Here's the algorithm:

1. Your message is embedded into a 384-dimension vector
2. Cosine similarity is computed against every stored memory
3. Memories below the similarity threshold (0.35) are filtered out
4. The remaining matches are sorted by similarity (highest first)
5. **Per-domain budgeting**: iterate through the sorted list, allowing up to **3 results per domain**
6. Merge all domain groups back together, sort by similarity, cap at **9 total**

### Why Per-Domain Top-K Matters

Without per-domain budgeting, if you had 200 general facts and 5 tool-usage facts, a query about "how to build the project" might return 9 general facts and 0 tool-usage facts — even though the tool-usage facts about `npm run build` would be the most useful.

With per-domain budgeting (3 per domain, 9 max), the same query would return up to 3 tool-usage facts, up to 3 user-preference facts, and up to 3 general facts — then the top 9 overall. This ensures every domain has a fair chance of being represented.

---

## System Prompt: Domain-Grouped Context

When recalled facts are injected into Bernard's system prompt, they're organized under domain headings:

```
## Recalled Context
Reference only if directly relevant to the current discussion.

### Tool Usage Patterns
- npm run build compiles TypeScript to dist/ directory
- git push origin main deploys to production

### User Preferences
- User prefers concise responses without excessive explanation

### General Knowledge
- Project uses PostgreSQL 15 with Prisma ORM
- API runs on port 3000 in development
```

This grouping gives the LLM clear signal about *what kind* of knowledge each fact represents. It can weigh tool-usage facts more heavily when you're asking about commands, and user-preference facts more heavily when deciding how to format a response.

Only domains with actual results get a heading — if no user-preference facts were recalled, that section is omitted entirely.

---

## Inspecting the System

You can see domain-specific memory stats in a running session:

```
/rag
```

This shows the total memory count and a per-domain breakdown:

```
  RAG memories: 47
  By domain:
    Tool Usage Patterns: 18
    User Preferences: 7
    General Knowledge: 22
```

---

## Adding New Domains

The domain registry (`src/domains.ts`) is designed to be extensible. Adding a new domain is a single entry in the `DOMAIN_REGISTRY` object:

1. Choose an `id` (machine key used in storage)
2. Write a `name` (human-readable, shown in system prompt headings)
3. Write a `description` (one-line, shown in `/rag`)
4. Write an `extractionPrompt` following the pattern:
   - Clear role framing on line 1
   - "Extract:" section listing what this domain captures
   - "Do NOT extract:" section listing what other domains handle
   - Output format instruction (JSON array of strings, max 500 chars)
5. Update the other domains' "Do NOT extract" sections to include the new domain's targets

Everything else — storage, retrieval, system prompt grouping, extraction parallelization — picks up the new domain automatically.

---

## Summary of the Data Flow

```
Session start
  └─ RAGStore loads memories.json (backfills domain: 'general' for legacy entries)
  └─ Cleans up stale .pending-*.json temp files (older than 1 hour)

User sends a message
  ├─ If context > 75% of window → compress
  │   ├─ Summarize old messages (LLM call)
  │   └─ Extract domain facts in parallel (3 LLM calls)  ──→ store per-domain
  ├─ Embed user message → search RAG store
  │   └─ Per-domain top-k (3/domain, 9 max)
  ├─ Build system prompt with domain-grouped recalled context
  └─ Generate response

User exits (/exit or Ctrl+D)
  ├─ Serialize full conversation → temp file
  ├─ Spawn detached background worker → exit immediately
  └─ Worker: extract domain facts (3 LLM calls) → store per-domain → delete temp file
```

---

# Technical Reference

Everything above describes the system conceptually. The sections below cover the implementation: module architecture, interfaces, algorithms, and the code paths that tie it all together.

---

## Module Architecture

The domain-specific memory system spans six source files. Here's how they depend on each other:

```
src/domains.ts          ← single source of truth, no dependencies
    ↑
src/rag.ts              ← imports DEFAULT_DOMAIN from domains
    ↑
src/context.ts          ← imports DOMAIN_REGISTRY, getDomainIds from domains
    ↑                      imports RAGStore type from rag
src/agent.ts            ← imports getDomain from domains
    ↑                      imports RAGSearchResult type from rag
src/rag-worker.ts       ← imports extractDomainFacts from context
    ↑                      imports RAGStore from rag
src/repl.ts             ← imports getDomain, getDomainIds from domains
                           imports RAGStore from rag
                           orchestrates the full lifecycle
```

`domains.ts` is the foundation — it has zero internal imports and defines the registry that every other module reads from. This means adding a new domain touches exactly one file, and everything downstream picks it up automatically.

---

## Core Interfaces

### `MemoryDomain` (src/domains.ts)

```typescript
interface MemoryDomain {
  id: string;                // machine key for storage/retrieval ('tool-usage')
  name: string;              // human-readable label ('Tool Usage Patterns')
  description: string;       // one-liner for /rag display
  extractionPrompt: string;  // full LLM system prompt for this domain
}
```

The `DOMAIN_REGISTRY` is a `Record<string, MemoryDomain>` — a plain object keyed by domain ID. `getDomainIds()` returns `Object.keys(DOMAIN_REGISTRY)`. `getDomain(id)` does a lookup with fallback to `DOMAIN_REGISTRY[DEFAULT_DOMAIN]` (which is `'general'`), so an unknown domain ID never causes a crash.

### `RAGMemory` (src/rag.ts)

```typescript
interface RAGMemory {
  id: string;              // '{timestamp}-{random6}' for uniqueness
  fact: string;            // the extracted text
  embedding: number[];     // 384-dim float vector from all-MiniLM-L6-v2
  source: string;          // 'compression' | 'exit' — when/how it was extracted
  domain: string;          // domain ID from the registry
  createdAt: string;       // ISO 8601 timestamp
  accessCount: number;     // incremented on each search hit
  lastAccessed?: string;   // ISO 8601 timestamp of last retrieval
}
```

This is the on-disk format. The full array is serialized as JSON to `~/.bernard/rag/memories.json`. Writes are atomic — write to `.tmp`, then `fs.renameSync` to the real file.

### `RAGSearchResult` (src/rag.ts)

```typescript
interface RAGSearchResult {
  fact: string;
  similarity: number;   // cosine similarity score (0.0 to 1.0)
  domain: string;       // domain ID, used by agent.ts for grouping
}
```

This is the return type from `RAGStore.search()`. The `domain` field is what allows `buildSystemPrompt()` in `agent.ts` to group results under `###` headings.

### `RAGStoreConfig` (src/rag.ts)

```typescript
interface RAGStoreConfig {
  topKPerDomain?: number;        // max results per domain (default: 3)
  maxResults?: number;           // max total results (default: 9)
  similarityThreshold?: number;  // minimum cosine similarity (default: 0.35)
  maxMemories?: number;          // prune cap (default: 5000)
}
```

All fields are optional with sensible defaults. The constructor destructures with `??` fallbacks.

### `DomainFacts` (src/context.ts)

```typescript
interface DomainFacts {
  domain: string;    // domain ID
  facts: string[];   // extracted facts for this domain
}
```

The return type of `extractDomainFacts()`. Each element represents one domain's extraction results.

---

## Key Functions and Their Implementation

### `extractDomainFacts()` — src/context.ts:128

This is the core extraction function. It takes serialized conversation text and a config, and returns domain-tagged facts.

```typescript
async function extractDomainFacts(
  serializedText: string,
  config: BernardConfig,
): Promise<DomainFacts[]>
```

**Implementation details:**

1. Early return with `[]` if `serializedText.trim()` is empty
2. Gets all domain IDs from the registry via `getDomainIds()`
3. Maps each domain ID to an async function that:
   - Looks up the domain's `extractionPrompt` from `DOMAIN_REGISTRY`
   - Calls `generateText()` (Vercel AI SDK) with the domain prompt as `system` and the conversation as `messages`
   - Parses the LLM response as JSON (stripping markdown code fences if present)
   - Filters the array to strings only, capping each at 500 characters
4. Wraps all promises in `Promise.allSettled()` — not `Promise.all()` — so one domain's failure doesn't abort the others
5. Iterates the settled results:
   - `'fulfilled'` with non-empty facts → pushed to the output array
   - `'rejected'` → logged via `debugLog`, silently skipped

The choice of `Promise.allSettled` over `Promise.all` is deliberate. If the LLM returns invalid JSON for one domain (which happens occasionally), the other two domains' facts are still captured. This is a fire-and-forget background operation, so partial results are better than total failure.

**Cost implications:** Three LLM calls instead of one. Since they run in parallel, wall-clock latency is roughly the same as a single call. Token cost triples. This is acceptable because extraction only happens during compression (already an expensive operation) and at exit (runs in a background process).

### `extractFacts()` — src/context.ts:183

Backward-compatible wrapper:

```typescript
async function extractFacts(
  serializedText: string,
  config: BernardConfig,
): Promise<string[]> {
  const domainFacts = await extractDomainFacts(serializedText, config);
  return domainFacts.flatMap((df) => df.facts);
}
```

Flattens the domain-tagged results into a plain string array. Exists so any code that doesn't care about domains can still call the simpler interface.

### `RAGStore.addFacts()` — src/rag.ts:88

```typescript
async addFacts(
  facts: string[],
  source: string,
  domain: string = DEFAULT_DOMAIN,
): Promise<number>
```

The third parameter `domain` defaults to `'general'` for backward compatibility. Any caller that doesn't pass a domain gets the old behavior.

**Implementation path:**

1. Gets the embedding provider (fastembed, lazily initialized)
2. Batch-embeds all facts in one call to `provider.embed(facts)`
3. For each fact + embedding pair:
   - Checks dedup: scans all existing memories, computes cosine similarity against the new embedding, skips if any exceed 0.92
   - Creates a `RAGMemory` object with the domain tag and pushes it onto the array
4. If any facts were added, runs `prune()` then `persist()`

**Dedup is cross-domain.** If the same fact gets extracted by two different domain prompts (unlikely due to exclusion lists, but possible), the second one is caught by the 0.92 similarity threshold regardless of domain.

### `RAGStore.search()` — src/rag.ts:147

```typescript
async search(query: string): Promise<RAGSearchResult[]>
```

**Algorithm in detail:**

```
1. embed(query) → queryEmbedding (384-dim vector)

2. for each memory in this.memories:
     similarity = cosine(queryEmbedding, memory.embedding)
     if similarity >= 0.35: keep it

3. sort all passing memories by similarity DESC

4. group by domain (Map<string, scored[]>):
     iterate sorted list
     for each entry:
       if domain group has < topKPerDomain (3) entries:
         add to group
       else:
         skip (this domain is full)

5. flatten all groups into one array
   sort by similarity DESC
   take first maxResults (9)

6. update accessCount and lastAccessed on selected memories
   persist to disk
```

The critical insight is step 4: because the input list is already sorted by similarity (descending), each domain gets its *best* matches. A domain with only 1 relevant fact gets that 1 fact. A domain with 50 relevant facts gets its top 3. No domain can monopolize all 9 result slots.

### `RAGStore.load()` — src/rag.ts:257

```typescript
private load(): void {
  // ...reads memories.json...
  this.memories = parsed.map((m: any) => ({
    ...m,
    domain: m.domain ?? DEFAULT_DOMAIN,
  }));
}
```

The `m.domain ?? DEFAULT_DOMAIN` line is the entire backward-compatibility migration. Legacy entries stored before the domain system was added have no `domain` field. The `??` operator assigns `'general'` to them. This happens in-memory at load time — the file on disk isn't rewritten until the next `persist()` call (triggered by `addFacts` or `search`).

### `RAGStore.countByDomain()` — src/rag.ts:224

```typescript
countByDomain(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of this.memories) {
    counts[m.domain] = (counts[m.domain] ?? 0) + 1;
  }
  return counts;
}
```

Simple frequency count. Used by the `/rag` command in `repl.ts` to display the per-domain breakdown. Returns raw domain IDs as keys — the REPL maps these to display names via `getDomain(id).name`.

### `buildSystemPrompt()` — src/agent.ts:83

```typescript
function buildSystemPrompt(
  config: BernardConfig,
  memoryStore: MemoryStore,
  mcpServerNames?: string[],
  ragResults?: RAGSearchResult[],
): string
```

When `ragResults` is present and non-empty, it builds the domain-grouped section:

```typescript
const byDomain = new Map<string, RAGSearchResult[]>();
for (const r of ragResults) {
  const d = r.domain;
  if (!byDomain.has(d)) byDomain.set(d, []);
  byDomain.get(d)!.push(r);
}

for (const [domainId, results] of byDomain) {
  const domain = getDomain(domainId);
  prompt += `\n\n### ${domain.name}`;
  for (const r of results) {
    prompt += `\n- ${r.fact}`;
  }
}
```

The `Map` preserves insertion order, so domains appear in the order their first result was encountered (which is similarity-descending from the search). `getDomain()` maps the raw ID (`'tool-usage'`) to the human-readable name (`'Tool Usage Patterns'`) for the heading. Unknown domain IDs fall back to the general domain's name.

### `compressHistory()` — src/context.ts:201

```typescript
async function compressHistory(
  history: CoreMessage[],
  config: BernardConfig,
  ragStore?: RAGStore,
): Promise<CoreMessage[]>
```

This orchestrates mid-session compression. The domain-relevant portion:

```typescript
const summarizePromise = generateText({ /* ... */ });
const extractPromise = ragStore
  ? extractDomainFacts(serialized, config)
  : Promise.resolve([]);

const [result, domainFacts] = await Promise.all([
  summarizePromise,
  extractPromise,
]);

if (ragStore && domainFacts.length > 0) {
  for (const df of domainFacts) {
    ragStore.addFacts(df.facts, 'compression', df.domain).catch(/* ... */);
  }
}
```

Key implementation choices:

- **`Promise.all` wraps summarization + extraction** — both run concurrently. Since `extractDomainFacts` internally uses `Promise.allSettled` for its 3 domain calls, the total concurrency is: 1 summarization call + 3 domain extraction calls = 4 parallel LLM requests.
- **`addFacts` calls are fire-and-forget** — `.catch()` logs errors but doesn't await. Storage failures don't block returning the compressed history.
- **The `'compression'` source tag** distinguishes mid-session facts from exit-time facts (`'exit'`), which is useful for debugging but doesn't affect retrieval.

---

## The Background Worker Process

`src/rag-worker.ts` is a standalone Node.js script (has a `#!/usr/bin/env node` shebang). It's spawned by `repl.ts` at exit:

```typescript
// In repl.ts cleanup handler:
const tempFile = path.join(ragDir, `.pending-${crypto.randomBytes(8).toString('hex')}.json`);
fs.writeFileSync(tempFile, JSON.stringify({
  serialized,             // full conversation as plain text
  provider: config.provider,
  model: config.model,
}));

const workerPath = path.join(__dirname, 'rag-worker.js');
const child = childProcess.spawn(process.execPath, [workerPath, tempFile], {
  detached: true,         // survives parent exit
  stdio: 'ignore',        // no stdout/stderr pipes
  env: process.env,       // inherits env (API keys, etc.)
});
child.unref();            // don't keep parent alive
```

The worker does its own `loadConfig()` call to reconstruct the config from `.env` files and the provider/model overrides in the temp file. This means it doesn't need any IPC — the temp file is the entire communication channel.

**Failure handling:**
- If the worker crashes before deleting the temp file, it stays on disk
- `RAGStore.cleanupStaleTemp()` runs on every `new RAGStore()` call
- Temp files older than 1 hour (`STALE_TEMP_MAX_AGE_MS`) are deleted
- The 1-hour window is generous — extraction typically finishes in seconds

**Why a detached process instead of `worker_threads`?** Bernard's main process needs to exit immediately. `worker_threads` would keep the process alive. A detached child process with `unref()` lets the parent exit while the child continues independently.

---

## Embedding Pipeline — src/embeddings.ts

The embedding layer sits beneath the RAG store and handles vector generation:

```typescript
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
}
```

**Implementation:** Uses fastembed's `all-MiniLM-L6-v2` model (via the `fastembed` npm package). The model runs locally using ONNX Runtime — no API calls, no network dependency, no token costs. It's lazily initialized on first use and cached for the process lifetime.

**Batch embedding:** `provider.embed(texts)` accepts an array and returns an array of vectors. Both `addFacts` (embedding new facts) and `search` (embedding the query) use this interface. The `addFacts` path batches all facts in a single call; the `search` path embeds one query string.

**`cosineSimilarity(a, b)`** computes the standard cosine similarity:

```
similarity = (a · b) / (||a|| * ||b||)
```

Returns 0 for zero-length or mismatched vectors. This function is called O(n) times per search (once per stored memory) and O(n) times per `addFacts` call for dedup checking. With the 5,000 memory cap and 384-dimension vectors, this is fast enough without indexing.

---

## Pruning Algorithm — src/rag.ts:237

When memory count exceeds `maxMemories` (5,000), the pruning algorithm runs:

```typescript
const halfLifeMs = 90 * 24 * 60 * 60 * 1000; // 90 days

const scored = this.memories.map((m) => {
  const ageMs = now - new Date(m.createdAt).getTime();
  const recency = Math.pow(0.5, ageMs / halfLifeMs);   // exponential decay
  const access = Math.log2(m.accessCount + 1);           // logarithmic boost
  return { memory: m, score: recency + access };
});

scored.sort((a, b) => b.score - a.score);
this.memories = scored.slice(0, this.maxMemories).map((s) => s.memory);
```

**Recency decay:** A fact created today scores 1.0. After 90 days it scores 0.5. After 180 days, 0.25. This is an exponential curve — it drops quickly at first then flattens, giving recent facts a strong advantage without completely eliminating old ones.

**Access boost:** `log2(accessCount + 1)` provides diminishing returns. A fact accessed 0 times scores 0. Accessed 1 time: 1.0. Accessed 7 times: 3.0. Accessed 100 times: ~6.6. The logarithm prevents a single frequently-accessed fact from becoming immortal.

**When it runs:** `prune()` is called from `addFacts()` after new memories are pushed. It only does work when the count exceeds the cap, so for most sessions it's a no-op.

---

## Constants Reference

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `DEFAULT_TOP_K_PER_DOMAIN` | 3 | rag.ts | Max search results per domain |
| `DEFAULT_MAX_RESULTS` | 9 | rag.ts | Max total search results |
| `DEFAULT_SIMILARITY_THRESHOLD` | 0.35 | rag.ts | Min cosine similarity for search |
| `DEFAULT_MAX_MEMORIES` | 5000 | rag.ts | Prune cap |
| `DEDUP_THRESHOLD` | 0.92 | rag.ts | Cosine similarity above which a fact is considered duplicate |
| `PRUNE_HALF_LIFE_DAYS` | 90 | rag.ts | Recency decay half-life |
| `STALE_TEMP_MAX_AGE_MS` | 3,600,000 | rag.ts | 1 hour — max age for pending temp files |
| `FACT_EXTRACTION_MAX` | 500 | context.ts | Max characters per extracted fact |
| `COMPRESSION_THRESHOLD` | 0.75 | context.ts | Fraction of context window that triggers compression |
| `RECENT_TURNS_TO_KEEP` | 4 | context.ts | User turns kept intact during compression |
| `DEFAULT_DOMAIN` | `'general'` | domains.ts | Fallback domain for legacy entries and untagged facts |

---

## Test Coverage

The domain-specific memory system is covered by tests across five test files:

| Test file | Tests | What it verifies |
|-----------|-------|-----------------|
| `src/domains.test.ts` | 10 | Registry completeness, required fields, extraction prompt structure, `getDomain` fallback, `getDomainIds` |
| `src/rag.test.ts` | 23 | Domain tagging on add/search, `topKPerDomain` limits, `maxResults` cap, legacy backfill, `countByDomain`, dedup, prune |
| `src/context.test.ts` | 37 | Parallel domain extraction (3 LLM calls), partial failure handling, empty input, fact filtering, `extractFacts` wrapper, `compressHistory` with domain tags |
| `src/agent.test.ts` | 25 | System prompt domain grouping with `###` headings, mixed-domain results, omission of empty domains |
| `src/rag-worker.test.ts` | 4 | Worker uses `extractDomainFacts`, stores per-domain, handles empty extraction, passes config overrides |

All tests use Vitest with `vi.mock()` for dependency isolation. The LLM calls are mocked — tests verify the wiring and data flow, not the LLM output quality.
