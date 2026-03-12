import { tool } from 'ai';
import { z } from 'zod';
import { SpecialistStore, type Specialist } from '../specialists.js';
import type { CandidateStore } from '../specialist-candidates.js';

/**
 * Creates the specialist management tool for saving and retrieving reusable expert profiles.
 *
 * Specialists are persistent personas with custom system prompts and behavioral guidelines
 * that shape how a sub-agent approaches work. Unlike routines (procedures), specialists
 * define *how* to work rather than *what* steps to follow.
 */
export function createSpecialistTool(
  specialistStore?: SpecialistStore,
  candidateStore?: CandidateStore,
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
    }),
    execute: async ({
      action,
      id,
      name,
      description,
      systemPrompt,
      guidelines,
    }): Promise<string> => {
      switch (action) {
        case 'list': {
          const specialists = store.list();
          if (specialists.length === 0) return 'No specialists saved yet.';
          return `Specialists (${specialists.length}):\n${specialists.map((s) => `  - ${s.id} — ${s.name}: ${s.description}`).join('\n')}`;
        }

        case 'read': {
          if (!id) return 'Error: id is required for read action.';
          const specialist = store.get(id);
          if (!specialist) return `No specialist found with id "${id}".`;
          let output = `# ${specialist.name} (${specialist.id})\n${specialist.description}\n\n## System Prompt\n${specialist.systemPrompt}`;
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
          try {
            const specialist = store.create(id, name, description, systemPrompt, guidelines ?? []);
            // Auto-mark matching candidate as accepted
            if (candidateStore) {
              const pending = candidateStore.listPending();
              const match = pending.find(
                (c) => c.draftId === id || c.name.toLowerCase() === name.toLowerCase(),
              );
              if (match) candidateStore.updateStatus(match.id, 'accepted');
            }
            return `Specialist "${specialist.name}" (${specialist.id}) created. Use specialist_run to invoke it.`;
          } catch (err: unknown) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        case 'update': {
          if (!id) return 'Error: id is required for update action.';
          const updates: Partial<
            Pick<Specialist, 'name' | 'description' | 'systemPrompt' | 'guidelines'>
          > = {};
          if (name !== undefined) updates.name = name;
          if (description !== undefined) updates.description = description;
          if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt;
          if (guidelines !== undefined) updates.guidelines = guidelines;
          if (Object.keys(updates).length === 0)
            return 'Error: provide at least one field to update (name, description, systemPrompt, or guidelines).';
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
