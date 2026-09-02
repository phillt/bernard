import { generateText } from 'ai';
import type { BernardConfig } from './config.js';
import { resolveSiteModel } from './model-policy.js';
import { debugLog, traceLlm } from './logger.js';
import { getCachedLLM, setCachedLLM, type LLMCacheKey } from './llm-cache.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';
import { SPEECH_EXAMPLES } from './speech-examples.js';
import {
  toSpeechText,
  reduceUnresolved,
  speechNormalizeSkipReason,
  clampForSpeech,
  SPEECH_MAX_CHARS,
  type SpeechText,
} from './speech-text.js';

/**
 * Stage 2 of speech text normalization (#432) — the semantic half.
 *
 * `speech-text.ts` has already stripped markup and verbalized every semiotic
 * class decidable from surface form. What reaches here is the residue that
 * needs a *judgement*: is `2026` a year or a quantity, what is that URL
 * actually a link to, which rows of that table matter. See that module's header
 * for why the boundary is drawn at ambiguity rather than difficulty.
 *
 * ## Fails OPEN, deliberately
 *
 * Every failure path returns the deterministic reduction rather than nothing.
 * This is the opposite of `claim-verifier.ts`, and the difference is what the
 * neutral outcome means: there, an unverified answer wearing a verified
 * answer's clothes is a lie, so it must fail closed. Here the neutral outcome
 * is audible, harmless, and still strictly better than what shipped before —
 * refusing to speak would be far worse than speaking plainly.
 *
 * ## Plain text out, not strict JSON
 *
 * A deliberate departure from `prompt-rewriter` / `recall-filter` /
 * `claim-verifier`. Those return JSON because the model makes a real structured
 * decision — `noop` vs `rewritten`, a verdict plus a reason. Here it makes none:
 * it always produces a script, and "produced nothing usable" is an error this
 * module already has to handle. JSON would buy one extra failure mode and a
 * quoting surface over multi-line prose headed for argv, in exchange for a
 * discriminator with exactly one value. The guards below replace the parser.
 */

export type NormalizeResult = { status: 'noop' } | { status: 'normalized'; spokenForm: string };

/**
 * The output should be no LONGER than its input — code is dropped, tables are
 * summarised. Past this the model is elaborating or answering the text instead
 * of voicing it.
 */
const MAX_OUTPUT_RATIO = 1.6;

/**
 * …and no SHORTER than this. The guard that mechanically enforces "re-translate,
 * don't summarize" — the single most likely way for this pass to lose a fact.
 * Mirrors `prompt-rewriter`'s `MIN_REWRITE_RATIO`.
 */
const MIN_OUTPUT_RATIO = 0.25;

const SPEECH_NORMALIZER_MAX_TOKENS = 1024;

