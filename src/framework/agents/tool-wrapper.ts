import type { CoreMessage, Tool } from 'ai';
import { classifyError } from '../../error-taxonomy.js';
import { CITATIONS_PROMPT, allowsInlineMarkers } from '../../agent-prompt.js';
import { getModelProfile } from '../../providers/index.js';
import type { AgentContext } from '../context.js';
import type { Specialist } from '../../specialists.js';
import { debugLog } from '../../logger.js';
import type { ToolNameAliasResolver } from '../../mcp-names.js';
import { resolveSiteModel } from '../../model-policy.js';
import { osPromptBlock } from '../../os-info.js';
import {
  isWrapperParseFailure,
  STRUCTURED_OUTPUT_RULES,
  wrapWrapperResult,
  type WrapperResult,
} from '../../structured-output.js';
import { outputHook } from '../hooks/output.js';
import { NormalStrategy } from '../strategies/normal.js';
import type { AgentDefinition, FormatMeta, ResolvedModel } from './types.js';
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
 * True when the model this wrapper will actually run on is one whose
 * `systemSuffix` already forbids narrating inline annotations, so telling it to
 * emit `[^Sn]` markers would conflict with its own guidance (#173).
 *
 * Resolves the site rather than reading `ctx.config` directly: a wrapper's model
 * comes from `resolveSiteModel(..., 'tool-wrapper', {specialist})`, so a pinned
 * specialist or a non-default `modelMode` can put it on a different family than
 * the session's configured one — and the gate has to describe the model that
 * will read the prompt.
 */
function suppressesInlineMarkers(ctx: AgentContext, specialist: Specialist): boolean {
  const site = resolveSiteModel(ctx.config, 'tool-wrapper', { specialist });
  const sdk = ctx.config.customProviders?.[site.provider]?.sdk;
  return !allowsInlineMarkers(getModelProfile(site.provider, site.modelName, sdk).family);
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
    // Citation conventions, for specialists that deal in sources (#417).
    //
    // Gated on `cite` having actually RESOLVED into this run's tools, not on
    // `specialist.targetTools` naming it: `cite` is only constructed when a
    // provenance store exists (`tools/index.ts`), so a specialist that asks for
    // it in a context without one would otherwise be told to use a tool it does
    // not have. Deriving the gate from the resolved registry also avoids a new
    // `Specialist` field — a wrapper that can call `cite` is by definition one
    // that works in source ids.
    //
    // `CITATIONS_PROMPT` attached only to the main agent before this
    // (`agents/main.ts`), so a dispatched specialist registered sources into
    // the shared store and was never told the convention for citing them.
    //
    // Note the marker instruction is best-effort, not the contract: the
    // `REASONING_FAMILIES` carve-out means some model families are never told
    // to emit `[^Sn]` at all. A specialist that needs its citations to be
    // machine-readable must carry them in its structured `result`, which is
    // what the bundled research agent does.
    if ('cite' in input.childTools && !suppressesInlineMarkers(ctx, specialist)) {
      systemPrompt += '\n\n' + CITATIONS_PROMPT;
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

  formatResult(result, input, _ctx, meta): WrapperResult {
    const wrapped: WrapperResult = input.wantStructured
      ? wrapWrapperResult(result.text)
      : { status: 'ok' as const, result: result.text };
    return relabelStepLimit(wrapped, meta);
  },
};

/**
 * Re-labels a wrapper result whose real failure was **running out of steps**.
 *
 * A dispatch that exhausts `maxSteps` is cut off mid-work, so the model never
 * reaches the final turn where it would write its JSON. `wrapWrapperResult`
 * then sees empty text and reports `parse_failed` — "did not produce valid
 * structured output" — which is true and useless: it points at the output
 * format when the actual problem is the budget. Observed on a real run where a
 * specialist spent all 13 steps thrashing and the parent was told its JSON was
 * malformed, so neither the log nor the parent agent recorded the one fact
 * that explained the failure.
 *
 * This lives here, on the definition, because the definition is where both
 * facts arrive (#370). Its predecessor `reclassifyStepLimit` sat in
 * `tool-wrapper-run.ts`, one layer up, where it had access to neither and so
 * inferred both from the formatted payload:
 *
 *  - It read the cutoff from a `stepLimitHit` the dispatch had to remember to
 *    forward; the runner now hands it to the formatter as {@link FormatMeta},
 *    which is also what let `sub` / `specialist` / `task` stop guessing.
 *  - It read "the parse failed" off `WrapperResult.error === 'parse_failed'` —
 *    a field {@link STRUCTURED_OUTPUT_RULES} explicitly tells the specialist to
 *    fill in ("put the cause in `error`"). A specialist reporting a
 *    *downstream* parse failure emits exactly that string with its own prose in
 *    `result`, and was silently relabelled `step_limit` whenever the run also
 *    exhausted its budget — the model's own diagnosis replaced by a wrong one.
 *    {@link isWrapperParseFailure} matches the envelope `wrapWrapperResult`
 *    mints instead, `result` constant included, so only OUR parse failure
 *    counts.
 *
 * The symmetric hazard is worth naming because it is not fully closable here:
 * `step_limit` is a real `ToolErrorType` (`error-taxonomy.ts`), so a model that
 * writes `"error": "step_limit"` mints a taxonomy-valid classification with no
 * dispatch behind it. What this change buys is that nothing downstream reads
 * that string back to *decide* anything — the verdict is now settled once, here,
 * from the dispatch fact.
 *
 * Two shapes are re-labelled, both of which mean "cut off with nothing to say":
 * our own parse failure, and — for `wantStructured: false` specialists, which
 * never parse — an `ok` whose result text is empty. That second one is worse
 * than a wrong label: it hands the parent an empty **success**.
 *
 * A run that hit the limit but still returned real content is left alone. The
 * model may have wrapped up on its last step, and overriding a substantive
 * answer with an error would discard work that did happen.
 */
export function relabelStepLimit(wrapped: WrapperResult, meta?: FormatMeta): WrapperResult {
  if (!meta?.stepLimitHit) return wrapped;

  // Only an *absent* result counts as empty. Testing `typeof !== 'string'`
  // would sweep up every successfully-parsed structured result, which is an
  // object — discarding exactly the work this guard is meant to preserve.
  const emptyOk =
    wrapped.status === 'ok' &&
    (wrapped.result === null ||
      wrapped.result === undefined ||
      (typeof wrapped.result === 'string' && wrapped.result.trim().length === 0));
  if (!emptyOk && !isWrapperParseFailure(wrapped)) return wrapped;

  return {
    ...wrapped,
    status: 'error',
    // `step_limit` is a real taxonomy category, deliberately: adding the label
    // without the entry would have downgraded the `parse_failed` it replaces
    // (`retryable: true`, concrete advice) to `unknown` ("did not match any
    // known pattern"). The recovery text is read from that playbook rather
    // than hand-written a second time, so every surface rendering `step_limit`
    // agrees.
    result: `Specialist ran out of steps (${meta.steps}) before producing a final answer. ${classifyError({ message: 'step_limit' }).playbook.model}`,
    error: 'step_limit',
  };
}

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
  resolveAlias?: ToolNameAliasResolver,
): Record<string, Tool> {
  const targets = specialist.targetTools;
  if (!targets || targets.length === 0) return {};
  const filtered: Record<string, Tool> = {};
  for (const name of targets) {
    // `targetTools` is persisted, so a record written before MCP tools were
    // namespaced per server (#413) names a bare tool. Resolve it forward;
    // `null` (unknown, or exported by more than one server) keeps the
    // pre-existing silent drop rather than guessing which server was meant.
    const live = fullRegistry[name] ? name : resolveAlias?.(name);
    if (live && fullRegistry[live]) {
      filtered[live] = fullRegistry[live];
      continue;
    }
    // `{}` is a supported result (#331), so a drop is otherwise invisible —
    // which is how an all-MCP wrapper could silently become tool-less.
    debugLog('tool-wrapper:target-tool-unresolved', { name });
  }
  return filtered;
}
