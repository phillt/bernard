import { dispatchToolWrapper } from './tool-wrapper-run.js';
import type { AgentContext } from '../framework/context.js';
import { debugLog } from '../logger.js';
import { preserveMeta } from '../framework/tools/adapter.js';
import { failureMarker, classifyError } from '../error-taxonomy.js';

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
 * Formats a wrapper's structured result so the main agent — and the
 * tool-augmentation layer's `detectToolError` — observe the *native* tool
 * return shape, just as if the shim had been bypassed.
 *
 * - On `status: 'ok'`, returns `wrapped.result` as-is (no JSON-stringifying
 *   structured payloads), so e.g. `shell`'s `{ output, is_error }` and
 *   `file_*`'s `{ ... }` propagate unchanged.
 * - On `status: 'error'`, maps the wrapper error to the *same shape* the
 *   native tool would have produced for an error:
 *     - `shell` → `{ output: 'Error (...): ...', is_error: true }`
 *     - `file_read_lines` / `file_edit_lines` / `file_write` → `{ error: '...' }`
 *     - everything else (web_*, MCP, generic) → `'Error (...): ...'` string
 *   This keeps `detectToolError` and tool-profile learning working whether or
 *   not the shim is active.
 */
export function formatWrappedResult(
  wrapped: { status: 'ok' | 'error'; result: unknown; error?: string },
  toolName?: string,
): unknown {
  if (wrapped.status === 'ok') {
    return wrapped.result;
  }
  const body = typeof wrapped.result === 'string' ? wrapped.result : JSON.stringify(wrapped.result);
  const message = wrapped.error ? `Error (${wrapped.error}): ${body}` : `Error: ${body}`;

  if (toolName === 'shell') {
    return { output: message, is_error: true };
  }
  if (
    toolName === 'file_read_lines' ||
    toolName === 'file_edit_lines' ||
    toolName === 'file_write'
  ) {
    return { error: message };
  }
  return message;
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
export function wrapToolWithSpecialist<TArgs>(
  baseTool: any,
  toolName: string,
  specialistId: string,
  ctx: AgentContext,
): any {
  const baseExecute = baseTool.execute;
  if (typeof baseExecute !== 'function') {
    return baseTool;
  }

  const shim = {
    ...baseTool,
    execute: async (args: TArgs, execOptions: any): Promise<unknown> => {
      const specialist = ctx.stores.specialists.get(specialistId);
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
          ctx,
        );
        if (wrapped.status === 'error') {
          // Use the same fallback for display that the classifier consumes, so
          // wrappers that report the diagnostic via `result` (parse_failed
          // paths etc.) still surface a usable snippet to the user instead of
          // an empty line. PR #189 review feedback.
          const snippet = wrapped.error ?? String(wrapped.result ?? '');
          const cls = classifyError({ message: snippet, toolName });
          // The user-facing half (`playbook.user`) is rendered by the Ink
          // thread from the sink's `tool-result.failure`, built centrally in
          // `output-sink.ts` — which covers every tool, not just the shimmed
          // ones. This site only stamps the marker so the category survives
          // into that classification (#353).
          // Prepend a one-line model-facing hint so the next turn's
          // tool-result message carries category + recovery guidance.
          // augment.ts strips this `[failure: ...]` prefix before recording
          // bad examples so the hint doesn't pollute the tool-profile bytes.
          const hint = `${failureMarker(cls.category)} ${cls.playbook.model}`;
          const annotated = {
            ...wrapped,
            error: wrapped.error ? `${hint}\n${wrapped.error}` : hint,
          };
          return formatWrappedResult(annotated, toolName);
        }
        return formatWrappedResult(wrapped, toolName);
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
  // Object spread drops the non-enumerable `__bernardMeta` from baseTool —
  // copy it onto the shim so downstream readers still see the tool's class.
  return preserveMeta(shim, baseTool);
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
  ctx: AgentContext,
  routing: Record<string, string> = DEFAULT_SHIM_ROUTING,
): Record<string, any> {
  const out: Record<string, any> = { ...tools };
  for (const [toolName, specialistId] of Object.entries(routing)) {
    if (!out[toolName]) continue;
    out[toolName] = wrapToolWithSpecialist(out[toolName], toolName, specialistId, ctx);
  }
  return out;
}
