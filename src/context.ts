import { generateText, type CoreMessage } from 'ai';
import { debugLog, isDebugEnabled } from './logger.js';
import type { BernardConfig } from './config.js';
import { resolveSiteModel } from './model-policy.js';
import type { RAGStore } from './rag.js';
import { DOMAIN_REGISTRY, getDomainIds } from './domains.js';
import {
  CONTEXT_SUMMARY_ACK,
  CONTEXT_SUMMARY_PREFIX,
  TRUNCATION_ACK,
  TRUNCATION_PREFIX,
} from './session-markers.js';
import { usageRecordFromSite, type UsageRecorder } from './framework/hooks/token-stats.js';

export {
  MODEL_CONTEXT_WINDOW_OVERRIDES,
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  getContextWindow,
  estimateMessageTokens,
} from './token-estimate.js';
import {
  getContextWindow,
  estimateMessageTokens,
  estimateMessagesTokens,
} from './token-estimate.js';

/** Fraction of the context window at which history compression is triggered. */
export const COMPRESSION_THRESHOLD = 0.75;
/** Number of recent user/assistant exchanges preserved verbatim during compression. */
export const RECENT_TURNS_TO_KEEP = 4;
/**
 * Minimum estimated tokens in the compressible region for a compaction to be
 * worth its two LLM calls (#310). Below this the summary that replaces the
 * region is a meaningful fraction of the region itself, so the run costs money
 * and latency to recover approximately nothing.
 */
export const MIN_COMPRESSION_RECLAIM_TOKENS = 2_000;

/**
 * Returns true when estimated token usage exceeds the compression threshold.
 * @param lastPromptTokens - actual prompt token count from the last API call
 * @param newMessageEstimate - rough token estimate for the new user message
 * @param model - model name for context window lookup
 * @param contextWindowOverride - optional override for the context window size (0 or undefined = auto-detect)
 */
export function shouldCompress(
  lastPromptTokens: number,
  newMessageEstimate: number,
  model: string,
  contextWindowOverride?: number,
): boolean {
  const contextWindow = getContextWindow(model, contextWindowOverride);
  const estimated = lastPromptTokens + newMessageEstimate;
  return estimated > contextWindow * COMPRESSION_THRESHOLD;
}

/** Convert a CoreMessage array into readable text for the summarizer. */
export function serializeMessages(messages: CoreMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractText(msg);
      if (text) lines.push(`User: ${text}`);
    } else if (msg.role === 'assistant') {
      const text = extractText(msg);
      if (text) lines.push(`Assistant: ${text}`);
      // Include tool calls if present
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            'type' in part &&
            part.type === 'tool-call'
          ) {
            const tc = part as { toolName: string; args: unknown };
            lines.push(`Assistant [tool call]: ${tc.toolName}(${JSON.stringify(tc.args)})`);
          }
        }
      }
    } else if (msg.role === 'tool') {
      // Tool results
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            'type' in part &&
            part.type === 'tool-result'
          ) {
            const tr = part as { toolName?: string; result: unknown };
            const name = tr.toolName ?? 'tool';
            const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
            const truncated = resultStr.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr;
            lines.push(`Tool [${name}]: ${truncated}`);
          }
        }
      }
    }
  }
  return lines.join('\n');
}

/**
 * Walk backward through history to find the split point that keeps the last N
 * user/assistant exchanges intact.
 * Returns the index where "recent" messages start (0 means nothing to compress).
 */
export function countRecentMessages(history: CoreMessage[], turnsToKeep: number): number {
  let userTurns = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      userTurns++;
      if (userTurns === turnsToKeep) {
        // If this is already the start, there's nothing older to compress
        if (i === 0) return 0;
        return i;
      }
    }
  }

  // Fewer user turns than turnsToKeep — nothing to compress
  return 0;
}

const FACT_EXTRACTION_MAX = 500;

/** Facts extracted from a conversation segment, grouped by their knowledge domain. */
export interface DomainFacts {
  /** Domain identifier (e.g. "general", "tool-usage", "user-preferences"). */
  domain: string;
  /** Plain-text facts extracted for this domain. */
  facts: string[];
}

/**
 * Extract facts from serialized conversation text using domain-specific prompts.
 * Runs all domain extractors in parallel via Promise.allSettled.
 * Partial failures (one domain errors) don't block others.
 *
 * @param abortSignal - Optional signal to cancel in-flight LLM calls (e.g. from a
 *   timeout or user Esc). All domain extractors share the same signal.
 */
