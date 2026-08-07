import type { CoreMessage, Tool } from 'ai';
import { z } from 'zod';
import { parseStructuredOutput } from '../../structured-output.js';
import { createDateTimeTool } from '../../tools/datetime.js';
import { createEvaluateTool } from '../../tools/evaluate.js';
import { createFileTools } from '../../tools/file.js';
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
 * Fraction of the sub-agent's per-call budget allocated to the Critic phase
 * of the PAC pipeline. The Critic only verifies (read-only), so it gets the
 * smallest slice.
 */
export const PAC_CRITIC_STEP_FRACTION = 0.2;

export const PAC_CRITIC_SYSTEM_PROMPT = `You are the Critic of a PAC (Planner → Actor → Critic) sub-agent pipeline. The Planner produced a plan with success criteria; the Actor executed it and reported its work. Your job is to verify whether the success criteria were actually met.

Rules:
- You may use ONLY read-only verification tools (file_read_lines, memory.read, scratch.read, web_read, web_search, datetime, evaluate). DO NOT call shell, write to memory, edit files, or take any action that changes state.
- Check the Actor's claims against actual observable state. If the Actor said "wrote file X with content Y" — read file X and confirm. If the Actor said "command returned Z" — re-run only if it is a safe read-only command, otherwise trust the Actor's transcript.
- Use \`evaluate\` to publish a short verdict reasoning visible to the user.
- Be strict but fair. PASS when every success criterion is met. WARN when the success criteria were met but there are caveats worth surfacing (partial coverage, unexpected output that did not block success, missing post-write check). FAIL when any success criterion is unmet, the Actor's evidence is missing, or the Actor reported unrecoverable errors.

Output format (STRICT):
Your FINAL message MUST be a single valid JSON object with this shape and nothing else — no prose before or after, no markdown code fences:

{
  "verdict": "pass" | "warn" | "fail",
  "reason": "<one or two sentences explaining the verdict, citing specific criteria>"
}

Emit the JSON only once, as your last message.`;

/**
 * Per-call payload for the Critic phase.
 */
export interface PacCriticInput {
  task: string;
  context?: string;
  plan: string;
  actorOutput: string;
  slotId: number;
}

/** Parsed verdict returned to the orchestrator. */
export interface PacCriticVerdict {
  verdict: 'pass' | 'warn' | 'fail';
  reason: string;
  raw: string;
}

const VerdictSchema = z.object({
  verdict: z.enum(['pass', 'warn', 'fail']),
  reason: z.string(),
});

function buildCriticTools(ctx: import('../context.js').AgentContext): Record<string, Tool> {
  const fileTools = createFileTools();
  return {
    evaluate: createEvaluateTool(ctx.verification),
    memory: toolToAISDK(createReadOnlyMemoryTool(ctx.stores.memory)),
    scratch: toolToAISDK(createReadOnlyScratchTool(ctx.stores.memory)),
    file_read_lines: fileTools.file_read_lines,
    web_search: createWebSearchTool(),
    web_read: createWebReadTool(),
    datetime: createDateTimeTool(),
  };
}

export const pacCriticDefinition: AgentDefinition<PacCriticInput, PacCriticVerdict> = {
  id: 'pac-critic',
  site: 'specialist',
  telemetrySite: 'pac-critic',
  historyMode: 'ephemeral',
  repairLabel: 'subagent',
  prefix: (input) => `sub:${input.slotId}/critic`,

  systemPrompt() {
    return PAC_CRITIC_SYSTEM_PROMPT;
  },

  // The Critic intentionally opts out of the framework's default
  // `<system_provided_context>` injection (issue #143). Memory + scratch are
  // exposed as read-only tools (`memory.read` / `scratch.read` via
  // `buildCriticTools`) so the Critic must explicitly look up whatever it
  // needs to verify against — keeps verification grounded in the task and the
  // Actor's report rather than ambient memory.
  contextInputs: () => null,

  tools(ctx) {
    return buildCriticTools(ctx);
  },

  strategy() {
    return new NormalStrategy();
  },

  stepBudget(config) {
    // Floor (not ceil) so the three phase budgets never sum above the legacy
    // single-`sub` budget. Minimum 2 so the critic can call one tool and then
    // emit its JSON verdict in a final text-only step.
    return Math.max(
      2,
      Math.floor(config.maxSteps * SUBAGENT_STEP_RATIO * PAC_CRITIC_STEP_FRACTION),
    );
  },

  buildUserMessage(input): CoreMessage {
    const parts: string[] = [`Original task: ${input.task}`];
    if (input.context) parts.push(`Context: ${input.context}`);
    parts.push(`Plan (from Planner):\n${input.plan}`);
    parts.push(`Actor's report:\n${input.actorOutput}`);
    parts.push('Verify the success criteria. Emit your final JSON verdict per the format rules.');
    return { role: 'user', content: parts.join('\n\n') };
  },

  hooks(_ctx, input) {
    return [outputHook(`sub:${input.slotId}/critic`)];
  },

  prepareStep(_ctx, _input, maxSteps) {
    return makeLastStepTextOnly(maxSteps);
  },

  formatResult(result): PacCriticVerdict {
    const text = result.text;
    const parsed = parseStructuredOutput(text, VerdictSchema);
    if (parsed) {
      return { verdict: parsed.verdict, reason: parsed.reason, raw: text };
    }
    // Fail-closed: an unparseable critic must not be treated as a silent pass,
    // because that would defeat the whole verification phase. Surface it as a
    // fail so `runPAC` either re-plans (if budget remains) or emits the FAIL
    // footer to the parent agent.
    return {
      verdict: 'fail',
      reason: 'critic output unparseable; treating as fail',
      raw: text,
    };
  },
};
