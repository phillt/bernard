import { type ToolProfileStore, classifyShellCommand, detectToolError } from '../tool-profiles.js';
import { ERROR_SNIPPET_MAX, detectResultFailure } from '../tool-result-shape.js';
import { debugLog } from '../logger.js';
import { printInfo } from '../output.js';
import { readBernardSource, readToolMeta, preserveMeta } from '../framework/tools/adapter.js';
import { isCacheable, type ToolResult } from '../framework/tools/types.js';
import { stripFailureMarker, classifyError } from '../error-taxonomy.js';
import type { BlockActionInput, BlockOutcome, ConfirmActionInput, ToolOptions } from './types.js';
import type { ConfirmThreshold } from '../risk.js';
import { riskFromMeta, shouldBlockInReadOnly, shouldConfirm } from '../risk.js';
import { CACHE_MISS, getCachedResult, setCachedResult } from '../framework/tools/result-cache.js';
import { redactArgs, REDACTED } from '../framework/tools/redact.js';
import type { ProvenanceStore } from '../provenance.js';
import type { ToolMeta } from '../framework/tools/types.js';
import { isDangerous, isSafelisted } from './shell.js';
import { permissionKeyFor } from '../tool-permissions.js';
import { mcpProfileKey, parseMCPToolName } from '../mcp-names.js';
import { resolveGrant, type ToolNameAliasResolver } from '../permissions/engine.js';
import { breadthOptionsFor, type BreadthOption } from '../permissions/breadth.js';
import { WRITE_PATH_TOOLS } from '../permissions/matchers.js';
import { checkWritePath } from '../permissions/write-scope.js';

/**
 * The wrapper shim prepends `[failure: <category>] <playbook.model>` to
 * the error string the model sees, so the next turn's tool-result message
 * carries category + recovery guidance. That hint is for the model, not for
 * the profile playbook — strip it before classifying or storing as a bad
 * example so the recorded bytes are the raw underlying error.
 */
function stripFailureHint(snippet: string): string {
  return stripFailureMarker(snippet);
}

/**
 * Returns the profile key for a given tool invocation. Shell commands are
 * classified into sub-categories; MCP tools are prefixed with `mcp.`.
 *
 * The MCP branch used to test `toolName.includes('__')` against the
 * `@ai-sdk/mcp` convention Bernard did not actually follow — it registered
 * bare names, so the branch never fired and MCP profiles were written
 * indistinguishably from built-ins. Since #413 the registry key really is
 * namespaced, so the branch is live and the key is honest about which server a
 * profile belongs to. Existing bare-keyed profiles are carried forward by
 * `getOrCreate`'s `seedFrom`, not rewritten.
 */
function resolveProfileKey(toolName: string, args: unknown): string {
  if (toolName === 'shell' && args && typeof args === 'object') {
    const cmd = (args as Record<string, unknown>).command;
    if (typeof cmd === 'string') {
      return `shell.${classifyShellCommand(cmd)}`;
    }
  }
  if (parseMCPToolName(toolName)) {
    return mcpProfileKey(toolName);
  }
  return toolName;
}

/**
 * The legacy profile key this call's history would have been stored under
 * before #413 — the server's own name for the tool — or `undefined` for a tool
 * whose key did not change.
 *
 * Read from `meta.rawName` rather than parsed back out of the namespaced key:
 * `sanitize` rewrites `.` to `_` at every rung and the last rung truncates, so
 * the key is not a reliable inverse.
 */
function legacyProfileKey(meta: ToolMeta | undefined): string | undefined {
  return meta?.rawName;
}

function safeSerialize(args: unknown): string {
  try {
    return JSON.stringify(args).slice(0, 300);
  } catch {
    return String(args).slice(0, 300);
  }
}

/**
 * Fires the profile-recording side-effect for a given outcome. `errorSnippet`
 * is undefined on success. Wrapped in setImmediate by the caller so it never
 * adds latency to tool execution.
 */