export async function extractDomainFacts(
  serializedText: string,
  config: BernardConfig,
  onUsage?: UsageRecorder,
  abortSignal?: AbortSignal,
): Promise<DomainFacts[]> {
  if (!serializedText.trim()) return [];

  const domainIds = getDomainIds();

  const site = resolveSiteModel(config, 'compressor');
  const results = await Promise.allSettled(
    domainIds.map(async (domainId) => {
      const domain = DOMAIN_REGISTRY[domainId];

      const t0 = Date.now();
      const result = await generateText({
        model: site.model,
        providerOptions: site.providerOptions,
        // Slot params (temperature/topP) apply, but spread BEFORE maxTokens so
        // this site's output cap stays authoritative (#286).
        ...site.params,
        maxTokens: 2048,
        system: domain.extractionPrompt,
        messages: [
          { role: 'user', content: `Extract facts from this conversation:\n\n${serializedText}` },
        ],
        abortSignal,
      });

      // Count this off-loop call toward the per-turn ledger (#258).
      onUsage?.(
        usageRecordFromSite(site, 'compressor', result.usage, result.providerMetadata, {
          latencyMs: Date.now() - t0,
        }),
      );

      const text = result.text?.trim();
      if (!text) return { domain: domainId, facts: [] };

      // Parse JSON array from response — handle markdown code fences
      const jsonStr = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) return { domain: domainId, facts: [] };

      const facts = parsed
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .filter((item) => item.length <= FACT_EXTRACTION_MAX);

      return { domain: domainId, facts };
    }),
  );

  const domainFacts: DomainFacts[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value.facts.length > 0) {
      domainFacts.push(result.value);
    } else if (result.status === 'rejected') {
      debugLog(
        'context:extractDomainFacts',
        `Domain "${domainIds[index]}" extraction failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  });

  return domainFacts;
}

/**
 * Extract notable facts from serialized conversation text via LLM.
 * Returns a flat array of facts (backward-compatible wrapper around extractDomainFacts).
 * @internal
 */
export async function extractFacts(
  serializedText: string,
  config: BernardConfig,
): Promise<string[]> {
  const domainFacts = await extractDomainFacts(serializedText, config);
  return domainFacts.flatMap((df) => df.facts);
}

/**
 * Minimum history length (message count) for RAG fact extraction to be
 * meaningful — one user turn + one assistant reply. Used by both the REPL exit
 * path (`src/index.ts`) and the `/clear --save` path (`src/ui/App.tsx`) so the
 * threshold can't drift between them.
 */
export const MIN_HISTORY_FOR_FACTS = 2;

export const SUMMARIZATION_PROMPT = `You are a conversation summarizer. Produce a concise summary of the conversation below, preserving:
- Key facts, decisions, and outcomes
- Important tool results and command outputs
- Any user preferences or requirements mentioned
- The overall arc of what was discussed and accomplished

For each task or goal mentioned, clearly mark its status:
- COMPLETED — if the task was finished or resolved
- IN PROGRESS — if the task is still ongoing and unfinished

Be concise but complete. Use bullet points. Do not include greetings or filler.`;

/**
 * Compress conversation history by summarizing older messages via the LLM.
 * Keeps the most recent turns intact and replaces older messages with a summary.
 * On failure, returns the original history unchanged.
 */
export async function compressHistory(
  history: CoreMessage[],
  config: BernardConfig,
  ragStore?: RAGStore,
  onUsage?: UsageRecorder,
  onStart?: () => void,
): Promise<CoreMessage[]> {
  const splitIndex = countRecentMessages(history, RECENT_TURNS_TO_KEEP);

  // Not enough history to compress
  if (splitIndex === 0) {
    return history;
  }

  const oldMessages = history.slice(0, splitIndex);
  const recentMessages = history.slice(splitIndex);

  // Don't pay for a compaction that cannot recover much (#310).
  //
  // `countRecentMessages` splits on *user turns*, and a tool-heavy turn can be
  // dozens of messages carrying several near-`MAX_TOOL_RESULT_CHARS` results —
  // so "everything older than the last 4 turns" is routinely a small slice of
  // the weight. One observed run compressed 8 messages while keeping 54.
  // Summarizing that costs two LLM calls (summarizer + per-domain fact
  // extraction) and replaces the region with a summary of its own, so below the
  // floor the net recovery approaches zero — or goes negative.
  const compressibleTokens = estimateHistoryTokens(oldMessages);
  if (compressibleTokens < MIN_COMPRESSION_RECLAIM_TOKENS) {
    debugLog('context:compress:skipped', {
      reason: 'below-reclaim-floor',
      oldMessageCount: oldMessages.length,
      recentMessageCount: recentMessages.length,
      compressibleTokens,
      floorTokens: MIN_COMPRESSION_RECLAIM_TOKENS,
    });
    return history;
  }

  const serialized = serializeMessages(oldMessages);

  if (!serialized.trim()) {
    return history;
  }

  // Everything above is a decision; everything below spends money. `onStart`
  // lets the caller show progress only once work is actually committed to —
  // without it the REPL printed "Compressing conversation context..." on every
  // turn once the history plateaued, since a skipped run leaves the trigger
  // unchanged and it re-fires next turn.
  onStart?.();

  try {
    // Run summarization and domain-specific fact extraction in parallel
    const summarizerSite = resolveSiteModel(config, 'compressor');
    const summarizeStartedAt = Date.now();
    const summarizePromise = generateText({
      model: summarizerSite.model,
      providerOptions: summarizerSite.providerOptions,
      // Slot params (temperature/topP) apply, but spread BEFORE maxTokens so
      // this site's output cap stays authoritative (#286).
      ...summarizerSite.params,
      maxTokens: 2048,
      system: SUMMARIZATION_PROMPT,
      messages: [{ role: 'user', content: `Summarize this conversation:\n\n${serialized}` }],
    });

    const extractPromise = ragStore
      ? extractDomainFacts(serialized, config, onUsage)
      : Promise.resolve([]);

    const [result, domainFacts] = await Promise.all([summarizePromise, extractPromise]);

    // Count the summarization call toward the per-turn ledger (#258).
    onUsage?.(
      usageRecordFromSite(summarizerSite, 'compressor', result.usage, result.providerMetadata, {
        latencyMs: Date.now() - summarizeStartedAt,
      }),
    );

    // Store extracted facts per domain — await to prevent races on persist()
    if (ragStore && domainFacts.length > 0) {
      await Promise.all(
        domainFacts.map((df) =>
          ragStore.addFacts(df.facts, 'compression', df.domain).catch((err) => {
            debugLog(
              'context:compress:rag',
              `Failed to store facts for domain ${df.domain}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
        ),
      );
    }

    const summary = result.text?.trim();
    if (!summary) {
      debugLog('context:compress', 'Summary was empty, keeping original history');
      return history;
    }

    const summaryMessage: CoreMessage = {
      role: 'user',
      content: `${CONTEXT_SUMMARY_PREFIX} — earlier conversation was compressed. This is background context only. Focus on the messages that follow for the current task.]\n\n${summary}`,
    };

    const ackMessage: CoreMessage = {
      role: 'assistant',
      content: CONTEXT_SUMMARY_ACK,
    };

    // Report what the run actually recovered (#310). Message counts alone were
    // blind to the thing that matters: a run can compress 8 messages, keep 54,
    // and reclaim ~10% of a 101k-token history for the price of two LLM calls,
    // and nothing said so.
    //
    // Derived from `compressibleTokens` rather than re-walking: the summary
    // replaces exactly `oldMessages`, so `reclaimed` is what that region cost
    // minus what replaced it. Two `estimateHistoryTokens(...)` passes over the
    // full history would otherwise run unconditionally to build an argument
    // `debugLog` discards whenever BERNARD_DEBUG is off — and the estimator
    // `JSON.stringify`s every non-string content part.
    if (isDebugEnabled()) {
      const summaryTokens = estimateHistoryTokens([summaryMessage, ackMessage]);
      const tokensBefore = compressibleTokens + estimateHistoryTokens(recentMessages);
      debugLog('context:compress', {
        oldMessageCount: oldMessages.length,
        recentMessageCount: recentMessages.length,
        summaryLength: summary.length,
        domainFactsCount: domainFacts.reduce((sum, df) => sum + df.facts.length, 0),
        tokensBefore,
        tokensAfter: tokensBefore - compressibleTokens + summaryTokens,
        reclaimed: compressibleTokens - summaryTokens,
        reclaimedPct:
          tokensBefore > 0
            ? Math.round(((compressibleTokens - summaryTokens) / tokensBefore) * 100)
            : 0,
      });
    }

    return [summaryMessage, ackMessage, ...recentMessages];
  } catch (err) {
    debugLog('context:compress:error', err instanceof Error ? err.message : String(err));
    return history;
  }
}

