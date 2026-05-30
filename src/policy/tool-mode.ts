import type { ConfirmThreshold } from '../risk.js';
import { hasToolInvocationKeyword } from '../qualifier/signals.js';
import type { PolicyDecision, SubPolicy } from './types.js';

type ToolMode = NonNullable<PolicyDecision['toolMode']>;

const QUESTION_WORD_RE =
  /^\s*(what|how|why|when|where|who|whom|whose|which|is|are|was|were|do|does|did|can|could|will|would|should|am)\b/i;

/**
 * Cheap "is this a pure information question?" classifier. No LLM call.
 *
 * Returns `true` when the text both
 * 1. lacks any tool-invocation verb (`hasToolInvocationKeyword`), and
 * 2. either ends with `?` or starts with a question word.
 *
 * Biased toward `false` (slightly over-confirming) on ambiguity. Used by
 * the tool-mode policy to flip `confirmThreshold` to `'never'` for plain
 * "what time is it?" / "how does X work?" turns where prompting would be
 * pure friction.
 */
export function isPureQuestion(text: string): boolean {
  if (!text) return false;
  if (hasToolInvocationKeyword(text)) return false;
  const trimmed = text.trim();
  // Require enough signal to be a real question. Trailing "?" alone is too
  // permissive — "delete X?" or bare "?" would otherwise flip the per-turn
  // threshold to `never` and bypass every confirmation. Require a leading
  // question word, and a minimum body length to discount one-glyph input.
  if (trimmed.length < 6) return false;
  return QUESTION_WORD_RE.test(trimmed);
}

function thresholdForMode(mode: 'off' | 'auto' | 'strict'): ConfirmThreshold {
  switch (mode) {
    case 'off':
      return 'never';
    case 'strict':
      return 'medium';
    case 'auto':
    default:
      return 'high';
  }
}

/**
 * Tool-mode + confirmation-threshold policy (issues #144, #179).
 *
 * Per-turn rules:
 * 1. Pure-question turn → `mode: 'read-only'`, `confirmThreshold: 'never'`.
 *    The agent can still call read tools (it usually needs to) but never
 *    pauses for permission.
 * 2. Otherwise → `mode` reflects the persistent `config.toolMode` (#179),
 *    threshold reflects `config.confirmMode` (#144). The two gates are
 *    orthogonal: toolMode answers "is this allowed at all?" and threshold
 *    answers "do I want to confirm allowed actions?".
 *      - confirmMode: off → threshold never
 *      - confirmMode: auto → threshold high (default; dangerous shell + external-API writes)
 *      - confirmMode: strict → threshold medium (also gates local writes + unclassified MCP)
 *
 * Both fields flow through `PolicyDecision.toolMode` and are consumed by
 * `augmentTools` in `src/tools/augment.ts`.
 */
export const toolModePolicy: SubPolicy<ToolMode> = (input) => {
  if (isPureQuestion(input.userInput)) {
    return {
      mode: 'read-only',
      requireConfirmForWrite: false,
      confirmThreshold: 'never',
      reason: 'pure-question',
    };
  }

  const confirmModeValue = input.config.confirmMode ?? 'auto';
  const confirmThreshold = thresholdForMode(confirmModeValue);
  const toolMode = input.config.toolMode ?? 'read-only';
  return {
    mode: toolMode,
    requireConfirmForWrite: confirmThreshold !== 'never',
    confirmThreshold,
    reason: `config-${toolMode}`,
  };
};
