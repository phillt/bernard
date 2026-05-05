import { tool } from 'ai';
import { z } from 'zod';
import type { PlanStore } from '../plan-store.js';
import { printPlan } from '../output.js';

const stepInputSchema = z.object({
  description: z.string().min(1, 'description must not be empty').describe('What this step accomplishes.'),
  verification: z
    .string()
    .min(1, 'verification must not be empty')
    .describe(
      'Concrete check that proves the step succeeded — a command to run, a file to read, a URL to GET, an output substring to look for. Must be observable, not subjective.',
    ),
});

/**
 * Creates the `plan` tool for coordinator (ReAct) mode.
 *
 * Each step carries a verification criterion at creation time. Marking a step
 * `done` requires a `signoff` attesting that the verification was actually
 * performed. `cancelled`/`error` require `note` (no sign-off, since the step
 * did not succeed).
 */
export function createPlanTool(planStore: PlanStore) {
  // Suppress redundant re-renders: the model often calls `view` repeatedly
  // (and may also re-issue an `update` that produces no visible change).
  // Compare against the last rendered string and skip printing when identical.
  let lastRendered: string | null = null;
  const printIfChanged = () => {
    const rendered = planStore.render();
    if (rendered === lastRendered) return;
    lastRendered = rendered;
    printPlan(planStore.view());
  };

  return tool({
    description:
      "Track and manage a structured plan for the current turn. Required in coordinator mode. Each step has a `verification` criterion (set at creation) describing how you'll prove it succeeded. Actions: 'create' seeds a plan with step objects {description, verification}; 'add' appends one such step; 'update' transitions a step's status; 'view' shows the plan. Marking 'done' requires `signoff` (attesting verification was performed). Marking 'cancelled' or 'error' requires `note` (the reason). The plan is visible to the user.",
    parameters: z.object({
      action: z.enum(['create', 'update', 'add', 'view']).describe('The action to perform'),
      steps: z
        .array(stepInputSchema)
        .optional()
        .describe('Required for create: ordered list of {description, verification} objects.'),
      step: stepInputSchema.optional().describe('Required for add: a {description, verification} object.'),
      id: z.number().optional().describe('Required for update: step id'),
      status: z
        .enum(['pending', 'in_progress', 'done', 'cancelled', 'error'])
        .optional()
        .describe('Required for update: new status'),
      note: z
        .string()
        .optional()
        .describe(
          'Required when transitioning to cancelled or error: 1-2 sentences explaining why the step did not complete.',
        ),
      signoff: z
        .string()
        .optional()
        .describe(
          'Required when transitioning to done: a brief statement (1-2 sentences) attesting that the verification criterion was checked and passed. Cite the concrete evidence (command output, file contents, status code) — do not just restate the description.',
        ),
    }),
    execute: async ({ action, steps, step, id, status, note, signoff }): Promise<string> => {
      switch (action) {
        case 'create': {
          if (!steps || steps.length === 0) {
            return 'Error: steps is required for create action and must be non-empty.';
          }
          const created = planStore.create(steps);
          printIfChanged();
          return `Plan created with ${created.length} step${created.length === 1 ? '' : 's'}.`;
        }
        case 'add': {
          if (!step) return 'Error: step is required for add action ({description, verification}).';
          const added = planStore.add(step);
          printIfChanged();
          return `Step ${added.id} added.`;
        }
        case 'update': {
          if (id === undefined || !status) {
            return 'Error: id and status are required for update action.';
          }
          if (status === 'done' && !signoff) {
            return 'Error: signoff is required when marking a step done. Cite the verification evidence (command output, file contents, status code) — do not just restate the step description.';
          }
          if ((status === 'cancelled' || status === 'error') && !note) {
            return `Error: note is required when marking a step ${status}. Explain why the step did not complete in 1-2 sentences.`;
          }
          const updated = planStore.update(id, status, { note, signoff });
          if (!updated) return `Error: no step found with id ${id}.`;
          printIfChanged();
          return `Step ${id} -> ${status}.`;
        }
        case 'view': {
          const current = planStore.view();
          if (current.length === 0) return 'No plan in progress. Use create to start one.';
          printIfChanged();
          return `Plan: ${current.length} step${current.length === 1 ? '' : 's'}, ${planStore.unresolvedCount()} unresolved.`;
        }
        default:
          return `Unknown action: ${action}`;
      }
    },
  });
}
