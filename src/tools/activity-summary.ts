import { extractToolCallLog } from '../critic.js';

const ARG_PREVIEW = 200;
const RESULT_PREVIEW = 400;

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
 */
export function appendActivitySummary(
  text: string,
  steps: unknown[] | undefined,
  agentLabel: string = 'agent',
): string {
  const summary = buildActivitySummary(steps);
  if (!text.trim()) {
    return [
      `(${agentLabel} produced no text summary; activity reconstructed from tool-call log)`,
      '',
      summary,
    ].join('\n');
  }
  return `${text.trimEnd()}\n\n${summary}`;
}
