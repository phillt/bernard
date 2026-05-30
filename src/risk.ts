import type { ToolMeta, ToolRisk } from './framework/tools/types.js';

/**
 * Coarse risk tier for a tool invocation. Drives the unified confirmation
 * gate (issue #144).
 *
 * - `low`    — read-only or no-op work. Never prompts.
 * - `medium` — local writes, in-process mutations, unclassified MCP tools.
 * - `high`   — destructive shell, external-API mutations, irreversible writes.
 *
 * Alias of {@link ToolRisk} which lives next to `ToolMeta` so the metadata
 * doesn't import the risk module.
 */
export type RiskLevel = ToolRisk;

/**
 * Per-turn confirmation threshold emitted by the Policy Engine. The augment
 * layer compares each tool call's {@link RiskLevel} against this threshold:
 *
 * - `never`  — never confirm (e.g. pure-question turns or `confirmMode: 'off'`)
 * - `high`   — confirm only `high`-risk calls (`confirmMode: 'auto'`)
 * - `medium` — confirm `medium` and `high` calls (`confirmMode: 'strict'`)
 * - `always` — confirm every call (reserved; not surfaced as a config mode today)
 */
export type ConfirmThreshold = 'never' | 'high' | 'medium' | 'always';

/**
 * Suffix-based read-only allowlist for MCP tools. Names ending in any of
 * these verbs are treated as safe lookup-style calls. Excludes write verbs
 * like `create`, `update`, `delete`, `send`, `post`.
 *
 * Centralized here so the MCP wrapper (`framework/tools/mcp.ts`) and the
 * reference-resolver lookup pass (`reference-tool-lookup.ts`) agree on the
 * same definition of "read-only MCP tool."
 */
const READONLY_MCP_SUFFIX_RE = /(?:^|_)(search|list|find|get|query|read|lookup)$/i;

/** Returns true when the given MCP tool name ends in a known read-only verb. */
export function isReadOnlyMCPSuffix(name: string): boolean {
  return READONLY_MCP_SUFFIX_RE.test(name);
}

/**
 * Maps tool metadata to a {@link RiskLevel}. Honors an explicit
 * `meta.risk` override; otherwise derives from `kind` + `sideEffect`,
 * with `meta.isWriteAction(args)` as a per-call refinement (e.g.
 * `memory.read` downgrades to `low` even though the tool's static
 * `kind` is `write`).
 *
 * Unknown / missing metadata defaults to `medium` — a safe middle ground
 * that prompts in `strict` mode but not in `auto`.
 */
export function riskFromMeta(meta: ToolMeta | undefined, args?: unknown): RiskLevel {
  if (!meta) return 'medium';
  if (meta.risk) return meta.risk;
  if (meta.kind === 'dangerous') return 'high';
  if (meta.kind === 'read' || meta.kind === 'inert') return 'low';
  // kind === 'write' — let the per-call predicate downgrade reads on
  // discriminator-style tools (memory/scratch with action: 'read').
  if (meta.isWriteAction && args !== undefined && !meta.isWriteAction(args)) return 'low';
  if (meta.sideEffect === 'external-api') return 'high';
  return 'medium';
}

/**
 * True iff a call at the given risk should be gated by the user-facing
 * confirmation prompt under the given policy threshold.
 */
export function shouldConfirm(risk: RiskLevel, threshold: ConfirmThreshold | undefined): boolean {
  if (!threshold || threshold === 'never') return false;
  if (threshold === 'always') return true;
  if (threshold === 'high') return risk === 'high';
  // 'medium'
  return risk === 'high' || risk === 'medium';
}

/**
 * True iff this tool call should be blocked under read-only mode (#179).
 *
 * `meta.kind` in `{'write','dangerous'}` → blocked. `'read'` / `'inert'` or
 * missing meta → allowed. Missing meta falls through to allowed so legacy/
 * foreign tools without classification don't get bricked silently; MCP tools
 * already get `kind: 'write'` by default via `wrapMCPTool()` so unclassified
 * MCP writes still trip this gate.
 *
 * When `meta.isWriteAction` is set, it overrides the static `kind` check for
 * this specific invocation — so `memory({action:'read'})` falls through even
 * though the `memory` tool's declared `kind` is `'write'`. `args` must be
 * the same object the model passed (post any wrapper rewriting); when omitted
 * the static behavior applies.
 */
export function shouldBlockInReadOnly(meta: ToolMeta | undefined, args?: unknown): boolean {
  if (!meta) return false;
  if (meta.isWriteAction && args !== undefined) return meta.isWriteAction(args);
  return meta.kind === 'write' || meta.kind === 'dangerous';
}