function recordOutcome(
  profileStore: ToolProfileStore,
  toolName: string,
  profileKey: string,
  argsSnippet: string,
  errorSnippet: string | undefined,
  meta?: ToolMeta,
): void {
  try {
    // Carry a pre-#413 bare-keyed history forward on first write under the new
    // namespaced key. No-op for every non-MCP tool and after the first record.
    //
    // Its own try: seeding is a best-effort migration, recording is the actual
    // job. Sharing the outer catch meant any failure here — including a store
    // that predates the method — silently skipped the record that followed.
    try {
      // Stamps `category` (`mcp.<server>`) as well as carrying history forward.
      // The field has been declared on `ToolProfile` since it was written and
      // never assigned by anything — it is what lets the prompt filter tell an
      // orphaned MCP profile from a built-in, and it is the tool -> server link
      // #377 needs in order to cascade profile deletion on server removal.
      profileStore.ensureSeeded?.(profileKey, legacyProfileKey(meta), meta?.category);
    } catch {
      // A carried-over history is a nicety; never lose the outcome over it.
    }
    if (errorSnippet !== undefined) {
      // Strip the wrapper-shim's `[failure: <category>] ...` hint before
      // classification + storage. Otherwise the recorded bad-example bytes
      // would include the hint, and a re-classification would briefly skew
      // toward the hint's category instead of the underlying error.
      const rawSnippet = stripFailureHint(errorSnippet);
      // Gate bad-example recording on correctability: environmental failures
      // (HTTP 404, rate limits, pool exhaustion, parse_failed) are not
      // call-shape mistakes the model can learn from, so we skip them.
      const cls = classifyError({ message: rawSnippet, toolName });
      if (cls.correctable) {
        profileStore.recordBadExample(profileKey, argsSnippet, rawSnippet, cls.category);
        debugLog(`augment:${toolName}:error`, {
          profileKey,
          category: cls.category,
          snippet: rawSnippet,
        });
        printInfo(`  ~ profile ${profileKey} — recorded error (${cls.category})`);
      } else {
        // Detected, but not a call-shape mistake — nothing to learn. Counting
        // it keeps the tool's record honest: before #366 this branch moved
        // neither counter, so the call simply vanished from the profile.
        profileStore.recordDismissed(profileKey, cls.category);
        debugLog(`augment:${toolName}:error:dismissed`, {
          profileKey,
          category: cls.category,
        });
      }
      return;
    }
    // Success path: always bump successCount so the ratio is observable, then
    // patch the most recent unfixed bad example if there is one.
    profileStore.recordSuccess(profileKey);
    const profile = profileStore.get(profileKey);
    if (
      profile?.badExamples.length &&
      profile.badExamples[profile.badExamples.length - 1].fix === '(awaiting successful retry)'
    ) {
      profileStore.patchLastBadWithFix(profileKey, argsSnippet);
      debugLog(`augment:${toolName}:patched`, { profileKey });
      printInfo(`  ~ profile ${profileKey} — learned fix`);
    }
  } catch {
    // Recording must never propagate errors.
  }
}

/**
 * Optional wiring for the unified confirmation gate (#144). When both
 * `confirmThreshold` and `confirmAction` are provided, each call whose risk
 * crosses the threshold is routed through `confirmAction` before reaching
 * the underlying `execute`. A `false` return cancels the call with a
 * `{type: 'cancelled'}` envelope; the underlying tool is never invoked.
 *
 * Read-only mode wiring (#179). When `toolMode === 'read-only'`, write tools
 * (meta.kind in {write, dangerous}) are routed through `blockAction` before
 * the confirm gate runs. A `'deny'` outcome cancels with a distinct denial
 * message so the model can tell it apart from a confirmation cancel. A
 * `'allow-tool-for-session'` outcome unlocks the tool name for the remainder
 * of this augment-tools session (allowlist is per-`augmentTools` closure;
 * REPL restart clears it). Defaults to `toolMode: 'write'` (no block gate)
 * to preserve historic behavior for callers that don't opt in. When
 * `toolMode: 'read-only'` is set but `blockAction` is undefined, every
 * write call is auto-denied (fail-closed).
 */
export interface AugmentOptions {
  profileStore: ToolProfileStore;
  confirmThreshold?: ConfirmThreshold;
  confirmAction?: ToolOptions['confirmAction'];
  toolMode?: 'read-only' | 'write';
  blockAction?: ToolOptions['blockAction'];
  /**
   * Shared per-REPL-session allowlist of tool names that bypass the block
   * gate. When provided, used in place of a closure-local Set so the
   * allowlist persists across `augmentTools` invocations (turns, nested
   * sub-agent / tool-wrapper dispatches). Omitting it falls back to a
   * fresh per-invocation Set — the legacy behavior, intentional for
   * tests that want isolation.
   */
  sessionToolAllowlist?: Set<string>;
  /**
   * Live reader for the active profile's persisted tool grants (#212).
   * Consulted by both gates before prompting — `allow` proceeds, `deny`
   * refuses, absent falls through to the prompt. Keys come from
   * `permissionKeyFor` (`shell:<primary>` for simple shell commands, the
   * tool name otherwise). Omitted by cron and tests → both gates behave
   * exactly as before #212.
   */
  getToolPermissions?: ToolOptions['getToolPermissions'];
  /**
   * This dispatch's write scope (#340). Absent → no path restriction, which
   * is the interactive default.
   */
  writeScope?: ToolOptions['writeScope'];
  /**
   * Maps a persisted tool name onto the live name it refers to, for grants
   * stored before MCP tools were namespaced per server (#413).
   *
   * Injected, never derived from `tools` — see `AgentContextMCP.resolveAlias`
   * for why the scope has to be the whole live surface. Pass
   * `ctx.mcp.resolveAlias`; omitting it leaves both gates on exact matching,
   * which is the pre-#413 behaviour.
   */
  resolveToolAlias?: ToolNameAliasResolver;
  /**
   * Deterministic tool result cache toggle (#171). When omitted or `true`,
   * tools whose `ToolMeta` passes `isCacheable` (deterministic + no side
   * effects, or `cacheable: true`) hit the in-process TTL cache in
   * `framework/tools/result-cache.ts`. Set `false` to bypass the cache and
   * always call `execute`. Defaults to enabled.
   */
  cacheEnabled?: boolean;
  /**
   * Per-turn ProvenanceStore for evidence-pointer registration (#141). When
   * provided and {@link evidenceEnabled} is not `false`, every successful
   * tool call is added as a `kind: 'tool-result'` source so the model can
   * cite it with `[^Sn]` markers in "verified" / "confirmed" claims. Errors,
   * denies, and cancellations are skipped. Dedup is handled by the store
   * (keyed on `kind` + `rawRef`).
   */
  provenance?: ProvenanceStore;
  /**
   * Toggle for evidence-pointer registration (#141). Defaults to `true` when
   * a {@link provenance} store is passed; set `false` to short-circuit the
   * add even when a store is wired (e.g. the policy engine disabled the
   * `evidence` sub-policy for this turn).
   */
  evidenceEnabled?: boolean;
  /**
   * Per-turn sink for `ToolMeta.verifyOutput` results (issue #145). When
   * provided, every tool call that defines `verifyOutput` and returns
   * `status: 'ok'` contributes a structured `Check` to this array — which is
   * later folded into the turn rubric by `Agent.processInput` (and the cron
   * runner). Omitting the sink disables the hook (legacy / tests).
   */
  postWriteChecks?: import('../rubric.js').Check[];
  /**
   * Per-turn tracker for verification attestation (issue #145). When provided,
   * every successful tool call is recorded so `attestAll(steps)` can later
   * answer "was the stated verification actually exercised?"
   */
  verificationTracker?: import('../verification-tracker.js').VerificationTracker;
}

