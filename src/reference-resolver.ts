import { generateText, type CoreMessage } from 'ai';
import { getModel } from './providers/index.js';
import { debugLog } from './logger.js';
import { sanitizeKey, REWRITER_HINTS_KEY, type MemoryStore } from './memory.js';
import type { RAGStore, RAGSearchResult } from './rag.js';
import type { BernardConfig } from './config.js';

/** Sentinel sourceKey used for resolutions drawn from the RAG knowledge base. */
export const RAG_SOURCE_KEY = 'rag';

/**
 * Derive a memory key from a natural-language reference phrase.
 * Strips a leading possessive/demonstrative and replaces internal spaces with dashes.
 *
 * Examples: "my brother" → "brother", "the car" → "car", "my brother Tom" → "brother-tom".
 */
export function deriveKeyFromReference(reference: string): string {
  const stripped = reference
    .toLowerCase()
    .trim()
    .replace(/^(my|our|the|her|his|their|that|this)\s+/, '');
  return sanitizeKey(stripped.replace(/\s+/g, '-'));
}

export interface ResolvedEntry {
  phrase: string;
  resolvedTo: string;
  sourceKey: string;
}

export interface Candidate {
  label: string;
  sourceKey: string;
  preview: string;
}

export type ResolveResult =
  | { status: 'noop' }
  | { status: 'resolved'; entries: ResolvedEntry[] }
  | { status: 'ambiguous'; reference: string; candidates: Candidate[] }
  | { status: 'unknown'; reference: string };

const RESOLVER_MAX_TOKENS = 512;
const RESOLVER_SYSTEM_PROMPT = `You resolve references in a user's request against their stored personal memory and knowledge base.
You DO NOT retrieve facts unprompted. You only resolve phrases the user already wrote.

Given the user's input, a list of available memory entries, and (optionally) relevant facts from the knowledge base, identify every phrase that refers to a specific person, thing, routine, or plan.

For each phrase:
- If exactly ONE memory entry unambiguously matches the reference, include it in \`entries\` with its memory key as \`sourceKey\`.
- If no memory entry matches but a fact in "## Relevant known facts" unambiguously identifies the person or thing, include it in \`entries\` with \`sourceKey: "rag"\`. Draw \`resolvedTo\` from the fact text.
- Prefer a memory entry over a RAG fact when both match the same phrase.
- If MULTIPLE memory entries plausibly match, stop and return status \`ambiguous\` for the FIRST ambiguous reference with 2-4 candidates. Do not guess.
- If the phrase clearly names a specific person, organization, or concrete thing (e.g. "my brother", "my dentist", "the car", "aaron") AND neither memory nor known facts match AND the reference was NOT already introduced in "## Recent conversation" AND resolving it is necessary to complete the request, stop and return status \`unknown\` for the FIRST such reference. The caller will prompt the user.
- If the reference was already introduced or clarified in "## Recent conversation" (e.g. the user or assistant named the person/thing earlier in this session), return \`noop\` for that phrase. The downstream agent has full history access and can resolve it without our help.
- Generic words ("the file", "this code", "the bug", "the PR", "my response", "my email") that don't point at a stored entity are NOT references — omit and prefer \`noop\`.
- Tool-resolvable identifiers (URLs like \`https://github.com/...\`, PR/issue numbers like \`#3802\` or \`PR 3802\`, file paths like \`/home/user/foo.md\`, commit hashes, package names, API endpoints) are NOT references — the downstream agent will fetch them with \`shell\`, \`gh\`, \`web_read\`, or similar tools. Omit them and prefer \`noop\`. Example: for "review PR https://github.com/foo/bar/pull/123", return \`{"status":"noop"}\`.

Output strict JSON matching one of these shapes and nothing else:
  {"status":"noop"}
  {"status":"resolved","entries":[{"phrase":"...","resolvedTo":"...","sourceKey":"..."}]}
  {"status":"ambiguous","reference":"...","candidates":[{"label":"...","sourceKey":"...","preview":"..."}]}
  {"status":"unknown","reference":"..."}

Rules:
- Be conservative. Prefer \`noop\` over guessing.
- Only one \`unknown\` or \`ambiguous\` per turn — pick the most important reference.
- For memory-sourced entries, use only keys from the provided memory list. For knowledge-base-sourced entries, use the literal string \`"rag"\`.
- \`resolvedTo\` is a short human-readable expansion drawn from the source content (not a raw dump).
- \`preview\` in candidates is a short one-line summary (~60 chars) distinguishing candidates.`;

const POSSESSIVE_PRESCAN = /\b(my|our|her|his|their)\s+\w+/i;
// Require 2+ words after "the/this/that" to avoid generic "the bug" / "this code" false-positives.
const DEMONSTRATIVE_PRESCAN = /\b(the|this|that)\s+\w+\s+\w+/i;

