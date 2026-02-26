import type { CoreMessage } from 'ai';
import { extractText } from './context.js';
import type { RAGSearchResult } from './rag.js';
import { DEFAULT_TOP_K_PER_DOMAIN, DEFAULT_MAX_RESULTS } from './rag.js';

/** Number of recent user messages (beyond the current input) to include in the RAG query. */
export const DEFAULT_WINDOW_SIZE = 2;
/** Maximum character length for the composed RAG search query. */
export const DEFAULT_MAX_QUERY_CHARS = 1000;
/** Similarity score bonus applied to facts that appeared in the previous turn's results. */
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

/**
 * Compact a tool call's args into a short summary string.
 * Only includes the first key-value pair for brevity — tool calls
 * are used as lightweight retrieval signals, not full records.
 * Returns a "key=value" string, or empty string if args is empty/null.
 */
function compactArgs(args: Record<string, unknown> | undefined | null): string {
  if (!args || typeof args !== 'object') return '';
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const key = keys[0];
  const raw = String(args[key] ?? '');
  const value = raw.length > 60 ? raw.slice(0, 57) + '...' : raw;
  return `${key}=${value}`;
}

/**
 * Walk history backward and collect tool call names + compact args from assistant messages.
 * Returns a comma-separated string in chronological order (oldest first).
 *
 * @param history - Conversation history to scan
 * @param maxMessages - Maximum number of assistant messages to scan (default: 3)
 * @param maxChars - Maximum character length for the returned string (default: 200)
 */
export function extractRecentToolContext(
  history: CoreMessage[],
  maxMessages: number = 3,
  maxChars: number = 200,
): string {
  const entries: string[] = [];
  let scanned = 0;

  for (let i = history.length - 1; i >= 0 && scanned < maxMessages; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;
    scanned++;

    if (!Array.isArray(msg.content)) continue;

    const msgEntries: string[] = [];
    for (const part of msg.content) {
      if (part.type === 'tool-call') {
        const compact = compactArgs(part.args as Record<string, unknown>);
        msgEntries.push(compact ? `${part.toolName}(${compact})` : part.toolName);
      }
    }
    entries.unshift(...msgEntries);
  }

  if (entries.length === 0) return '';

  let result = entries.join(', ');
  if (result.length > maxChars) {
    if (maxChars < 3) return '';
    result = result.slice(0, maxChars - 3) + '...';
  }
  return result;
}

/** Options for {@link buildRAGQuery}. */
export interface BuildRAGQueryOptions {
  /** Character budget for the composed query (default: 1000). */
  maxQueryChars?: number;
  /** Comma-separated tool context string (e.g. "shell(command=ls), memory"). */
  toolContext?: string;
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

  const toolContext = options?.toolContext;

  if (recentUserTexts.length === 0 && !toolContext) return currentInput.slice(0, maxChars);

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

  // Tool context is lowest-priority: only inserted if remaining budget > 10 chars
  if (toolContext && remaining > 10) {
    const wrapped = `[tools: ${toolContext}]`;
    const truncatedTool = wrapped.slice(0, remaining);
    parts.unshift(truncatedTool);
  }

  return [...parts, current].join('. ');
}

/** Options for {@link applyStickiness}. */
export interface ApplyStickinessOptions {
  /** Similarity score bonus for previously-seen facts (default: 0.05). */
  boost?: number;
  /** Max results to keep per domain after re-ranking (default: 5). */
  topKPerDomain?: number;
  /** Max total results after re-ranking (default: 15). */
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
  const topKPerDomain = options?.topKPerDomain ?? DEFAULT_TOP_K_PER_DOMAIN;
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;

  // Apply boost
  const boosted = currentResults.map((r) => ({
    ...r,
    similarity: previousFacts.has(r.fact) ? Math.min(r.similarity + boost, 1.0) : r.similarity,
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