/** Max characters to keep per tool-result content part in history. */
export const MAX_TOOL_RESULT_CHARS = 10_000;

/**
 * Truncate large tool-result content parts in response messages before adding to history.
 * The user already sees the full result via onStepFinish; the history copy just needs
 * enough for the LLM to understand what happened on subsequent turns.
 * Returns a new array — does not mutate the input.
 */
export function truncateToolResults(
  messages: CoreMessage[],
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): CoreMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    let changed = false;
    const newContent = msg.content.map((part: any) => {
      if (
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'tool-result'
      ) {
        const resultStr =
          typeof part.result === 'string' ? part.result : JSON.stringify(part.result);
        if (resultStr.length > maxChars) {
          changed = true;
          return {
            ...part,
            result:
              resultStr.slice(0, maxChars) +
              `\n...[truncated from ${resultStr.length} to ${maxChars} chars]`,
          };
        }
      }
      return part;
    });

    return changed ? { ...msg, content: newContent } : msg;
  });
}

/** Estimates token count for a single message's content. */

/**
 * Rough-but-safe token estimator for pre-flight checks.
 * Uses 3.6 chars/token (instead of 4) for a ~10% safety margin,
 * since tool-result tokens can be denser than natural language.
 */
export function estimateHistoryTokens(history: CoreMessage[]): number {
  return estimateMessagesTokens(history);
}

