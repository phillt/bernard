import { tool } from 'ai';
import { z } from 'zod';
import {
  SpecialistStore,
  type SpecialistUpdates,
  type SpecialistExample,
  type SpecialistBadExample,
} from '../specialists.js';
import { ProtectedSpecialistError } from '../specialist-authority.js';
import type { CandidateStoreReader } from '../specialist-candidates.js';
import {
  type BernardConfig,
  PROVIDER_MODELS,
  isValidProvider,
  blankToUndefined,
} from '../config.js';
import { resolveSiteModel } from '../model-policy.js';
import { ALL_ROLE_IDS, MODEL_ROLES, type RoleId } from '../model-roles.js';
import { validateModelParams, PARAM_IDS, type ModelParams } from '../providers/model-params.js';
import { attachMeta } from '../framework/tools/adapter.js';
import type { AgentDefinition } from '../framework/agents/types.js';
import {
  DISPATCH_STRATEGIES,
  DISPATCH_TOOL_SURFACES,
  MAX_STEP_RATIO,
  SCOPE_AXES,
} from '../framework/agents/dispatch-profile.js';
import { scopeList } from '../text.js';

const goodExampleSchema = z.object({
  input: z.string(),
  call: z.string(),
  note: z.string().optional(),
});

const badExampleSchema = z.object({
  input: z.string(),
  call: z.string(),
  note: z.string().optional(),
  error: z.string(),
  fix: z.string(),
});

/**
 * Converts a {@link ProtectedSpecialistError} (raised when a mutation targets a
 * bundled specialist) into the tool's `Error: …` string; rethrows anything else.
 */
function protectedOrThrow(err: unknown): string {
  if (err instanceof ProtectedSpecialistError) return `Error: ${err.message}`;
  throw err;
}

/**
 * Rejects the two `targetTools` shapes no producer ever means.
 *
 * A `tool-wrapper` / `meta` that names none is inert rather than over-broad —
 * `buildChildTools` hands it an empty registry (#331) — so it is refused where
 * it is created. Nothing validated this before, which is exactly why the
 * permissive default had to exist.
 *
 * **A `persona` declaring `[]` is refused too, since #507.** Personas now reach
 * `buildChildTools` (the comment here used to say they never do, and that is
 * how it went stale), where a non-empty list is a fence and an empty one is
 * read as "unscoped" — because `[]` is a value nothing ever chose. A real
 * install carries one: a record with `targetTools: []` whose own system prompt
 * says to use the browser-control MCP tools. Refusing it at creation is what
 * stops the population growing; the dispatch's `debugLog` is then a migration
 * aid for the records that predate this rather than a permanent report.
 *
 * An ABSENT list stays legal on a persona, and means every tool the resolved
 * surface allows — the back-compat path 28 of 30 real personas take.
 *
 * Returns an error string, or `null` when the combination is fine.
 */
function targetToolsScopeError(
  kind: string | undefined,
  targetTools: string[] | undefined,
): string | null {
  const effective = kind ?? 'persona';
  if (effective === 'persona') {
    return targetTools?.length === 0
      ? `Error: targetTools: [] is not a scope — omit the field to give this specialist every ` +
          `tool its dispatch allows, or name the tools it may use, e.g. targetTools: ["web_search"].`
      : null;
  }
  if (effective !== 'tool-wrapper' && effective !== 'meta') return null;
  if (targetTools && targetTools.length > 0) return null;
  return (
    `Error: a "${effective}" specialist must declare targetTools. It fronts specific tools, ` +
    `and one that names none is handed no tools at all. Pass e.g. targetTools: ["shell"].`
  );
}