/** A model imitating its input's shape rather than voicing its content. */
const MARKUP_LEAK_RE = /(^|\n)\s*(?:```|#{1,6}\s|\|.*\|\s*$)/;

/** A narrating preamble is stripped rather than rejected — the body is usable. */
const PREAMBLE_RE = /^(here'?s|sure|okay|ok|certainly)\b[^\n]*:\s*\n/i;

function buildSystemPrompt(): string {
  return `You are a text normalizer for a speech synthesizer.

The text below has already been read on screen by the user. Your output is spoken aloud by a text-to-speech engine and is never displayed. Convert the written form into the spoken form — what a person reading this aloud would actually say.

Identify each token's semiotic class (number, year, identifier, link, path, table, measurement) and verbalize it according to that class.

Rules:
- Say the same facts. Add nothing, remove no claim, answer nothing. This is a transform, not a reply. Never summarize.
- Numbers that are identifiers — versions, commit hashes, order numbers, issue numbers — are read as digit groups. Numbers that are quantities stay quantities. Years are read as years.
- Never spell a link. Name what it points at. If you cannot name it, say the host only.
- A table is not read cell by cell. Say what it shows and the rows that matter, in sentences.
- Read a file path as its filename, not directory by directory.
- Expand symbols and abbreviations into words.
- Keep sentences short enough to say in one breath.
- Do not narrate what you are doing. No preamble, no "here is", no closing offer.
- Output only the spoken text. No markdown, no code fences, no headings, no lists.

Examples — written form, then how to say it:
${renderExamples()}`;
}

/**
 * Renders {@link SPEECH_EXAMPLES} as the few-shot block, including the `avoid`
 * readings. Showing a small model the wrong reading beside the right one is
 * what stops it reverting to the wrong one — the deterministic rows are included
 * too, since the model sees their output and must not undo it.
 */
function renderExamples(): string {
  return SPEECH_EXAMPLES.map((ex) => {
    const lines = [`- ${ex.writtenForm.replace(/\n/g, ' ')}`, `  say: ${ex.spokenForm}`];
    if (ex.avoid) lines.push(`  not: ${ex.avoid}`);
    return lines.join('\n');
  }).join('\n');
}

/**
 * Constant — `SPEECH_EXAMPLES` is a module constant and the prompt derives
 * entirely from it. Built once rather than per call, since it is also embedded
 * in the LLM cache key and would otherwise be re-serialized on every lookup.
 */
const SYSTEM_PROMPT = buildSystemPrompt();

/**
 * Shape and length guards, in place of a JSON parser. Returns why the output was
 * rejected, or `null` to accept — the same idiom as `speechNormalizeSkipReason`,
 * so "why did we bail" reads the same on both sides of the module boundary.
 */
function rejectReason(
  text: string,
  inputChars: number,
): 'empty' | 'markup' | 'too-long' | 'too-short' | null {
  if (text.length === 0) return 'empty';
  if (MARKUP_LEAK_RE.test(text)) return 'markup';
  if (text.length > inputChars * MAX_OUTPUT_RATIO) return 'too-long';
  if (text.length < inputChars * MIN_OUTPUT_RATIO) return 'too-short';
  return null;
}

/**
 * The LLM pass alone. Exported for its own test; callers want
 * {@link toSpokenForm}, which owns the whole fail-open chain.
 */
export async function normalizeSpeech(
  prepared: SpeechText,
  config: BernardConfig,
  abortSignal?: AbortSignal,
  onUsage?: UsageRecorder,
): Promise<NormalizeResult> {
  if (!config.voiceNormalizer) {
    debugLog('speech-normalizer:skip', { reason: 'disabled' });
    return { status: 'noop' };
  }
  const skip = speechNormalizeSkipReason(prepared);
  if (skip !== null) {
    debugLog('speech-normalizer:skip', { reason: skip, unresolved: prepared.unresolved });
    return { status: 'noop' };
  }

  const input = prepared.spokenForm;
  debugLog('speech-normalizer:request', {
    chars: input.length,
    unresolved: prepared.unresolved,
  });

  try {
    const site = resolveSiteModel(config, 'speech-normalizer');
    const system = SYSTEM_PROMPT;

    // The cache-key → getCachedLLM → abort-on-hit → traceLlm → usageRecordFromSite
    // → setCachedLLM sequence below is the seventh copy of a block that
    // `prompt-rewriter`, `recall-filter`, `reference-resolver`,
    // `specialist-detector` and `reference-tool-lookup` (twice) also carry —
    // and those have already drifted three ways (one omits the cache-hit abort
    // guard entirely, another never forwards `abortSignal`). This copy follows
    // `prompt-rewriter.ts` deliberately; extracting the shape is a six-file
    // refactor that does not belong in this change.
    const cacheOn = config.cacheEnabled !== false;
    const cacheKey: LLMCacheKey | null = cacheOn
      ? {
          siteName: 'speech-normalizer',
          modelId: site.model.modelId,
          providerOptions: site.providerOptions,
          params: site.params,
          system,
          userContent: input,
        }
      : null;

    let rawText: string;
    const cached = cacheKey ? getCachedLLM(cacheKey) : undefined;
    if (cached !== undefined) {
      // Honour a pre-aborted signal even on a cache hit, so a superseded
      // readback can't sneak past the guard by being cheap.
      if (abortSignal?.aborted) {
        debugLog('speech-normalizer:aborted', null);
        return { status: 'noop' };
      }
      debugLog('cache:llm:hit', { site: 'speech-normalizer' });
      rawText = cached;
    } else {
      if (cacheKey) debugLog('cache:llm:miss', { site: 'speech-normalizer' });
      const t0 = Date.now();
      const result = await traceLlm('speech-normalizer', site.model.modelId, () =>
        generateText({
          model: site.model,
          providerOptions: site.providerOptions,
          // Slot params spread BEFORE maxTokens so this site's output cap stays
          // authoritative — a slot maxOutputTokens must not blow it (#286).
          ...site.params,
          system,
          messages: [{ role: 'user', content: input }],
          maxSteps: 1,
          maxTokens: SPEECH_NORMALIZER_MAX_TOKENS,
          abortSignal,
        }),
      );
      onUsage?.(
        usageRecordFromSite(site, 'speech-normalizer', result.usage, result.providerMetadata, {
          latencyMs: Date.now() - t0,
        }),
      );
      if (!result.text) {
        debugLog('speech-normalizer:empty-response', null);
        return { status: 'noop' };
      }
      rawText = result.text;
      if (cacheKey) setCachedLLM(cacheKey, rawText);
    }

    const text = rawText.replace(PREAMBLE_RE, '').trim();
    const reject = rejectReason(text, input.length);
    if (reject) {
      debugLog(`speech-normalizer:rejected-${reject}`, {
        inputChars: input.length,
        outputChars: rawText.length,
      });
      return { status: 'noop' };
    }
    debugLog('speech-normalizer:normalized', { chars: text.length });
    return { status: 'normalized', spokenForm: text };
  } catch (err) {
    debugLog('speech-normalizer:error', err instanceof Error ? err.message : String(err));
    return { status: 'noop' };
  }
}

export interface SpokenFormResult {
  /** Argv-ready. Empty means there is nothing worth speaking. */
  text: string;
  /** True when the model's rendering won — the caller's one-time notice keys on this. */
  normalized: boolean;
}

/**
 * The one entry point: written form in, argv-ready spoken form out. Never
 * throws.
 *
 * The fail-open chain, in order — every step past the first lands on the
 * deterministic reduction, never on the raw markdown:
 *
 *  1. `toSpeechText` (cannot throw)
 *  2. the pass is disabled
 *  3. the skip predicate fired
 *  4. `resolveSiteModel` threw (no key for the cheap tier)
 *  5. `generateText` threw, aborted, or returned nothing
 *  6. a shape or length guard rejected the output
 *  7. success — the model's text
 *  8. `clampForSpeech`, then a last non-empty check
 */
export async function toSpokenForm(
  writtenForm: string,
  config: BernardConfig,
  abortSignal?: AbortSignal,
  onUsage?: UsageRecorder,
): Promise<SpokenFormResult> {
  const prepared = toSpeechText(writtenForm);
  const result = await normalizeSpeech(prepared, config, abortSignal, onUsage);

  const normalized = result.status === 'normalized';
  const winner = normalized ? result.spokenForm : reduceUnresolved(prepared.spokenForm);

  let text = clampForSpeech(winner, SPEECH_MAX_CHARS);
  if (text.length === 0) text = clampForSpeech(prepared.spokenForm, SPEECH_MAX_CHARS);
  return { text, normalized };
}
