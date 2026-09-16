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
 * Centralized here so the MCP wrapper (`mcp.ts`) and the watcher probe
 * (`watchers/probe.ts`) agree on one definition of "read-only MCP tool".
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
/**
 * Verbs that EMIT something into the world that cannot be un-emitted (#575).
 *
 * This answers a different question from {@link WRITE_VERBS}, and conflating
 * the two is what got the first duplicate-write gate withdrawn. That one asks
 * "does this mutate"; this asks "is doing it twice a second thing that
 * happened". A message is sent, a calendar event is created, a row is appended
 * — each repeat is a new artefact somebody receives. Setting a value is not:
 * `mark_read`, `set_status`, `update_row`, `archive_chat`, `rename_file` and
 * `delete_message` all land on the same state whether called once or twice,
 * so repeating them is wasteful at worst and must not be refused.
 *
 * So this is a strict subset of the write verbs — the state-setting half of
 * that set is deliberately absent — plus a few names it never needed.
 *
 * **It is narrower than "every MCP write" on purpose, and the trace that
 * motivated the gate is the proof.** `focus_app` carries no read verb and no
 * write verb, so it classifies as a write; it is the third most-used MCP tool
 * on the install this was measured against (38 calls), and the dispatch that
 * double-sent called it TWICE with identical arguments, once before each send.
 * A rule keyed on write-ness refuses the second `focus_app` before the send it
 * exists to stop is ever reached.
 *
 * Same stop-gap status as its neighbour above, and the same replacement: MCP
 * declares `idempotentHint` for exactly this, and #570 is where reading the
 * server's own annotations lands. Until then a name is all there is.
 */
const EMIT_VERBS = new Set([
  'send',
  'post',
  'reply',
  'forward',
  'create',
  'add',
  'insert',
  'upload',
  'publish',
  'submit',
  'invite',
  'draft',
  'email',
  'notify',
]);

/**
 * Whether repeating this MCP tool with identical arguments emits a second time.
 *
 * Segmented exactly as {@link isReadOnlyMCPToolName} segments, through the same
 * shared `parseMCPToolName`, so the two cannot disagree about where the tool
 * name starts. Callers must AND this with `!isReadOnlyMCPToolName(name)`:
 * `list_drafts` and `search_posts` carry an emit verb and are lookups, and a
 * read is never worth refusing.
 */
export function hasEmitVerb(name: string): boolean {
  const bare = parseMCPToolName(name)?.tool ?? name;
  return bare
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .some((seg) => EMIT_VERBS.has(seg));
}

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
 * **Two callers now, and they agree for a reason worth stating.** The read-only
 * block gate (#179) asks "may this run"; `write-barrier.ts` asks "could a read
 * observe a difference". Both reduce to "does it mutate", which is why one
 * predicate serves them — the #513 lesson that `risk.ts` already owns the
 * answer. A future refinement made for permission reasons would silently move
 * the barrier too, so it is named here rather than left to be found.
 *
 * A third caller was tried and withdrawn, and the reason still bounds what this
 * predicate can be asked (#575). A duplicate-write gate wanted "is repeating
 * this harmful", which is IDEMPOTENCY rather than mutation — and measured
 * against real logs the substitution is not close: of 46 adjacent identical
 * `shell` repeats, this predicate calls 44 of them writes, including
 * `ls -l … | cat` and `grep -nE …`, because `primaryShellCommand` returns null
 * for any compound line. Do not reach for this to answer that question; the
 * answer is `ToolMeta.nonIdempotent`, fed for MCP by {@link hasEmitVerb}.
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