const URL_RE = /https?:\/\/\S+/gi;
const GH_REF_RE = /\b(?:PR|issue|pull|issues)[\s#]*\d+\b|#\d+\b/gi;
const FILE_PATH_RE = /(?<!\S)(?:~|\.{1,2})?\/[\w./\-]+/g;
const COMMIT_HASH_RE = /\b[a-f0-9]{7,40}\b/gi;

/**
 * Remove tokens that the main agent can resolve with tools (URLs, PR/issue refs,
 * file paths, commit hashes) before the reference resolver sees the input.
 * Mirrors {@link ./image.ts:stripImagePaths} in shape and intent.
 */
export function stripToolResolvableTokens(text: string): string {
  return text
    .replace(URL_RE, ' ')
    .replace(GH_REF_RE, ' ')
    .replace(FILE_PATH_RE, ' ')
    .replace(COMMIT_HASH_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shouldSkipResolver(userInput: string): boolean {
  // Run the resolver when the prompt contains a strong reference signal (possessive, or a
  // multi-word demonstrative phrase). Even when memory is empty the resolver may return
  // `unknown` and prompt the user to fill in the missing entity.
  return !(POSSESSIVE_PRESCAN.test(userInput) || DEMONSTRATIVE_PRESCAN.test(userInput));
}

function buildHintsBlock(hints?: Map<string, string>): string {
  if (!hints || hints.size === 0) return '';
  const lines: string[] = ['## Persisted hints (honor these first, do not re-ask)'];
  for (const [phrase, sourceKey] of hints.entries()) {
    lines.push(`- "${phrase}" → ${sourceKey}`);
  }
  return lines.join('\n');
}

const MAX_MEMORY_ENTRIES_IN_PROMPT = 40;
const MAX_MEMORY_PREVIEW_CHARS = 140;
const MAX_RAG_FACTS_IN_PROMPT = 12;
const MAX_RAG_FACT_CHARS = 240;
const RECENT_TURNS_IN_PROMPT = 4;
const MAX_TURN_PREVIEW_CHARS = 300;

function extractMessageText(msg: CoreMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  const parts: string[] = [];
  for (const part of msg.content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join(' ');
}

export function buildRecentTurnsBlock(history: CoreMessage[]): string {
  if (history.length === 0) return '';
  const turns: { role: string; text: string }[] = [];
  for (let i = history.length - 1; i >= 0 && turns.length < RECENT_TURNS_IN_PROMPT; i--) {
    const msg = history[i];
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = extractMessageText(msg).trim().replace(/\s+/g, ' ');
    if (text.length === 0) continue;
    const preview =
      text.length > MAX_TURN_PREVIEW_CHARS ? text.slice(0, MAX_TURN_PREVIEW_CHARS) + '…' : text;
    turns.unshift({ role: msg.role, text: preview });
  }
  if (turns.length === 0) return '';
  const lines: string[] = ['## Recent conversation'];
  for (const t of turns) {
    lines.push(`- ${t.role}: ${t.text}`);
  }
  return lines.join('\n');
}

function buildRagBlock(facts: RAGSearchResult[]): string {
  if (facts.length === 0) return '';
  const lines: string[] = ['## Relevant known facts'];
  const selected = facts.slice(0, MAX_RAG_FACTS_IN_PROMPT);
  for (const f of selected) {
    const trimmed = f.fact.trim().replace(/\s+/g, ' ');
    const preview =
      trimmed.length > MAX_RAG_FACT_CHARS ? trimmed.slice(0, MAX_RAG_FACT_CHARS) + '…' : trimmed;
    lines.push(`- ${preview}`);
  }
  return lines.join('\n');
}

function buildMemoryBlock(contents: Map<string, string>): string {
  const lines: string[] = ['## Available memory entries'];
  const entries = Array.from(contents.entries());
  const selected = entries.slice(0, MAX_MEMORY_ENTRIES_IN_PROMPT);
  for (const [key, content] of selected) {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    const preview =
      trimmed.length > MAX_MEMORY_PREVIEW_CHARS
        ? trimmed.slice(0, MAX_MEMORY_PREVIEW_CHARS) + '…'
        : trimmed;
    lines.push(`- ${key}: ${preview}`);
  }
  const omitted = entries.length - selected.length;
  if (omitted > 0) {
    lines.push(`- … ${omitted} more entr${omitted === 1 ? 'y' : 'ies'} omitted for brevity`);
  }
  return lines.join('\n');
}

function parseResolverResponse(text: string): ResolveResult | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed?.status === 'noop') return { status: 'noop' };
    if (parsed?.status === 'resolved' && Array.isArray(parsed.entries)) {
      const entries: ResolvedEntry[] = parsed.entries
        .filter(
          (e: any) =>
            e &&
            typeof e.phrase === 'string' &&
            typeof e.resolvedTo === 'string' &&
            typeof e.sourceKey === 'string',
        )
        .map((e: any) => ({ phrase: e.phrase, resolvedTo: e.resolvedTo, sourceKey: e.sourceKey }));
      if (entries.length === 0) return { status: 'noop' };
      return { status: 'resolved', entries };
    }
    if (
      parsed?.status === 'ambiguous' &&
      typeof parsed.reference === 'string' &&
      Array.isArray(parsed.candidates)
    ) {
      const candidates: Candidate[] = parsed.candidates
        .filter(
          (c: any) =>
            c &&
            typeof c.label === 'string' &&
            typeof c.sourceKey === 'string' &&
            typeof c.preview === 'string',
        )
        .slice(0, 4)
        .map((c: any) => ({ label: c.label, sourceKey: c.sourceKey, preview: c.preview }));
      if (candidates.length < 2) return { status: 'noop' };
      return { status: 'ambiguous', reference: parsed.reference, candidates };
    }
    if (
      parsed?.status === 'unknown' &&
      typeof parsed.reference === 'string' &&
      parsed.reference.trim().length > 0
    ) {
      return { status: 'unknown', reference: parsed.reference.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export function validateAgainstMemory(
  result: ResolveResult,
  memoryKeys: Set<string>,
  ragAvailable: boolean = false,
): ResolveResult {
  const isValidSource = (key: string) =>
    (ragAvailable && key === RAG_SOURCE_KEY) || memoryKeys.has(key);
  if (result.status === 'resolved') {
    const safe = result.entries.filter((e) => isValidSource(e.sourceKey));
    return safe.length === 0 ? { status: 'noop' } : { status: 'resolved', entries: safe };
  }
  if (result.status === 'ambiguous') {
    const safe = result.candidates.filter((c) => isValidSource(c.sourceKey));
    return safe.length < 2
      ? { status: 'noop' }
      : { status: 'ambiguous', reference: result.reference, candidates: safe };
  }
  return result;
}

export async function resolveReferences(
  userInput: string,
  memoryStore: MemoryStore,
  config: BernardConfig,
  hints?: Map<string, string>,
  abortSignal?: AbortSignal,
  ragStore?: RAGStore,
  recentHistory?: CoreMessage[],
): Promise<ResolveResult> {
  const contents = memoryStore.getAllMemoryContents();
  contents.delete(REWRITER_HINTS_KEY);
  const memoryKeys = Array.from(contents.keys());

  if (shouldSkipResolver(userInput)) {
    debugLog('reference-resolver:skip', {
      reason: 'no-reference-tokens',
      prompt: userInput,
    });
    return { status: 'noop' };
  }

  let ragFacts: RAGSearchResult[] = [];
  if (ragStore) {
    try {
      ragFacts = await ragStore.search(userInput);
      debugLog('reference-resolver:rag-hits', { count: ragFacts.length });
    } catch (err) {
      debugLog('reference-resolver:rag-error', err instanceof Error ? err.message : String(err));
      ragFacts = [];
    }
  }

  const historyBlock = recentHistory ? buildRecentTurnsBlock(recentHistory) : '';

  const userMessage = [
    `## User request\n${userInput}`,
    historyBlock,
    buildMemoryBlock(contents),
    buildRagBlock(ragFacts),
    buildHintsBlock(hints),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');

  debugLog('reference-resolver:request', {
    prompt: userInput,
    memoryKeys,
    ragFactCount: ragFacts.length,
    recentTurnCount: historyBlock ? historyBlock.split('\n').length - 1 : 0,
    hints: hints ? Array.from(hints.entries()) : [],
  });

  try {
    const result = await generateText({
      model: getModel(config.provider, config.model),
      system: RESOLVER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      maxSteps: 1,
      maxTokens: RESOLVER_MAX_TOKENS,
      abortSignal,
    });

    if (!result.text) {
      debugLog('reference-resolver:empty-response', null);
      return { status: 'noop' };
    }
    debugLog('reference-resolver:response', result.text.slice(0, 200));
    const parsed = parseResolverResponse(result.text);
    if (!parsed) {
      debugLog('reference-resolver:parse-failed', result.text.slice(0, 200));
      return { status: 'noop' };
    }
    const validated = validateAgainstMemory(parsed, new Set(memoryKeys), ragFacts.length > 0);
    debugLog('reference-resolver:result', validated);
    return validated;
  } catch (err) {
    debugLog('reference-resolver:error', err instanceof Error ? err.message : String(err));
    return { status: 'noop' };
  }
}

const MAX_RENDERED_FIELD_CHARS = 200;

function oneLine(value: string, max: number = MAX_RENDERED_FIELD_CHARS): string {
  const flat = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

export function renderResolvedBlock(entries: ResolvedEntry[]): string {
  if (entries.length === 0) return '';
  const lines: string[] = ['## Resolved References'];
  lines.push(
    "These references resolve phrases in the user's request from stored memory or the knowledge base. Treat as hints, not rules. If a resolution seems wrong for the current task, cross-check with the memory tool or ask.",
  );
  for (const e of entries) {
    const phrase = oneLine(e.phrase, 80);
    const resolvedTo = oneLine(e.resolvedTo);
    if (e.sourceKey === RAG_SOURCE_KEY) {
      lines.push(`- "${phrase}" → ${resolvedTo} (from knowledge base)`);
    } else {
      const sourceKey = sanitizeKey(e.sourceKey);
      lines.push(`- "${phrase}" → ${resolvedTo} (from memory: ${sourceKey})`);
    }
  }
  return lines.join('\n');
}
