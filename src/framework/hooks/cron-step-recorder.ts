import type { CronLogStep } from '../../cron/log-store.js';
import type { AgentHook } from './types.js';
import { readToolMeta } from '../tools/adapter.js';
import { redactArgs, REDACTED } from '../tools/redact.js';

/**
 * Maximum chars to keep per tool result before truncating in the log.
 * Matches the cap used inline by `cron/runner.ts` before Phase C.
 */
const CRON_RESULT_MAX_LEN = 10240;

/**
 * Bounds one tool result for persistence (#347).
 *
 * This used to test `typeof result === 'string'` and return anything else
 * untouched — which made the truncating branch effectively dead, because every
 * Bernard tool returns an object: `shell` → `{output, is_error}` (`maxBuffer`
 * 10 MB), `file_read_lines` → `{lines: [...]}` (bounded only by the 50 MB
 * `MAX_FILE_SIZE`), MCP → `{content: [...]}`. Full results landed in
 * `CronLogStore` verbatim, persisted per step per run for every job — and cron
 * is unattended, so nobody saw the growth. `cron_logs_get` then read it all
 * back into an agent's context.
 *
 * Serializes before measuring, and bounds *during* serialization rather than
 * after: the inputs are unbounded, so a plain `JSON.stringify` of a 10 MB
 * `shell` result costs ~39 ms and ~20 MB transient before the slice throws it
 * away (measured in #343). The replacer keeps that at ~0 ms.
 *
 * Returns a string once truncation happens — a truncated object is not a valid
 * instance of its own shape, and a marker is what makes a bounded entry
 * distinguishable from a complete one. Small results keep their structure, so
 * readers that walk it still work on everything that fits.
 */
function truncateResult(result: unknown, maxLen: number): unknown {
  if (result === undefined || result === null) return result;
  if (typeof result === 'string') {
    return result.length > maxLen
      ? result.slice(0, maxLen) + `... (truncated, ${result.length} chars total)`
      : result;
  }
  let text: string;
  try {
    // `appendEntry` must never throw on a log write, and AI SDK results can
    // carry cycles — same reason `previewOfResult` (#343) wraps this.
    text =
      JSON.stringify(result, (_key, v: unknown) =>
        typeof v === 'string' && v.length > maxLen ? v.slice(0, maxLen) + '…' : v,
      ) ?? String(result);
  } catch {
    text = String(result);
  }
  if (text.length <= maxLen) return result;
  return text.slice(0, maxLen) + `... (truncated, ${text.length} chars total)`;
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
