import type { CoreMessage, Tool } from 'ai';
import { buildMemoryContext } from '../../memory-context.js';
import { createDateTimeTool } from '../../tools/datetime.js';
import { createFileTools } from '../../tools/file.js';
import { createMemoryTool, createScratchTool } from '../../tools/memory.js';
import { createThinkTool } from '../../tools/think.js';
import { createWebReadTool } from '../../tools/web.js';
import { createWebSearchTool } from '../../tools/web-search.js';
import { toolToAISDK } from '../tools/adapter.js';
import { outputHook } from '../hooks/output.js';
import { NormalStrategy } from '../strategies/normal.js';
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
export interface PacPlannerInput {
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
    memory: toolToAISDK(createMemoryTool(ctx.stores.memory)),
    scratch: toolToAISDK(createScratchTool(ctx.stores.memory)),
    file_read_lines: fileTools.file_read_lines,
    web_search: createWebSearchTool(),
    web_read: createWebReadTool(),
    datetime: createDateTimeTool(),
  };
}

export const pacPlannerDefinition: AgentDefinition<PacPlannerInput, string> = {
  id: 'pac-planner',
  historyMode: 'ephemeral',
  repairLabel: 'subagent',
  prefix: (input) => `sub:${input.slotId}/plan`,

  systemPrompt(ctx) {
    return (
      PAC_PLANNER_SYSTEM_PROMPT +
      buildMemoryContext({ memoryStore: ctx.stores.memory, includeScratch: true })
    );
  },

  tools(ctx) {
    return buildPlannerTools(ctx);
  },

  strategy() {
    return new NormalStrategy();
  },

  stepBudget(config) {
    return Math.max(2, Math.ceil(config.maxSteps * SUBAGENT_STEP_RATIO * PAC_PLANNER_STEP_FRACTION));
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
    return { role: 'user', content: parts.join('\n\n') };
  },

  hooks(_ctx, input) {
    return [outputHook(`sub:${input.slotId}/plan`)];
  },

  formatResult(result) {
    return result.text.trim();
  },
};
