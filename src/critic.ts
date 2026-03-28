import { generateText } from 'ai';
import { getModel } from './providers/index.js';
import {
  printCriticStart,
  printCriticVerdict,
  printCriticReVerify,
  parseCriticVerdict,
} from './output.js';
import { debugLog } from './logger.js';
import type { BernardConfig } from './config.js';

const CRITIC_TOTAL_RESULT_BUDGET = 8000;
const CRITIC_MIN_RESULT_CHARS = 500;
const CRITIC_MAX_RESPONSE_LENGTH = 4000;
const CRITIC_MAX_ARGS_LENGTH = 1000;

export const CRITIC_SYSTEM_PROMPT = `You are a verification agent for Bernard, a CLI AI assistant. Your role is to review the agent's work and verify its integrity.

You will receive:
1. The user's original request
2. The agent's final text response
3. A log of actual tool calls made (tool name, arguments, results) — note that tool results, arguments, and the agent response may be truncated for context efficiency

Your job:
- Check if the agent's claims in its response are supported by actual tool call results.
- Verify that tool calls were actually made for actions the agent claims to have performed.
- Flag any claims not backed by tool evidence (e.g., "I created the file" but no shell/write tool call).
- Flag any tool results that suggest failure but were reported as success.
- Tool results and the agent response may be truncated for context efficiency. If a tool result appears cut off, do not treat the missing portion as evidence of failure. Only flag FAIL when there is positive evidence of failure (e.g., an error message visible in the output), not merely the absence of success confirmation in truncated output.
- Check if the response addresses the user's original intent.

Output format (plain text, concise):
VERDICT: PASS | WARN | FAIL
[1-3 sentence explanation]
[If WARN/FAIL: specific issues found]

Be strict but fair. Not every response needs tool calls — knowledge answers are fine. Focus on cases where the agent *claims* to have done something via tools.`;

export interface CriticResult {
  verdict: 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';
  explanation: string;
}

export const CRITIC_MAX_RETRIES = 2;

export interface CriticToolEntry {
  toolName: string;
  args: unknown;
  result: unknown;
}

/** Extracts a structured log of tool calls from generateText step results. */
export function extractToolCallLog(
  steps: { toolCalls: any[]; toolResults: any[] }[],
): CriticToolEntry[] {
  const entries: CriticToolEntry[] = [];
  for (const step of steps) {
    for (let i = 0; i < step.toolCalls.length; i++) {
      const tc = step.toolCalls[i];
      const tr = step.toolResults[i];
      entries.push({ toolName: tc.toolName, args: tc.args, result: tr?.result });
    }
  }
  return entries;
}

/**
 * Runs the critic agent to verify the main agent's response against actual tool calls.
 *
 * @param config - Bernard configuration for provider/model selection.
 * @param userInput - The original user request.
 * @param responseText - The agent's final text response.
 * @param toolCallLog - Structured log of tool calls and results.
 * @param options - Optional retry flag, display prefix, and abort signal.
 * @returns Parsed critic result, or null on error.
 */
export async function runCritic(
  config: BernardConfig,
  userInput: string,
  responseText: string,
  toolCallLog: CriticToolEntry[],
  options?: { isRetry?: boolean; prefix?: string; abortSignal?: AbortSignal },
): Promise<CriticResult | null> {
  try {
    if (options?.isRetry) {
      printCriticReVerify(options?.prefix);
    } else {
      printCriticStart(options?.prefix);
    }

    const perResultLimit = Math.max(
      CRITIC_MIN_RESULT_CHARS,
      Math.floor(CRITIC_TOTAL_RESULT_BUDGET / toolCallLog.length),
    );

    const truncatedLog = toolCallLog.map((entry) => {
      const raw =
        typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result ?? null);
      const truncated = raw.length > perResultLimit ? raw.slice(0, perResultLimit) + '...' : raw;
      return {
        toolName: entry.toolName,
        args: entry.args,
        result: truncated,
      };
    });

    const truncatedResponse =
      responseText.length > CRITIC_MAX_RESPONSE_LENGTH
        ? responseText.slice(0, CRITIC_MAX_RESPONSE_LENGTH) + '\n... (truncated)'
        : responseText;

    const criticMessage = `## Original User Request
${userInput}

## Agent Response
${truncatedResponse}

## Tool Call Log (${truncatedLog.length} calls)
${truncatedLog
  .map((e, i) => {
    const argsStr = JSON.stringify(e.args);
    const truncatedArgs =
      argsStr.length > CRITIC_MAX_ARGS_LENGTH
        ? argsStr.slice(0, CRITIC_MAX_ARGS_LENGTH) + '...'
        : argsStr;
    return `${i + 1}. ${e.toolName}(${truncatedArgs})\n   Result: ${e.result}`;
  })
  .join('\n\n')}`;

    const result = await generateText({
      model: getModel(config.provider, config.model),
      system: CRITIC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: criticMessage }],
      maxSteps: 1,
      maxTokens: 1024,
      abortSignal: options?.abortSignal,
    });

    if (result.text) {
      const parsed = parseCriticVerdict(result.text);
      printCriticVerdict(result.text, options?.prefix);
      return {
        verdict: parsed.verdict as CriticResult['verdict'],
        explanation: parsed.explanation,
      };
    }

    return null;
  } catch (err) {
    debugLog('critic:error', err instanceof Error ? err.message : String(err));
    return null;
  }
}
