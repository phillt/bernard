import { generateText } from 'ai';
import type { CoreMessage } from './framework/sdk.js';
import { debugLog, traceLlm } from './logger.js';
import { sanitizeKey, REWRITER_HINTS_KEY, type MemoryStore } from './memory.js';
import type { RAGStore, RAGSearchResult } from './rag.js';
import type { BernardConfig } from './config.js';
import { resolveSiteModel } from './model-policy.js';
import { getCachedLLM, setCachedLLM, type LLMCacheKey } from './llm-cache.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';
import { rankByTermOverlap } from './lexical.js';
import { clipSafe, factDatePrefix } from './text.js';

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
- If no memory entry matches but a fact in "## Relevant known facts" unambiguously identifies the person or thing, include it in \`entries\` with \`sourceKey: "rag"\`. Draw \`resolvedTo\` from the fact text. Facts are dated; when two disagree, the newer one wins.
- Prefer a memory entry over a RAG fact when both match the same phrase.
- ONE SOURCE PER ENTRY. \`resolvedTo\` comes from the single source named in \`sourceKey\` and nothing else. Never blend a memory entry with a knowledge-base fact, and never fill in detail the source does not state.
- \`resolvedTo\` NAMES the thing; it does not describe it. "my daughter" → "Sarah, my daughter". "our daily blaze" → "the Daily Blaze report". How something is done, what format it takes, who it goes to — that stays in the source, which the downstream agent reads in full. Keep it under about a dozen words.
- Resolve EVERY phrase you can. A phrase you cannot place must not stop you resolving the others: if anything resolved, return \`resolved\` with all of those entries and simply omit the rest.
- Return \`ambiguous\` only when nothing resolved and MULTIPLE memory entries plausibly match one reference — give 2-4 candidates. Do not guess.
- Return \`unknown\` only when nothing resolved AND the phrase clearly names a specific person, organization, or concrete thing (e.g. "my brother", "my dentist", "the car", "aaron") AND neither memory nor known facts match AND it was NOT already introduced in "## Recent conversation" AND resolving it is necessary to complete the request.
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
- At most one \`unknown\` or \`ambiguous\` per turn, and never when anything else resolved.
- For memory-sourced entries, use only keys from the provided memory list. For knowledge-base-sourced entries, use the literal string \`"rag"\`.
- \`resolvedTo\` is a short name drawn from its one source — never a summary, never a dump.
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

/**
 * How the memory list is budgeted. Entries sharing words with the request are
 * previewed first and in full ({@link MAX_MEMORY_PREVIEW_CHARS}); the rest of
 * the first {@link MAX_MEMORY_ENTRIES_IN_PROMPT} still get a short preview,
 * because a reference is usually SEMANTIC — "my wife" shares no word with a note
 * reading "Spouse: Ana", and a key alone cannot be resolved from. Past that,
 * entries are listed by key alone, up to {@link MAX_KEY_ONLY_ENTRIES}, so the
 * prompt stays bounded on a large store.
 *
 * This used to be the first 40 entries in `readdir` order, each cut at 140
 * characters — so on a store of 120 notes anything filed after roughly "d" was
 * invisible, and the notes that were shown were cut mid-sentence. The resolver
 * then filled the gap from whatever knowledge-base fact sounded closest, which
 * is how a stale description reached the rewritten prompt under a memory
 * key's name. Listing every key keeps every entity findable; previewing the
 * ones the request actually mentions puts the text where it is needed.
 */
const MAX_PREVIEWED_MEMORY_ENTRIES = 12;
const MAX_MEMORY_ENTRIES_IN_PROMPT = 40;
const MAX_SHORT_PREVIEW_CHARS = 140;
const MAX_KEY_ONLY_ENTRIES = 200;
/** Shared with `recall-filter`, so the two passes see the same text of a note. */
export const MAX_MEMORY_PREVIEW_CHARS = 400;
/**
 * A `resolvedTo` longer than this is a description, not a name, and is dropped.
 * The rewriter inlines `resolvedTo` into the user's own words, so a paraphrase
 * here becomes something the user appears to have said.
 */
export const MAX_RESOLVED_TO_CHARS = 120;
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
    lines.push(`- ${factDatePrefix(f.createdAt)}${oneLine(f.fact, MAX_RAG_FACT_CHARS)}`);
  }
  return lines.join('\n');
}

export function buildMemoryBlock(contents: Map<string, string>, request: string): string {
  const lines: string[] = ['## Available memory entries'];
  const previewed = rankByTermOverlap(contents, request).slice(0, MAX_PREVIEWED_MEMORY_ENTRIES);
  for (const key of previewed) {
    lines.push(`- ${key}: ${oneLine(contents.get(key)!, MAX_MEMORY_PREVIEW_CHARS)}`);
  }
  const shown = new Set(previewed);
  const rest = [...contents.keys()].filter((k) => !shown.has(k));
  const shortRoom = Math.max(0, MAX_MEMORY_ENTRIES_IN_PROMPT - previewed.length);
  for (const key of rest.slice(0, shortRoom)) {
    lines.push(`- ${key}: ${oneLine(contents.get(key)!, MAX_SHORT_PREVIEW_CHARS)}`);
  }
  const keyOnly = rest.slice(shortRoom, shortRoom + MAX_KEY_ONLY_ENTRIES);
  if (keyOnly.length > 0) {
    // Key alone: enough to name an entity, too little to be quoted as one.
    lines.push('- Other entries (key only — content not shown):');
    for (const key of keyOnly) lines.push(`  - ${key}`);
  }
  const omitted = rest.length - shortRoom - keyOnly.length;
  if (omitted > 0) {
    lines.push(`- … ${omitted} more entr${omitted === 1 ? 'y' : 'ies'} omitted for brevity`);
  }
  return lines.join('\n');
}

function parseResolverResponse(text: string, ignoreEntries = false): ResolveResult | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed?.status === 'noop') return { status: 'noop' };
    // Entries win whatever status came with them. An `ambiguous` or `unknown`
    // shape cannot carry them, so honouring that status would discard every
    // phrase that DID resolve — the defect the prompt's "resolve EVERY phrase"
    // rule exists to stop, and a cheap model will not always follow the rule.
    if (!ignoreEntries && Array.isArray(parsed?.entries)) {
      const entries: ResolvedEntry[] = parsed.entries
        .filter(
          (e: any) =>
            e &&
            typeof e.phrase === 'string' &&
            typeof e.resolvedTo === 'string' &&
            typeof e.sourceKey === 'string',
        )
        .filter((e: any) => {
          if (e.resolvedTo.trim().length <= MAX_RESOLVED_TO_CHARS) return true;
          debugLog('reference-resolver:dropped-description', {
            phrase: e.phrase,
            sourceKey: e.sourceKey,
            chars: e.resolvedTo.length,
          });
          return false;
        })
        .map((e: any) => ({ phrase: e.phrase, resolvedTo: e.resolvedTo, sourceKey: e.sourceKey }));
      if (entries.length > 0) return { status: 'resolved', entries };
      if (parsed.status === 'resolved') return { status: 'noop' };
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
  onUsage?: UsageRecorder,
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
    buildMemoryBlock(contents, userInput),
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
    const site = resolveSiteModel(config, 'reference-resolver');

    // LLM subcall cache (#171): deterministic (temperature 0) classification, so
    // identical (model, system, user content) reuse the prior result for the TTL.
    const cacheOn = config.cacheEnabled !== false;
    const cacheKey: LLMCacheKey | null = cacheOn
      ? {
          siteName: 'reference-resolver',
          modelId: site.model.modelId,
          providerOptions: site.providerOptions,
          params: site.params,
          system: RESOLVER_SYSTEM_PROMPT,
          userContent: userMessage,
        }
      : null;
    let rawText: string;
    const cached = cacheKey ? getCachedLLM(cacheKey) : undefined;
    if (cached !== undefined) {
      if (abortSignal?.aborted) return { status: 'noop' };
      debugLog('cache:llm:hit', { site: 'reference-resolver' });
      rawText = cached;
    } else {
      if (cacheKey) debugLog('cache:llm:miss', { site: 'reference-resolver' });
      const t0 = Date.now();
      const result = await traceLlm('reference-resolver', site.model.modelId, () =>
        generateText({
          model: site.model,
          providerOptions: site.providerOptions,
          // Slot params (temperature/topP) apply, but spread BEFORE maxTokens so
          // this site's output cap stays authoritative (#286).
          ...site.params,
          system: RESOLVER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
          maxSteps: 1,
          maxTokens: RESOLVER_MAX_TOKENS,
          abortSignal,
        }),
      );
      // Count this pre-turn call toward the per-turn ledger (#258). Only on a
      // real call — a cache hit above spent no tokens.
      onUsage?.(
        usageRecordFromSite(site, 'reference-resolver', result.usage, result.providerMetadata, {
          latencyMs: Date.now() - t0,
        }),
      );
      if (!result.text) {
        debugLog('reference-resolver:empty-response', null);
        return { status: 'noop' };
      }
      rawText = result.text;
      if (cacheKey) setCachedLLM(cacheKey, rawText);
    }

    debugLog('reference-resolver:response', rawText.slice(0, 200));
    const parsed = parseResolverResponse(rawText);
    if (!parsed) {
      debugLog('reference-resolver:parse-failed', rawText.slice(0, 200));
      return { status: 'noop' };
    }
    const keySet = new Set(memoryKeys);
    let validated = validateAgainstMemory(parsed, keySet, ragFacts.length > 0);
    // Entries outrank a declared `ambiguous`/`unknown` only if they SURVIVE
    // validation. When every one names a source that does not exist, the
    // model's own question is still a real one — fall back to it rather than
    // discarding a valid ambiguity for an invalid resolution.
    if (validated.status === 'noop' && parsed.status === 'resolved') {
      const declared = parseResolverResponse(rawText, true);
      if (declared && declared.status !== 'resolved' && declared.status !== 'noop') {
        validated = validateAgainstMemory(declared, keySet, ragFacts.length > 0);
      }
    }
    debugLog('reference-resolver:result', validated);
    return validated;
  } catch (err) {
    debugLog('reference-resolver:error', err instanceof Error ? err.message : String(err));
    return { status: 'noop' };
  }
}

const MAX_RENDERED_FIELD_CHARS = 200;

export function oneLine(value: string, max: number = MAX_RENDERED_FIELD_CHARS): string {
  const flat = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? clipSafe(flat, max) + '…' : flat;
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
