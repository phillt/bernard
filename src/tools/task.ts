import { z } from 'zod';
import { attachmentsArg, resolveAttachments } from './attachment-args.js';
import { resolveProviderAndModel } from '../config.js';
import { printTaskStart, printTaskEnd } from '../output.js';
import type { AgentContext } from '../framework/context.js';
import type { BernardTool, ToolResult } from '../framework/tools/types.js';
import { ok, err } from '../framework/tools/types.js';
import {
  definitions,
  registerBuiltinDefinitions,
  taskDefinition,
  type TaskInput,
  type TaskResult,
} from '../framework/agents/index.js';
import { runDefinition } from '../framework/agents/run.js';
import { withSlot, getMaxConcurrentAgents } from './agent-pool.js';
import { runDispatchOrFail } from './dispatch-failure.js';

// Re-export helpers + types that other modules (repl.ts, sub.ts, tests) already
// import from this path. The implementations live in `framework/agents/task.ts`.
export {
  TASK_SYSTEM_PROMPT,
  TASK_STEP_RATIO,
  TaskResultSchema,
  getTaskMaxSteps,
  makeLastStepTextOnly,
  wrapTaskResult,
} from '../framework/agents/task.js';
export type { TaskResult } from '../framework/agents/task.js';

/**
 * Internal payload carried inside the {@link ToolResult} envelope. The
 * model-facing serializer reshapes this into the historical
 * `{status: 'success'|'error', output, details?}` JSON.
 *
 * Important: the task tool returns an `ok` envelope even when `innerStatus`
 * is `'error'`. That distinction (the *task* reported failure vs. the *tool*
 * itself failed to run) keeps tool-execution errors (slot exhausted, API
 * failure) on the envelope-error path while preserving today's full bytes
 * (`{status:"error",output:...,details:...}`) for the model.
 */
export interface TaskPayload {
  innerStatus: 'success' | 'error';
  output: any;
  details?: string;
}

const TASK_PARAMETERS = z
  .object({
    task: z
      .string()
      .optional()
      .describe(
        'A self-contained task description. Include specific objective, expected output, exact file paths or commands, and success criteria. The task executor has zero prior context.',
      ),
    taskId: z
      .string()
      .optional()
      .describe(
        'ID of a saved task (task-prefixed routine) to execute. Loads stored task content as the primary description.',
      ),
    context: z.string().optional().describe('Optional additional context for the task'),
    attachments: attachmentsArg,

    provider: z
      .string()
      .optional()
      .describe(
        'Optional provider override for this task (e.g. "xai"). Falls back to global config.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Optional model override for this task (e.g. "grok-code-fast-1"). Falls back to global config.',
      ),
  })
  .refine((data) => data.task || data.taskId, {
    message: 'Either task or taskId must be provided',
  });

type TaskArgs = z.infer<typeof TASK_PARAMETERS>;

/**
 * Serializes a task envelope back to the historical JSON bytes the model has
 * seen since the tool was introduced: `{"status":"success"|"error","output":...,"details"?:...}`.
 * The envelope is internal-only; the model never sees `{status:"ok",result:{...}}`.
 */
function serializeTaskForModel(r: ToolResult<TaskPayload>): string {
  if (r.status === 'ok') {
    const { innerStatus, output, details } = r.result;
    return JSON.stringify(
      details !== undefined
        ? { status: innerStatus, output, details }
        : { status: innerStatus, output },
    );
  }
  return JSON.stringify({ status: 'error', output: r.error.message });
}

/**
 * Creates the task execution tool for focused, isolated sub-tasks with
 * structured JSON output.
 *
 * The dispatch wrapper here owns three things no generic dispatch factory
 * could: the saved-task lookup via `routineStore.get(taskId)` (which can
 * short-circuit with a friendly error before any LLM call), the
 * concurrency-pool slot dance (slot id is also the log prefix), and the
 * start/end terminal markers. Everything else — system prompt, tool set, step
 * budget, `prepareStep`, hook chain, JSON wrapping — lives on `taskDefinition`
 * and is exercised through `runDefinition`. What IS shared across the five
 * dispatch boundaries is the catch, and that lives in `runDispatchOrFail`
 * (#351); the abandoned `createDispatchTool` factory it replaces is gone.
 */
