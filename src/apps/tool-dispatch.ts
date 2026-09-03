import type { Tool } from 'ai';
import type { z } from 'zod';
import { debugLog } from '../logger.js';
import { DEFAULT_SHELL_TIMEOUT, loadPreferences } from '../config.js';
import { createTools } from '../tools/index.js';
import { augmentTools } from '../tools/augment.js';
import { MemoryStore } from '../memory.js';
import { ToolProfileStore } from '../tool-profiles.js';
import { initShellParser } from '../permissions/shell-ast.js';
import { runWorkspace } from '../paths.js';
// The LEAF, not `../headless.js`. That module imports `MCPManager`, `RAGStore`
// and the agent-definition registry — 161 ms of module graph, on the one path
// whose whole premise is that it does not pay for an agent runtime.
import { headlessToolOptions, resolvePosture, type HeadlessPosture } from '../headless-posture.js';
import { loadAppGrants } from './app-grants.js';
import { directInvocableRefusal } from './direct-tool.js';
import { detectResultFailure } from '../tool-result-shape.js';
import { ARG_REF_PREFIX, formatZodError, type ToolDispatch } from './manifest.js';
import type { ResolvedInvocation } from './invocation.js';
import * as fs from 'node:fs';

/**
 * A `kind: 'tool'` action: one tool call, no model (#445).
 *
 * **Deliberately not `runHeadless`.** That function owns the whole
 * agent recipe — MCP connect (measured ~1.1–1.6 s), a RAG store, context
 * assembly, a dispatch loop — and a deterministic action needs none of it.
 * Paying an agent runtime's startup to move a file would give back most of
 * what skipping the model saved, and the point of this tier is that it costs
 * nothing.
 *
 * What it does keep is the part that matters: the registry goes through
 * {@link augmentTools}, so the deny gate, the write-scope gate and the confirm
 * gate all fire exactly as they do for an agent action. Skipping the model
 * must never mean skipping the gates.
 */

export type ToolActionResult =
  | { ok: true; result: unknown }
  /** The request was wrong — a bad manifest or unmappable args. Exit 2. */
  | { ok: false; kind: 'invalid'; message: string }
  /** The call ran and failed, or timed out. Exit 1. */
  | { ok: false; kind: 'failed'; message: string; timedOut: boolean };

/**
 * Resolves the manifest's parameter map against the validated call arguments.
 *
 * `$.<name>` reads a declared arg; anything else is a literal. An **absent**
 * optional arg drops the parameter rather than passing `undefined`, so a tool
 * sees the same shape a model would have produced.
 *
 * A reference to an undeclared arg cannot occur here — the manifest refinement
 * rejects it at parse time — so this maps rather than validates.
 */
export function mapToolArgs(
  dispatch: ToolDispatch,
  callArgs: Record<string, string | number | boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [param, value] of Object.entries(dispatch.args)) {
    if (typeof value === 'string' && value.startsWith(ARG_REF_PREFIX)) {
      const ref = value.slice(ARG_REF_PREFIX.length);
      if (!(ref in callArgs)) continue;
      out[param] = callArgs[ref];
    } else {
      out[param] = value;
    }
  }
  return out;
}

export interface DispatchToolActionOpts {
  invocation: ResolvedInvocation;
  dispatch: ToolDispatch;
  timeoutMs: number | null;
  abortSignal?: AbortSignal;
}

