import { providerSupportsPromptCache } from './providers/prompt-cache.js';
import { formatTokenCount } from './output.js';

/**
 * Provider-aware cost guardrail (#298).
 *
 * On a provider with no prompt-cache discount, the large stable request prefix —
 * system + tool schemas + rolling history — is re-billed at full price on *every*
 * step, whereas a caching provider serves most of it at ~10% after step 1.
 * Nothing surfaces this asymmetry today. This module decides whether a completed
 * turn warrants a one-time, rate-limited hint.
 *
 * Which providers those are is owned by `providerSupportsPromptCache` — today
 * custom endpoints only. Do NOT restate the list here: an earlier version named
 * xAI, which stopped being true when xAI was added to `PROMPT_CACHE_PROVIDERS`
 * (every xAI catalog entry publishes a `cacheReadPerMTok` rate), leaving a
 * comment that contradicted the code it introduced.
 */

export interface NoPromptCacheHintInput {
  /** The active provider for the turn (`config.provider`). */
  provider: string;
  /**
   * The turn's main-agent prompt size in tokens — the size re-billed per step.
   * Use the last-step prompt-token count (`spinnerStats.latestPromptTokens`),
   * the closest proxy for the re-sent prefix.
   */
  promptTokens: number;
  /** Threshold above which the prefix is "large enough to warn"; `0` disables. */
  thresholdTokens: number;
  /** Whether the hint already fired this session (rate-limit to once). */
  alreadyWarned: boolean;
}

/**
 * Returns a user-facing hint string when the active provider offers no
 * prompt-cache discount AND this turn's prefix crossed the threshold AND we
 * haven't already warned — otherwise `null`. Pure and side-effect-free so the
 * caller owns the once-per-session latch and the surfacing (toast/banner).
 */
export function noPromptCacheHint(input: NoPromptCacheHintInput): string | null {
  if (input.alreadyWarned) return null;
  if (input.thresholdTokens <= 0) return null; // guardrail disabled
  if (providerSupportsPromptCache(input.provider)) return null; // caching provider — no re-bill
  if (input.promptTokens < input.thresholdTokens) return null; // prefix small enough to ignore
  return (
    `${input.provider} has no prompt-cache discount, so this turn re-billed ~${formatTokenCount(input.promptTokens)} ` +
    `input tokens at full price on every step. To cut cost, delegate MCP-heavy work (keeps the prefix small) ` +
    `or switch to a caching provider (anthropic / openai).`
  );
}
