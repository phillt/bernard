import type { FormatMeta } from '../framework/agents/types.js';

const ARG_PREVIEW = 200;
const RESULT_PREVIEW = 400;

/**
 * Per-entry preview budgets. Callers tune these because what the log is FOR
 * differs by dispatch (#367).
 *
 * A sub-agent's log is read by a human in the terminal, where a generous result
 * preview is the point. A delegate helper's log is read by the MAIN AGENT, on
 * every MCP call, and lands in the context per dispatch — so it is bounded much
 * harder there. The two observed #367 failures need only the tool name plus a
 * short result snippet ("Pressed Enter on combobox element: …" is ~55 chars) to
 * be caught, so a tight budget loses no verification value.
 */
export interface ActivityBudgets {
  args?: number;
  result?: number;
}

interface ToolCallEntry {
  toolName: string;
  args: unknown;
  result: unknown;
}

function extractToolCallLog(steps: { toolCalls: any[]; toolResults: any[] }[]): ToolCallEntry[] {
  const entries: ToolCallEntry[] = [];
  for (const step of steps) {
    for (let i = 0; i < step.toolCalls.length; i++) {
      const tc = step.toolCalls[i];
      const tr = step.toolResults[i];
      entries.push({ toolName: tc.toolName, args: tc.args, result: tr?.result });
    }
  }
  return entries;
}

function previewValue(v: unknown, limit: number): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.slice(0, limit);
}

/**
 * Builds a deterministic Markdown summary of every tool call recorded by a
 * `generateText` run. Used as a post-run activity log so callers can verify
 * what a sub-agent or specialist actually did, even when the model's prose
 * output is empty or under-reports the side effects.
 */
export function buildActivitySummary(
  steps: unknown[] | undefined,
  budgets?: ActivityBudgets,
): string {
  const log = extractToolCallLog((steps ?? []) as Parameters<typeof extractToolCallLog>[0]);
  if (log.length === 0) {
    return '## Activity Log\n(no tool calls)';
  }
  const lines = log.map(
    (e, i) =>
      `${i + 1}. ${e.toolName}(${previewValue(e.args, budgets?.args ?? ARG_PREVIEW)})\n   → ${previewValue(e.result, budgets?.result ?? RESULT_PREVIEW)}`,
  );
  return ['## Activity Log', `${log.length} tool call(s):`, ...lines].join('\n');
}

/**
 * Returns the model's text with an Activity Log appended. When the text is
 * empty or whitespace-only, emits a preamble explaining that the activity was
 * reconstructed from the tool-call log.
 *
 * `agentLabel` identifies the caller in the empty-text preamble (e.g. "specialist", "subagent").
 *
 * `meta` separates the two reasons the text is empty (#370). "Produced no text
 * summary" reads as a model that chose to say nothing; a dispatch cut off at
 * its `maxSteps` ceiling never got to the turn where it would have summarized,
 * which is a different fact and the one that explains the failure. The runner
 * knows which it was, so the preamble stops guessing. Absent `meta` means the
 * caller did not pass it — not that the run finished; a run that finished passes
 * `{stepLimitHit: false}` and lands in the same branch. Only tests reach that.
 */
export function appendActivitySummary(
  text: string,
  steps: unknown[] | undefined,
  agentLabel: string,
  meta?: FormatMeta,
  budgets?: ActivityBudgets,
): string {
  const summary = buildActivitySummary(steps, budgets);
  if (!text.trim()) {
    const preamble = meta?.stepLimitHit
      ? `(${agentLabel} ran out of steps (${meta.steps}) before producing a text summary; activity reconstructed from tool-call log)`
      : `(${agentLabel} produced no text summary; activity reconstructed from tool-call log)`;
    return [preamble, '', summary].join('\n');
  }
  return `${text.trimEnd()}\n\n${summary}`;
}
