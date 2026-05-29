import type { CronLogStep } from '../../cron/log-store.js';
import type { AgentHook } from './types.js';
import { readToolMeta } from '../tools/adapter.js';
import { redactArgs, REDACTED } from '../tools/redact.js';

/**
 * Maximum chars to keep per tool-result string before truncating in the log.
 * Matches the cap used inline by `cron/runner.ts` before Phase C.
 */
const CRON_RESULT_MAX_LEN = 10240;

function truncateResult(result: unknown, maxLen: number): unknown {
  if (typeof result === 'string' && result.length > maxLen) {
    return result.slice(0, maxLen) + `... (truncated, ${result.length} chars total)`;
  }
  return result;
}

/**
 * Accumulates structured step records into the caller-supplied `steps` array
 * for {@link CronLogStore} persistence. The cron runner is the only call site
 * that needs full per-step records (vs. interactive sites which only print);
 * this hook is the framework analogue of the bespoke `onStepFinish` lambda
 * inside `src/cron/runner.ts` before Phase C.
 *
 * The hook owns its own monotonically-increasing `stepIndex`; callers should
 * create a fresh hook (and a fresh `steps` array) per cron run.
 *
 * When `toolRegistry` is supplied, each tool call's args and result are scrubbed
 * against the tool's `ToolMeta.sensitiveArgs` / `sensitiveResult` fields before
 * persistence.
 */
export function cronStepRecorderHook(
  steps: CronLogStep[],
  toolRegistry?: Record<string, unknown>,
): AgentHook {
  let stepIndex = 0;
  return {
    onStepFinish: ({ text, toolCalls, toolResults, usage, finishReason }) => {
      const truncatedResults = (toolResults ?? []).map((tr) => {
        const meta = toolRegistry ? readToolMeta(toolRegistry[tr.toolName]) : undefined;
        return {
          toolName: tr.toolName,
          toolCallId: tr.toolCallId,
          result: meta?.sensitiveResult ? REDACTED : truncateResult(tr.result, CRON_RESULT_MAX_LEN),
        };
      });
      steps.push({
        stepIndex: stepIndex++,
        timestamp: new Date().toISOString(),
        text: text || '',
        toolCalls: (toolCalls ?? []).map((tc) => {
          const meta = toolRegistry ? readToolMeta(toolRegistry[tc.toolName]) : undefined;
          const args = meta
            ? (redactArgs(tc.args, meta.sensitiveArgs) as Record<string, unknown>)
            : (tc.args as Record<string, unknown>);
          return {
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            args,
          };
        }),
        toolResults: truncatedResults,
        usage: {
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          totalTokens: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
        },
        finishReason: finishReason || 'unknown',
      });
    },
  };
}