export async function dispatchToolAction(opts: DispatchToolActionOpts): Promise<ToolActionResult> {
  const { invocation, dispatch, timeoutMs } = opts;
  const { action, appId } = invocation;

  const posture = resolvePosture({
    toolMode: action.toolMode,
    confirmMode: action.confirmMode,
    // The same per-app workspace an agent action gets. A deterministic action
    // is the LESS trusted writer of the two — no model to notice an odd path,
    // and the caller supplies the arguments — so it is scoped identically.
    writeScope: { workspace: runWorkspace('apps', appId) },
    toolPermissions: loadAppGrants(appId),
  });
  if (posture.toolPermissions?.length) await initShellParser();
  try {
    fs.mkdirSync(posture.writeScope!.workspace, { recursive: true });
  } catch {
    // A tool that needs it will fail with a real filesystem error, which says
    // more than anything this could report.
  }

  // Deliberately NOT `loadConfig()`, which calls `validateConfig` and throws
  // when no provider API key is configured. A `kind: 'tool'` action makes no
  // model call, so demanding a key would be an agent-shaped requirement on the
  // one path that has nothing to do with an agent — the same property
  // `bernard voice-test` holds. The single value needed is a shell timeout,
  // and nothing directly invocable runs a shell.
  const registry = await buildRegistry(shellTimeout(), posture);
  const tool = registry[dispatch.tool];

  const refusal = directInvocableRefusal(dispatch.tool, tool);
  if (refusal) return { ok: false, kind: 'invalid', message: refusal };

  const mapped = mapToolArgs(dispatch, invocation.frozenArgs);

  // **Nothing else validates these.** Inside an agent loop the AI SDK parses a
  // tool call against `parameters` before `execute` ever runs; a direct call
  // skips that entirely, so a missing required field would reach the tool as
  // `undefined` and a wrong type would reach it as itself.
  const parsed = (
    tool as unknown as {
      parameters: {
        safeParse: (v: unknown) => { success: boolean; error?: unknown; data?: unknown };
      };
    }
  ).parameters.safeParse(mapped);
  if (!parsed.success) {
    return {
      ok: false,
      kind: 'invalid',
      message: `Arguments for "${dispatch.tool}" are not valid: ${formatZodError(parsed.error as z.ZodError)}`,
    };
  }

  debugLog('script:tool-dispatch', {
    appId,
    action: invocation.actionName,
    tool: dispatch.tool,
    // Parameter names only, never their values.
    params: Object.keys(mapped),
  });

  const signal = deadlineSignal(timeoutMs, opts.abortSignal);
  try {
    const raw: unknown = await (
      tool as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }
    ).execute(parsed.data, {
      toolCallId: `app-${appId}-${invocation.actionName}`,
      abortSignal: signal,
      messages: [],
    });
    // A tool fails in two ways: it throws, or it RETURNS a value whose
    // contents say the work did not happen (#363). Both of a direct call's
    // refusals are the second kind — the deny and write-scope gates return an
    // `Error: `-prefixed string rather than throwing — so without this a
    // refused action reports `ok: true` with the refusal as its result and the
    // caller reads a denial as a success. `detectResultFailure` is the one
    // shape-based answer the rest of Bernard already uses.
    const failure = detectResultFailure(raw);
    if (failure !== undefined) {
      return { ok: false, kind: 'failed', message: failure, timedOut: false };
    }
    return { ok: true, result: raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'failed', message, timedOut: signal?.aborted === true };
  }
}

/**
 * The augmented registry a tool action runs against.
 *
 * `surface: 'worker'` as a literal, matching `buildActionTools` and for the
 * same reason: the external path must not inherit whatever a definition
 * declares for its user-facing use. There is no MCP bag — an MCP tool arrives
 * pre-wrapped with a JSON Schema rather than a zod schema, so it could not be
 * arg-checked here even if it were eligible.
 *
 * `headlessToolOptions` is shared with `runHeadless` rather than restated. Its
 * security property is what it OMITS — no `blockAction`, so `augmentTools`
 * auto-denies a write under `read-only` — and an omission cannot be
 * type-checked, so a second hand-written copy is how one of them quietly grows
 * the field and stops failing closed.
 */
async function buildRegistry(
  shellTimeoutMs: number,
  posture: HeadlessPosture,
): Promise<Record<string, Tool>> {
  const toolOptions = headlessToolOptions(posture, shellTimeoutMs);
  const base = await createTools(
    toolOptions,
    new MemoryStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { surface: 'worker' },
  );
  return augmentTools(base as never, {
    profileStore: new ToolProfileStore({ seed: false }),
    toolMode: posture.toolMode,
    confirmThreshold: posture.confirmThreshold,
    ...toolOptions,
  }) as unknown as Record<string, Tool>;
}

/** Composes the action's wall clock with the caller's own signal. */
function deadlineSignal(timeoutMs: number | null, caller?: AbortSignal): AbortSignal | undefined {
  if (timeoutMs === null || timeoutMs <= 0) return caller;
  const timer = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timer]) : timer;
}

/**
 * The shell timeout `createTools` requires.
 *
 * No directly-invocable tool can run a shell, so this never bounds anything
 * here — but it is resolved the way the REPL resolves it rather than hardcoded,
 * so the number cannot quietly disagree with the user's own setting.
 * `loadPreferences` rather than `loadConfig`, for the reason at the call site.
 */
function shellTimeout(): number {
  return loadPreferences().shellTimeout ?? DEFAULT_SHELL_TIMEOUT;
}
