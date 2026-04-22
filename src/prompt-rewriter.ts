import { generateText } from 'ai';
import { getModel } from './providers/index.js';
import type { ModelProfile } from './providers/profiles.js';
import type { ResolvedEntry } from './reference-resolver.js';
import type { BernardConfig } from './config.js';
import { debugLog } from './logger.js';

/**
 * Model-specific Prompt Rewriter — a pre-turn LLM pass that restructures the
 * user's input for the active model family while preserving intent.
 *
 * Acts as a compiler preprocessor, not a planner: no new verbs, no new entities,
 * no expanded scope. Consumes resolved entries from {@link ./reference-resolver}
 * so concrete names can be inlined into the rewritten prompt (optional).
 *
 * All failure paths fall through to `{ status: 'noop' }` so the caller can
 * default to the original user input. The LLM call uses temperature 0 for
 * determinism.
 */

export type RewriteResult = { status: 'noop' } | { status: 'rewritten'; text: string };

const REWRITER_MAX_TOKENS = 768;

/** Skip prompts shorter than this — not worth the LLM round-trip. */
const MIN_INPUT_CHARS = 8;

/**
 * Skip prompts that already start with a structural marker (the user likely
 * authored a formatted prompt). Keeps round-trips off short, obvious inputs.
 */
const STRUCTURED_PREFIX = /^\s*(task:|#\s|<[a-z])/i;

/** Reject suspiciously short rewrites relative to the source (catches truncation). */
const MIN_REWRITE_RATIO = 0.4;

/**
 * Whole-prompt matches for conversational replies and acknowledgments. Full-match only —
 * "ok" alone is a followup, but "ok so what I need is..." is a real request.
 */
const CONVERSATIONAL_RE =
  /^(ok(ay)?|thanks?|thank you|yes|yep|yeah|no|nope|sure|cool|got it|sounds good|continue|go ahead|keep going|next|and|also|why|how come|really|hmm+|what)[.!?]*$/i;

/**
 * Short follow-up prefixes that key off conversation state. No nouns worth inlining,
 * no structure to reshape — pass the prompt through to the main agent untouched.
 */
const FOLLOWUP_PREFIX_RE =
  /^(what about|how about|and what|why not|why is|why does|is that|does that|can you also|can you now)\b/i;

export type SkipReason = 'disabled' | 'short-or-structured' | 'conversational' | 'followup' | null;

/**
 * Returns a specific reason string when the rewriter should skip, or `null` to continue.
 * Exposed so the REPL (and tests) can log the precise skip cause.
 */
export function skipRewriterReason(input: string): SkipReason {
  const trimmed = input.trim();
  // Check conversational / followup patterns first so they report a specific reason
  // rather than falling through to the length check for short acknowledgments like "why?".
  if (CONVERSATIONAL_RE.test(trimmed)) return 'conversational';
  if (FOLLOWUP_PREFIX_RE.test(trimmed)) return 'followup';
  if (trimmed.length < MIN_INPUT_CHARS) return 'short-or-structured';
  if (trimmed.startsWith('/')) return 'short-or-structured';
  if (STRUCTURED_PREFIX.test(trimmed)) return 'short-or-structured';
  return null;
}

export function shouldSkipRewriter(input: string): boolean {
  return skipRewriterReason(input) !== null;
}

function buildSystemPrompt(profile: ModelProfile): string {
  return `You are a prompt preprocessor. Your job is to rewrite the user's input so a downstream "${profile.family}" model handles it reliably.

Rules:
- Preserve every verb, noun, and constraint the user wrote. Do not add tasks. Do not remove tasks. Do not answer the request.
- Treat this as a lossless structural transform, not reasoning. If in doubt, output status "noop".
- If resolved entities are provided, you MAY inline them verbatim to eliminate ambiguity (e.g. replace "my daughter" with "Sarah, my daughter"). Never invent or extrapolate entities.
- Never wrap the rewrite in the downstream wrapper (\`<user_request>\`) or in markdown code fences — the caller applies those. Lightweight structural tags like \`<task>\`, \`<context>\`, or \`<constraints>\` are allowed when the per-model hint recommends them.
- Per-model hint: ${profile.rewriterHint}

Output strict JSON and nothing else. One of:
  {"status":"noop"}
  {"status":"rewritten","text":"…"}

Prefer "noop" generously. Specifically return "noop" when the input is:
- A followup or clarification to a previous turn (e.g. "why not?", "what about the other one?", "and then?").
- An acknowledgment or conversational reply (e.g. "ok thanks", "got it", "sounds good").
- A short single-sentence question that is already unambiguous.
- Already clearly structured.

Only rewrite when the original prompt has real ambiguity or missing structure that a lossless transform can fix. When in doubt, "noop".`;
}

function buildUserMessage(input: string, resolvedEntries: ResolvedEntry[]): string {
  const blocks: string[] = [`## Original user input\n${input}`];
  if (resolvedEntries.length > 0) {
    const lines: string[] = ['## Resolved entities (optional inlining)'];
    for (const e of resolvedEntries) {
      lines.push(`- "${e.phrase}" → ${e.resolvedTo}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function parseRewriterResponse(text: string): RewriteResult | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed?.status === 'noop') return { status: 'noop' };
    if (parsed?.status === 'rewritten' && typeof parsed.text === 'string') {
      const trimmed = parsed.text.trim();
      if (trimmed.length === 0) return null;
      return { status: 'rewritten', text: trimmed };
    }
    return null;
  } catch {
    return null;
  }
}

export async function rewritePrompt(
  input: string,
  profile: ModelProfile,
  resolvedEntries: ResolvedEntry[],
  config: BernardConfig,
  abortSignal?: AbortSignal,
): Promise<RewriteResult> {
  if (!config.promptRewriter) {
    debugLog('prompt-rewriter:skip', { reason: 'disabled' });
    return { status: 'noop' };
  }
  const skipReason = skipRewriterReason(input);
  if (skipReason !== null) {
    debugLog('prompt-rewriter:skip', { reason: skipReason, input });
    return { status: 'noop' };
  }

  debugLog('prompt-rewriter:request', { family: profile.family, inputChars: input.length });

  try {
    const result = await generateText({
      model: getModel(config.provider, config.model),
      system: buildSystemPrompt(profile),
      messages: [{ role: 'user', content: buildUserMessage(input, resolvedEntries) }],
      maxSteps: 1,
      maxTokens: REWRITER_MAX_TOKENS,
      temperature: 0,
      abortSignal,
    });

    if (!result.text) {
      debugLog('prompt-rewriter:empty-response', null);
      return { status: 'noop' };
    }

    const parsed = parseRewriterResponse(result.text);
    if (!parsed) {
      debugLog('prompt-rewriter:parse-failed', result.text.slice(0, 200));
      return { status: 'noop' };
    }

    if (parsed.status === 'rewritten') {
      if (parsed.text.length < input.length * MIN_REWRITE_RATIO) {
        debugLog('prompt-rewriter:rejected-truncation', {
          original: input.length,
          rewritten: parsed.text.length,
        });
        return { status: 'noop' };
      }
      debugLog('prompt-rewriter:rewritten', { chars: parsed.text.length });
      return parsed;
    }

    debugLog('prompt-rewriter:noop', null);
    return parsed;
  } catch (err) {
    debugLog('prompt-rewriter:error', err instanceof Error ? err.message : String(err));
    return { status: 'noop' };
  }
}
