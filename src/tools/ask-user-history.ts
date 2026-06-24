/**
 * Helpers for injecting ask_user answers into conversation history as
 * `role:'user'` messages (#245). Keeping this logic in a pure module makes
 * it easy to unit-test without wiring up the full REPL.
 */

import type { CoreMessage } from 'ai';
import type { AskUserBatchResult } from './types.js';

/**
 * Formats the resolved answers from an `ask_user` tool call into a human-
 * readable string suitable for a `role:'user'` history message.
 *
 * Returns `null` in cases where no user bubble should be inserted:
 * - `{ unavailable: true }` — headless; no interactive user.
 * - `{ cancelled: true, answered: [] }` — user cancelled before answering
 *   anything; no content to show.
 *
 * Array slots (multi-select answers) are comma-joined so the message is
 * always a plain string.
 */
export function formatAskUserAnswers(
  payload: AskUserBatchResult,
  questions?: string[],
): string | null {
  // Headless — no user interaction took place.
  if ('unavailable' in payload) return null;

  if ('cancelled' in payload && payload.cancelled) {
    const answered = payload.answered;
    if (!answered || answered.length === 0) {
      // Cancelled before the first answer — nothing to show.
      return null;
    }
    // Partial answers before cancellation.
    const lines = answered.map((a, i) => {
      const label = questions?.[i] ? `${questions[i]}: ` : '';
      const value = Array.isArray(a) ? a.join(', ') : a;
      return `${label}${value}`;
    });
    lines.push('[cancelled]');
    return lines.join('\n');
  }

  // Fully answered.
  const answers = (payload as { answers: (string | string[])[] }).answers;
  if (!answers || answers.length === 0) return null;

  // Format all answers (single or multi-question) uniformly so that question
  // labels are applied regardless of batch size. This ensures the output is
  // consistent whether `questions` is provided or not.
  const formatted = answers.map((a, i) => {
    const label = questions?.[i] ? `${questions[i]}: ` : '';
    const value = Array.isArray(a) ? a.join(', ') : a;
    return `${label}${value}`;
  });

  if (answers.length === 1) {
    // Single question — return the single formatted line directly (no newline).
    return formatted[0];
  }

  return formatted.join('\n');
}

/**
 * Scans the tail of `history` (from `start` forward) for any `role:'tool'`
 * messages that include an `ask_user` result, synthesises a `role:'user'`
 * message from the answers, and pushes it onto `history` in place.
 *
 * The scan is robust to a shrunk/replaced history array: `start` is clamped
 * so it never exceeds the current array length.
 *
 * Deduplication: `injectedIds` is a caller-supplied Set that tracks tool call
 * IDs already processed this turn. Pass the same Set on every call within a
 * turn (e.g. auto-continue loop) to prevent double-injection.
 *
 * The `role:'tool'` result message is kept intact — we are ADDING a user
 * message after it, not replacing it.
 */
export function injectAskUserHistoryMessages(
  history: CoreMessage[],
  start: number,
  injectedIds: Set<string>,
): void {
  if (history.length === 0) return;

  // Clamp in case history shrank due to compression/truncation mid-turn.
  // `history.length - 1` is the maximum valid index; we must not pass the
  // end of the array or the loop below never runs.
  const safeStart = start < history.length ? start : Math.max(0, history.length - 1);

  // We snapshot the length before looping so any messages we push during the
  // loop don't get re-scanned.
  const scanEnd = history.length;

  for (let i = safeStart; i < scanEnd; i++) {
    const msg = history[i];
    if (msg.role !== 'tool') continue;

    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (
        typeof part !== 'object' ||
        part === null ||
        (part as { type?: unknown }).type !== 'tool-result' ||
        (part as { toolName?: unknown }).toolName !== 'ask_user'
      ) {
        continue;
      }

      const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
      const idKey = typeof toolCallId === 'string' ? toolCallId : `idx:${i}`;

      // Skip if we already injected a user message for this call.
      if (injectedIds.has(idKey)) continue;

      // Parse the result — `result` holds the JSON string returned by execute().
      const raw = (part as { result?: unknown }).result;
      let payload: AskUserBatchResult & { unavailable?: boolean };
      try {
        payload =
          typeof raw === 'string'
            ? (JSON.parse(raw) as typeof payload)
            : (raw as typeof payload);
      } catch {
        continue;
      }
      if (!payload || typeof payload !== 'object') continue;

      const text = formatAskUserAnswers(payload as AskUserBatchResult);
      if (!text) {
        // Still mark as processed so we don't revisit on the next call.
        injectedIds.add(idKey);
        continue;
      }

      history.push({
        role: 'user' as const,
        content: text,
      });
      injectedIds.add(idKey);
    }
  }
}
