import type { CronLogStep } from '../../cron/log-store.js';
import type { AgentHook } from './types.js';
import { readToolMeta } from '../tools/adapter.js';
import { redactArgs, REDACTED, boundedStringify } from '../tools/redact.js';

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
 * The bounded serialization itself lives in `boundedStringify` — see there for
 * why a plain `JSON.stringify` and a naive truncating replacer are each wrong
 * for a different result shape. What stays here is the decision this recorder
 * owns: a result that fits keeps its real structure, and one that doesn't
 * degrades to a marked string, because a truncated object is not a valid
 * instance of its own shape and would read as complete.
 */
/**
 * The signal that an entry is bounded rather than complete. One helper so the
 * two paths can't drift — it is the only thing a log reader has to go on.
 */
function mark(text: string, total: number): string {
  return `${text}... (truncated, ${total} chars total)`;
}

function truncateResult(result: unknown, maxLen: number): unknown {
  if (typeof result === 'string') {
    return result.length > maxLen ? mark(result.slice(0, maxLen), result.length) : result;
  }
  const { text, bounded } = boundedStringify(result, maxLen);
  // `bounded` rather than `text.length > maxLen`: once the budget starts
  // dropping keys the serialized form can come back UNDER the cap, and a
  // length-only test would then hand back the original unbounded object.
  if (!bounded) return result;
  return mark(text.slice(0, maxLen), text.length);
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
