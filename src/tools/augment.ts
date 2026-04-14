import { type ToolProfileStore, classifyShellCommand, detectToolError } from '../tool-profiles.js';
import { debugLog } from '../logger.js';
import { printInfo } from '../output.js';

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
 * Wraps every tool's `execute` function to observe results and record
 * error examples to the profile store, and patch fixes when the model
 * retries successfully. The recording is fire-and-forget via `setImmediate`
 * so it never adds latency to tool execution.
 *
 * Does NOT modify tool descriptions, parameters, or any other field.
 */
/**
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

    const originalExecute = toolDef.execute;

    augmented[toolName] = {
      ...toolDef,
      execute: async (args: unknown, execOptions: unknown) => {
        let result: unknown;
        try {
          result = await originalExecute(args, execOptions);
        } catch (thrown: unknown) {
          // Infrastructure-level throws (MCP reconnect, network, etc.) are not
          // usage errors — don't record them as bad examples.
          debugLog(
            `augment:${toolName}:threw`,
            thrown instanceof Error ? thrown.message : String(thrown),
          );
          throw thrown;
        }

        // Non-blocking observation: record error/success in the next event loop tick
        const profileKey = resolveProfileKey(toolName, args);
        const capturedResult = result;
        setImmediate(() => {
          try {
            const errorInfo = detectToolError(toolName, capturedResult);
            const argsSnippet = safeSerialize(args);

            if (errorInfo.isError) {
              profileStore.recordBadExample(profileKey, argsSnippet, errorInfo.snippet);
              debugLog(`augment:${toolName}:error`, { profileKey, snippet: errorInfo.snippet });
              printInfo(`  ~ profile ${profileKey} — recorded error`);
            } else {
              // On success, check if we should patch the last unfixed bad example
              const profile = profileStore.get(profileKey);
              if (
                profile?.badExamples.length &&
                profile.badExamples[profile.badExamples.length - 1].fix ===
                  '(awaiting successful retry)'
              ) {
                profileStore.patchLastBadWithFix(profileKey, argsSnippet);
                debugLog(`augment:${toolName}:patched`, { profileKey });
                printInfo(`  ~ profile ${profileKey} — learned fix`);
              }
            }
          } catch {
            // Recording must never propagate errors
          }
        });

        return result;
      },
    };
  }

  return augmented;
}