/**
 * Characters of non-history request prefix → tokens.
 *
 * The prefix is everything sent alongside the history: SYSTEM prompt, per-turn
 * context message, and the tool block. Exported so the caller's "are we over
 * budget?" test and {@link emergencyTruncate}'s "what fits?" answer cannot
 * disagree about the divisor — they previously each spelled out `/ 4`.
 *
 * Note this is 4 chars/token while {@link estimateHistoryTokens} uses 3.6. That
 * asymmetry predates #323 and is left alone deliberately: changing it would
 * move every truncation threshold at once.
 */
export function estimatePrefixTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Progressively drop oldest messages until estimated tokens fit within budget.
 * Always keeps at least the last 6 messages so the model has some context.
 * Prepends a synthetic truncation notice.
 *
 * `prefixChars` is the total size of everything that will be sent alongside
 * this history — SYSTEM prompt + per-turn context message + tool block. It is
 * one number rather than one argument per contributor because the caller is the
 * only party that knows the full list, and the previous shape encouraged
 * smuggling: this took a `systemPrompt` string it used only for `.length`, so
 * `agent.ts` padded it with `'\n'.repeat(contextMsgChars)` to get the context
 * message counted, and #323 was about to add a third channel for the tool block
 * (~21k chars / ~5.3k tokens on the main agent — omitted entirely, on the one
 * path that runs *because* a budget was already exceeded).
 */
export function emergencyTruncate(
  history: CoreMessage[],
  tokenBudget: number,
  prefixChars: number,
  currentUserMessage?: string,
): CoreMessage[] {
  const historyBudget = tokenBudget - estimatePrefixTokens(prefixChars);

  const taskHint = currentUserMessage
    ? `\n\nThe user's most recent request was: ${currentUserMessage.slice(0, 500)}`
    : '';

  if (historyBudget <= 0) {
    // Prefix alone exceeds budget — keep last 6 messages anyway
    const kept = history.slice(-6);
    return [
      {
        role: 'user',
        content: `${TRUNCATION_PREFIX} to fit context window. Focus on the most recent messages below.]${taskHint}`,
      },
      { role: 'assistant', content: TRUNCATION_ACK },
      ...kept,
    ];
  }

  // Walk backward, accumulating estimated tokens
  let accumulated = 0;
  let cutoff = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(history[i]);
    if (accumulated + msgTokens > historyBudget) {
      cutoff = i + 1;
      break;
    }
    accumulated += msgTokens;
    if (i === 0) cutoff = 0;
  }

  // Always keep at least 6 messages (covers 1-2 complete user turns with tool calls)
  const minKeep = Math.max(0, history.length - 6);
  if (cutoff > minKeep) cutoff = minKeep;

  // Align cutoff backward to a 'user' message boundary so the kept
  // slice never starts with an orphaned 'tool' or 'assistant' message
  // (which would violate provider role-ordering requirements).
  // Searching backward (instead of forward) preserves the min-keep guarantee.
  if (cutoff > 0 && cutoff < history.length && history[cutoff].role !== 'user') {
    let aligned = cutoff;
    while (aligned > 0 && history[aligned].role !== 'user') {
      aligned--;
    }
    cutoff = aligned;
  }

  const kept = history.slice(cutoff);

  if (cutoff === 0) {
    // Nothing was dropped
    return history;
  }

  const notice: CoreMessage = {
    role: 'user',
    content: `${TRUNCATION_PREFIX} to fit context window. Focus on the most recent messages below.]${taskHint}`,
  };
  const ack: CoreMessage = {
    role: 'assistant',
    content: TRUNCATION_ACK,
  };

  return [notice, ack, ...kept];
}

/**
 * Detect token overflow errors from various providers.
 * Covers Anthropic, OpenAI, and xAI error message patterns.
 */
export function isTokenOverflowError(message: string): boolean {
  return /maximum.*prompt.*length|prompt.*too.*long|context.*length.*exceeded|maximum.*context.*length|token.*limit/i.test(
    message,
  );
}

/** Extract the plain-text content from a CoreMessage, joining multiple text parts with spaces. */
export function extractText(msg: CoreMessage): string | null {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return null;

  const textParts = msg.content
    .filter(
      (p): p is { type: 'text'; text: string } =>
        typeof p === 'object' && p !== null && 'type' in p && p.type === 'text',
    )
    .map((p) => p.text);

  return textParts.length > 0 ? textParts.join(' ') : null;
}
