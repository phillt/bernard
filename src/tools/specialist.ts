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
import { validateModelParams, PARAM_IDS, type ModelParams } from '../providers/model-params.js';
import { attachMeta } from '../framework/tools/adapter.js';

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
 * A `tool-wrapper` / `meta` specialist that names no `targetTools` is now inert
 * rather than over-broad — `buildChildTools` hands it an empty registry (#331) —
 * so reject it where it is created. Nothing validated this before, which is
 * exactly why the permissive default had to exist. `persona` is unaffected: it
 * never reaches `buildChildTools`.
 *
 * Returns an error string, or `null` when the combination is fine.
 */
function targetToolsScopeError(
  kind: string | undefined,
  targetTools: string[] | undefined,
): string | null {
  const effective = kind ?? 'persona';
  if (effective !== 'tool-wrapper' && effective !== 'meta') return null;
  if (targetTools && targetTools.length > 0) return null;
  return (
    `Error: a "${effective}" specialist must declare targetTools. It fronts specific tools, ` +
    `and one that names none is handed no tools at all. Pass e.g. targetTools: ["shell"].`
  );
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
          .enum(['create', 'update', 'list', 'read', 'delete'])
          .describe('The action to perform'),
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
            'For tool-wrapper or meta specialists: the tool names exposed to the child agent (e.g. ["shell"] or ["specialist", "tool_wrapper_run"]). Isolates the specialist from unrelated tools.',
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
        params,
        kind,
        targetTools,
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

          case 'create': {
            if (!id) return 'Error: id is required for create action.';
            if (!name) return 'Error: name is required for create action.';
            if (!description) return 'Error: description is required for create action.';
            if (!systemPrompt) return 'Error: systemPrompt is required for create action.';
            // Normalize blanks ("", "   ") to undefined so an LLM emitting ""
            // doesn't fail validation and so policy auto-assign still fires.
            const normProvider = blankToUndefined(provider);
            const normModel = blankToUndefined(model);
            if (normProvider !== undefined) {
              if (!isValidProvider(normProvider))
                return `Error: Unknown provider "${normProvider}". Valid providers: ${Object.keys(PROVIDER_MODELS).join(', ')}`;
              // Model is not validated against PROVIDER_MODELS: the catalog can
              // lag day-0 model releases, and the underlying SDK already
              // rejects unknown ids. Trust the caller and pass through.
            }
            // Auto-assign policy-resolved provider/model when multi-model
            // mode is active and the user didn't specify either (#170).
            let resolvedProvider = normProvider;
            let resolvedModel = normModel;
            if (normProvider === undefined && normModel === undefined && config) {
              try {
                const site = resolveSiteModel(config, 'specialist');
                if (site.source === 'policy') {
                  resolvedProvider = site.provider;
                  resolvedModel = site.modelName;
                }
              } catch {
                // Policy resolution is best-effort; fall through to no override.
              }
            }
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
                params: resolvedParams,
                kind,
                targetTools,
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
            if (goodExamples !== undefined)
              updates.goodExamples = goodExamples as SpecialistExample[];
            if (badExamples !== undefined)
              updates.badExamples = badExamples as SpecialistBadExample[];
            if (structuredOutput !== undefined) updates.structuredOutput = structuredOutput;
            // Auto-clear model when provider is cleared and model not explicitly provided
            if (provider === '' && model === undefined) updates.model = '';
            if (Object.keys(updates).length === 0)
              return 'Error: provide at least one field to update (name, description, systemPrompt, guidelines, provider, model, kind, targetTools, goodExamples, badExamples, or structuredOutput).';
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
