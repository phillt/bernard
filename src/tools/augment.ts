import { type ToolProfileStore, classifyShellCommand, detectToolError } from '../tool-profiles.js';
import { debugLog } from '../logger.js';
import { printInfo } from '../output.js';
import { readBernardSource, readToolMeta, preserveMeta } from '../framework/tools/adapter.js';
import type { ToolResult } from '../framework/tools/types.js';
import { classifyError } from '../error-taxonomy.js';
import type { ConfirmActionInput, ToolOptions } from './types.js';
import type { ConfirmThreshold } from '../risk.js';
import { riskFromMeta, shouldConfirm } from '../risk.js';

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
 */
export interface AugmentOptions {
  profileStore: ToolProfileStore;
  confirmThreshold?: ConfirmThreshold;
  confirmAction?: ToolOptions['confirmAction'];
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
  const confirmThreshold = opts.confirmThreshold;
  const confirmAction = opts.confirmAction;
  const augmented: Record<string, any> = {};

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
    const risk = riskFromMeta(meta);
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
            if (!(await runGate(toolName, args, toolDef, execOptions))) {
              const cancelled: ToolResult<unknown> = {
                status: 'error',
                error: { type: 'cancelled', message: 'Action cancelled by user.' },
              };
              return source.serializeForModel(cancelled);
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

            return source.serializeForModel(envelope);
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
