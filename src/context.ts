import { generateText, type CoreMessage } from 'ai';
import { getModel } from './providers/index.js';
import { debugLog } from './logger.js';
import type { BernardConfig } from './config.js';
import type { RAGStore } from './rag.js';
import { DOMAIN_REGISTRY, getDomainIds } from './domains.js';

/** Model name → context window size in tokens */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-5-20250929': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  // OpenAI
  'gpt-5.2': 400_000,
  'gpt-5.2-chat-latest': 128_000,
  'gpt-4o-mini': 128_000,
  o3: 200_000,
  'o3-mini': 200_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  'gpt-4.1-nano': 1_000_000,
  // xAI
  'grok-4-1-fast-reasoning': 2_000_000,
  'grok-4-1-fast-non-reasoning': 2_000_000,
  'grok-4-fast-reasoning': 2_000_000,
  'grok-4-fast-non-reasoning': 2_000_000,
  'grok-4-0709': 256_000,
  'grok-code-fast-1': 256_000,
  'grok-3': 131_072,
  'grok-3-mini': 131_072,
};

/** Fallback context window size (in tokens) for models not listed in MODEL_CONTEXT_WINDOWS. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Fraction of the context window at which history compression is triggered. */
export const COMPRESSION_THRESHOLD = 0.75;
/** Number of recent user/assistant exchanges preserved verbatim during compression. */
export const RECENT_TURNS_TO_KEEP = 4;

/** Look up context window for a model, falling back to 128k for unknown models. */
export function getContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Returns true when estimated token usage exceeds the compression threshold.
 * @param lastPromptTokens - actual prompt token count from the last API call
 * @param newMessageEstimate - rough token estimate for the new user message
 * @param model - model name for context window lookup
 */
export function shouldCompress(
  lastPromptTokens: number,
  newMessageEstimate: number,
  model: string,
): boolean {
  const contextWindow = getContextWindow(model);
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
 */
export async function extractDomainFacts(
  serializedText: string,
  config: BernardConfig,
): Promise<DomainFacts[]> {
  if (!serializedText.trim()) return [];

  const domainIds = getDomainIds();

  const results = await Promise.allSettled(
    domainIds.map(async (domainId) => {
      const domain = DOMAIN_REGISTRY[domainId];

      const result = await generateText({
        model: getModel(config.provider, config.model),
        maxTokens: 2048,
        system: domain.extractionPrompt,
        messages: [
          { role: 'user', content: `Extract facts from this conversation:\n\n${serializedText}` },
        ],
      });

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

const SUMMARIZATION_PROMPT = `You are a conversation summarizer. Produce a concise summary of the conversation below, preserving:
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
): Promise<CoreMessage[]> {
  const splitIndex = countRecentMessages(history, RECENT_TURNS_TO_KEEP);

  // Not enough history to compress
  if (splitIndex === 0) {
    return history;
  }

  const oldMessages = history.slice(0, splitIndex);
  const recentMessages = history.slice(splitIndex);
  const serialized = serializeMessages(oldMessages);

  if (!serialized.trim()) {
    return history;
  }

  try {
    // Run summarization and domain-specific fact extraction in parallel
    const summarizePromise = generateText({
      model: getModel(config.provider, config.model),
      maxTokens: 2048,
      system: SUMMARIZATION_PROMPT,
      messages: [{ role: 'user', content: `Summarize this conversation:\n\n${serialized}` }],
    });

    const extractPromise = ragStore ? extractDomainFacts(serialized, config) : Promise.resolve([]);

    const [result, domainFacts] = await Promise.all([summarizePromise, extractPromise]);

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
      content: `[Context Summary — earlier conversation was compressed. This is background context only. Focus on the messages that follow for the current task.]\n\n${summary}`,
    };

    const ackMessage: CoreMessage = {
      role: 'assistant',
      content: "Understood. I have the context from our earlier conversation. Let's continue.",
    };

    debugLog('context:compress', {
      oldMessageCount: oldMessages.length,
      recentMessageCount: recentMessages.length,
      summaryLength: summary.length,
      domainFactsCount: domainFacts.reduce((sum, df) => sum + df.facts.length, 0),
    });

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

/**
 * Rough-but-safe token estimator for pre-flight checks.
 * Uses 3.6 chars/token (instead of 4) for a ~10% safety margin,
 * since tool-result tokens can be denser than natural language.
 */
export function estimateHistoryTokens(history: CoreMessage[]): number {
  let chars = 0;
  for (const msg of history) {
    chars += JSON.stringify(msg.content).length;
  }
  return Math.ceil(chars / 3.6);
}

/**
 * Progressively drop oldest messages until estimated tokens fit within budget.
 * Always keeps at least the last 6 messages so the model has some context.
 * Prepends a synthetic truncation notice.
 */
export function emergencyTruncate(
  history: CoreMessage[],
  tokenBudget: number,
  systemPrompt: string,
  currentUserMessage?: string,
): CoreMessage[] {
  const systemTokens = Math.ceil(systemPrompt.length / 4);
  const historyBudget = tokenBudget - systemTokens;

  const taskHint = currentUserMessage
    ? `\n\nThe user's most recent request was: ${currentUserMessage.slice(0, 500)}`
    : '';

  if (historyBudget <= 0) {
    // System prompt alone exceeds budget — keep last 6 messages anyway
    const kept = history.slice(-6);
    return [
      {
        role: 'user',
        content: `[Earlier conversation was truncated to fit context window. Focus on the most recent messages below.]${taskHint}`,
      },
      { role: 'assistant', content: 'Understood. Continuing with limited context.' },
      ...kept,
    ];
  }

  // Walk backward, accumulating estimated tokens
  let accumulated = 0;
  let cutoff = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = Math.ceil(JSON.stringify(history[i].content).length / 3.6);
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
    content: `[Earlier conversation was truncated to fit context window. Focus on the most recent messages below.]${taskHint}`,
  };
  const ack: CoreMessage = {
    role: 'assistant',
    content: 'Understood. Continuing with limited context.',
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
