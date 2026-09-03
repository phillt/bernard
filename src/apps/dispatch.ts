import type { Tool } from 'ai';
import { createTools } from '../tools/index.js';
import type { AgentContext } from '../framework/context.js';
import { buildChildTools, type ToolWrapperInput } from '../framework/agents/index.js';
import { definitions } from '../framework/agents/index.js';
import { runHeadless, resolvePosture, type RunHeadlessResult } from '../headless.js';
import type { WrapperResult } from '../structured-output.js';
import { loadAppGrants } from './app-grants.js';
import { runWorkspace } from '../paths.js';
import type { AppAction } from './manifest.js';
import { renderArgsBlock, type ResolvedInvocation } from './invocation.js';

/**
 * Builds the tool registry one action's agent runs against.
 *
 * The **intersection** of the action's `toolAllowlist` and the specialist's own
 * `targetTools`: an action can narrow what the specialist already targets and
 * can never widen it, so a typo in a manifest grants nothing. `buildChildTools`
 * returns `{}` when nothing matches (#331) — a misconfigured allowlist fails
 * visibly rather than silently inheriting.
 *
 * Two deliberate differences from `dispatchToolWrapper`'s registry assembly
 * (`src/tools/tool-wrapper-run.ts`), recorded so nobody reconciles them:
 *
 *  - That one folds `agent` / `task` / `specialist_run` / `tool_wrapper_run`
 *    in before filtering, because a user-invoked wrapper may legitimately
 *    delegate. An externally-invoked action may not — handing a caller a door
 *    into unbounded sub-dispatch is the opposite of a closed action registry.
 *  - That one passes `toolWrapperDefinition.toolSurface` (`'full'`). Here the
 *    surface is pinned to `'worker'` as a literal, so `mcp_config`,
 *    `specialist`, `lineup_edit` and the cron family are never *constructed*.
 *    A literal rather than the resolved value precisely because the external
 *    path must not inherit whatever the definition declares for its
 *    user-facing use.
 */
export function buildActionTools(
  ctx: AgentContext,
  action: AppAction,
  specialistTargetTools: string[] | undefined,
): Record<string, Tool> {
  const base = createTools(
    ctx.toolOptions,
    ctx.stores.memory,
    // The raw MCP bag, not the delegation surface: `buildChildTools` filters by
    // real MCP tool names, which per-server delegates would make unresolvable.
    ctx.mcp.tools,
    undefined,
    undefined,
    undefined,
    undefined,
    ctx.provenance,
    { surface: 'worker' },
  );
  const targets = specialistTargetTools ?? [];
  const granted = action.toolAllowlist.filter((t) => targets.includes(t));
  return buildChildTools({ targetTools: granted }, base, ctx.mcp.resolveAlias);
}

export interface DispatchActionOpts {
  invocation: ResolvedInvocation;
  /** Effective wall clock, already floored against the action's own. */
  timeoutMs: number | null;
  log: (msg: string) => void;
  /** Correlation id the caller persists in its own records. */
  runId: string;
  abortSignal?: AbortSignal;
}

export type DispatchActionResult = RunHeadlessResult<WrapperResult>;

/**
 * Runs one resolved action headlessly.
 *
 * Dispatches `toolWrapperDefinition` through {@link runHeadless} rather than
 * through `dispatchToolWrapper`, deliberately. That path takes an agent-pool
 * slot, appends to the reasoning log, and — the reason it is disqualified —
 * enqueues correction candidates on failure. An external caller's failed
 * invocation must not shape a local specialist's few-shot examples; the
 * correction queue was designed for the user's own mistakes, not an
 * adversarial caller's.
 */
export async function dispatchAction(opts: DispatchActionOpts): Promise<DispatchActionResult> {
  const { invocation, timeoutMs, log, runId, abortSignal } = opts;
  const { action, frozenArgs } = invocation;

  return runHeadless<ToolWrapperInput, WrapperResult>({
    definition: () => definitions.get<ToolWrapperInput, WrapperResult>('tool-wrapper'),
    posture: resolvePosture({
      toolMode: action.toolMode,
      confirmMode: action.confirmMode,
      // Path-scoped writes (#340). An applet action is the LESS trusted
      // unattended writer — triggered from a browser, with a caller supplying
      // the arguments — so it gets a per-app workspace and nothing else.
      // Stated rather than omitted: `HeadlessPostureInput.writeScope` is
      // required precisely because the first cut of this omitted it and an
      // action whose specialist targets `file_write` could write anywhere.
      // Per-app grants beyond the workspace belong to #420's grant record.
      writeScope: { workspace: runWorkspace('apps', invocation.appId) },
      // Persisted per-app grants (#420), read fresh on every dispatch so a
      // revocation applies to the next invocation with no restart. **The
      // app's own rules, never `config.toolPermissions`** — an app inheriting
      // the user's "always allow" grants is the confused-deputy widening the
      // capability design exists to prevent. See `src/apps/app-grants.ts`.
      toolPermissions: loadAppGrants(invocation.appId),
      // `skipPermissions` is deliberately not passed, and deliberately not
      // reachable: `AppActionSchema` is `.strict()`, so a manifest declaring
      // the key is REJECTED at parse time rather than ignored. An app cannot
      // declare itself exempt from the safeguards — only a cron job, whose
      // record the user wrote, can.
    }),
    // No retrieval: an action is a bounded, declared operation, and injecting
    // the user's recalled memory into it would widen what an external caller
    // can reach without anything in the manifest saying so. Omitting the query
    // also means `runHeadless` never constructs the RAG store at all.
    timeoutMs,
    log,
    runId,
    abortSignal,
    debugLabel: 'script',
    buildInput: (env) => {
      const specialist = env.ctx.stores.specialists.get(action.specialistId);
      const childTools = buildActionTools(env.ctx, action, specialist?.targetTools);
      return {
        specialistId: action.specialistId,
        // The instruction channel: author-written, never caller bytes.
        input: action.instructions,
        // The data channel.
        context: renderArgsBlock(frozenArgs),
        slotId: 0,
        childTools,
        wantStructured: specialist?.structuredOutput ?? true,
      };
    },
  });
}
