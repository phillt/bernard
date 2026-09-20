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
 * Checked against EVERY segment, and it is what makes matching a read verb
 * ANYWHERE safe: `get_or_create_chat` leads with a read verb and creates,
 * `mark_as_read` ENDS with one while writing, and — measured off a real
 * server — `google_tasks_set_default_list` ends with one too. All three are
 * refused here.
 *
 * **The bound its previous docstring stated is gone, and that is why this list
 * is no longer short (#612).** While the read test was end-anchored, a name
 * with no read verb at either END was already refused, so this only ever
 * decided names that CO-OCCURRED a write verb with a read verb at an end —
 * which is what licensed "do not treat it as a general vocabulary of writes".
 * Matching a read verb at any POSITION removes that licence: this is now the
 * sole discriminator over every name containing a read verb anywhere, a far
 * larger population, and a mutation verb missing from it is a tool that loses
 * the confirm gate, the read-only block gate, the write barrier and the
 * duplicate guard in one go. So it was widened in the same change, which is the
 * only order in which the widening is safe.
 *
 * The rule for adding to it: an unambiguous mutation that appears as a
 * tool-name verb on a mainstream MCP server. `risk.test.ts` carries a negative
 * case per entry, each riding on a MIDDLE read verb, because that is the
 * population this now has to hold on its own.
 *
 * **Inclusion is not free, and the tempting version of that sentence is
 * wrong.** A verb added here does not merely leave a read where the widening
 * found it: a name whose read verb sits at an END was a read under the OLD rule
 * too, so `get_merge_status` or `get_sync_status` flip read → write. That is
 * over-refusal — an extra confirm prompt in `strict`, and not watchable — where
 * the other direction loses the confirm gate, the read-only block gate, the
 * write barrier and the duplicate guard at once, on a tool that merges pull
 * requests or shares files. The asymmetry is what licenses erring toward
 * inclusion; it does not make it costless, and a verb whose mutating form
 * carries no read verb anyway (`export_report`, `refresh_tokens` — already
 * writes by absence) buys nothing against that cost and stays out.
 *
 * **`email` is deliberately absent**, and it is the case that shows this set
 * and {@link EMIT_VERBS} are not interchangeable: it is an emit verb, and
 * putting it here would classify `google_gmail_get_email` as a write — the
 * exact bug #612 reports.
 *
 * It is also a stop-gap for a server that declares nothing. Since #570
 * {@link classifyMCPTool} prefers MCP's own `readOnlyHint` over any of this,
 * so on an annotating server this is the fallback rather than the answer.
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
  // Widened with the any-position read match (#612). Each is a mutation a real
  // server uses as a tool-name verb; the first five were read off `google-mcp`'s
  // own 61-tool surface, the rest off mainstream servers (GitHub, Slack,
  // Notion, Drive). `export` and `refresh` were considered and dropped — see
  // the cost paragraph above; `get_export_url` and `get_refresh_token` are
  // ordinary read names, and neither verb buys anything, since `export_report`
  // and `refresh_tokens` carry no read verb and are already writes.
  'append',
  'replace',
  'share',
  'complete',
  'respond',
  'merge',
  'join',
  'approve',
  'cancel',
  'revoke',
  'assign',
  'close',
  'trigger',
  'deploy',
  'sync',
  'import',
  'publish',
  'submit',
  'invite',
  'notify',
]);

/**
 * Whether an MCP tool name reads rather than writes.
 *
 * Renamed from `isReadOnlyMCPSuffix`: it has not tested a suffix since the
 * verb-first fix, and four call sites plus CLAUDE.md were still citing
 * end-anchoring as load-bearing reasoning. A name that describes a mechanism the
 * function no longer has is the same defect as a comment that outran the code.
 *
 * Matches a read verb at ANY segment position, with no write verb anywhere.
 *
 * It got there in two steps, and the second is the interesting one. #569 moved
 * it off a pure suffix (`/(?:^|_)(search|list|…)$/`), which recognised
 * `messages_list` and not `list_messages` — verb-first naming is at least as
 * common, so on any verb-first server EVERY read tool was a medium-risk write.
 * That fix matched a read verb at either END, which is a better guess and still
 * the wrong shape: a server that prefixes its own tools with a namespace pushes
 * the verb into the MIDDLE, and `google-mcp` does exactly that. Measured,
 * `google_gmail_list_emails`, `google_gmail_list_unread_emails`,
 * `google_gmail_get_email` and `google_calendar_get_events` were all writes, so
 * a watcher refused to poll a Gmail inbox and the user fell back to cron (#612).
 *
 * The consequence is not only the watcher gate. `mcp.ts` feeds this into every
 * MCP tool's `kind`, `sideEffect` and `nonIdempotent`, which reach six places:
 * the confirm gate, the read-only block gate, `write-barrier.ts`, the
 * reconnect-retry refusal, `duplicate-guard.ts` and `mcp-prose-args.ts` — so
 * `google_gmail_get_email` was also having its arguments typographically
 * folded as though it emitted something.
 *
 * Widening moves the whole burden onto {@link WRITE_VERBS}, which is why that
 * set grew in the same change; see its docstring for the invariant that
 * replaced "a name with no read verb at either end is already refused".
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
 * Same stop-gap status as its neighbour above, and the same replacement, which
 * has now landed: MCP declares `idempotentHint` for exactly this, and
 * {@link classifyMCPTool} prefers it. This is what answers for a server that
 * declares nothing, which is still nearly all of them.
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
 * read is never worth refusing. {@link classifyMCPTool} does that conjunction
 * for the MCP path; `mcp-prose-args.ts` still spells it out because it asks a
 * narrower question of its own.
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
  return segments.some((seg) => READ_VERBS.has(seg));
}

/**
 * What a server declares about one of its own tools (#570).
 *
 * The two fields Bernard acts on, and no more. MCP defines two others —
 * `destructiveHint` and `openWorldHint` — and they are deliberately NOT here:
 * `destructiveHint` maps onto `kind: 'dangerous'`, which is `high` risk, which
 * cron auto-denies headlessly under its default posture, so reading it would
 * start failing cron jobs that work today. That is a tightening worth making
 * and it is a decision of its own, not a free rider on a bug fix. A field
 * nothing enforces is a lie on disk.
 */
