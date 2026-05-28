/**
 * Barrel for the framework's agent layer. Definitions are registered via
 * {@link registerBuiltinDefinitions}, called once from the CLI / REPL / cron
 * entry points (and from tests that need the singleton populated). This keeps
 * import-time side effects out of the framework so tests can construct their
 * own registries cleanly.
 *
 * Kind imports are added here incrementally as each migration lands.
 */
import { cronDefinition } from './cron.js';
import { mainAgentDefinition } from './main.js';
import { pacActorDefinition } from './pac-actor.js';
import { pacCriticDefinition } from './pac-critic.js';
import { pacPlannerDefinition } from './pac-planner.js';
import { definitions } from './registry.js';
import { specialistDefinition } from './specialist.js';
import { subAgentDefinition } from './sub.js';
import { taskDefinition } from './task.js';
import { toolWrapperDefinition } from './tool-wrapper.js';

export type { AgentDefinition, HistoryMode, ModelOverrides, ResolvedModel } from './types.js';
export { runDefinition } from './run.js';
export type { RunDefinitionOpts, RunDefinitionResult } from './run.js';
export { definitions, DefinitionRegistry } from './registry.js';
export {
  subAgentDefinition,
  type SubAgentInput,
  SUB_AGENT_SYSTEM_PROMPT,
  SUBAGENT_STEP_RATIO,
} from './sub.js';
export {
  taskDefinition,
  type TaskInput,
  type TaskResult,
  TaskResultSchema,
  TASK_SYSTEM_PROMPT,
  TASK_STEP_RATIO,
  getTaskMaxSteps,
  makeLastStepTextOnly,
  wrapTaskResult,
} from './task.js';
export {
  specialistDefinition,
  type SpecialistInput,
  SPECIALIST_STEP_RATIO,
  SPECIALIST_ENFORCEMENT_STEP_RATIO,
  SPECIALIST_EXECUTION_RULES,
} from './specialist.js';
export {
  toolWrapperDefinition,
  type ToolWrapperInput,
  TOOL_WRAPPER_STEP_RATIO,
  buildChildTools,
  formatExamples,
} from './tool-wrapper.js';
export { cronDefinition, type CronInput, DAEMON_SYSTEM_PROMPT } from './cron.js';
export { mainAgentDefinition, type MainInput } from './main.js';
export {
  pacPlannerDefinition,
  type PacPlannerInput,
  PAC_PLANNER_STEP_FRACTION,
  PAC_PLANNER_SYSTEM_PROMPT,
} from './pac-planner.js';
export {
  pacActorDefinition,
  type PacActorInput,
  PAC_ACTOR_STEP_FRACTION,
  PAC_ACTOR_SYSTEM_PROMPT,
} from './pac-actor.js';
export {
  pacCriticDefinition,
  type PacCriticInput,
  type PacCriticVerdict,
  PAC_CRITIC_STEP_FRACTION,
  PAC_CRITIC_SYSTEM_PROMPT,
} from './pac-critic.js';

/**
 * Idempotently registers all built-in agent definitions on the process-wide
 * {@link definitions} singleton. Safe to call multiple times — subsequent
 * calls are no-ops. Tests that need an isolated registry should construct a
 * fresh {@link DefinitionRegistry} instead.
 */
export function registerBuiltinDefinitions(): void {
  if (!definitions.has(mainAgentDefinition.id)) {
    definitions.register(mainAgentDefinition);
  }
  if (!definitions.has(subAgentDefinition.id)) {
    definitions.register(subAgentDefinition);
  }
  if (!definitions.has(pacPlannerDefinition.id)) {
    definitions.register(pacPlannerDefinition);
  }
  if (!definitions.has(pacActorDefinition.id)) {
    definitions.register(pacActorDefinition);
  }
  if (!definitions.has(pacCriticDefinition.id)) {
    definitions.register(pacCriticDefinition);
  }
  if (!definitions.has(taskDefinition.id)) {
    definitions.register(taskDefinition);
  }
  if (!definitions.has(specialistDefinition.id)) {
    definitions.register(specialistDefinition);
  }
  if (!definitions.has(toolWrapperDefinition.id)) {
    definitions.register(toolWrapperDefinition);
  }
  if (!definitions.has(cronDefinition.id)) {
    definitions.register(cronDefinition);
  }
}