/**
 * Refuses a binding whose specialist cannot cover the action it is bound to
 * (#519).
 *
 * `grantedToolNames` hands a dispatch the INTERSECTION of the action's
 * `toolAllowlist` and the specialist's `targetTools`, so a tool the action
 * allows and the specialist does not target is simply **absent** — the agent
 * runs with fewer tools than the manifest promises, possibly none, and fails as
 * a bad ANSWER rather than an error. `agent-builder`'s prompt calls it "the
 * single easiest thing to get wrong", and until now nothing checked it: the
 * rule lived in prose and in a bad example.
 *
 * **Bind time is the creation boundary for this rule**, and it is the only
 * place both halves exist. A specialist is created before its applet action is
 * known — `agent-builder` deliberately creates unbound, validates by execution,
 * and binds last — so there is no `toolAllowlist` in scope at create. At bind
 * there is, exactly.
 *
 * Reuses `uncoveredTools` / `uncoveredToolsMessage` as a fourth consumer rather
 * than computing the same set again; the VERDICT is deliberately not shared,
 * per that module's own note, and this one refuses for the reason
 * `applet.ts:checkDispatch` refuses: a model mid-authoring will not come back
 * to it, so the binding must not be written believing it works.
 *
 * Fails **open** on anything it cannot read. A missing app, an unparseable
 * manifest or an unreadable registry means the check could not run, not that
 * the binding is wrong — and refusing a legitimate bind because a manifest was
 * mid-write would be worse than the defect.
 */
async function bindCoverageError(
  boundTo: { appId: string; action: string },
  targetTools: string[] | undefined,
): Promise<string | null> {
  try {
    const { AppRegistry } = await import('../apps/registry.js');
    const { uncoveredTools, uncoveredToolsMessage } = await import('../apps/invocation.js');
    const resolved = new AppRegistry({ seed: false }).resolve(boundTo.appId, boundTo.action);
    if (!resolved.ok) return null;
    const allowed = resolved.action.toolAllowlist ?? [];
    const missing = uncoveredTools(allowed, targetTools);
    if (missing.length === 0) return null;
    return `Error: ${uncoveredToolsMessage('this specialist', allowed, missing)} Add them to targetTools before binding.`;
  } catch {
    return null;
  }
}

/**
 * Rejects a `stepRatio` the resolver would silently discard (#508).
 *
 * `resolveDispatchProfile` already falls back on an out-of-range value, because
 * it runs on every dispatch and must not throw for a bad record. That is the
 * safety net, not the message: a record written with `stepRatio: 50` would be
 * stored, ignored forever, and the only trace would be a debug line nobody
 * reads. The creation boundary is where a model can still be told, so it is
 * told here — the same division `targetToolsScopeError` makes against
 * `buildChildTools`' silent drop.
 *
 * Returns an error string, or `null` when the value is fine. `0` is the clear
 * sentinel and is handled by the caller before this is reached.
 */
function stepRatioError(value: number | undefined): string | null {
  if (value === undefined || value === 0) return null;
  if (!Number.isFinite(value) || value < 0 || value > MAX_STEP_RATIO) {
    return (
      `Error: stepRatio is a FRACTION of the session step budget, not a step count — ` +
      `it must be greater than 0 and at most ${MAX_STEP_RATIO}. Got ${value}. ` +
      `For "about a fifth of the usual work" pass 0.2; pass 0 to clear.`
    );
  }
  return null;
}

/**
 * Creates the specialist management tool for saving and retrieving reusable expert profiles.
 *
 * Specialists are persistent personas with custom system prompts and behavioral guidelines
 * that shape how a sub-agent approaches work. Unlike routines (procedures), specialists
 * define *how* to work rather than *what* steps to follow.
 */
