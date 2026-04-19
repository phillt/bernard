import { generateText } from 'ai';
import { getModel } from './providers/index.js';
import { debugLog } from './logger.js';
import { sanitizeKey, type MemoryStore } from './memory.js';
import type { BernardConfig } from './config.js';

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
const RESOLVER_SYSTEM_PROMPT = `You resolve references in a user's request against their stored personal memory.
You DO NOT retrieve facts. You only resolve phrases the user already wrote.

Given the user's input and a list of available memory entries, identify every phrase that refers to a specific person, thing, routine, or plan stored in memory.

For each phrase:
- If exactly ONE memory entry unambiguously matches the reference, include it in \`entries\`.
- If MULTIPLE entries plausibly match, stop and return status \`ambiguous\` for the FIRST ambiguous reference with 2-4 candidates. Do not guess.
- If the phrase clearly names a specific person, organization, or concrete thing in the user's life (e.g. "my brother", "my dentist", "the car", "my landlord") AND no memory entry matches AND resolving it is necessary to complete the request, stop and return status \`unknown\` for the FIRST such reference. The caller will prompt the user.
- Generic words ("the file", "this code", "the bug", "the PR", "my response", "my email") that don't point at a stored entity are NOT references — omit and prefer \`noop\`.

Output strict JSON matching one of these shapes and nothing else:
  {"status":"noop"}
  {"status":"resolved","entries":[{"phrase":"...","resolvedTo":"...","sourceKey":"..."}]}
  {"status":"ambiguous","reference":"...","candidates":[{"label":"...","sourceKey":"...","preview":"..."}]}
  {"status":"unknown","reference":"..."}

Rules:
- Be conservative. Prefer \`noop\` over guessing.
- Only one \`unknown\` or \`ambiguous\` per turn — pick the most important reference.
- Never invent a sourceKey. Use only keys from the provided memory list.
- \`resolvedTo\` is a short human-readable expansion drawn from the memory content (not a raw dump).
- \`preview\` in candidates is a short one-line summary (~60 chars) distinguishing candidates.`;

const REFERENCE_PRESCAN = /\b(my|our|the|her|his|their|that|this)\s+\w+/i;

export function shouldSkipResolver(userInput: string, _memoryKeys: string[]): boolean {
  // Run the resolver whenever the prompt contains a possessive/demonstrative token, even
  // when memory is empty — the resolver may return `unknown` and prompt the user to fill
  // in the missing entity.
  return !REFERENCE_PRESCAN.test(userInput);
}

function buildHintsBlock(hints?: Map<string, string>): string {
  if (!hints || hints.size === 0) return '';
  const lines: string[] = ['## Persisted hints (honor these first, do not re-ask)'];
  for (const [phrase, sourceKey] of hints.entries()) {
    lines.push(`- "${phrase}" → ${sourceKey}`);
  }
  return lines.join('\n');
}

function buildMemoryBlock(contents: Map<string, string>): string {
  const lines: string[] = ['## Available memory entries'];
  for (const [key, content] of contents.entries()) {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    const preview = trimmed.length > 280 ? trimmed.slice(0, 280) + '…' : trimmed;
    lines.push(`- ${key}: ${preview}`);
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
        .filter((e: any) => e && typeof e.phrase === 'string' && typeof e.resolvedTo === 'string' && typeof e.sourceKey === 'string')
        .map((e: any) => ({ phrase: e.phrase, resolvedTo: e.resolvedTo, sourceKey: e.sourceKey }));
      if (entries.length === 0) return { status: 'noop' };
      return { status: 'resolved', entries };
    }
    if (parsed?.status === 'ambiguous' && typeof parsed.reference === 'string' && Array.isArray(parsed.candidates)) {
      const candidates: Candidate[] = parsed.candidates
        .filter((c: any) => c && typeof c.label === 'string' && typeof c.sourceKey === 'string' && typeof c.preview === 'string')
        .slice(0, 4)
        .map((c: any) => ({ label: c.label, sourceKey: c.sourceKey, preview: c.preview }));
      if (candidates.length < 2) return { status: 'noop' };
      return { status: 'ambiguous', reference: parsed.reference, candidates };
    }
    if (parsed?.status === 'unknown' && typeof parsed.reference === 'string' && parsed.reference.trim().length > 0) {
      return { status: 'unknown', reference: parsed.reference.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

function validateAgainstMemory(result: ResolveResult, memoryKeys: Set<string>): ResolveResult {
  if (result.status === 'resolved') {
    const safe = result.entries.filter((e) => memoryKeys.has(e.sourceKey));
    return safe.length === 0 ? { status: 'noop' } : { status: 'resolved', entries: safe };
  }
  if (result.status === 'ambiguous') {
    const safe = result.candidates.filter((c) => memoryKeys.has(c.sourceKey));
    return safe.length < 2 ? { status: 'noop' } : { status: 'ambiguous', reference: result.reference, candidates: safe };
  }
  return result;
}

export async function resolveReferences(
  userInput: string,
  memoryStore: MemoryStore,
  config: BernardConfig,
  hints?: Map<string, string>,
  abortSignal?: AbortSignal,
): Promise<ResolveResult> {
  const contents = memoryStore.getAllMemoryContents();
  const memoryKeys = Array.from(contents.keys());

  if (shouldSkipResolver(userInput, memoryKeys)) {
    debugLog('reference-resolver:skip', {
      reason: memoryKeys.length === 0 ? 'empty-memory' : 'no-reference-tokens',
      prompt: userInput,
    });
    return { status: 'noop' };
  }

  const resolvedHintKeys = new Set<string>();
  if (hints) {
    for (const [phrase, sourceKey] of hints.entries()) {
      if (memoryKeys.includes(sourceKey) && userInput.toLowerCase().includes(phrase.toLowerCase())) {
        resolvedHintKeys.add(sourceKey);
      }
    }
  }

  const userMessage = [
    `## User request\n${userInput}`,
    buildMemoryBlock(contents),
    buildHintsBlock(hints),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');

  debugLog('reference-resolver:request', {
    prompt: userInput,
    memoryKeys,
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
    debugLog('reference-resolver:response', result.text);
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

export function renderResolvedBlock(entries: ResolvedEntry[]): string {
  if (entries.length === 0) return '';
  const lines: string[] = ['## Resolved References'];
  lines.push(
    'These references resolve phrases in the user\'s request from stored memory. Treat as hints, not rules. If a resolution seems wrong for the current task, cross-check with the memory tool or ask.',
  );
  for (const e of entries) {
    lines.push(`- "${e.phrase}" → ${e.resolvedTo} (from memory: ${e.sourceKey})`);
  }
  return lines.join('\n');
}

