import type { CoreMessage } from 'ai';
import { extractText } from './context.js';
import type { RAGSearchResult } from './rag.js';

export const DEFAULT_WINDOW_SIZE = 2;
export const DEFAULT_MAX_QUERY_CHARS = 1000;
export const DEFAULT_STICKINESS_BOOST = 0.05;

const BOUNDARY_PREFIXES = [
  '[Context Summary',
  '[Previous session ended',
  '[Earlier conversation was truncated',
];

/**
 * Walk history backward and collect up to `maxMessages` user-role text strings.
 * Skips system-injected boundary messages (context summaries, session markers).
 * Returns texts in chronological order (oldest first).
 */
export function extractRecentUserTexts(
  history: CoreMessage[],
  maxMessages: number = DEFAULT_WINDOW_SIZE,
): string[] {
  const texts: string[] = [];

  for (let i = history.length - 1; i >= 0 && texts.length < maxMessages; i--) {
    const msg = history[i];
    if (msg.role !== 'user') continue;

    const text = extractText(msg);
    if (!text) continue;

    // Skip system-injected boundary messages
    if (BOUNDARY_PREFIXES.some((prefix) => text.startsWith(prefix))) continue;

    texts.push(text);
  }

  // Reverse to chronological order (oldest first)
  texts.reverse();
  return texts;
}

export interface BuildRAGQueryOptions {
  maxQueryChars?: number;
}

/**
 * Build a RAG search query from the current user input plus recent history.
 * Current input is always at the end (transformers attend more to later tokens).
 * Truncates older messages first to stay within the character budget.
 */
export function buildRAGQuery(
  currentInput: string,
  recentUserTexts: string[],
  options?: BuildRAGQueryOptions,
): string {
  const maxChars = options?.maxQueryChars ?? DEFAULT_MAX_QUERY_CHARS;

  if (recentUserTexts.length === 0) return currentInput.slice(0, maxChars);

  // Always preserve current input (truncate if alone it exceeds budget)
  const current = currentInput.slice(0, maxChars);
  let remaining = maxChars - current.length - 2; // -2 for ". " separator

  if (remaining <= 0) return current;

  // Add older messages from most-recent to oldest, truncating older ones first
  const parts: string[] = [];
  for (let i = recentUserTexts.length - 1; i >= 0; i--) {
    const text = recentUserTexts[i];
    if (remaining <= 0) break;
    const truncated = text.slice(0, remaining);
    parts.unshift(truncated);
    remaining -= truncated.length + 2; // -2 for ". " separator between parts
  }

  return [...parts, current].join('. ');
}

export interface ApplyStickinessOptions {
  boost?: number;
  topKPerDomain?: number;
  maxResults?: number;
}

/**
 * Boost similarity scores for facts that appeared in the previous turn's results.
 * Re-sorts by boosted similarity and re-applies domain top-k and total cap.
 * Boost is NOT cumulative — only relative to the immediately prior turn.
 */
export function applyStickiness(
  currentResults: RAGSearchResult[],
  previousFacts: Set<string>,
  options?: ApplyStickinessOptions,
): RAGSearchResult[] {
  if (previousFacts.size === 0) return currentResults;

  const boost = options?.boost ?? DEFAULT_STICKINESS_BOOST;
  const topKPerDomain = options?.topKPerDomain ?? 3;
  const maxResults = options?.maxResults ?? 9;

  // Apply boost
  const boosted = currentResults.map((r) => ({
    ...r,
    similarity: previousFacts.has(r.fact)
      ? Math.min(r.similarity + boost, 1.0)
      : r.similarity,
  }));

  // Re-sort by boosted similarity
  boosted.sort((a, b) => b.similarity - a.similarity);

  // Re-apply domain top-k
  const domainCounts = new Map<string, number>();
  const filtered: RAGSearchResult[] = [];
  for (const result of boosted) {
    const count = domainCounts.get(result.domain) ?? 0;
    if (count >= topKPerDomain) continue;
    domainCounts.set(result.domain, count + 1);
    filtered.push(result);
    if (filtered.length >= maxResults) break;
  }

  return filtered;
}