export function createTaskTool(ctx: AgentContext): BernardTool<TaskArgs, TaskPayload> {
  registerBuiltinDefinitions();
  const { config } = ctx;
  const routineStore = ctx.stores.routines;
  return {
    meta: { name: 'task', kind: 'read' },
    description:
      'Execute a focused, isolated task with structured JSON output {status, output, details?}. Tasks have no conversation history and a limited step budget. Use when you need a discrete, machine-readable result — especially during routine execution for chaining outcomes.',
    parameters: TASK_PARAMETERS,
    execute: async ({ task, taskId, context, attachments, provider, model }, execOptions) => {
      const loaded = resolveAttachments(attachments);
      // `task` answers in a `ToolResult` envelope, not a prefixed string —
      // each of the four dispatch tools reports a bad path in its own contract.
      if (!loaded.ok) return err({ type: 'invalid_args', message: loaded.error });
      const resolution = resolveProviderAndModel({ provider, model, config });
      if (!resolution.ok) {
        const envHint = resolution.isCustom ? '' : ` or set ${resolution.envVar}`;
        return err({
          type: 'invalid_args',
          message: `No API key found for provider "${resolution.provider}". Run: bernard add-key ${resolution.provider} <your-api-key>${envHint}.`,
        });
      }

      // Resolve saved task content if taskId is provided (before acquiring slot)
      let resolvedTask = task ?? '';
      if (taskId) {
        if (!routineStore) {
          return err({
            type: 'invalid_args',
            message: 'taskId provided but routine store is not available.',
          });
        }
        const routine = routineStore.get(taskId);
        if (routine) {
          resolvedTask = routine.content;
          if (task && task !== taskId) {
            resolvedTask += `\n\nAdditional context: ${task}`;
          }
        } else {
          return err({ type: 'invalid_args', message: `Saved task "${taskId}" not found.` });
        }
      }

      return withSlot(
        async (slot) => {
          const id = slot.id;
          printTaskStart(resolvedTask);

          // A cancelled dispatch unwinds; a failed one is a tool result (#327,
          // #351 — the try/catch/re-throw is `runDispatchOrFail`'s). Unlike the
          // three string-returning siblings this one owes the model a
          // `ToolResult` envelope, which is why the shaper is a callback.
          return runDispatchOrFail(
            async () => {
              const def = definitions.get<TaskInput, TaskResult>('task');
              const input: TaskInput = {
                task: resolvedTask,
                ...(context ? { context } : {}),
                attachments: loaded.read(),
                slotId: id,
              };
              const { formatted: taskResult } = await runDefinition(ctx, def, input, {
                abortSignal: execOptions.abortSignal,
                // Forward only the user-supplied provider/model so resolveSiteModel
                // can fall through to the modelMode tier table when neither is set.
                overrides: { provider, model },
              });

              const envelope = ok<TaskPayload>(
                taskResult.details !== undefined
                  ? {
                      innerStatus: taskResult.status,
                      output: taskResult.output,
                      details: taskResult.details,
                    }
                  : { innerStatus: taskResult.status, output: taskResult.output },
              );
              printTaskEnd(serializeTaskForModel(envelope));
              return envelope;
            },
            (message) => {
              const errEnvelope = err<TaskPayload>({ type: 'exec_failed', message });
              // The end marker carries the envelope, so it can only be written
              // once the failure has been shaped — it stays off the cancellation
              // path here exactly as it was before.
              printTaskEnd(serializeTaskForModel(errEnvelope));
              return errEnvelope;
            },
          );
        },
        () =>
          err<TaskPayload>({
            type: 'exec_failed',
            message: `Maximum concurrent agents (${getMaxConcurrentAgents()}) reached. Wait for existing agents to finish.`,
          }),
      );
    },
    serializeForModel: serializeTaskForModel,
  };
}

// `taskDefinition` is intentionally re-exported in case future code (or tests)
// wants direct access to the definition record.
export { taskDefinition };
