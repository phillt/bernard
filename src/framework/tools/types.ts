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
  /**
   * For an MCP tool, the name the server itself exports it under (#413).
   *
   * `name` is the namespaced registry key, which at the truncation ladder's
   * last rung is not invertible and is lossy at every rung (`sanitize` rewrites
   * `.` to `_`). Consumers that need the tool's own name — the `/mcp` listing,
   * the tool-profile carry-forward — must read it from here rather than
   * re-deriving it from the key.
   */
  rawName?: string;
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
  /**
   * Per-call refinement of `kind` for tools whose write-ness depends on a
   * discriminator argument (e.g. `memory`/`scratch` with `action: 'read'`
   * vs `action: 'write'`). Returns `true` iff THIS specific invocation
   * mutates state. When set, the read-only block gate (#179) consults this
   * instead of the static `kind`; the confirmation gate (#144) likewise
   * downgrades to `low` risk when the predicate returns `false`. Unset
   * tools keep the static `kind`-based behavior.
   */
  isWriteAction?: (args: unknown) => boolean;
  /**
   * True when this tool dispatches on an `action` argument covering operations
   * of very different consequence (#253, #322). Profile permission grants then
   * key per action (`cron:delete`) and the breadth ladder offers "this action" /
   * "any action" instead of exact-args — so an "always allow" granted while
   * listing jobs cannot authorise deleting them.
   *
   * Declared here rather than in a name list kept elsewhere: the discriminator
   * is a tool-local fact, it is the same one {@link isWriteAction} already
   * refines on, and a separate list can disagree with the tool it describes.
   * `attachActionMeta` sets it, so any action-enum tool built that way is
   * covered by construction.
   *
   * Deliberately a flag rather than a configurable field NAME: the persisted
   * rule specifier format is literally `action:<value>` (minted in
   * `permissions/breadth.ts`, matched in `permissions/engine.ts`), so a tool
   * dispatching on some other field would mint grants the engine could never
   * match. The field name is fixed by the on-disk format.
   *
   * `routine` / `specialist` / `lineup_edit` have the same action shape but
   * deliberately do NOT declare it: users may hold stored rules keyed on the
   * bare name, and re-keying them would silently invalidate those. That needs
   * its own change, with a migration.
   */
  actionScoped?: boolean;
  /**
   * Optional post-write schema/state check (issue #145). Runs after the tool
   * returns `status: 'ok'` and contributes a structured `Check` to the turn's
   * rubric. Used for "did we mutate external state, and did we confirm it
   * post-write?" — e.g. `file_edit_lines` re-stats the path and compares its
   * hash to the declared `new_hash`. Return `null` to skip (not applicable
   * for this call). Synchronous; should be fast and side-effect-free.
   */
  verifyOutput?: (args: unknown, result: unknown) => VerifyOutcome | null;
}

/** Outcome of a `ToolMeta.verifyOutput` check. */
export interface VerifyOutcome {
  status: 'pass' | 'warn' | 'fail';
  evidence?: string;
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
  | 'step_limit'
  | 'cancelled'
  | 'denied'
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
