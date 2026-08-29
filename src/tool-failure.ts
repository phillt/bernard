import { classifyToolFailure, type Classification } from './error-taxonomy.js';
import { detectToolError } from './tool-profiles.js';
import type { ToolErrorType } from './framework/tools/types.js';

/**
 * The user-facing half of a classified tool failure.
 *
 * A failed call already renders red, so this is not about visibility — it is
 * the recovery advice. Before #353 the call site surfaced `playbook.model` (an
 * instruction addressed to the model) into the result the user reads, while
 * `playbook.user` — the line telling *them* what to do — was handed to a
 * `printToolFailure` stub and discarded.
 */
export interface ToolFailure {
  category: ToolErrorType;
  /** `Classification.playbook.user` — one-line recovery guidance. */
  hint: string;
  severity: Classification['severity'];
}

/**
 * Classifies a tool result, returning the user-facing failure or `undefined`
 * when it succeeded.
 *
 * A total, pure projection of a tool result — which is why the renderer derives
 * it rather than carrying it: unlike `StaticItem`'s other UI-only fields
 * (`rewriteOriginal` is known only at turn start, `timing`/`costUsd` only at
 * turn end), this is recoverable from the message alone. Caching it would mean
 * two producers — the live commit path and `buildResumeSeed`, which rebuilds
 * items from disk with no sink event to copy — and a drift bug between them.
 *
 * Its own module rather than the sink's: this is a classification question, not
 * a streaming one, and the view layer should not reach into `framework/hooks/`
 * to ask it.
 */
export function toolFailureFor(toolName: string, result: unknown): ToolFailure | undefined {
  const info = detectToolError(toolName, result);
  if (!info.isError) return undefined;
  const cls = classifyToolFailure({ snippet: info.snippet, toolName });
  return { category: cls.category, hint: cls.playbook.user, severity: cls.severity };
}
