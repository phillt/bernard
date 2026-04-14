import { tool } from 'ai';
import { z } from 'zod';
import {
  SpecialistStore,
  type SpecialistUpdates,
  type SpecialistExample,
  type SpecialistBadExample,
} from '../specialists.js';
import type { CandidateStoreReader } from '../specialist-candidates.js';
import { type BernardConfig, PROVIDER_MODELS, isValidProvider } from '../config.js';

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

  return tool({
    description:
      'Manage reusable expert profiles (specialists). Specialists are persistent personas with custom instructions and behavioral guidelines that shape how a sub-agent approaches work. Unlike routines (step-by-step procedures), specialists define expertise and behavioral rules for recurring task patterns.',
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
          if (provider !== undefined) {
            if (!isValidProvider(provider))
              return `Error: Unknown provider "${provider}". Valid providers: ${Object.keys(PROVIDER_MODELS).join(', ')}`;
            if (model !== undefined && !PROVIDER_MODELS[provider]?.includes(model))
              return `Error: Unknown model "${model}" for provider "${provider}". Valid models: ${PROVIDER_MODELS[provider].join(', ')}`;
          } else if (model !== undefined && config) {
            // Validate model against the global config's provider when no explicit provider given
            if (!PROVIDER_MODELS[config.provider]?.includes(model))
              return `Error: Unknown model "${model}" for provider "${config.provider}". Valid models: ${PROVIDER_MODELS[config.provider].join(', ')}`;
          }
          try {
            const specialist = store.createFull({
              id,
              name,
              description,
              systemPrompt,
              guidelines: guidelines ?? [],
              provider,
              model,
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
            if (model !== undefined && model !== '' && !PROVIDER_MODELS[provider]?.includes(model))
              return `Error: Unknown model "${model}" for provider "${provider}". Valid models: ${PROVIDER_MODELS[provider].join(', ')}`;
          } else if (model !== undefined && model !== '' && provider === undefined) {
            // Model-only update: validate against existing specialist's provider or global config
            const existing = store.get(id);
            const effectiveProvider = existing?.provider || config?.provider;
            if (effectiveProvider && !PROVIDER_MODELS[effectiveProvider]?.includes(model))
              return `Error: Unknown model "${model}" for provider "${effectiveProvider}". Valid models: ${PROVIDER_MODELS[effectiveProvider]?.join(', ') ?? 'none'}`;
          }
          const updates: SpecialistUpdates = {};
          if (name !== undefined) updates.name = name;
          if (description !== undefined) updates.description = description;
          if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt;
          if (guidelines !== undefined) updates.guidelines = guidelines;
          if (provider !== undefined) updates.provider = provider;
          if (model !== undefined) updates.model = model;
          if (kind !== undefined) updates.kind = kind;
          if (targetTools !== undefined) updates.targetTools = targetTools;
          if (goodExamples !== undefined)
            updates.goodExamples = goodExamples as SpecialistExample[];
          if (badExamples !== undefined)
            updates.badExamples = badExamples as SpecialistBadExample[];
          if (structuredOutput !== undefined) updates.structuredOutput = structuredOutput;
          // Auto-clear model when provider is cleared and model not explicitly provided
          if (provider === '' && model === undefined) updates.model = '';
          if (Object.keys(updates).length === 0)
            return 'Error: provide at least one field to update (name, description, systemPrompt, guidelines, provider, model, kind, targetTools, goodExamples, badExamples, or structuredOutput).';
          const updated = store.update(id, updates);
          if (!updated) return `No specialist found with id "${id}".`;
          return `Specialist "${updated.name}" (${updated.id}) updated.`;
        }

        case 'delete': {
          if (!id) return 'Error: id is required for delete action.';
          const deleted = store.delete(id);
          if (!deleted) return `No specialist found with id "${id}".`;
          return `Specialist "${id}" deleted.`;
        }

        default:
          return `Unknown action: ${action}`;
      }
    },
  });
}