export interface MCPToolAnnotations {
  /** `true` → the tool does not modify its environment. */
  readOnlyHint?: boolean;
  /** `true` → repeating the call with identical arguments adds no effect. */
  idempotentHint?: boolean;
}

/** Whether a classification came from the server or from the name guess. */
export type ClassificationSource = 'annotation' | 'name';

export interface MCPToolClassification {
  isRead: boolean;
  nonIdempotent: boolean;
  /** Which source decided {@link isRead} — see #570's last acceptance line. */
  readSource: ClassificationSource;
  /** Which source decided {@link nonIdempotent}. */
  idempotencySource: ClassificationSource;
}

/**
 * The two facts `mcp.ts` needs about an MCP tool, from the server where it said
 * so and from the name where it did not (#570).
 *
 * Precedence, and the second rung is the one that matters: `readOnlyHint: true`
 * makes a tool a read whatever its name looks like, and `readOnlyHint: false`
 * makes it a write **even when the name reads like a lookup** — today's
 * direction of failure, where a server explicitly marking a tool destructive is
 * silently overridden by our own regex. Absent, the name heuristic decides
 * exactly as it did before, which is the fallback for the overwhelming majority
 * of servers: `google-mcp`, the server behind #612, declares no annotations at
 * all across its 61 tools, so its fix comes entirely from the widened name
 * match above.
 *
 * "Annotations are untrusted" is not an argument for the regex, and #570 spends
 * a section on why: a hostile server that would lie in `readOnlyHint: true` can
 * equally name its destructive tool `get_stuff`. Same attacker, same trust
 * model, and the name is simply the worse instrument — wrong on the honest
 * servers, which are the whole population that matters. The real controls are
 * the permission gates, the write scope and `confirmMode`, and none of them
 * moves here.
 *
 * Idempotency is only asked of a WRITE. MCP says `idempotentHint` is meaningful
 * only when `readOnlyHint` is false, and Bernard already had the same rule for
 * its own reason — `duplicate-guard.ts` must never refuse a repeated lookup —
 * which is why `mcp.ts` spelled it `!isRead && hasEmitVerb(raw)`. That
 * conjunction moves in here so the two halves cannot be recombined wrongly by
 * the next caller.
 *
 * Note what is deliberately NOT inherited from the spec: MCP says an
 * unannotated tool should be assumed destructive and non-idempotent. Applying
 * that would make every unannotated write non-idempotent, which turns off the
 * reconnect-and-retry for effectively every server in the wild and hands
 * `duplicate-guard.ts` a far wider population than it was measured against.
 * #570 asks for the opposite and says so: an unannotated tool behaves exactly
 * as it does now.
 */
export function classifyMCPTool(
  rawName: string,
  annotations?: MCPToolAnnotations,
): MCPToolClassification {
  // `typeof === 'boolean'`, not `!== undefined`: this object originates as
  // untyped server data, so a string `"true"` must not read as a declaration.
  // The reader in `mcp.ts` type-guards too — twice rather than once, because
  // that one is the boundary and this one is the decision.
  const declaredRead = annotations?.readOnlyHint;
  const hasDeclaredRead = typeof declaredRead === 'boolean';
  const isRead = hasDeclaredRead ? declaredRead : isReadOnlyMCPToolName(rawName);
  const readSource: ClassificationSource = hasDeclaredRead ? 'annotation' : 'name';

  // A read is never worth refusing a repeat of, so whatever decided `isRead`
  // decided this too — which is why the source is carried across rather than
  // reported as a second, unasked question.
  if (isRead) {
    return { isRead, nonIdempotent: false, readSource, idempotencySource: readSource };
  }

  const declaredIdempotent = annotations?.idempotentHint;
  if (typeof declaredIdempotent === 'boolean') {
    return {
      isRead,
      nonIdempotent: !declaredIdempotent,
      readSource,
      idempotencySource: 'annotation',
    };
  }
  return { isRead, nonIdempotent: hasEmitVerb(rawName), readSource, idempotencySource: 'name' };
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
