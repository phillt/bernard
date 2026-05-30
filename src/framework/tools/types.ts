import type { z } from 'zod';

/**
 * Side-effect classification for a tool invocation. Used together with
 * `deterministic` to decide whether a tool's results are safe to cache.
 *
 * - `none`         — pure computation, no observable side effects.
 * - `local`        — affects local filesystem, in-process state, or local services.
 * - `network`      — issues network requests, but only to fetch data.
 * - `external-api` — mutates state on a third-party service.
 */
export type ToolSideEffect = 'none' | 'local' | 'network' | 'external-api';

/**
 * Coarse risk tier for a tool, used by the unified confirmation gate
 * (issue #144). Defined here (rather than in `src/risk.ts`) so `ToolMeta`
 * doesn't pull in the larger risk-classification module — keep the type
 * itself near the metadata that carries it.
 */
export type ToolRisk = 'low' | 'medium' | 'high';

/**
 * Standard tool metadata. `name` is the registry key; `kind` enables capability
 * filtering (e.g. `byMetadata({kind: 'read'})` for the reference-resolver lookup
 * pass). `category` mirrors today's `classifyShellCommand` grouping for
 * tool-profile organization.
 *
 * The remaining fields classify a tool by determinism, side effects, and
 * sensitivity. They are all optional so legacy declarations continue to
 * compile; the meta-coverage test enforces presence at runtime.
 */
export interface ToolMeta {
  name: string;
  kind: 'read' | 'write' | 'dangerous' | 'inert';
  category?: string;
  /** Same args always produce the same result. Required for caching. */
  deterministic?: boolean;
  /** What the tool touches when it runs. */
  sideEffect?: ToolSideEffect;
  /** Explicit opt-in for caching when sideEffect != 'none'. */
  cacheable?: boolean;
  /** Cache TTL in ms. 0 = indefinite. Defaults to 5 minutes when omitted. */
  cacheTtlMs?: number;
  /** Argument field names whose values should be redacted in logs/cache keys. */
  sensitiveArgs?: string[];
  /** When true, the tool's result is redacted in logs. */
  sensitiveResult?: boolean;
  /**
   * Explicit override for the risk tier used by the confirmation gate
   * (issue #144). When unset, `riskFromMeta` derives the tier from
   * `kind` + `sideEffect`. Tools that don't fit the default mapping (a
   * read-style tool with `external-api` side effects that's actually safe,
   * or a `write` tool that's exceptionally destructive) can declare here.
   */
  risk?: ToolRisk;
}

/**
 * A tool is cacheable iff it is deterministic AND either has no side effects
 * or was explicitly opted in via `cacheable: true`.
 */
export function isCacheable(meta: ToolMeta): boolean {
  return meta.deterministic === true && (meta.sideEffect === 'none' || meta.cacheable === true);
}

/**
 * Failure taxonomy for tool calls. `invalid_args` and `exec_failed` are
 * call-shape mistakes the model can learn from (and feed the correction
 * loop); the rest are environmental / irreducible and are excluded from
 * learning by `error-taxonomy.ts`. `not_found` is context-dependent —
 * shell "command not found" is learnable; HTTP 404 is not.
 */
export type ToolErrorType =
  | 'invalid_args'
  | 'exec_failed'
  | 'not_found'
  | 'auth'
  | 'rate_limit'
  | 'permission'
  | 'timeout'
  | 'transient'
  | 'parse_failed'
  | 'pool_exhausted'
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
export type ToolResult<T> = { status: 'ok'; result: T } | { status: 'error'; error: ToolError };

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
