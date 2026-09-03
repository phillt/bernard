import type { CoreMessage } from 'ai';
import { estimateMessagesTokens, getContextWindow } from '../../token-estimate.js';

/**
 * Refuses a dispatch whose seed cannot fit the model it resolved to (#451).
 *
 * `runDefinition` measured nothing about the size of what it was about to
 * send. That was tolerable while every dispatch was text; #427 made a dispatch
 * able to carry up to 4 × 10 MB of image, so a `tool_wrapper_run` pinned to a
 * small-context cheap model would accept the attachment, send it, and fail at
 * the provider — mid-dispatch, after the pool slot was taken and the
 * connection made.
 *
 * **Scoped to the whole seed, not to attachments.** Text can overflow a small
 * pinned model too; images only made it easy to hit. Building the
 * attachment-only version would be building the narrow case of something
 * already needed.
 */

/**
 * Fraction of the window a dispatch's seed may occupy before it is refused.
 *
 * Below `agent.ts`'s own 0.9 preflight ratio on purpose. That one runs with a
 * COMPLETE prefix and can truncate; this one runs with an incomplete prefix
 * (see {@link seedBudgetRefusal}) and can only refuse, so it needs the headroom
 * that the difference represents.
 */
export const SEED_BUDGET_RATIO = 0.8;

export interface SeedBudgetInput {
  seed: CoreMessage[];
  /** Post-resolution model name — never `config.model`, which may not be it. */
  modelName: string;
  /** `BernardConfig.tokenWindow`; 0 or undefined means auto-detect. */
  windowOverride?: number;
  /** SYSTEM prompt + tool block, in characters. */
  prefixChars: number;
}

/**
 * A refusal string, or `null` to proceed.
 *
 * **The estimate is deliberately an under-count**, and saying so is part of the
 * contract: the per-turn `<system_provided_context>` message is assembled
 * inside `innerIterate`, after this runs, so it is not included. That is
 * acceptable for a threshold set below the window — the check exists to catch
 * an order-of-magnitude mistake (a 10 MB image against a 32k model), not to
 * predict the exact wire size. `agent.ts`'s preflight is the one that counts
 * everything, and it is the one that can truncate.
 */
export function seedBudgetRefusal(input: SeedBudgetInput): string | null {
  const window = getContextWindow(input.modelName, input.windowOverride);
  const budget = Math.floor(window * SEED_BUDGET_RATIO);
  // 4 chars/token for the prefix, matching `estimatePrefixTokens`. The 3.6 the
  // message estimator uses is the other half of an asymmetry that predates
  // this and is left alone deliberately.
  const estimate = estimateMessagesTokens(input.seed) + Math.ceil(input.prefixChars / 4);
  if (estimate <= budget) return null;
  return (
    `This dispatch is too large for ${input.modelName}: about ${estimate.toLocaleString()} tokens ` +
    `against a ${window.toLocaleString()}-token window. Shorten the task or context, send fewer ` +
    'attachments, or pass `provider` and `model` to choose a larger model.'
  );
}
