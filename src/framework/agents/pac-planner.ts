import type { CoreMessage, Tool } from 'ai';
import { attachTo } from './user-message.js';
import type { WithAttachments } from './user-message.js';
import { createDateTimeTool } from '../../tools/datetime.js';
import { createFileTools } from '../../tools/file.js';
import { createThinkTool } from '../../tools/think.js';
import { createWebReadTool } from '../../tools/web.js';
import { createWebSearchTool } from '../../tools/web-search.js';
import { toolToAISDK } from '../tools/adapter.js';
import { outputHook } from '../hooks/output.js';
import { createReadOnlyMemoryTool, createReadOnlyScratchTool } from '../pac/read-only-memory.js';
import { NormalStrategy } from '../strategies/normal.js';
import { makeLastStepTextOnly } from './task.js';
import { SUBAGENT_STEP_RATIO } from './sub.js';
import type { AgentDefinition } from './types.js';

/**
 * Fraction of the sub-agent's per-call budget allocated to the Planner phase
 * of the PAC pipeline. The Planner only thinks and gathers read-only context,
 * so it gets the smallest slice.
 */
export const PAC_PLANNER_STEP_FRACTION = 0.2;

export const PAC_PLANNER_SYSTEM_PROMPT = `You are the Planner of a PAC (Planner → Actor → Critic) sub-agent pipeline. The Actor will execute your plan and the Critic will verify the result against the success criteria you write.

Your job:
1. Read the task carefully. Use the read-only tools (think, file_read_lines, memory.read, scratch.read, web_search, web_read, datetime) only to confirm assumptions — never to act on the world.
2. Produce a numbered plan of concrete steps the Actor should take. Each step must be small enough to execute without further planning.
3. Spell out explicit success criteria the Critic can check (specific file contents, command outputs, observable state changes — not vague "task completed" wording).
4. Note edge cases or failure modes the Actor should watch for.

Rules:
- DO NOT execute the plan. No shell, no file edits, no writes, no external state changes.
- DO NOT speculate beyond what the task and available read-only tools tell you.
- Output exactly one plan. End with a line that reads literally: PLAN COMPLETE
- Be terse. The plan goes to another LLM, not a human.

Output template:
## Plan
1. <step>
2. <step>
...

## Success Criteria
- <criterion>
- <criterion>

PLAN COMPLETE`;

/**
 * Per-call payload for the Planner phase. `priorPlan` and `criticFeedback` are
 * populated on a re-plan (after a Critic FAIL with retry budget remaining) so
 * the Planner can revise rather than start from scratch.
 */
export interface PacPlannerInput extends WithAttachments {
  task: string;
  context?: string;
  slotId: number;
  priorPlan?: string;
  criticFeedback?: string;
}

function buildPlannerTools(ctx: import('../context.js').AgentContext): Record<string, Tool> {
  const fileTools = createFileTools();
  return {
    think: createThinkTool(),
    memory: toolToAISDK(createReadOnlyMemoryTool(ctx.stores.memory)),
    scratch: toolToAISDK(createReadOnlyScratchTool(ctx.stores.memory)),
    file_read_lines: fileTools.file_read_lines,
    web_search: createWebSearchTool(),
    web_read: createWebReadTool(),
    datetime: createDateTimeTool(),
  };
}

export const pacPlannerDefinition: AgentDefinition<PacPlannerInput, string> = {
  id: 'pac-planner',
  site: 'specialist',
  telemetrySite: 'pac-planner',
  historyMode: 'ephemeral',
  repairLabel: 'subagent',
  prefix: (input) => `sub:${input.slotId}/plan`,

  systemPrompt() {
    return PAC_PLANNER_SYSTEM_PROMPT;
  },

  // contextInputs omitted: framework default injects memory + scratch.

  tools(ctx) {
    return buildPlannerTools(ctx);
  },

  strategy() {
    return new NormalStrategy();
  },

  stepBudget(config) {
    // Floor (not ceil) so the three phase budgets never sum above the legacy
    // single-`sub` budget. Minimum 2 to leave room for one tool call + a final
    // text step.
    return Math.max(
      2,
      Math.floor(config.maxSteps * SUBAGENT_STEP_RATIO * PAC_PLANNER_STEP_FRACTION),
    );
  },

  buildUserMessage(input): CoreMessage {
    const parts: string[] = [`Task: ${input.task}`];
    if (input.context) parts.push(`Context: ${input.context}`);
    if (input.priorPlan) {
      parts.push(`Prior plan (rejected by Critic):\n${input.priorPlan}`);
    }
    if (input.criticFeedback) {
      parts.push(`Critic feedback to address:\n${input.criticFeedback}`);
    }
    return attachTo(parts.join('\n\n'), input.attachments);
  },

  hooks(_ctx, input) {
    return [outputHook(`sub:${input.slotId}/plan`)];
  },

  prepareStep(_ctx, _input, maxSteps) {
    return makeLastStepTextOnly(maxSteps);
  },

  formatResult(result) {
    return result.text.trim();
  },
};
