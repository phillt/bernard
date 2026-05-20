import { dispatchToolWrapper, type ToolWrapperDeps } from './tool-wrapper-run.js';
import { debugLog } from '../logger.js';

/**
 * Builds the natural-language input handed to a wrapper specialist when the
 * shim forwards a direct tool call. The wrapper sees the original tool name
 * and its arguments verbatim so it can validate, transform, or pass through.
 */
export function buildShimInput(toolName: string, args: unknown): string {
  let argsJson: string;
  try {
    argsJson = JSON.stringify(args, null, 2);
  } catch {
    argsJson = String(args);
  }
  return `The main agent issued a direct call to the \`${toolName}\` tool with these arguments:

\`\`\`json
${argsJson}
\`\`\`

Execute this tool call (or a safer/equivalent variant if you spot a clear problem) and return the structured JSON output. Keep your \`result\` field tight — the parent agent only sees \`result\` and any \`error\`, never your \`reasoning\` array.`;
}

/**
 * Formats a wrapper's structured result into a string suitable for return
 * from a regular tool's `execute` — i.e. what the main agent will see in its
 * tool-result message. On success, returns the `result` field directly
 * (stringifying non-string values). On error, prefixes with `Error:` so the
 * model treats it like any other tool error.
 */
export function formatWrappedResult(wrapped: {
  status: 'ok' | 'error';
  result: unknown;
  error?: string;
}): string {
  if (wrapped.status === 'ok') {
    return typeof wrapped.result === 'string' ? wrapped.result : JSON.stringify(wrapped.result);
  }
  const body = typeof wrapped.result === 'string' ? wrapped.result : JSON.stringify(wrapped.result);
  return wrapped.error ? `Error (${wrapped.error}): ${body}` : `Error: ${body}`;
}

/**
 * Wraps a base tool so that, when the corresponding wrapper specialist is
 * registered, the model's call is transparently routed through
 * {@link dispatchToolWrapper}. The model sees the same name, description, and
 * schema — only the execution path changes.
 *
 * When the specialist is absent (or its kind is wrong, etc.), the shim falls
 * through to the base tool's `execute` so behavior degrades gracefully.
 *
 * Only the wrapper's `result` (or `error` message) crosses back to the parent
 * agent; the wrapper's `reasoning` array is logged separately and never enters
 * the parent's context.
 */
export function wrapToolWithSpecialist<TArgs, TResult>(
  baseTool: any,
  toolName: string,
  specialistId: string,
  deps: ToolWrapperDeps,
): any {
  const baseExecute = baseTool.execute;
  if (typeof baseExecute !== 'function') {
    return baseTool;
  }

  return {
    ...baseTool,
    execute: async (args: TArgs, execOptions: any): Promise<TResult | string> => {
      const specialist = deps.specialistStore.get(specialistId);
      if (!specialist) {
        return baseExecute(args, execOptions);
      }
      const kind = specialist.kind ?? 'persona';
      if (kind !== 'tool-wrapper') {
        // Not the right kind for shim routing — let the raw tool handle it.
        return baseExecute(args, execOptions);
      }

      try {
        const wrapped = await dispatchToolWrapper(
          {
            specialistId,
            input: buildShimInput(toolName, args),
            abortSignal: execOptions?.abortSignal,
            runLabel: `[shim] ${toolName} → ${specialist.name}`,
          },
          deps,
        );
        return formatWrappedResult(wrapped) as TResult | string;
      } catch (err) {
        // Defensive: if the dispatch itself throws, fall back to the raw tool
        // rather than killing the turn.
        debugLog(
          `wrap-with-specialist:${toolName}:dispatch-error`,
          err instanceof Error ? err.message : String(err),
        );
        return baseExecute(args, execOptions);
      }
    },
  };
}

/**
 * The default routing table mapping low-level tool names to their wrapper
 * specialist IDs. Used by the main agent to auto-route raw calls.
 */
export const DEFAULT_SHIM_ROUTING: Record<string, string> = {
  shell: 'shell-wrapper',
  web_read: 'web-wrapper',
  file_read_lines: 'file-wrapper',
  file_edit_lines: 'file-wrapper',
};

/**
 * Applies {@link wrapToolWithSpecialist} to every tool name in the given
 * routing table. Tools not present in the registry are skipped silently.
 *
 * Routing is only applied on the main agent — sub-agents, specialists, and
 * the wrapper specialists themselves keep their raw tools to avoid recursion.
 */
export function applyShimRouting(
  tools: Record<string, any>,
  deps: ToolWrapperDeps,
  routing: Record<string, string> = DEFAULT_SHIM_ROUTING,
): Record<string, any> {
  const out: Record<string, any> = { ...tools };
  for (const [toolName, specialistId] of Object.entries(routing)) {
    if (!out[toolName]) continue;
    out[toolName] = wrapToolWithSpecialist(out[toolName], toolName, specialistId, deps);
  }
  return out;
}
