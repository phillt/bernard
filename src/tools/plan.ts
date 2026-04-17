import { tool } from 'ai';
import { z } from 'zod';
import type { PlanStore } from '../plan-store.js';
import { printPlan } from '../output.js';

/**
 * Creates the `plan` tool for coordinator (ReAct) mode.
 *
 * The main agent uses this to expose a structured, visible todo list with a
 * status lifecycle: pending → in_progress → done/cancelled/error. Each action
 * prints the updated plan to the user.
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
      "Track and manage a structured plan for the current turn. Required in coordinator mode. Actions: 'create' seeds a new plan (pass `steps` — an array of step descriptions), 'add' appends a step, 'update' transitions a step's status (pending -> in_progress -> done/cancelled/error), 'view' shows the current plan. Mark a step 'cancelled' when the user pivots or the step becomes unnecessary; mark it 'error' when the step is genuinely unachievable. Always pass `note` explaining the reason for cancelled/error. The plan is visible to the user — use it to show your intended work before acting.",
    parameters: z.object({
      action: z.enum(['create', 'update', 'add', 'view']).describe('The action to perform'),
      steps: z
        .array(z.string())
        .optional()
        .describe('Required for create: ordered list of step descriptions'),
      step: z.string().optional().describe('Required for add: description of the new step'),
      id: z.number().optional().describe('Required for update: step id'),
      status: z
        .enum(['pending', 'in_progress', 'done', 'cancelled', 'error'])
        .optional()
        .describe('Required for update: new status'),
      note: z
        .string()
        .optional()
        .describe(
          'Required when transitioning to a terminal status (done/cancelled/error). For done: summarize what was accomplished and the key result. For cancelled/error: explain why. Keep to 1-2 sentences.',
        ),
    }),
    execute: async ({ action, steps, step, id, status, note }): Promise<string> => {
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
          if (!step) return 'Error: step is required for add action.';
          const added = planStore.add(step);
          printIfChanged();
          return `Step ${added.id} added.`;
        }
        case 'update': {
          if (id === undefined || !status) {
            return 'Error: id and status are required for update action.';
          }
          if ((status === 'done' || status === 'cancelled' || status === 'error') && !note) {
            return `Error: note is required when marking a step ${status}. Summarize what was accomplished (done) or why it could not be (cancelled/error) in 1-2 sentences.`;
          }
          const updated = planStore.update(id, status, note);
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
