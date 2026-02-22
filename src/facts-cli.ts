import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { RAGStore } from './rag.js';
import type { RAGSearchResultWithId } from './rag.js';
import { getDomain } from './domains.js';
import { loadConfig } from './config.js';
import { printInfo, printError } from './output.js';

const MAX_FILE_QUERY_LENGTH = 10000;

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
export async function factsList(): Promise<void> {
  const config = loadConfig();
  if (!config.ragEnabled) {
    printInfo('RAG is disabled. Set BERNARD_RAG_ENABLED=true to enable.');
    return;
  }

  const ragStore = new RAGStore();
  const results = ragStore.listMemories();

  if (results.length === 0) {
    printInfo('No facts stored.');
    return;
  }

  displayResults(results, false);
  await promptDelete(results, ragStore);
}

/**
 * Search RAG facts by semantic similarity and optionally delete selected results.
 * If `query` is a path to an existing file, its contents are used as the search text.
 * @param query - Free-text search string or path to a file whose contents serve as the query.
 */
export async function factsSearch(query: string): Promise<void> {
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

  const ragStore = new RAGStore();
  const results = await ragStore.searchWithIds(searchQuery);

  if (results.length === 0) {
    printInfo('No matching facts found.');
    return;
  }

  displayResults(results, true);
  await promptDelete(results, ragStore);
}