function isProfileStore(v: AugmentOptions | ToolProfileStore): v is ToolProfileStore {
  return typeof (v as ToolProfileStore).get === 'function';
}

/**
 * One-line description for the confirmation prompt. Shell carries the command
 * verbatim (highest signal) — prefixed `Dangerous command:` only when it
 * matches the dangerous patterns, plain `$ <cmd>` otherwise (#212); everything
 * else falls back to `toolName` with a truncated JSON tail when args exist.
 */
function buildConfirmReason(toolName: string, args: unknown): string {
  if (toolName === 'shell' && args && typeof args === 'object') {
    const cmd = (args as Record<string, unknown>).command;
    if (typeof cmd === 'string') {
      return isDangerous(cmd) ? `Dangerous command: ${cmd}` : `$ ${cmd}`;
    }
  }
  const snippet = args ? ` ${safeSerialize(args)}` : '';
  return `${toolName}${snippet}`;
}

/**
 * Cancelled-shape result returned when the user denies a confirmation prompt.
 * Mirrors the `{output, is_error}` legacy shape for tools that historically
 * returned that (shell, file edit); for migrated `BernardTool`s the envelope's
 * `serializeForModel` decides how the cancellation is rendered.
 *
 * `is_error: true` is intentional — the model must distinguish a cancelled
 * call from a successful one, otherwise it will continue the turn assuming
 * the action took effect (e.g. that an email was sent or a file was deleted).
 */
const CANCELLED_LEGACY_RESULT = {
  output: 'Action cancelled by user.',
  is_error: true,
};

/**
 * Legacy cancellation shape returned when a write call is denied under
 * read-only mode (#179). Kept separate from {@link CANCELLED_LEGACY_RESULT}
 * so the model's next turn can distinguish "user denied write at the
 * least-privilege gate" from "user cancelled this specific confirmation."
 */
const READ_ONLY_DENIED_MESSAGE =
  'Action denied — read-only mode. Ask the user to allow this tool or switch toolMode to write.';

const DENIED_LEGACY_RESULT = {
  output: READ_ONLY_DENIED_MESSAGE,
  is_error: true,
};

/**
 * Wraps every tool's `execute` function to observe results and record
 * error examples to the profile store, and patch fixes when the model
 * retries successfully. The recording is fire-and-forget via `setImmediate`
 * so it never adds latency to tool execution.
 *
 * For tools that originated as {@link import('../framework/tools/types.js').BernardTool}
 * (detected via the `__bernardSource` side-channel attached by `toolToAISDK`),
 * error detection reads the envelope discriminator directly — no heuristics.
 * For legacy AI-SDK tools and MCP-wrapped tools, the shared structural
 * `detectResultFailure` path applies instead.
 *
 * Does NOT modify tool descriptions, parameters, or any other field.
 *
 * Uses `Record<string, any>` intentionally — this is a generic wrapper across
 * heterogeneous tool types (built-in, MCP, dispatch) whose parameter types are
 * erased at this boundary. The SDK's `ToolSet` type is `Record<string, Tool>`
 * but `Tool`'s generic parameters make it impossible to write a single wrapper
 * without `any`.
 *
 * Accepts either a `ToolProfileStore` (legacy/test call shape) or an
 * {@link AugmentOptions} bundle that adds the optional confirmation gate.
 */