export function createSpecialistTool(
  specialistStore?: SpecialistStore,
  candidateStore?: CandidateStoreReader,
  config?: BernardConfig,
) {
  const store = specialistStore ?? new SpecialistStore();

  return attachMeta(
    tool({
      description:
        'Manage reusable expert profiles (specialists). Specialists are persistent personas with custom instructions and behavioral guidelines that shape how a sub-agent approaches work. Unlike routines (step-by-step procedures), specialists define expertise and behavioral rules for recurring task patterns. Bundled specialists (those that ship with Bernard, e.g. shell-wrapper, specialist-creator) are protected: update and delete are refused on them.',
      parameters: z.object({
        action: z
          .enum(['create', 'update', 'list', 'read', 'delete', 'roles', 'inspect'])
          .describe(
            'The action to perform. "roles" lists the model roles a specialist may declare, ' +
              'with what each is for — read it before choosing one. "inspect" shows what one ' +
              'specialist DECLARES against what that resolves to right now — the model its ' +
              'role picks, the steps its ratio buys, and any tools its binding promises that ' +
              'it does not target.',
          ),
        id: z
          .string()
          .optional()
          .describe(
            'Specialist ID (kebab-case slug, e.g. "email-triage"). Required for create/read/update/delete.',
          ),
        name: z.string().optional().describe('Display name (required for create)'),
        description: z.string().optional().describe('One-line summary (required for create)'),
        systemPrompt: z
          .string()
          .optional()
          .describe("The specialist's persona and behavioral instructions (required for create)"),
        guidelines: z
          .array(z.string())
          .optional()
          .describe('Short behavioral rules, appended as bullets (optional, defaults to [])'),
        provider: z
          .string()
          .optional()
          .describe(
            'Optional LLM provider override for this specialist (e.g. "xai", "openai"). Used with create/update.',
          ),
        model: z
          .string()
          .optional()
          .describe(
            'Optional model override for this specialist (e.g. "grok-code-fast-1"). Used with create/update.',
          ),
        params: z
          .record(z.enum(PARAM_IDS), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Optional generation params for this specialist's pinned model (issue #286), keyed by id: " +
              '"temperature"/"topP"/"maxOutputTokens" (numbers), "reasoningEffort" (e.g. "low"/"high"), ' +
              '"thinkingBudget" (Anthropic tokens). Capability-gated against the pinned (provider, model) — ' +
              'rejected params are dropped. Requires a provider/model pin. Used with create/update.',
          ),
        role: z
          // `''` is in the union deliberately: the description offers it as
          // the way to clear a role, and a bare `z.enum` would reject it
          // before `execute` ran — making the documented behaviour
          // unreachable and the store's clearing branch dead.
          .union([z.enum(ALL_ROLE_IDS as unknown as [RoleId, ...RoleId[]]), z.literal('')])
          .optional()
          .describe(
            'What this specialist is FOR, in model-selection terms — NOT a vendor or a model. ' +
              'The active profile resolves it to an actual model, and keeps doing so when the ' +
              'profile changes. Prefer this over provider/model: a pin you chose yourself is the ' +
              'kind most likely to go stale. Call action:"roles" to see the options. ' +
              'Pass "" to clear. Used with create/update.',
          ),
        boundTo: z
          .object({
            appId: z.string().min(1).describe('The applet this specialist serves.'),
            action: z.string().min(1).describe('The action within it.'),
          })
          .optional()
          .describe(
            'Binds this specialist to ONE applet action, so it is reachable only through that ' +
              'capability and never as a free-floating specialist. May be set on create, or on ' +
              'update for a specialist that is not yet bound — validate an unbound specialist ' +
              'first, then bind it. Re-binding an already-bound one is refused.',
          ),
        kind: z
          .enum(['persona', 'tool-wrapper', 'meta'])
          .optional()
          .describe(
            'Specialist category. "persona" (default) is the historical role-based specialist. "tool-wrapper" fronts a concrete tool or CLI and is invoked via tool_wrapper_run. "meta" specialists operate on other specialists (e.g. specialist-creator).',
          ),
        targetTools: z
          .array(z.string())
          .optional()
          .describe(
            'The tool names exposed to the child agent (e.g. ["shell"] or ["specialist", "tool_wrapper_run"]). Enforced for every kind: the specialist holds exactly these plus its reasoning tools, and nothing else. Required on tool-wrapper and meta; optional on persona, where omitting it means every tool the dispatch surface allows.',
          ),
        stepRatio: z
          .number()
          .optional()
          .describe(
            'How much work this specialist gets, as a FRACTION of the session step budget — ' +
              '0.2 for a lookup that should be one or two calls, 1 for a research run that ' +
              'needs the full budget. A fraction rather than a count so it scales with the ' +
              "user's own setting. Omit unless the work is clearly smaller or larger than " +
              'usual; the default is 0.5. Pass 0 to clear. Used with create/update.',
          ),
        strategy: z
          // `''` is in the union for the reason `role`'s is: the description
          // offers it as the way to clear, and a bare `z.enum` would reject it
          // before `execute` ran.
          .union([z.enum(DISPATCH_STRATEGIES), z.literal('')])
          .optional()
          .describe(
            'How this specialist runs. "react" is a think → act → evaluate loop with plan ' +
              'enforcement — for multi-step work where the right next call depends on the last ' +
              'result. "normal" is a single pass. Omit to follow the session default. ' +
              'Pass "" to clear. Used with create/update.',
          ),
        toolSurface: z
          .union([z.enum(DISPATCH_TOOL_SURFACES), z.literal('')])
          .optional()
          .describe(
            'Which built-in registry this specialist is scoped to. "worker" drops the tools a ' +
              'dispatched agent has no business using (routines, lineups, cron, MCP config); ' +
              '"full" keeps them, and is only right for a specialist that manages Bernard itself. ' +
              'Omit unless you need "full" — the default is already the narrow one. ' +
              'Pass "" to clear. Used with create/update.',
          ),
        goodExamples: z
          .array(goodExampleSchema)
          .optional()
          .describe(
            'Few-shot examples of correct tool usage. Each entry: {input, call, note?}. Used by tool-wrapper specialists.',
          ),
        badExamples: z
          .array(badExampleSchema)
          .optional()
          .describe(
            'Few-shot examples of incorrect tool usage with their corrections. Each entry: {input, call, error, fix, note?}.',
          ),
        structuredOutput: z
          .boolean()
          .optional()
          .describe(
            'When true, the specialist must emit JSON {status, result, error?, reasoning?} as its final message. Default: true for tool-wrapper kind, false otherwise.',
          ),
      }),
      execute: async ({
        action,
        id,
        name,
        description,
        systemPrompt,
        guidelines,
        provider,
        model,
        role,
        boundTo,
        params,
        kind,
        targetTools,
        stepRatio,
        strategy,
        toolSurface,
        goodExamples,
        badExamples,
        structuredOutput,
      }): Promise<string> => {
        switch (action) {
          case 'list': {
            const specialists = store.list();
            if (specialists.length === 0) return 'No specialists saved yet.';
            return `Specialists (${specialists.length}):\n${specialists
              .map((s) => {
                const modelTag =
                  s.provider || s.model
                    ? ` [${s.provider ?? 'default'}/${s.model ?? 'default'}]`
                    : '';
                return `  - ${s.id} — ${s.name}: ${s.description}${modelTag}`;
              })
              .join('\n')}`;
          }

          case 'read': {
            if (!id) return 'Error: id is required for read action.';
            const specialist = store.get(id);
            if (!specialist) return `No specialist found with id "${id}".`;
            let output = `# ${specialist.name} (${specialist.id})\n${specialist.description}`;
            if (specialist.kind && specialist.kind !== 'persona') {
              output += `\n\nKind: ${specialist.kind}`;
            }
            if (specialist.targetTools && specialist.targetTools.length > 0) {
              output += `\nTarget tools: ${specialist.targetTools.join(', ')}`;
            }
            if (specialist.structuredOutput) {
              output += `\nStructured output: true`;
            }
            if (specialist.provider || specialist.model) {
              output += `\n\n## Model Override\nProvider: ${specialist.provider ?? 'default'}\nModel: ${specialist.model ?? 'default'}`;
            } else if (specialist.role) {
              // Shown INSTEAD of the override block, not beside it: a pin
              // short-circuits resolution, so a record with both would be
              // reporting a role that never decides anything.
              output += `\n\nRole: ${specialist.role} (resolved against the active profile)`;
            }
            output += `\n\n## System Prompt\n${specialist.systemPrompt}`;
            if (specialist.guidelines.length > 0) {
              output += `\n\n## Guidelines\n${specialist.guidelines.map((g) => `- ${g}`).join('\n')}`;
            }
            if (specialist.goodExamples && specialist.goodExamples.length > 0) {
              output += `\n\n## Good Examples`;
              for (const ex of specialist.goodExamples) {
                output += `\n- input: ${ex.input}\n  call: ${ex.call}`;
                if (ex.note) output += `\n  note: ${ex.note}`;
              }
            }
            if (specialist.badExamples && specialist.badExamples.length > 0) {
              output += `\n\n## Bad Examples`;
              for (const ex of specialist.badExamples) {
                output += `\n- input: ${ex.input}\n  call: ${ex.call}\n  error: ${ex.error}\n  fix: ${ex.fix}`;
                if (ex.note) output += `\n  note: ${ex.note}`;
              }
            }
            return output;
          }

          case 'roles': {
            // The catalogue, rendered for a model rather than for the lineup
            // editor. `lookFor` is the part that makes a choice grounded — it
            // says what the role is optimised for, which is the actual
            // question being asked.
            const lines = MODEL_ROLES.map((r) => `- ${r.id} — ${r.description}\n  ${r.lookFor}`);
            return (
              'Model roles a specialist may declare.\n\n' +
              `${lines.join('\n')}\n\n` +
              'Declare one as `role`. It resolves against the active profile, so it keeps ' +
              'meaning the right thing when the profile changes. Do not set provider/model ' +
              'unless the user named a specific one.'
            );
          }

          case 'inspect': {
            // Declared vs. resolved (#519). `read` returns the record; this
            // answers the question a record cannot: what does it actually get?
            // Every line here is a value the record only names indirectly —
            // `role` picks a model through the active profile, `stepRatio` is a
            // fraction of a setting, and a binding's coverage gap is an
            // intersection with a manifest the record has never seen.
            if (!id) return 'Error: id is required for inspect action.';
            const record = store.get(id);
            if (!record) return `No specialist found with id "${id}".`;
            const lines: string[] = [`${record.name} (${record.id}) — ${record.kind ?? 'persona'}`];

            if (record.role) {
              let resolvedLine = `role: ${record.role}`;
              if (config) {
                try {
                  const site = resolveSiteModel(config, 'specialist', { specialist: record });
                  resolvedLine += ` → ${site.provider}/${site.modelName} (${site.source})`;
                } catch {
                  // Resolution needs a usable profile; naming the role alone is
                  // still the useful half.
                }
              }
              lines.push(resolvedLine);
            } else if (record.provider || record.model) {
              lines.push(
                `pinned: ${record.provider ?? 'default'}/${record.model ?? 'default'} — a pin, not an intent. ` +
                  'It is dropped as stale when it is off the active lineup.',
              );
            } else {
              lines.push('role: none declared — this specialist follows the dispatching site.');
            }

            // Through the real resolver and the real definition, never a second
            // implementation. Re-deriving these was the failure this action
            // exists to catch, one level down: an out-of-range `stepRatio` would
            // be reported as if it will be honoured when `resolveDispatchProfile`
            // is going to discard it, a `tool-wrapper` record's own ratio and
            // its `Math.max(2, …)` floor would both be invisible, and
            // `SPECIALIST_STEP_RATIO` was re-hardcoded as a literal `0.5`.
            // "What does this record actually get" is answered by the code that
            // gives it.
            // Deferred, like `bindCoverageError`'s: a static edge would put the
            // whole agent runtime on `createTools`' eager graph, which is the
            // cost #452 exists to have removed.
            const [
              { specialistDefinition },
              { toolWrapperDefinition },
              { resolveDispatchProfile },
            ] = await Promise.all([
              import('../framework/agents/specialist.js'),
              import('../framework/agents/tool-wrapper.js'),
              import('../framework/agents/dispatch-profile.js'),
            ]);
            const def = (
              record.kind === 'tool-wrapper' ? toolWrapperDefinition : specialistDefinition
            ) as AgentDefinition<{ specialistId: string }, unknown>;
            // The resolver reads exactly one thing off the context, and this is
            // the store it would have read.
            const profile = resolveDispatchProfile(
              { stores: { specialists: store } } as never,
              def,
              {
                specialistId: record.id,
              },
            );
            if (config) {
              const steps = def.stepBudget(config, { specialistId: record.id }, profile);
              lines.push(
                profile.stepRatio === undefined
                  ? `steps: ${steps} (the site default for a ${def.id})`
                  : `stepRatio: ${profile.stepRatio} → ${steps} steps`,
              );
              // A declared value the resolver threw away is the single most
              // useful thing this command can say.
              if (record.stepRatio !== undefined && profile.stepRatio === undefined) {
                lines.push(`  ⚠ declared stepRatio ${record.stepRatio} is invalid and is ignored`);
              }
            }
            if (record.strategy) {
              lines.push(
                profile.strategy
                  ? `strategy: ${profile.strategy}`
                  : `strategy: ${record.strategy} — not a known strategy, so it is ignored`,
              );
            }
            if (record.toolSurface) {
              lines.push(
                profile.toolSurface
                  ? `toolSurface: ${profile.toolSurface}`
                  : `toolSurface: ${record.toolSurface} — not a known surface, so it is ignored`,
              );
            }
            lines.push(
              record.targetTools?.length
                ? `targetTools: ${record.targetTools.join(', ')}`
                : 'targetTools: none declared',
            );
            // The knowledge fences (#511), reported through the same resolved
            // profile. `[]` is a real posture — deny-all — so it is rendered as
            // "(nothing)" rather than folded into "none declared"; the two mean
            // opposite things and the resolver already keeps them apart.
            // Field names, not the viewer's short labels: this surface prints
            // what you would type into the JSON, and the two vocabularies are
            // both user-visible — which is why the table carries both rather
            // than unifying them (#552).
            for (const axis of SCOPE_AXES) {
              // Named `field`, not `label`: the table also carries a `label`
              // (`memory` / `knowledge` / `corpus`) for the viewer, and binding
              // a local called `label` inside the one loop that must NOT use it
              // is an invitation to "fix" this back.
              const field = axis.field;
              const declared = record[axis.field];
              const resolved = profile[axis.field];
              if (resolved === undefined) continue;
              lines.push(`${field}: ${scopeList(resolved)}`);
              const dropped = Array.isArray(declared) ? declared.length - resolved.length : null;
              if (dropped === null) {
                lines.push(`  ⚠ declared ${field} is not a list, so this dispatch reads nothing`);
              } else if (dropped > 0) {
                lines.push(
                  `  ⚠ ${dropped} declared entr${dropped === 1 ? 'y is' : 'ies are'} invalid and dropped`,
                );
              }
            }

            if (record.boundTo) {
              lines.push(`bound to: ${record.boundTo.appId}/${record.boundTo.action}`);
              const coverage = await bindCoverageError(record.boundTo, record.targetTools);
              // A gap here is a REPORT, not a refusal: the binding already
              // exists, and refusing to describe it is how the one command that
              // could diagnose it becomes useless.
              lines.push(
                coverage ? `  ⚠ ${coverage.replace(/^Error: /, '')}` : '  ✓ covers the action',
              );
            }
            if (record.disabled) lines.push('disabled: yes — dispatch refuses it.');
            return lines.join('\n');
          }

          case 'create': {
            if (!id) return 'Error: id is required for create action.';
            if (!name) return 'Error: name is required for create action.';
            if (!description) return 'Error: description is required for create action.';
            if (!systemPrompt) return 'Error: systemPrompt is required for create action.';
            // Normalize blanks ("", "   ") to undefined so an LLM emitting ""
            // doesn't fail validation and so policy auto-assign still fires.
            const normProvider = blankToUndefined(provider);
            const normModel = blankToUndefined(model);
            // A create declares either a BINDING or an INTENT, never both.
            // `provider`/`model` is a binding — a specific model was chosen.
            // `role` is an intent — a kind of work was chosen, and the active
            // profile picks the model, now and after every re-tier. A record
            // carrying both would behave according to `resolveSiteModel`'s
            // internal ordering rather than anything anyone declared, which is
            // the shape `AppActionSchema` refuses for the same reason.
            const normRole = role === '' ? undefined : role;
            if (normRole && (normProvider !== undefined || normModel !== undefined)) {
              return 'Error: declare either `role` or `provider`/`model`, not both. A role lets the active profile choose the model; a pin overrides it.';
            }
            const ratioError = stepRatioError(stepRatio);
            if (ratioError) return ratioError;
            // A create MAY bind directly, so the coverage rule has to hold on
            // both doors. `agent-builder` deliberately creates unbound and
            // binds last, but nothing forces that order.
            if (boundTo) {
              const coverage = await bindCoverageError(boundTo, targetTools);
              if (coverage) return coverage;
            }
            if (normProvider !== undefined) {
              if (!isValidProvider(normProvider))
                return `Error: Unknown provider "${normProvider}". Valid providers: ${Object.keys(PROVIDER_MODELS).join(', ')}`;
              // Model is not validated against PROVIDER_MODELS: the catalog can
              // lag day-0 model releases, and the underlying SDK already
              // rejects unknown ids. Trust the caller and pass through.
            }
            // A create that declares NEITHER a role nor a pin now persists
            // neither (#519).
            //
            // This block used to mint a policy-resolved `provider`/`model` and
            // write it to disk, justified as keeping today's behaviour byte for
            // byte for existing callers — `specialist-creator` named
            // explicitly. That justification has expired: `specialist-creator`
            // is the caller this change teaches to declare a role, and the pin
            // it was minting is **exactly** what the off-lineup guard exists to
            // drop. One nobody chose, dropped as stale the moment the user
            // switches lineup, and bucketed as `pinned` in `bernard usage`
            // instead of by tier.
            //
            // Removing it is also the only enforceable form of the rule. Prose
            // in two bundled prompts binds a model that read them; the writer
            // binds every path — a hand-written record, `/specialists`, a
            // future creator, or `agent-builder` on a turn where it forgets.
            // `resolveSiteModel` already treats "declares neither" as the site
            // default, so the resolved model is the same — decided live rather
            // than frozen, which is the whole difference between a binding and
            // an intent.
            const resolvedProvider = normProvider;
            const resolvedModel = normModel;
            // Capability-gate params against the pinned model; needs a pin.
            // Reject rather than silently drop so the caller knows params
            // require a provider+model to bind to.
            let resolvedParams: ModelParams | undefined;
            if (params && Object.keys(params).length > 0) {
              if (!resolvedProvider || !resolvedModel) {
                return 'Error: params require a provider and model pin. Set provider+model on this specialist (or enable a model-mode lineup) before adding params.';
              }
              const safe = validateModelParams(resolvedProvider, resolvedModel, params);
              if (Object.keys(safe).length > 0) resolvedParams = safe;
            }
            const createScopeError = targetToolsScopeError(kind, targetTools);
            if (createScopeError) return createScopeError;
            try {
              const specialist = store.createFull({
                id,
                name,
                description,
                systemPrompt,
                guidelines: guidelines ?? [],
                provider: resolvedProvider,
                model: resolvedModel,
                role: normRole,
                boundTo,
                params: resolvedParams,
                kind,
                targetTools,
                ...(stepRatio !== undefined && stepRatio !== 0 ? { stepRatio } : {}),
                ...(strategy ? { strategy } : {}),
                ...(toolSurface ? { toolSurface } : {}),
                goodExamples: goodExamples as SpecialistExample[] | undefined,
                badExamples: badExamples as SpecialistBadExample[] | undefined,
                structuredOutput,
              });
              // Auto-mark matching candidate as accepted (best-effort)
              try {
                if (candidateStore) {
                  const pending = candidateStore.listPending();
                  const match = pending.find(
                    (c) => c.draftId === id || c.name.toLowerCase() === name.toLowerCase(),
                  );
                  if (match) candidateStore.updateStatus(match.id, 'accepted');
                }
              } catch {
                // candidate status update is best-effort; don't block specialist creation
              }
              return `Specialist "${specialist.name}" (${specialist.id}) created. Use specialist_run to invoke it.`;
            } catch (err: unknown) {
              return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
          }

          case 'update': {
            if (!id) return 'Error: id is required for update action.';
            if (provider !== undefined && provider !== '') {
              if (!isValidProvider(provider))
                return `Error: Unknown provider "${provider}". Valid providers: ${Object.keys(PROVIDER_MODELS).join(', ')}`;
            }
            // Model is not validated against PROVIDER_MODELS: the catalog can
            // lag day-0 model releases, and the underlying SDK already
            // rejects unknown ids.
            // Read once: both the params branch and the targetTools scope guard
            // need the stored record.
            const existingRecord = store.get(id);
            const updates: SpecialistUpdates = {};
            if (name !== undefined) updates.name = name;
            if (description !== undefined) updates.description = description;
            if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt;
            if (guidelines !== undefined) updates.guidelines = guidelines;
            if (provider !== undefined) updates.provider = provider;
            if (model !== undefined) updates.model = model;
            if (boundTo !== undefined) {
              const coverage = await bindCoverageError(
                boundTo,
                targetTools ?? existingRecord?.targetTools,
              );
              if (coverage) return coverage;
              updates.boundTo = boundTo;
            }
            if (role !== undefined) {
              updates.role = role;
              // Setting a role clears any pin, or the both-state `create`
              // refuses is reachable through `update`. `params` go with it:
              // they are capability-gated against a pin (see below), so a
              // role-declaring specialist can never carry them.
              if (role !== '') {
                updates.provider = '';
                updates.model = '';
                updates.params = {};
              }
            }
            if (params !== undefined) {
              // Validate against the effective pin: the new provider/model if
              // supplied, else the specialist's existing one. An empty `params`
              // object is an explicit "clear". A non-empty `params` with no pin
              // is rejected rather than silently dropped — params need a
              // provider+model to bind to.
              const effProvider = blankToUndefined(provider) ?? existingRecord?.provider;
              const effModel = blankToUndefined(model) ?? existingRecord?.model;
              if (Object.keys(params).length > 0 && (!effProvider || !effModel)) {
                return 'Error: params require a provider and model pin. Set provider+model on this specialist before adding params.';
              }
              updates.params =
                effProvider && effModel ? validateModelParams(effProvider, effModel, params) : {};
            }
            if (kind !== undefined) updates.kind = kind;
            if (targetTools !== undefined) updates.targetTools = targetTools;
            // Validate the MERGED record, not the patch: promoting a persona to
            // `tool-wrapper` without also supplying `targetTools` is exactly the
            // combination that would produce an inert specialist.
            if (kind !== undefined || targetTools !== undefined) {
              const updateScopeError = targetToolsScopeError(
                kind ?? existingRecord?.kind,
                targetTools ?? existingRecord?.targetTools,
              );
              if (updateScopeError) return updateScopeError;
            }
            const updateRatioError = stepRatioError(stepRatio);
            if (updateRatioError) return updateRatioError;
            if (stepRatio !== undefined) updates.stepRatio = stepRatio;
            if (strategy !== undefined) updates.strategy = strategy;
            if (toolSurface !== undefined) updates.toolSurface = toolSurface;
            if (goodExamples !== undefined)
              updates.goodExamples = goodExamples as SpecialistExample[];
            if (badExamples !== undefined)
              updates.badExamples = badExamples as SpecialistBadExample[];
            if (structuredOutput !== undefined) updates.structuredOutput = structuredOutput;
            // Auto-clear model when provider is cleared and model not explicitly provided
            if (provider === '' && model === undefined) updates.model = '';
            if (Object.keys(updates).length === 0)
              return 'Error: provide at least one field to update (name, description, systemPrompt, guidelines, provider, model, role, kind, targetTools, stepRatio, strategy, toolSurface, goodExamples, badExamples, or structuredOutput).';
            try {
              const updated = store.update(id, updates);
              if (!updated) return `No specialist found with id "${id}".`;
              return `Specialist "${updated.name}" (${updated.id}) updated.`;
            } catch (err: unknown) {
              return protectedOrThrow(err);
            }
          }

          case 'delete': {
            if (!id) return 'Error: id is required for delete action.';
            try {
              const deleted = store.delete(id);
              if (!deleted) return `No specialist found with id "${id}".`;
              return `Specialist "${id}" deleted.`;
            } catch (err: unknown) {
              return protectedOrThrow(err);
            }
          }

          default:
            return `Unknown action: ${action}`;
        }
      },
    }),
    {
      name: 'specialist',
      kind: 'write',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
    },
  );
}
