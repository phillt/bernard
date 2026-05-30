import { type ToolProfileStore, classifyShellCommand, detectToolError } from '../tool-profiles.js';
import { debugLog } from '../logger.js';
import { printInfo } from '../output.js';
import { readBernardSource, readToolMeta, preserveMeta } from '../framework/tools/adapter.js';
import { isCacheable, type ToolResult } from '../framework/tools/types.js';
import { classifyError } from '../error-taxonomy.js';
import type { BlockActionInput, BlockOutcome, ConfirmActionInput, ToolOptions } from './types.js';
import type { ConfirmThreshold } from '../risk.js';
import { riskFromMeta, shouldBlockInReadOnly, shouldConfirm } from '../risk.js';
import { CACHE_MISS, getCachedResult, setCachedResult } from '../framework/tools/result-cache.js';

/**
 * The wrapper shim prepends `[failure: <category>] <playbook.model>` to
 * the error string the model sees, so the next turn's tool-result message
 * carries category + recovery guidance. That hint is for the model, not for
 * the profile playbook — strip it before classifying or storing as a bad
 * example so the recorded bytes are the raw underlying error.
 */
const FAILURE_HINT_PREFIX = /^\[failure: [a-z_]+\][^\n]*\n?/;

function stripFailureHint(snippet: string): string {
  return snippet.replace(FAILURE_HINT_PREFIX, '');
}

/**
 * Returns the profile key for a given tool invocation. Shell commands are
 * classified into sub-categories; MCP tools are prefixed with `mcp.`.
 */
function resolveProfileKey(toolName: string, args: unknown): string {
  if (toolName === 'shell' && args && typeof args === 'object') {
    const cmd = (args as Record<string, unknown>).command;
    if (typeof cmd === 'string') {
      return `shell.${classifyShellCommand(cmd)}`;
    }
  }
  // MCP tools follow the @ai-sdk/mcp naming convention: serverName__toolName
  if (toolName.includes('__')) {
    return `mcp.${toolName}`;
  }
  return toolName;
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
): void {
  try {
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
   * Deterministic tool result cache toggle (#171). When omitted or `true`,
   * tools whose `ToolMeta` passes `isCacheable` (deterministic + no side
   * effects, or `cacheable: true`) hit the in-process TTL cache in
   * `framework/tools/result-cache.ts`. Set `false` to bypass the cache and
   * always call `execute`. Defaults to enabled.
   */
  cacheEnabled?: boolean;
}

function isProfileStore(v: AugmentOptions | ToolProfileStore): v is ToolProfileStore {
  return typeof (v as ToolProfileStore).get === 'function';
}

/**
 * One-line description for the confirmation prompt. Shell carries the command
 * verbatim (highest signal); everything else falls back to `toolName` with a
 * truncated JSON tail when args exist.
 */
function buildConfirmReason(toolName: string, args: unknown): string {
  if (toolName === 'shell' && args && typeof args === 'object') {
    const cmd = (args as Record<string, unknown>).command;
    if (typeof cmd === 'string') return `Dangerous command: ${cmd}`;
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
 * For legacy AI-SDK tools and MCP-wrapped tools, the historical
 * `detectToolError` heuristic path still applies.
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

  const augmented: Record<string, any> = {};

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
  ): Promise<boolean> => {
    if (toolMode !== 'read-only') return true;
    const meta = readToolMeta(toolDef);
    if (!shouldBlockInReadOnly(meta, args)) return true;
    if (sessionToolAllowlist.has(toolName)) return true;
    if (!blockAction) {
      debugLog(`augment:${toolName}:block:fail-closed`, { toolMode });
      return false;
    }
    const input: BlockActionInput = {
      toolName,
      args,
      reason: buildConfirmReason(toolName, args),
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
  ): Promise<boolean> => {
    if (!confirmAction) return true;
    const meta = readToolMeta(toolDef);
    const risk = riskFromMeta(meta, args);
    if (!shouldConfirm(risk, confirmThreshold)) return true;
    const input: ConfirmActionInput = {
      toolName,
      args,
      risk,
      reason: buildConfirmReason(toolName, args),
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
            if (!(await runBlockGate(toolName, args, toolDef, execOptions))) {
              const denied: ToolResult<unknown> = {
                status: 'error',
                // Distinct from 'cancelled' so envelope consumers that branch
                // on error.type can tell "user denied write under read-only
                // mode" apart from "user cancelled this specific confirm."
                error: { type: 'denied', message: READ_ONLY_DENIED_MESSAGE },
              };
              return source.serializeForModel(denied);
            }
            if (!(await runGate(toolName, args, toolDef, execOptions))) {
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
                  ),
                );
                return cached;
              }
              debugLog(`cache:tool:miss`, { tool: toolName });
            }
            let envelope: ToolResult<unknown>;
            try {
              envelope = await source.execute(args, execOptions as never);
            } catch (thrown: unknown) {
              // Infrastructure-level throws (reconnect, network, etc.) are not
              // usage errors — don't record them as bad examples.
              debugLog(
                `augment:${toolName}:threw`,
                thrown instanceof Error ? thrown.message : String(thrown),
              );
              throw thrown;
            }

            const profileKey = resolveProfileKey(toolName, args);
            const argsSnippet = safeSerialize(args);
            const errSnippet =
              envelope.status === 'error'
                ? `${envelope.error.message}${envelope.error.snippet ? `\n${envelope.error.snippet}` : ''}`.slice(
                    0,
                    200,
                  )
                : undefined;
            setImmediate(() =>
              recordOutcome(profileStore, toolName, profileKey, argsSnippet, errSnippet),
            );

            const serialized = source.serializeForModel(envelope);
            // Only cache successful envelopes — denied/cancelled/error must
            // never be served from cache on a subsequent identical call.
            if (toolIsCacheable && envelope.status === 'ok') {
              setCachedResult(source.meta, args, serialized);
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
          if (!(await runBlockGate(toolName, args, toolDef, execOptions))) {
            return DENIED_LEGACY_RESULT;
          }
          if (!(await runGate(toolName, args, toolDef, execOptions))) {
            return CANCELLED_LEGACY_RESULT;
          }
          let result: unknown;
          try {
            result = await originalExecute(args, execOptions);
          } catch (thrown: unknown) {
            debugLog(
              `augment:${toolName}:threw`,
              thrown instanceof Error ? thrown.message : String(thrown),
            );
            throw thrown;
          }

          const profileKey = resolveProfileKey(toolName, args);
          const argsSnippet = safeSerialize(args);
          const capturedResult = result;
          setImmediate(() => {
            try {
              const errorInfo = detectToolError(toolName, capturedResult);
              const errSnippet = errorInfo.isError ? errorInfo.snippet : undefined;
              recordOutcome(profileStore, toolName, profileKey, argsSnippet, errSnippet);
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