export function augmentTools(
  tools: Record<string, any>,
  options: AugmentOptions | ToolProfileStore,
): Record<string, any> {
  const opts: AugmentOptions = isProfileStore(options) ? { profileStore: options } : options;
  const profileStore = opts.profileStore;
  const confirmAction = opts.confirmAction;
  // When a caller wires `confirmAction` but doesn't supply a threshold (e.g. cron,
  // which is headless and never runs the Policy Engine), default to `'high'`.
  // Otherwise `shouldConfirm(risk, undefined)` short-circuits to "proceed" and the
  // auto-deny-high callback never fires — silently re-opening the very gap #144 closes.
  const confirmThreshold: ConfirmThreshold | undefined =
    opts.confirmThreshold ?? (confirmAction ? 'high' : undefined);

  // Read-only mode gate (#179). When unset, behave as `'write'` so existing
  // callers that haven't migrated don't have their tool calls blocked.
  const toolMode = opts.toolMode ?? 'write';
  const blockAction = opts.blockAction;
  const writeScope = opts.writeScope;
  // Per-tool session allowlist keyed by tool name. Prefer the shared Set
  // passed in via `opts.sessionToolAllowlist` (owned by the REPL for the
  // process lifetime) so an "allow-tool-for-session" decision survives
  // across turns AND across nested sub-agent / tool-wrapper dispatches.
  // Falls back to a closure-local Set when none is provided (tests, cron).
  const sessionToolAllowlist = opts.sessionToolAllowlist ?? new Set<string>();
  // Deterministic-tool result cache (#171). Default ON. The check runs AFTER
  // the block/confirm gates so cacheable tools that also opted in with
  // `sideEffect !== 'none'` (a rare combination) still honor read-only mode
  // and risk-based confirms. The existing per-toolName:hash(args) session
  // allowlist on the confirm gate means a repeat call with the same args
  // doesn't re-prompt, so the extra gate trip is essentially free.
  const cacheEnabled = opts.cacheEnabled !== false;
  // Evidence-pointer registration (#141). Active only when a ProvenanceStore
  // is wired AND the policy hasn't disabled it. Errors during `add` are
  // swallowed so a malformed source never aborts a real tool call.
  const provenance = opts.provenance;
  // Default closed: registration only runs when the policy engine explicitly
  // opts in. The previous `?? true` fallback silently enabled evidence in
  // contexts that never consult the policy (cron, hand-assembled contexts),
  // populating the shared store with entries the model was never told about.
  const evidenceEnabled = provenance ? opts.evidenceEnabled === true : false;
  const postWriteChecks = opts.postWriteChecks;
  const verificationTracker = opts.verificationTracker;

  /**
   * Stable 53-bit djb2 hash for an args string. Used to derive an evidence
   * `rawRef` that uniquely identifies the call. Truncating the raw args in
   * the rawRef caused long-prefix collisions (two `shell` commands with the
   * same first 120 chars deduped to one source) which silently dropped the
   * second call's evidence.
   */
  const hashArgs = (s: string): string => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  };

  const registerEvidence = (
    toolName: string,
    args: unknown,
    meta: ToolMeta | undefined,
    resultText: string,
  ): void => {
    if (!evidenceEnabled || !provenance) return;
    try {
      // Redact declared-sensitive arg fields before they reach label/rawRef,
      // matching the contract result-cache.ts / cron-step-recorder.ts /
      // tool-wrapper-run.ts already follow. Without this, an MCP tool that
      // declares `sensitiveArgs: ['apiKey']` would leak its key into the
      // <available_sources> block the LLM sees every turn.
      const safeArgs = redactArgs(args, meta?.sensitiveArgs);
      const argsSnippet = safeSerialize(safeArgs);
      // Same contract for result content: when the tool's output itself is
      // sensitive (sensitiveResult: true) we never let it reach the model
      // via <available_sources>.
      const previewSrc = meta?.sensitiveResult ? REDACTED : resultText;
      const labelTail = argsSnippet ? `: ${argsSnippet.slice(0, 80)}` : '';
      provenance.add({
        kind: 'tool-result',
        label: `${toolName}${labelTail}`,
        contentPreview: previewSrc,
        rawRef: `tool:${toolName}:${hashArgs(argsSnippet)}`,
      });
    } catch (err) {
      debugLog(
        `augment:${toolName}:evidence:failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const augmented: Record<string, any> = {};

  /**
   * Is this shell call a dangerous, non-safelisted command? Such calls always
   * re-prompt and are never offered a profile-scope grant (#261).
   */
  const isDangerousShellCall = (toolName: string, args: unknown): boolean => {
    if (toolName !== 'shell') return false;
    const cmd = (args as Record<string, unknown> | undefined)?.command;
    return typeof cmd === 'string' && isDangerous(cmd) && !isSafelisted(cmd);
  };

  /**
   * Profile-persisted grant resolution (#212/#261), shared by both gates.
   * Evaluates the active profile's `PermissionRule[]` through the deterministic
   * engine: `allow` skips the gate's prompt, `deny` refuses without prompting,
   * `ask` falls through to the gate's dialog. Checked after the session
   * allowlist, before prompting.
   */
  const resolveProfileGrant = (toolName: string, args: unknown): 'allow' | 'deny' | 'ask' => {
    const rules = opts.getToolPermissions?.() ?? [];
    if (rules.length === 0) return 'ask';
    const isDangerousShell = isDangerousShellCall(toolName, args);
    const decision = resolveGrant(toolName, args, rules, isDangerousShell, opts.resolveToolAlias);
    if (decision === 'deny') debugLog(`augment:${toolName}:profile-deny`, {});
    return decision;
  };

  /**
   * Breadth ladder for the confirm/block dialog (#261), or `undefined` when no
   * profile-scope grant should be offered (dangerous shell, complex/unparseable
   * commands, missing args) so the dialog omits the "for this profile" row.
   */
  const computeBreadthOptions = (
    toolName: string,
    args: unknown,
    isDangerousShell: boolean,
    meta: ToolMeta | undefined,
  ): BreadthOption[] | undefined => {
    if (isDangerousShell) return undefined;
    const ladder = breadthOptionsFor(toolName, args, meta);
    return ladder.length ? ladder : undefined;
  };

  /**
   * Write-scope gate (#340). Returns `null` to proceed, or a refusal string
   * naming where the write may go instead — the same shape `checkWritePath`
   * returns, so the gate forwards rather than translates.
   *
   * Sits ahead of the block and confirm gates because it answers a different
   * question — *where*, not *whether the user wants to be asked*. A write into
   * this dispatch's own workspace is low risk regardless of which tool made
   * it; a write to `~/.ssh/authorized_keys` is high risk regardless. The risk
   * tiers cannot express that, which is why #337 withheld the write-capable
   * file tools from cron instead of fixing it.
   *
   * **Structured path arguments only.** `shell` is deliberately NOT covered:
   * extracting write targets from an arbitrary command line is not reliably
   * possible, and a containment check that is sometimes wrong is worse than
   * none — it grants confidence it has not earned. Shell keeps its existing
   * dangerous-command denial. Answering #340's "does this subsume shell?" as
   * *not yet*, on purpose.
   *
   * Keyed off `WRITE_PATH_TOOLS` rather than `FILE_TOOLS` so a read tool in
   * that set is not gated: this bounds writes, not reads.
   */
  const runWriteScopeGate = (toolName: string, args: unknown): string | null => {
    if (!writeScope) return null;
    if (!WRITE_PATH_TOOLS.has(toolName)) return null;
    // The type check lives in `checkWritePath`, which REFUSES a non-string
    // path. Repeating it here — where the natural return is `null`, meaning
    // allow — put two checks on one condition with opposite verdicts, and made
    // the module's fail-closed branch unreachable from production.
    const refusal = checkWritePath(
      writeScope,
      (args as { path?: unknown } | undefined)?.path as string,
    );
    if (!refusal) return null;
    debugLog(`augment:${toolName}:write-scope:refused`, {
      workspace: writeScope.workspace,
      grants: writeScope.grants?.length ?? 0,
    });
    return refusal;
  };

  /**
   * The gates that apply no matter what posture a dispatch runs under, plus
   * the grant decision the later gates need.
   *
   * **The deny half is unconditional, and that is the whole point (#420).** A
   * persisted `deny` rule used to be enforced only from inside the block and
   * confirm gates, and both return early before consulting the rules: the
   * block gate short-circuits unless `toolMode === 'read-only'` **and** the
   * tool is classified as a write, the confirm gate unless the risk crosses
   * the threshold. So under an applet's own posture — `read-only` with
   * threshold `high` — a `deny` on a **low-risk read tool** (`web_search`,
   * `web_read`, `file_read_lines`, `memory{action:'read'}`) was inert: the
   * user's rule existed, matched, and never ran.
   *
   * Only `deny` is refused here. `allow` keeps meaning what it already meant —
   * skip the prompt in the gate that would have raised one — and is handed
   * onward, so this adds a refusal without widening anything.
   *
   * One function rather than three stanzas at each of the two `execute`
   * wrappers below: both call sites already forward a refusal string verbatim,
   * and a gate only SOME call sites run is the shape that let the write-scope
   * gate ship unwired to `runDefinition` in #340. It also resolves the grant
   * exactly once per call — it was being recomputed, shell parse included, in
   * each gate that consulted it.
   *
   * The deny rule is checked first: "you may not use this tool" is a broader
   * statement than "not at that path", and the more actionable refusal to hand
   * back.
   */
  const runUnconditionalGates = (
    toolName: string,
    args: unknown,
    toolDef: any,
  ): { refusal: string } | { grant: 'allow' | 'ask' } => {
    const grant = resolveProfileGrant(toolName, args);
    if (grant === 'deny') {
      const key = permissionKeyFor(toolName, args, readToolMeta(toolDef));
      return {
        refusal:
          `\`${key ?? toolName}\` is denied for this dispatch by a permission rule. ` +
          'Do not retry it; use a different tool or report that the capability is not granted.',
      };
    }
    const outOfScope = runWriteScopeGate(toolName, args);
    return outOfScope ? { refusal: outOfScope } : { grant };
  };

  /**
   * Block gate (#179). Returns `true` to fall through to {@link runGate},
   * `false` if the call was denied (caller returns a cancelled-shape result).
   *
   * Short-circuits to proceed when `toolMode === 'write'` or the tool's meta
   * isn't classified as write/dangerous. When `toolMode === 'read-only'` but
   * `blockAction` is undefined, fails closed (denies every write) so headless
   * callers that forgot to wire the prompt don't silently leak side effects.
   */
  const runBlockGate = async (
    toolName: string,
    args: unknown,
    toolDef: any,
    execOptions: unknown,
    // Already resolved by `runUnconditionalGates`, which refuses `deny` before
    // this runs — so only 'allow' and 'ask' can arrive, and there is no second
    // resolution (or second shell parse) here.
    grant: 'allow' | 'ask',
  ): Promise<boolean> => {
    if (toolMode !== 'read-only') return true;
    const meta = readToolMeta(toolDef);
    if (!shouldBlockInReadOnly(meta, args)) return true;
    if (sessionToolAllowlist.has(toolName)) return true;
    if (grant === 'allow') return true;
    const dangerousShell = isDangerousShellCall(toolName, args);
    const permissionKey = permissionKeyFor(toolName, args, meta);
    if (!blockAction) {
      debugLog(`augment:${toolName}:block:fail-closed`, { toolMode });
      return false;
    }
    const input: BlockActionInput = {
      toolName,
      args,
      reason: buildConfirmReason(toolName, args),
      permissionKey,
      breadthOptions: computeBreadthOptions(toolName, args, dangerousShell, meta),
    };
    const signal = (execOptions as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
    let outcome: BlockOutcome;
    try {
      outcome = await blockAction(input, signal);
    } catch (err) {
      // A throwing blockAction is a wiring bug — fail closed (deny) so the
      // model gets a clear cancellation rather than silently bypassing.
      debugLog(`augment:${toolName}:block:threw`, err instanceof Error ? err.message : String(err));
      return false;
    }
    if (outcome === 'deny') return false;
    if (outcome === 'allow-tool-for-session') sessionToolAllowlist.add(toolName);
    // 'allow-tool-for-profile': the UI layer persisted the grant before
    // resolving; the live getToolPermissions reader covers later calls.
    // Deliberately NOT added to sessionToolAllowlist — that Set is keyed by
    // tool name, so adding `shell` for a `shell:ls` grant would over-allow
    // every shell command for the session.
    return true;
  };

  /**
   * Returns `true` to proceed, `false` if the user cancelled. `undefined`
   * confirmAction or threshold short-circuits to proceed.
   */
  const runGate = async (
    toolName: string,
    args: unknown,
    toolDef: any,
    execOptions: unknown,
    grant: 'allow' | 'ask',
  ): Promise<boolean> => {
    if (!confirmAction) return true;
    const meta = readToolMeta(toolDef);
    const risk = riskFromMeta(meta, args);
    if (!shouldConfirm(risk, confirmThreshold)) return true;
    if (grant === 'allow') return true;
    const dangerousShell = isDangerousShellCall(toolName, args);
    const permissionKey = permissionKeyFor(toolName, args, meta);
    const input: ConfirmActionInput = {
      toolName,
      args,
      risk,
      reason: buildConfirmReason(toolName, args),
      permissionKey,
      breadthOptions: computeBreadthOptions(toolName, args, dangerousShell, meta),
    };
    const signal = (execOptions as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
    try {
      return await confirmAction(input, signal);
    } catch (err) {
      // A throwing confirmAction is a wiring bug — fail closed (deny) so
      // the model gets a clear cancellation rather than silently bypassing.
      debugLog(
        `augment:${toolName}:confirm:threw`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  };

  for (const [toolName, toolDef] of Object.entries(tools)) {
    if (!toolDef || typeof toolDef.execute !== 'function') {
      augmented[toolName] = toolDef;
      continue;
    }

    const source = readBernardSource(toolDef);

    if (source) {
      // Envelope-aware path for migrated BernardTools. We run the source
      // execute (which returns a ToolResult envelope), record based on the
      // discriminator, then call serializeForModel to produce the bytes the
      // model sees — exactly what toolToAISDK would have done.
      augmented[toolName] = preserveMeta(
        {
          ...toolDef,
          execute: async (args: unknown, execOptions: unknown) => {
            const gates = runUnconditionalGates(toolName, args, toolDef);
            if ('refusal' in gates) {
              const refused: ToolResult<unknown> = {
                status: 'error',
                error: { type: 'denied', message: gates.refusal },
              };
              return source.serializeForModel(refused);
            }
            if (!(await runBlockGate(toolName, args, toolDef, execOptions, gates.grant))) {
              const denied: ToolResult<unknown> = {
                status: 'error',
                // Distinct from 'cancelled' so envelope consumers that branch
                // on error.type can tell "user denied write under read-only
                // mode" apart from "user cancelled this specific confirm."
                error: { type: 'denied', message: READ_ONLY_DENIED_MESSAGE },
              };
              return source.serializeForModel(denied);
            }
            if (!(await runGate(toolName, args, toolDef, execOptions, gates.grant))) {
              const cancelled: ToolResult<unknown> = {
                status: 'error',
                error: { type: 'cancelled', message: 'Action cancelled by user.' },
              };
              return source.serializeForModel(cancelled);
            }
            // Deterministic-tool cache check (#171). Only opted-in tools
            // (deterministic + sideEffect:'none'|cacheable:true) participate;
            // anything else skips both the lookup and the miss log so cache
            // telemetry only reflects cacheable tools. The cached value is the
            // already-serialized model bytes — see the setCachedResult call
            // below.
            const toolIsCacheable = cacheEnabled && isCacheable(source.meta);
            if (toolIsCacheable) {
              const cached = getCachedResult(source.meta, args);
              if (cached !== CACHE_MISS) {
                debugLog(`cache:tool:hit`, { tool: toolName });
                // Bump successCount + patch any awaiting-fix bad example on
                // cache hits too — without this, profile learning silently
                // stalls for cacheable tools.
                setImmediate(() =>
                  recordOutcome(
                    profileStore,
                    toolName,
                    resolveProfileKey(toolName, args),
                    safeSerialize(args),
                    undefined,
                    readToolMeta(toolDef),
                  ),
                );
                // Evidence pointer (#141) for cache hits: without this, a
                // cacheable tool whose TTL outlives a turn boundary returns
                // a cached result the model is told (by EVIDENCE_PROMPT) it
                // can cite — but the per-turn ProvenanceStore was cleared at
                // turn start so no `[^Sn]` is available. Re-register so the
                // post-clear turn has the source. ProvenanceStore dedups by
                // (kind, rawRef), so intra-turn repeats are a no-op.
                const cachedPreview = typeof cached === 'string' ? cached : safeSerialize(cached);
                registerEvidence(toolName, args, source.meta, cachedPreview);
                return cached;
              }
              debugLog(`cache:tool:miss`, { tool: toolName });
            }
            let envelope: ToolResult<unknown>;
            const execStartedAt = Date.now();
            const argsPreview = safeSerialize(redactArgs(args, source.meta?.sensitiveArgs));
            debugLog(`augment:${toolName}:start`, undefined);
            debugLog('tool:execute:start', { tool: toolName, args: argsPreview });
            try {
              envelope = await source.execute(args, execOptions as never);
              debugLog(`augment:${toolName}:done`, {
                ok: envelope.status === 'ok',
              });
              debugLog('tool:execute:end', {
                tool: toolName,
                durationMs: Date.now() - execStartedAt,
                status: envelope.status,
              });
            } catch (thrown: unknown) {
              // Infrastructure-level throws (reconnect, network, etc.) are not
              // usage errors — don't record them as bad examples.
              debugLog(
                `augment:${toolName}:threw`,
                thrown instanceof Error ? thrown.message : String(thrown),
              );
              debugLog('tool:execute:error', {
                tool: toolName,
                durationMs: Date.now() - execStartedAt,
                message: thrown instanceof Error ? thrown.message : String(thrown),
              });
              throw thrown;
            }

            const profileKey = resolveProfileKey(toolName, args);
            const argsSnippet = safeSerialize(args);
            const errSnippet =
              envelope.status === 'error'
                ? `${envelope.error.message}${envelope.error.snippet ? `\n${envelope.error.snippet}` : ''}`.slice(
                    0,
                    ERROR_SNIPPET_MAX,
                  )
                : undefined;
            setImmediate(() =>
              recordOutcome(
                profileStore,
                toolName,
                profileKey,
                argsSnippet,
                errSnippet,
                readToolMeta(toolDef),
              ),
            );

            const serialized = source.serializeForModel(envelope);
            // Only cache successful envelopes — denied/cancelled/error must
            // never be served from cache on a subsequent identical call.
            if (toolIsCacheable && envelope.status === 'ok') {
              setCachedResult(source.meta, args, serialized);
            }
            // Evidence pointer (#141): register every successful tool call so
            // the model can cite it for verified claims. Errored / denied /
            // cancelled envelopes never become evidence.
            if (envelope.status === 'ok') {
              const previewSrc =
                typeof serialized === 'string' ? serialized : safeSerialize(serialized);
              registerEvidence(toolName, args, source.meta, previewSrc);
              recordVerification(verificationTracker, toolName, args, envelope.result);
              runVerifyOutput(postWriteChecks, source.meta, args, envelope.result);
            }
            return serialized;
          },
        },
        toolDef,
      );
      continue;
    }

    // Legacy heuristic path for AI-SDK / MCP / dispatch tools that have not
    // been migrated. Behavior is unchanged from pre-Phase-B, plus the
    // pre-execute confirmation gate (#144). MCP / legacy tools return the
    // raw result to the model, so the cancelled payload is a plain string
    // marker rather than a serialized envelope.
    const originalExecute = toolDef.execute;
    augmented[toolName] = preserveMeta(
      {
        ...toolDef,
        execute: async (args: unknown, execOptions: unknown) => {
          const gates = runUnconditionalGates(toolName, args, toolDef);
          if ('refusal' in gates) return `Error: ${gates.refusal}`;
          if (!(await runBlockGate(toolName, args, toolDef, execOptions, gates.grant))) {
            return DENIED_LEGACY_RESULT;
          }
          if (!(await runGate(toolName, args, toolDef, execOptions, gates.grant))) {
            return CANCELLED_LEGACY_RESULT;
          }
          let result: unknown;
          const execStartedAt = Date.now();
          debugLog('tool:execute:start', {
            tool: toolName,
            args: safeSerialize(redactArgs(args, readToolMeta(toolDef)?.sensitiveArgs)),
          });
          try {
            result = await originalExecute(args, execOptions);
          } catch (thrown: unknown) {
            debugLog(
              `augment:${toolName}:threw`,
              thrown instanceof Error ? thrown.message : String(thrown),
            );
            debugLog('tool:execute:error', {
              tool: toolName,
              durationMs: Date.now() - execStartedAt,
              message: thrown instanceof Error ? thrown.message : String(thrown),
            });
            throw thrown;
          }

          const profileKey = resolveProfileKey(toolName, args);
          const argsSnippet = safeSerialize(args);
          const capturedResult = result;
          // Evidence pointer (#141), synchronous: deferring this inside the
          // setImmediate below races with `provenance.clear()` at the start
          // of the next turn (back-to-back processInput, /task path, tests),
          // and a throw from detectToolError would silently skip it. Recording
          // must also stay asynchronous — the legacy path tests assert
          // detectToolError has not run by the time execute returns — so the
          // gate reads the shared structural predicate directly instead (#363).
          // It replaces an inline `is_error === true || 'error' in result`,
          // which knew nothing of MCP's `isError` and misread `{error: null}`
          // (what `structured-output`'s `nullableOptional` leaves behind).
          const looksLikeError = detectResultFailure(capturedResult) !== undefined;
          // Log a non-throwing failure as `status: 'error'` so the JSONL
          // reflects what the model actually received. The legacy path used
          // to always log `'ok'` whenever execute didn't throw, which made
          // wrapper sub-dispatch errors (which surface as `{is_error: true}`
          // or `{error: '...'}` envelopes — see `wrap-with-specialist.ts`)
          // invisible at the augment-log layer. Since #363 this also covers
          // MCP's `{content, isError: true}`, which is how a whole session of
          // dead-socket calls logged as 254 consecutive `ok`s.
          debugLog('tool:execute:end', {
            tool: toolName,
            durationMs: Date.now() - execStartedAt,
            status: looksLikeError ? 'error' : 'ok',
          });
          if (!looksLikeError) {
            const previewSrc =
              typeof capturedResult === 'string' ? capturedResult : safeSerialize(capturedResult);
            registerEvidence(toolName, args, readToolMeta(toolDef), previewSrc);
            recordVerification(verificationTracker, toolName, args, capturedResult);
            runVerifyOutput(postWriteChecks, readToolMeta(toolDef), args, capturedResult);
          }
          setImmediate(() => {
            try {
              const errorInfo = detectToolError(toolName, capturedResult);
              const errSnippet = errorInfo.isError ? errorInfo.snippet : undefined;
              recordOutcome(
                profileStore,
                toolName,
                profileKey,
                argsSnippet,
                errSnippet,
                readToolMeta(toolDef),
              );
            } catch {
              // detectToolError throws are swallowed; recording must never propagate.
            }
          });

          return result;
        },
      },
      toolDef,
    );
  }

  return augmented;
}

/**
 * Push a `verifyOutput` outcome into the turn's `postWriteChecks` sink
 * (issue #145). No-op when no sink is wired, when the tool has no meta, or
 * when `verifyOutput` is undefined. Hook throws never propagate — a buggy
 * verification check must not abort the real tool call.
 */
function runVerifyOutput(
  sink: import('../rubric.js').Check[] | undefined,
  meta: import('../framework/tools/types.js').ToolMeta | undefined,
  args: unknown,
  result: unknown,
): void {
  if (!sink || !meta?.verifyOutput) return;
  try {
    const outcome = meta.verifyOutput(args, result);
    if (!outcome) return;
    sink.push({
      id: `post_write_${meta.name}`,
      label: `${meta.name} post-write check`,
      status: outcome.status,
      evidence: outcome.evidence,
    });
  } catch (err) {
    debugLog(
      `augment:verifyOutput:${meta.name}:threw`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Record a successful tool call into the turn's `VerificationTracker`
 * (issue #145). No-op when no tracker is wired. Hook is best-effort —
 * tracker errors never propagate.
 */
function recordVerification(
  tracker: import('../verification-tracker.js').VerificationTracker | undefined,
  toolName: string,
  args: unknown,
  result: unknown,
): void {
  if (!tracker) return;
  try {
    tracker.recordCall(toolName, args, result);
  } catch (err) {
    debugLog(`augment:verificationTracker:threw`, err instanceof Error ? err.message : String(err));
  }
}
