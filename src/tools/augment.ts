import { type ToolProfileStore, classifyShellCommand, detectToolError } from '../tool-profiles.js';
import { debugLog } from '../logger.js';
import { printInfo } from '../output.js';
import { readBernardSource, preserveMeta } from '../framework/tools/adapter.js';
import type { ToolResult } from '../framework/tools/types.js';
import { classifyError } from '../error-taxonomy.js';

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
 */
export function augmentTools(
  tools: Record<string, any>,
  profileStore: ToolProfileStore,
): Record<string, any> {
  const augmented: Record<string, any> = {};

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
    // been migrated. Behavior is unchanged from pre-Phase-B.
    const originalExecute = toolDef.execute;
    augmented[toolName] = preserveMeta(
      {
        ...toolDef,
        execute: async (args: unknown, execOptions: unknown) => {
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
