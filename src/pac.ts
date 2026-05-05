import type { CoreMessage } from 'ai';
import type { BernardConfig } from './config.js';
import { extractToolCallLog, runCritic, CRITIC_MAX_RETRIES } from './critic.js';
import { printCriticRetry } from './output.js';
import { truncateToolResults } from './context.js';
import { debugLog } from './logger.js';

/** Subset of `GenerateTextResult` that callers continue to consume after PAC ends. */
export interface PACFinalResult {
  text: string;
  steps: any[];
  response: { messages: CoreMessage[] };
}

export interface PACLoopResult {
  /**
   * The final generateText result after all PAC iterations. Carrying the whole
   * result (rather than spreading individual fields) prevents call sites from
   * silently going stale when a new field is added to the result shape.
   */
  finalResult: PACFinalResult;
  /** Whether the critic passed on the final iteration. */
  criticPassed: boolean;
  /** Number of retry iterations used. */
  retriesUsed: number;
}

/**
 * Runs a Plan-Act-Critic loop around a generateText result.
 *
 * If tool calls were made, runs the critic. On FAIL, injects feedback
 * and re-generates up to maxRetries times.
 */
export async function runPACLoop(opts: {
  config: BernardConfig;
  userInput: string;
  initialResult: { text: string; steps: any[]; response: { messages: CoreMessage[] } };
  regenerate: (
    extraMessages: CoreMessage[],
  ) => Promise<{ text: string; steps: any[]; response: { messages: CoreMessage[] } }>;
  maxRetries?: number;
  prefix?: string;
  abortSignal?: AbortSignal;
}): Promise<PACLoopResult> {
  const { config, userInput, prefix, abortSignal } = opts;
  const maxRetries = opts.maxRetries ?? CRITIC_MAX_RETRIES;
  let result = opts.initialResult;
  let retriesUsed = 0;

  let toolCallLog = extractToolCallLog(result.steps);
  if (toolCallLog.length === 0) {
    return { finalResult: result, criticPassed: true, retriesUsed: 0 };
  }

  const criticResult = await runCritic(config, userInput, result.text, toolCallLog, {
    prefix,
    abortSignal,
  });

  if (!criticResult || criticResult.verdict === 'PASS' || criticResult.verdict === 'WARN') {
    return { finalResult: result, criticPassed: true, retriesUsed: 0 };
  }

  // FAIL — retry loop
  let lastCriticResult = criticResult;
  while (retriesUsed < maxRetries) {
    if (abortSignal?.aborted) break;

    retriesUsed++;
    printCriticRetry(retriesUsed, maxRetries, prefix);

    const feedbackMessages: CoreMessage[] = [
      ...truncateToolResults(result.response.messages as CoreMessage[]),
      {
        role: 'user' as const,
        content: `The critic agent reviewed your work and found issues:\n\nVERDICT: ${lastCriticResult.verdict}\n${lastCriticResult.explanation}\n\nPlease address these issues and try again.`,
      },
    ];

    try {
      result = await opts.regenerate(feedbackMessages);
      toolCallLog = extractToolCallLog(result.steps);

      if (toolCallLog.length === 0) {
        return { finalResult: result, criticPassed: true, retriesUsed };
      }

      const retryCriticResult = await runCritic(config, userInput, result.text, toolCallLog, {
        isRetry: true,
        prefix,
        abortSignal,
      });

      if (
        !retryCriticResult ||
        retryCriticResult.verdict === 'PASS' ||
        retryCriticResult.verdict === 'WARN'
      ) {
        return { finalResult: result, criticPassed: true, retriesUsed };
      }

      lastCriticResult = retryCriticResult;
    } catch (err) {
      debugLog('pac:retry-error', err instanceof Error ? err.message : String(err));
      break;
    }
  }

  return { finalResult: result, criticPassed: false, retriesUsed };
}
