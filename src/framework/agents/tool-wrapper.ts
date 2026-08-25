import type { CoreMessage, Tool } from 'ai';
import { resolveSiteModel } from '../../model-policy.js';
import { osPromptBlock } from '../../os-info.js';
import {
  STRUCTURED_OUTPUT_RULES,
  wrapWrapperResult,
  type WrapperResult,
} from '../../structured-output.js';
import { outputHook } from '../hooks/output.js';
import { NormalStrategy } from '../strategies/normal.js';
import type { AgentDefinition, ResolvedModel } from './types.js';
import { makeLastStepTextOnly } from './task.js';

/** Fraction of `config.maxSteps` allocated to a tool-wrapper run. */
export const TOOL_WRAPPER_STEP_RATIO = 0.5;

/**
 * Per-call payload for the tool-wrapper definition. The dispatch wrapper at
 * `src/tools/tool-wrapper-run.ts` owns slot acquisition, the
 * specialist-existence/kind guards, and the recursive assembly of
 * `childTools` (because tool-wrapper specialists may call dispatch tools like
 * `agent` / `task` / `specialist_run` / `tool_wrapper_run`, which would
 * otherwise produce an import cycle if assembled inside the framework).
 *
 * `wantStructured` mirrors `specialist.structuredOutput ?? kind === 'tool-wrapper'`
 * — when true, the definition forces a JSON last step and parses the output
 * through {@link wrapWrapperResult}; otherwise the raw text is wrapped as
 * `{ status: 'ok', result: text }`.
 */
export interface ToolWrapperInput {
  specialistId: string;
  input: string;
  context?: string;
  slotId: number;
  /** Pre-assembled child registry (already filtered by `specialist.targetTools`). */
  childTools: Record<string, Tool>;
  /** Whether to enforce JSON last-step + parse output through `wrapWrapperResult`. */
  wantStructured: boolean;
}

/**
 * Tool-wrapper definition: ephemeral history, persona + examples + OS block +
 * (optional) structured-output rules + memory context as system prompt;
 * `childTools` as the tool set; 50% of the main step budget; final-step JSON
 * enforcement when `wantStructured`; result parsed into a {@link WrapperResult}.
 *
 * Model resolution honours `specialist.provider` / `specialist.model` (looked
 * up live so runtime edits are picked up).
 */
export const toolWrapperDefinition: AgentDefinition<ToolWrapperInput, WrapperResult> = {
  id: 'tool-wrapper',
  historyMode: 'ephemeral',
  // The sole opt-out of the ephemeral → `'worker'` derivation (#322). Wrapper
  // specialists are scoped by `specialist.targetTools`, and three bundled ones
  // target tools the worker surface removes: `mcp-manager` needs `mcp_config` /
  // `mcp_add_url` / `mcp_verify`, and `correction-agent` / `specialist-creator`
  // need `specialist`. `dispatchToolWrapper` assembles `input.childTools` from
  // the full registry for that reason; this declares the same fact where a
  // reader of the definition can see it.
  toolSurface: 'full',
  repairLabel: 'tool-wrapper',
  prefix: (input) => `wrap:${input.slotId}`,

  systemPrompt(ctx, input) {
    const specialist = ctx.stores.specialists.get(input.specialistId);
    if (!specialist) {
      throw new Error(`No specialist found with id "${input.specialistId}".`);
    }
    let systemPrompt = specialist.systemPrompt;
    if (specialist.guidelines.length > 0) {
      systemPrompt += '\n\nGuidelines:\n' + specialist.guidelines.map((g) => `- ${g}`).join('\n');
    }
    systemPrompt += '\n\n' + osPromptBlock();
    systemPrompt += formatExamples(specialist);
    if (input.wantStructured) {
      systemPrompt += STRUCTURED_OUTPUT_RULES;
    }
    if (Object.keys(input.childTools).length > 0) {
      systemPrompt += `\n\nAvailable tools for this run: ${Object.keys(input.childTools).join(', ')}`;
    } else {
      systemPrompt +=
        '\n\nNo tools are available for this run. Produce the structured output based on reasoning alone.';
    }
    return systemPrompt;
  },

  // contextInputs omitted: framework default injects memory + scratch.

  tools(_ctx, input) {
    return input.childTools;
  },

  strategy() {
    return new NormalStrategy();
  },

  stepBudget(config) {
    return Math.max(2, Math.ceil(config.maxSteps * TOOL_WRAPPER_STEP_RATIO));
  },

  buildUserMessage(input): CoreMessage {
    const content = input.context
      ? `Request: ${input.input}\n\nContext: ${input.context}`
      : `Request: ${input.input}`;
    return { role: 'user', content };
  },

  hooks(_ctx, input) {
    return [outputHook(`wrap:${input.slotId}`)];
  },

  prepareStep(_ctx, input, maxSteps) {
    return input.wantStructured ? makeLastStepTextOnly(maxSteps) : undefined;
  },

  resolveModel(ctx, input, overrides): ResolvedModel {
    const specialist = ctx.stores.specialists.get(input.specialistId);
    const site = resolveSiteModel(ctx.config, 'tool-wrapper', { overrides, specialist });
    return {
      model: site.model,
      providerOptions: site.providerOptions,
      params: site.params,
      provider: site.provider,
      modelName: site.modelName,
      // Carry the resolved tier so ledger attribution (#258) buckets this
      // dispatch by tier rather than defaulting to `pinned`.
      tier: site.tier,
    };
  },

  formatResult(result, input): WrapperResult {
    return input.wantStructured
      ? wrapWrapperResult(result.text)
      : { status: 'ok' as const, result: result.text };
  },
};

