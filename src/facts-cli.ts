import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { RAGStore } from './rag.js';
import type { RAGSearchResultWithId } from './rag.js';
import { getDomain } from './domains.js';
import { loadConfig } from './config.js';
import { printInfo, printError } from './output.js';
import { specialistRagDir } from './paths.js';
import { listSpecialistRagIds, specialistFactsNotice } from './specialist-rag.js';

const MAX_FILE_QUERY_LENGTH = 10000;

/**
 * Which store a command addresses.
 *
 * Every command here constructed a bare `new RAGStore()` and had no flags at
 * all — which was right when there was one store and silently wrong the moment
 * a specialist got its own (#501). The `dir` is the entire difference; `RAGStore`
 * has taken one since that change, and owns its own file path, so nothing here
 * re-derives `memories.json`.
 *
 * THROWS on an unknown id rather than returning a union every caller has to
 * narrow: `src/index.ts` already wraps both commands in a `try` that prints the
 * message, so the three hand-written narrowings bought nothing. The message still
 * names the ids that do exist, because an unknown one is a user typo.
 */
function resolveStore(specialist?: string): RAGStore {
  if (specialist === undefined) return new RAGStore();
  const known = listSpecialistRagIds();
  if (!known.includes(specialist)) {
    throw new Error(
      known.length === 0
        ? `No specialist has its own facts yet. They are written at session close, ` +
            `for specialists that ran.`
        : `No facts for specialist "${specialist}". Known: ${known.join(', ')}.`,
    );
  }
  return new RAGStore({ dir: specialistRagDir(specialist) });
}

/**
 * Tells the user the other stores exist, once, with both guards inside.
 *
 * A printer rather than a getter, because as a `string | null` it was three
 * `if (footer)` sites that had ALREADY diverged: `factsSearch` printed it only on
 * the zero-result path, so a user who searched and got hits was never told the
 * other stores existed. The sentence itself comes from `specialistFactsNotice`,
 * shared with the REPL's `/rag`.
 */
