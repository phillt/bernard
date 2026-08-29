import { detectToolError } from '../../tool-profiles.js';
import { toolFailureFor, getOutputSink } from './output-sink.js';
import type { AgentHook } from './types.js';

/**
 * Prints tool calls, tool results, and assistant text for every completed
 * step, optionally tagged with a colored `[prefix]` label (e.g. `sub:2`,
 * `spec:3`, `task:1`, `wrap:4`).
 *
 * Extracted from the verbatim `onStepFinish` lambda that was previously
 * duplicated across `subagent.ts`, `specialist-run.ts`, `task.ts`, and
 * `tool-wrapper-run.ts`. The main agent uses this hook with no prefix.
 *
 * Phase C (#214): when an `OutputSink` is registered via `setOutputSink`,
 * step events flow into the sink instead of the stdout printers. The sink
 * branch never falls through to stdout — the Ink renderer owns the screen
 * when a sink is active, and double-writing would tear the terminal. When
 * no sink is registered (legacy readline REPL, cron jobs, most tests), the
 * existing stdout path runs unchanged.
 *
 * Streaming text is NOT emitted from this hook — `onStepFinish` only fires
 * at step completion. Per-token deltas for the main agent come from the
 * runner's `streamText` branch (`src/framework/runner.ts`) which pushes
 * `text-delta` events directly into the sink as they arrive. To avoid
 * double-rendering the main agent's text (once per delta and once in bulk
 * at step end), the sink branch here skips `text-delta` for the main agent
 * (`prefix === undefined`) — sub-agents and wrappers still emit a single
 * bulk `text-delta` per step since they don't stream.
 */
export function outputHook(prefix?: string): AgentHook {
  return {
    onStepFinish: ({ text, toolCalls, toolResults }) => {
      const sink = getOutputSink();
      if (!sink) return;
      // Main agent (`prefix === undefined`) streams via `runStreaming`, which
      // already pushes `tool-call` / `tool-result` to the sink the moment the
      // model finishes the call and the SDK returns the execute result. Emit
      // them here again and the Ink thread would render each tool twice.
      // Sub-agents / wrappers don't stream, so they still need this path.
      if (prefix !== undefined) {
        for (const tc of toolCalls ?? []) {
          sink.append({
            kind: 'tool-call',
            callId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
            agentLabel: prefix,
          });
        }
        for (const tr of toolResults ?? []) {
          // Per-tool shapes vary (`shell` uses `is_error`, `web_read` returns
          // an "Error:" string, MCP tools surface text content, …) — defer to
          // the same classifier so the Ink thread colors failed calls red.
          const errInfo = detectToolError(tr.toolName, tr.result);
          sink.append({
            kind: 'tool-result',
            callId: tr.toolCallId,
            result: tr.result,
            isError: errInfo.isError,
            // The recovery advice the user needs; the red colouring alone only
            // says that something failed, not what to do about it.
            failure: toolFailureFor(tr.toolName, tr.result),
            agentLabel: prefix,
          });
        }
        if (text) {
          // Sub-agent / wrapper bulk-render.
          sink.append({ kind: 'text-delta', text, agentLabel: prefix });
        }
      }
    },
  };
}
