import { printToolCall, printToolResult, printAssistantText } from '../../output.js';
import type { AgentHook } from './types.js';

/**
 * Prints tool calls, tool results, and assistant text for every completed
 * step, optionally tagged with a colored `[prefix]` label (e.g. `sub:2`,
 * `spec:3`, `task:1`, `wrap:4`).
 *
 * Extracted from the verbatim `onStepFinish` lambda that was previously
 * duplicated across `subagent.ts`, `specialist-run.ts`, `task.ts`, and
 * `tool-wrapper-run.ts`. The main agent uses this hook with no prefix.
 */
export function outputHook(prefix?: string): AgentHook {
  return {
    onStepFinish: ({ text, toolCalls, toolResults }) => {
      for (const tc of toolCalls ?? []) {
        printToolCall(tc.toolName, tc.args as Record<string, unknown>, prefix);
      }
      for (const tr of toolResults ?? []) {
        printToolResult(tr.toolName, tr.result, prefix);
      }
      if (text) {
        printAssistantText(text, prefix);
      }
    },
  };
}
