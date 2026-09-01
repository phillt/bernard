const ARG_PREVIEW = 200;
const RESULT_PREVIEW = 400;

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
export function buildActivitySummary(steps: unknown[] | undefined): string {
  const log = extractToolCallLog((steps ?? []) as Parameters<typeof extractToolCallLog>[0]);
  if (log.length === 0) {
    return '## Activity Log\n(no tool calls)';
  }
  const lines = log.map(
    (e, i) =>
      `${i + 1}. ${e.toolName}(${previewValue(e.args, ARG_PREVIEW)})\n   → ${previewValue(e.result, RESULT_PREVIEW)}`,
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
 * knows which it was, so the preamble stops guessing. Absent `meta` keeps the
 * original wording — that is the honest message for a run that finished.
 */
export function appendActivitySummary(
  text: string,
  steps: unknown[] | undefined,
  agentLabel: string,
  meta?: { stepLimitHit: boolean; steps: number },
): string {
  const summary = buildActivitySummary(steps);
  if (!text.trim()) {
    const preamble = meta?.stepLimitHit
      ? `(${agentLabel} ran out of steps (${meta.steps}) before producing a text summary; activity reconstructed from tool-call log)`
      : `(${agentLabel} produced no text summary; activity reconstructed from tool-call log)`;
    return [preamble, '', summary].join('\n');
  }
  return `${text.trimEnd()}\n\n${summary}`;
}
