/**
 * Framework-surface alias for {@link makeRepairHook}. Brings the repair
 * factory into the `src/framework/hooks/` namespace so callers can import
 * everything they need to build an {@link AgentSpec} from one place.
 *
 * Not an {@link AgentHook} — the AI SDK accepts at most one
 * `experimental_repairToolCall` function; it sits in `spec.repair`, not in
 * the hook chain. Modeling it as a composable observer would mislead callers
 * into stacking incompatible repair strategies.
 */
export { makeRepairHook as repairHook } from '../../tool-call-repair.js';
export type { MakeRepairHookOpts, RepairLabel } from '../../tool-call-repair.js';