function printSpecialistFooter(specialist?: string): void {
  // Never inside a specialist's own listing: it has no siblings to point at and
  // the reader is already there on purpose.
  if (specialist !== undefined) return;
  const notice = specialistFactsNotice(listSpecialistRagIds());
  if (!notice) return;
  printInfo(`\n${notice.summary} ${notice.ids.join(', ')}`);
  printInfo(`  ${notice.hint}`);
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Parse a comma-separated selection of numbers and ranges (e.g. "1,3,5-8").
 * Returns sorted deduplicated 1-based indices, or null if invalid.
 */
export function parseSelection(input: string, max: number): number[] | null {
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const indices = new Set<number>();

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (isNaN(start) || isNaN(end) || start < 1 || end > max || start > end) return null;
      for (let i = start; i <= end; i++) indices.add(i);
    } else {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 1 || num > max) return null;
      indices.add(num);
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

function displayResults(results: RAGSearchResultWithId[], showSimilarity: boolean): void {
  // Group by domain preserving encounter order
  const byDomain = new Map<string, RAGSearchResultWithId[]>();
  for (const r of results) {
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
    byDomain.get(r.domain)!.push(r);
  }

  const label = showSimilarity ? `${results.length} results` : `${results.length} facts`;
  printInfo(`\n## Recalled Context (${label})\n`);

  let index = 1;
  for (const [domainId, items] of byDomain) {
    const domain = getDomain(domainId);
    printInfo(`### ${domain.name}`);
    for (const item of items) {
      if (showSimilarity) {
        const pct = Math.round(item.similarity * 100);
        printInfo(`  ${index}. (${pct}%) ${item.fact}`);
      } else {
        printInfo(`  ${index}. ${item.fact}`);
      }
      index++;
    }
    printInfo('');
  }
}

async function promptDelete(results: RAGSearchResultWithId[], ragStore: RAGStore): Promise<void> {
  if (results.length === 0) return;

  const input = await promptLine(
    'Enter fact numbers to delete (e.g. 1,3,5-8), or press Enter to cancel: ',
  );
  if (!input) {
    return;
  }

  const selection = parseSelection(input, results.length);
  if (!selection) {
    printError('Invalid selection.');
    return;
  }

  const toDelete = selection.map((i) => results[i - 1]);
  printInfo(`\nAbout to delete ${toDelete.length} fact(s):`);
  for (const item of toDelete) {
    const preview = item.fact.length > 80 ? item.fact.slice(0, 80) + '...' : item.fact;
    printInfo(`  - ${preview}`);
  }

  const confirmed = await confirm(`\nDelete ${toDelete.length} fact(s)? (y/N): `);
  if (!confirmed) {
    printInfo('Cancelled.');
    return;
  }

  const ids = toDelete.map((item) => item.id);
  const deleted = ragStore.deleteByIds(ids);
  printInfo(`Deleted ${deleted} fact(s).`);
}

/**
 * List all stored RAG facts grouped by domain and optionally delete selected entries.
 * Used by the `bernard facts` CLI command (no query argument).
 */
export async function factsList(specialist?: string): Promise<void> {
  const config = loadConfig();
  if (!config.ragEnabled) {
    printInfo('RAG is disabled. Set BERNARD_RAG_ENABLED=true to enable.');
    return;
  }

  const ragStore = resolveStore(specialist);
  const results = ragStore.listMemories();

  if (results.length === 0) {
    printInfo(specialist ? `No facts stored for "${specialist}".` : 'No facts stored.');
    printSpecialistFooter(specialist);
    return;
  }

  displayResults(results, false);
  printSpecialistFooter(specialist);
  await promptDelete(results, ragStore);
}

/**
 * Permanently delete all RAG facts after interactive confirmation.
 * Requires the user to type an exact confirmation phrase.
 */
export async function clearFacts(specialist?: string): Promise<void> {
  const config = loadConfig();
  if (!config.ragEnabled) {
    printInfo('RAG is disabled. Set BERNARD_RAG_ENABLED=true to enable.');
    return;
  }

  const ragStore = resolveStore(specialist);
  const total = ragStore.count();

  if (total === 0) {
    printInfo('No facts stored. Nothing to clear.');
    return;
  }

  const counts = ragStore.countByDomain();

  printInfo('');
  printInfo('\u26a0\ufe0f  This will permanently delete ALL learned RAG facts.');
  printInfo('');
  const entries = Object.entries(counts);
  const maxLen = Math.max(...entries.map(([d]) => d.length), 'Total:'.length);

  printInfo('  Current facts:');
  for (const [domain, count] of entries) {
    printInfo(`    ${domain.padEnd(maxLen)}  ${String(count).padStart(6)} facts`);
  }
  printInfo(`    ${'Total:'.padEnd(maxLen)}  ${String(total).padStart(6)} facts`);
  printInfo('');
  // The store's own file, asked of the store. This printed the imported
  // `MEMORIES_FILE` unconditionally — the wrong path the moment a `--specialist`
  // flag existed, on the one screen whose whole job is to say what is about to be
  // destroyed — and the first fix re-derived `memories.json` here instead, which
  // is the same mistake one step removed.
  printInfo(`  Storage: ${ragStore.storageFile}`);
  printInfo('');

  const answer = await promptLine('  Type "yes, delete all facts" to confirm: ');
  if (answer !== 'yes, delete all facts') {
    printInfo('Cancelled.');
    return;
  }

  ragStore.clear();
  printInfo('');
  const parts = Object.entries(counts).map(([d, c]) => `${c} ${d}`);
  printInfo(`\u2713 Deleted ${total} facts (${parts.join(', ')}). RAG memory is now empty.`);
}

/**
 * Search RAG facts by semantic similarity and optionally delete selected results.
 * If `query` is a path to an existing file, its contents are used as the search text.
 * @param query - Free-text search string or path to a file whose contents serve as the query.
 */
export async function factsSearch(query: string, specialist?: string): Promise<void> {
  const config = loadConfig();
  if (!config.ragEnabled) {
    printInfo('RAG is disabled. Set BERNARD_RAG_ENABLED=true to enable.');
    return;
  }

  // If query points to an existing file, use its contents
  let searchQuery = query;
  if (fs.existsSync(query)) {
    try {
      const stat = fs.statSync(query);
      if (stat.isFile()) {
        const content = fs.readFileSync(query, 'utf-8');
        searchQuery = content.slice(0, MAX_FILE_QUERY_LENGTH);
        printInfo(`Using contents of ${query} as search query (${content.length} chars)`);
      }
    } catch {
      // Fall through to use query as-is
    }
  }

  const ragStore = resolveStore(specialist);
  const results = await ragStore.searchWithIds(searchQuery);

  if (results.length === 0) {
    printInfo('No matching facts found.');
    printSpecialistFooter(specialist);
    return;
  }

  displayResults(results, true);
  printSpecialistFooter(specialist);
  await promptDelete(results, ragStore);
}
