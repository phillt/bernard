import { startSpinner, buildSpinnerMessage, type SpinnerStats } from '../../output.js';
import type { AgentHook } from './types.js';

/**
 * Target object whose fields the hook mutates in place. Implemented today
 * by the {@link Agent} instance (`this.lastStepPromptTokens`,
 * `this.spinnerStats`); tests can pass a plain object.
 */
export interface TokenStatsTarget {
  lastStepPromptTokens: number;
  spinnerStats: SpinnerStats | null;
}

/**
 * Tracks per-step token usage for the main agent. After each step:
 *  - writes the latest prompt-token count onto `target.lastStepPromptTokens`
 *    (used downstream for compression-headroom calculations);
 *  - accumulates prompt + completion totals on `target.spinnerStats` when set;
 *  - restarts the thinking spinner between tool-call steps so the user sees
 *    live progress while another LLM call is in flight.
 *
 * Extracted from the verbatim block at the top of the main-agent
 * `onStepFinish` lambda; behavior is byte-identical to pre-Phase-C `agent.ts`.
 */
export function tokenStatsHook(target: TokenStatsTarget): AgentHook {
  return {
    onStepFinish: ({ toolCalls, usage }) => {
      if (usage) {
        target.lastStepPromptTokens = usage.promptTokens;
        if (target.spinnerStats) {
          target.spinnerStats.totalPromptTokens += usage.promptTokens;
          target.spinnerStats.totalCompletionTokens += usage.completionTokens;
          target.spinnerStats.latestPromptTokens = usage.promptTokens;
        }
      }
      if ((toolCalls?.length ?? 0) > 0 && target.spinnerStats) {
        startSpinner(() => buildSpinnerMessage(target.spinnerStats!));
      }
    },
  };
}
