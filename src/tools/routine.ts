import { tool } from 'ai';
import { z } from 'zod';
import { RoutineStore } from '../routines.js';

/**
 * Creates the routine management tool for saving and retrieving reusable multi-step workflows.
 *
 * Routines are named procedures (deploy, release, onboarding, etc.) that the user can
 * teach Bernard and later invoke via `/{routine-id}` in the REPL.
 */
export function createRoutineTool() {
  const store = new RoutineStore();

  return tool({
    description:
      'Manage reusable multi-step workflows (routines). Routines capture procedures the user teaches you — deploy scripts, release checklists, onboarding flows, etc. Once saved, the user can invoke them with /{routine-id} in the REPL. Content should be free-form markdown capturing steps, decisions, and intent.',
    parameters: z.object({
      action: z
        .enum(['create', 'update', 'list', 'read', 'delete'])
        .describe('The action to perform'),
      id: z
        .string()
        .optional()
        .describe(
          'Routine ID (kebab-case slug, e.g. "deploy-staging"). Required for create/read/update/delete.',
        ),
      name: z.string().optional().describe('Display name (required for create)'),
      description: z.string().optional().describe('One-line summary (required for create)'),
      content: z.string().optional().describe('Full procedure as markdown (required for create)'),
    }),
    execute: async ({ action, id, name, description, content }): Promise<string> => {
      switch (action) {
        case 'list': {
          const routines = store.list();
          if (routines.length === 0) return 'No routines saved yet.';
          return `Routines (${routines.length}):\n${routines.map((r) => `  - /${r.id} — ${r.name}: ${r.description}`).join('\n')}`;
        }

        case 'read': {
          if (!id) return 'Error: id is required for read action.';
          const routine = store.get(id);
          if (!routine) return `No routine found with id "${id}".`;
          return `# ${routine.name} (/${routine.id})\n${routine.description}\n\n${routine.content}`;
        }

        case 'create': {
          if (!id) return 'Error: id is required for create action.';
          if (!name) return 'Error: name is required for create action.';
          if (!description) return 'Error: description is required for create action.';
          if (!content) return 'Error: content is required for create action.';
          try {
            const routine = store.create(id, name, description, content);
            return `Routine "${routine.name}" (/${routine.id}) created. The user can now invoke it with /${routine.id}.`;
          } catch (err: unknown) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        case 'update': {
          if (!id) return 'Error: id is required for update action.';
          const updates: Record<string, string> = {};
          if (name !== undefined) updates.name = name;
          if (description !== undefined) updates.description = description;
          if (content !== undefined) updates.content = content;
          if (Object.keys(updates).length === 0)
            return 'Error: provide at least one field to update (name, description, or content).';
          const updated = store.update(id, updates);
          if (!updated) return `No routine found with id "${id}".`;
          return `Routine "${updated.name}" (/${updated.id}) updated.`;
        }

        case 'delete': {
          if (!id) return 'Error: id is required for delete action.';
          const deleted = store.delete(id);
          if (!deleted) return `No routine found with id "${id}".`;
          return `Routine "${id}" deleted.`;
        }

        default:
          return `Unknown action: ${action}`;
      }
    },
  });
}
