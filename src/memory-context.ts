import type { MemoryStore } from './memory.js';
import type { RAGSearchResult } from './rag.js';
import { getDomain } from './domains.js';

export interface MemoryContextOptions {
  memoryStore: MemoryStore;
  ragResults?: RAGSearchResult[];
  includeScratch?: boolean;
}

/**
 * Build the memory/RAG context sections for injection into a system prompt.
 * Returns the concatenated Recalled Context, Persistent Memory, and optionally
 * Scratch Notes sections. Returns empty string if nothing to inject.
 */
export function buildMemoryContext(options: MemoryContextOptions): string {
  const { memoryStore, ragResults, includeScratch = true } = options;
  let context = '';

  if (ragResults && ragResults.length > 0) {
    context +=
      '\n\n## Recalled Context\nReference only if directly relevant to the current discussion.';

    const byDomain = new Map<string, RAGSearchResult[]>();
    for (const r of ragResults) {
      const d = r.domain;
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d)!.push(r);
    }

    for (const [domainId, results] of byDomain) {
      const domain = getDomain(domainId);
      context += `\n\n### ${domain.name}`;
      for (const r of results) {
        context += `\n- ${r.fact}`;
      }
    }
  }

  const memories = memoryStore.getAllMemoryContents();
  if (memories.size > 0) {
    context += '\n\n## Persistent Memory\n';
    for (const [key, content] of memories) {
      context += `\n### ${key}\n${content}\n`;
    }
  }

  if (includeScratch) {
    const scratch = memoryStore.getAllScratchContents();
    if (scratch.size > 0) {
      context += '\n\n## Scratch Notes (session only)\n';
      for (const [key, content] of scratch) {
        context += `\n### ${key}\n${content}\n`;
      }
    }
  }

  return context;
}