/** Formats good/bad examples as a markdown block appended to the child's system prompt. */
export function formatExamples(specialist: {
  goodExamples?: Array<{ input: string; call: string; note?: string }>;
  badExamples?: Array<{ input: string; call: string; error: string; fix: string; note?: string }>;
}): string {
  const parts: string[] = [];
  const good = specialist.goodExamples ?? [];
  const bad = specialist.badExamples ?? [];
  if (good.length > 0) {
    parts.push('\n\n## Good Examples (follow these patterns)');
    for (const ex of good) {
      parts.push(`\n- Input: ${ex.input}\n  Call: ${ex.call}`);
      if (ex.note) parts.push(`\n  Note: ${ex.note}`);
    }
  }
  if (bad.length > 0) {
    parts.push('\n\n## Bad Examples (AVOID these patterns)');
    for (const ex of bad) {
      parts.push(
        `\n- Input: ${ex.input}\n  Bad call: ${ex.call}\n  Error observed: ${ex.error}\n  Correct approach: ${ex.fix}`,
      );
      if (ex.note) parts.push(`\n  Note: ${ex.note}`);
    }
  }
  return parts.join('');
}

/**
 * Builds the child tool set a tool-wrapper specialist exposes: only the names
 * in `targetTools` survive.
 *
 * An absent or empty `targetTools` yields **no tools** (#331). It used to yield
 * the *entire* registry — and since `dispatchToolWrapper` assembles that
 * registry from the raw `ctx.mcp.tools` rather than the delegation surface, an
 * unscoped specialist carried every connected server's full MCP schema set:
 * exactly the prefix per-server delegation (#296/#305) exists to remove. The
 * leak was the default, not the filter.
 *
 * Returning `{}` is a state this function already produces, and one the caller
 * already handles: a `targetTools` naming only unknown tools yields the same
 * thing, and `buildSystemPrompt` tells the specialist plainly that it has no
 * tools for this run. Failing visibly beats carrying 143 schemas quietly —
 * and `createSpecialist` now rejects a `tool-wrapper`/`meta` record with no
 * `targetTools` at the creation boundary, so this default should be
 * unreachable for anything created after #331.
 */
export function buildChildTools(
  specialist: { targetTools?: string[] },
  fullRegistry: Record<string, Tool>,
): Record<string, Tool> {
  const targets = specialist.targetTools;
  if (!targets || targets.length === 0) return {};
  const filtered: Record<string, Tool> = {};
  for (const name of targets) {
    if (fullRegistry[name]) filtered[name] = fullRegistry[name];
  }
  return filtered;
}
