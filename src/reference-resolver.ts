import { generateText } from 'ai';
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
- If the phrase clearly names a specific person, organization, or concrete thing (e.g. "my brother", "my dentist", "the car", "aaron") AND neither memory nor known facts match AND resolving it is necessary to complete the request, stop and return status \`unknown\` for the FIRST such reference. The caller will prompt the user.
- Generic words ("the file", "this code", "the bug", "the PR", "my response", "my email") that don't point at a stored entity are NOT references — omit and prefer \`noop\`.

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
): ResolveResult {
  const isValidSource = (key: string) => key === RAG_SOURCE_KEY || memoryKeys.has(key);
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

  const userMessage = [
    `## User request\n${userInput}`,
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
    const validated = validateAgainstMemory(parsed, new Set(memoryKeys));
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
    "These references resolve phrases in the user's request from stored memory. Treat as hints, not rules. If a resolution seems wrong for the current task, cross-check with the memory tool or ask.",
  );
  for (const e of entries) {
    const phrase = oneLine(e.phrase, 80);
    const resolvedTo = oneLine(e.resolvedTo);
    const sourceKey = sanitizeKey(e.sourceKey);
    lines.push(`- "${phrase}" → ${resolvedTo} (from memory: ${sourceKey})`);
  }
  return lines.join('\n');
}
