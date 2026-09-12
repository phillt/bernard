import type { ToolMeta, ToolRisk } from './framework/tools/types.js';
// A pure leaf (`node:crypto` only), so this stays free of the MCP manager's
// graph — the edge `tool-bytes.ts` and `mcp-names.ts` exist to refuse.
import { parseMCPToolName } from './mcp-names.js';

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
 * Verbs that make an MCP tool a lookup-style call.
 *
 * Centralized here so the MCP wrapper (`mcp.ts`), the reference-resolver lookup
 * pass (`reference-tool-lookup.ts`) and the watcher probe (`watchers/probe.ts`)
 * agree on one definition of "read-only MCP tool".
 */
const READ_VERBS = new Set(['search', 'list', 'find', 'get', 'query', 'read', 'lookup']);

/**
 * Verbs that disqualify a name however it is shaped.
 *
 * Checked against EVERY segment, and it is what makes matching a leading verb
 * safe: `get_or_create_chat` leads with a read verb and creates, and
 * `mark_as_read` ENDS with one while writing. Both are refused here.
 *
 * **Its job is much narrower than the list makes it look**, and stating the
 * bound is what stops it growing to sixty entries: a name with no read verb at
 * either end is already refused, so this only ever decides names that CO-OCCUR
 * a write verb with a read verb at an end. Do not treat it as a general
 * vocabulary of writes.
 *
 * It is also a stop-gap. #570 replaces the guessing entirely with MCP's own
 * `readOnlyHint`, at which point this is the fallback for unannotated servers
 * rather than the primary answer.
 */
const WRITE_VERBS = new Set([
  'create',
  'update',
  'delete',
  'send',
  'post',
  'write',
  'remove',
  'set',
  'add',
  'modify',
  'patch',
  'put',
  'archive',
  'move',
  'rename',
  'upload',
  'insert',
  'edit',
  'mark',
  'star',
  'react',
  'reply',
  'forward',
  'clear',
  'draft',
]);

/**
 * Whether an MCP tool name reads rather than writes.
 *
 * Renamed from `isReadOnlyMCPSuffix`: it has not tested a suffix since the
 * verb-first fix, and four call sites plus CLAUDE.md were still citing
 * end-anchoring as load-bearing reasoning. A name that describes a mechanism the
 * function no longer has is the same defect as a comment that outran the code.
 *
 * Matches a read verb at EITHER end, which is the fix: this was end-anchored
 * only (`/(?:^|_)(search|list|…)$/`), so it recognised `messages_list` and not
 * `list_messages` — and verb-first naming is at least as common. Beeper's
 * `list_messages` was therefore classified `kind: 'write'`, which is not a
 * watcher problem: `mcp.ts` feeds this into every tool's risk tier, so on any
 * verb-first server EVERY read tool was a medium-risk write — refused outright
 * under `toolMode: 'read-only'`, prompting under `strict`, and excluded from the
 * resolver's lookup allowlist.
 *
 * It is a loosening, so it is guarded rather than widened: a read verb at either
 * end, and NO write verb anywhere. The verb set itself is unchanged.
 *
 * The namespace is stripped first. Keys are `server_hash__tool` since #413, so
 * segmenting the whole key would make the first segment the server name and the
 * leading-verb test would never fire — which is the same reason the original was
 * anchored rather than free-floating.
 */
export function isReadOnlyMCPToolName(name: string): boolean {
  // `parseMCPToolName`, not a local strip. The inline version split on the LAST
  // `__` while the shared one splits on the FIRST, and they disagree for any
  // tool whose own name contains `__` — a server exporting `get__foo` came out
  // as `foo`, no read verb, classified a WRITE. That is the exact bug class this
  // function was just changed to fix, reintroduced one branch over. The server
  // segment is sanitized and cannot contain `__`; the tool half can, which is
  // why first-match is the correct rule and why it lives in one place.
  const bare = parseMCPToolName(name)?.tool ?? name;
  const segments = bare.toLowerCase().split('_').filter(Boolean);
  if (segments.some((seg) => WRITE_VERBS.has(seg))) return false;
  return READ_VERBS.has(segments[0]) || READ_VERBS.has(segments[segments.length - 1]);
}

/**
 * Maps tool metadata to a {@link RiskLevel}. Honors an explicit
 * `meta.risk` override; otherwise derives from `kind` + `sideEffect`,
 * with two per-call refinements: `meta.riskForCall(args)`, which may raise
 * or lower (#456 — `applet.delete` is `high` while the tool is `medium`),
 * and `meta.isWriteAction(args)`, which may only lower (e.g. `memory.read`
 * downgrades to `low` even though the tool's static `kind` is `write`).
 *
 * The order is the contract and `risk.test.ts` states it: `meta.risk` >
 * `riskForCall` > `isWriteAction` > `kind`/`sideEffect`.
 *
 * Unknown / missing metadata defaults to `medium` — a safe middle ground
 * that prompts in `strict` mode but not in `auto`.
 */
export function riskFromMeta(meta: ToolMeta | undefined, args?: unknown): RiskLevel {
  if (!meta) return 'medium';
  if (meta.risk) return meta.risk;
  // The only hook that can RAISE (#456), and it sits here for two reasons: a
  // static `meta.risk` is the more deliberate statement so it still wins, and
  // a statement about this specific call beats the generic downgrade below.
  // Guarded on `args` exactly as the predicate below is, so a metadata-only
  // call (no args in hand) is unchanged.
  if (meta.riskForCall && args !== undefined) {
    const raised = meta.riskForCall(args);
    if (raised) return raised;
  }
  // Per-call predicate FIRST (#212) — read-shaped invocations downgrade even
  // on dangerous-kind tools (shell's `ls` / `git status`), not just on
  // discriminator-style write tools (memory/scratch with action: 'read').
  // Mirrors `shouldBlockInReadOnly`, where the predicate already overrides
  // the static kind.
  if (meta.isWriteAction && args !== undefined && !meta.isWriteAction(args)) return 'low';
  if (meta.kind === 'dangerous') return 'high';
  if (meta.kind === 'read' || meta.kind === 'inert') return 'low';
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
