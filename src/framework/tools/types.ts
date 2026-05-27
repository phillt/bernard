import type { z } from 'zod';

/**
 * Standard tool metadata. `name` is the registry key; `kind` enables capability
 * filtering (e.g. `byMetadata({kind: 'read'})` for the reference-resolver lookup
 * pass). `category` mirrors today's `classifyShellCommand` grouping for
 * tool-profile organization.
 */
export interface ToolMeta {
  name: string;
  kind: 'read' | 'write' | 'dangerous' | 'inert';
  category?: string;
}

export type ToolErrorType =
  | 'invalid_args'
  | 'exec_failed'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export interface ToolError {
  type: ToolErrorType;
  message: string;
  /** Short excerpt for tool-profile bad-example storage. */
  snippet?: string;
  /** Hint that another attempt is worth trying. */
  retryable?: boolean;
}

/**
 * Discriminated union the agent reads internally. `status` mirrors the shape
 * the codebase already uses in `tool_wrapper_run`.
 */
export type ToolResult<T> =
  | { status: 'ok'; result: T }
  | { status: 'error'; error: ToolError };

export function ok<T>(result: T): ToolResult<T> {
  return { status: 'ok', result };
}

export function err<T = never>(error: ToolError): ToolResult<T> {
  return { status: 'error', error };
}

/**
 * Type guard for the `ToolResult` envelope. Used by `augment.ts` to skip
 * heuristic error detection for migrated tools.
 */
export function isToolResult(value: unknown): value is ToolResult<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { status?: unknown };
  return v.status === 'ok' || v.status === 'error';
}

/**
 * Options passed to `execute`. Mirrors what the AI SDK supplies via its own
 * `ToolExecutionOptions`, narrowed to the fields tool implementations use.
 */
export interface ToolExecOptions {
  toolCallId?: string;
  abortSignal?: AbortSignal;
  messages?: unknown[];
}

/**
 * Native Bernard tool contract. `execute` returns the envelope; the AI SDK
 * never sees it directly — `serializeForModel` translates back to whatever
 * shape the tool has historically exposed to the model.
 */
export interface BernardTool<TArgs, TData> {
  meta: ToolMeta;
  description: string;
  parameters: z.ZodType<TArgs>;
  execute: (args: TArgs, opts: ToolExecOptions) => Promise<ToolResult<TData>>;
  serializeForModel: (result: ToolResult<TData>) => unknown;
}
