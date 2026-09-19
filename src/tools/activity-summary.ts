import type { FormatMeta } from '../framework/agents/types.js';
import { classifyError, failureMarker } from '../error-taxonomy.js';

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
    if (meta?.stepLimitHit) {
      return [
        stepLimitHint(),
        `(${agentLabel} ran out of steps (${meta.steps}) before producing a text summary; activity reconstructed from tool-call log)`,
        '',
        summary,
      ].join('\n');
    }
    return [
      `(${agentLabel} produced no text summary; activity reconstructed from tool-call log)`,
      '',
      summary,
    ].join('\n');
  }
  return `${text.trimEnd()}\n\n${summary}`;
}

/**
 * The machine half of a step-limited verdict (#406).
 *
 * A dispatch cut off at its budget used to report itself in two incompatible
 * shapes: `task` and `tool-wrapper` mint a `status: 'error'` envelope that
 * `detectResultFailure` reads as a failure, while the four prose formatters —
 * `sub`, `specialist`, `pac-actor`, `mcp-delegate` — returned a sentence, and a
 * sentence reads as SUCCESS. So the same event bumped `successCount`, registered
 * its truncated output as citable evidence and logged `status: 'ok'` at four of
 * six formatters. That is precisely the accounting #395 closed for *empty*
 * delegate returns, reproduced for truncated ones: saying something is what made
 * them look successful.
 *
 * The fix is one line here because `appendActivitySummary` is the single
 * function all four share.
 *
 * **The marker rather than an `Error:` prefix**, which is the fork #406 posed and
 * left open. `[failure: step_limit]` already exists, `step_limit` is already a
 * `ToolErrorType`, and its row already says exactly what "incomplete" needs:
 * `severity: 'low'`, `retryable: true`, `correctable: false`. So every consumer
 * lands correctly with no third state invented — `successCount` does not bump,
 * the failure goes to `ToolProfile.dismissed` rather than to bad examples,
 * evidence registration stops, and `ToolFailureHint` renders it in the low
 * severity colour rather than as an alarming red error. An `Error:` prefix would
 * have got the detection and framed partial-but-useful work as a failure.
 *
 * **The marker's own line, and the playbook rides on it** — the format
 * `wrap-with-specialist.ts` already mints and `stripFailureMarker` already knows
 * how to remove. That keeps the human preamble intact on the line below, and it
 * is what the parent model reads: the recovery advice comes from the taxonomy
 * playbook rather than being written a second time here, so every surface
 * rendering `step_limit` still agrees.
 *
 * Only the EMPTY case, mirroring `relabelStepLimit`: a run that hit the limit and
 * still returned real content may simply have wrapped up on its last step, and
 * calling that a failure throws away work that did happen.
 */
function stepLimitHint(): string {
  return `${failureMarker('step_limit')} ${classifyError({ message: 'step_limit' }).playbook.model}`;
}
