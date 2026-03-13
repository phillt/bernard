import { tool } from 'ai';
import { z } from 'zod';
import { SpecialistStore, type Specialist } from '../specialists.js';
import type { CandidateStoreReader } from '../specialist-candidates.js';
import { type BernardConfig, PROVIDER_MODELS, isValidProvider } from '../config.js';

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
    }): Promise<string> => {
      switch (action) {
        case 'list': {
          const specialists = store.list();
          if (specialists.length === 0) return 'No specialists saved yet.';
          return `Specialists (${specialists.length}):\n${specialists.map((s) => {
            const modelTag = s.provider || s.model
              ? ` [${s.provider ?? 'default'}/${s.model ?? 'default'}]`
              : '';
            return `  - ${s.id} — ${s.name}: ${s.description}${modelTag}`;
          }).join('\n')}`;
        }

        case 'read': {
          if (!id) return 'Error: id is required for read action.';
          const specialist = store.get(id);
          if (!specialist) return `No specialist found with id "${id}".`;
          let output = `# ${specialist.name} (${specialist.id})\n${specialist.description}`;
          if (specialist.provider || specialist.model) {
            output += `\n\n## Model Override\nProvider: ${specialist.provider ?? 'default'}\nModel: ${specialist.model ?? 'default'}`;
          }
          output += `\n\n## System Prompt\n${specialist.systemPrompt}`;
          if (specialist.guidelines.length > 0) {
            output += `\n\n## Guidelines\n${specialist.guidelines.map((g) => `- ${g}`).join('\n')}`;
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
          }
          try {
            const specialist = store.create(id, name, description, systemPrompt, guidelines ?? [], provider, model);
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
          }
          const updates: Partial<
            Pick<Specialist, 'name' | 'description' | 'systemPrompt' | 'guidelines' | 'provider' | 'model'>
          > = {};
          if (name !== undefined) updates.name = name;
          if (description !== undefined) updates.description = description;
          if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt;
          if (guidelines !== undefined) updates.guidelines = guidelines;
          if (provider !== undefined) updates.provider = provider;
          if (model !== undefined) updates.model = model;
          if (Object.keys(updates).length === 0)
            return 'Error: provide at least one field to update (name, description, systemPrompt, guidelines, provider, or model).';
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
