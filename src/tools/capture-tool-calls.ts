import { readToolMeta } from '../framework/tools/adapter.js';
import type { ToolMeta } from '../framework/tools/types.js';
import { redactArgs, REDACTED } from '../framework/tools/redact.js';

/**
 * Turning a dispatch's `result.steps` into a compact, redacted record.
 *
 * A leaf, so both dispatch paths can reach it. It lived in
 * `tool-wrapper-run.ts`, which `specialist-run.ts` cannot import — that edge is
 * the import cycle the dispatch overlay was restructured to avoid, since
 * `tool-wrapper-run.ts` imports `specialist-run.ts` and nothing imports back.
 * The functions are pure and depend only on the tool metadata, so a leaf is
 * where they belong rather than beside one of their two callers.
 */

/**
 * Captures the last tool call observed in a `generateText` result.
 * Used to populate `attemptedCall` on correction candidates.
 */
export function captureLastToolCall(steps: any[] | undefined): string {
  if (!steps || steps.length === 0) return '(no tool call)';
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const calls = step?.toolCalls ?? [];
    if (calls.length > 0) {
      const tc = calls[calls.length - 1];
      try {
        return `${tc.toolName} ${JSON.stringify(tc.args).slice(0, 600)}`;
      } catch {
        return `${tc.toolName} (unserializable args)`;
      }
    }
  }
  return '(no tool call)';
}

/** Max characters of a tool result retained in the reasoning log. */
const RESULT_PREVIEW_MAX_CHARS = 300;

/**
 * Renders a tool result for the reasoning log (#343).
 *
 * Was `String(value)`, which yields `"[object Object]"` for the majority of
 * Bernard tools — `shell` returns `{output, is_error}`, the file tools return
 * objects, MCP returns `{content:[…]}`. The one field recording what a tool
 * actually returned carried no information, in the log whose stated purpose is
 * post-hoc triage.
 *
 * **Bounded, because the inputs are not.** `shell` runs with a 10 MB
 * `maxBuffer` and caps nothing on the way out, and `file_read_lines` reads up
 * to `MAX_FILE_SIZE`. A plain `JSON.stringify` of a 10 MB result to keep 300
 * bytes measured 38 ms and ~20 MB of transient allocation, synchronously, on
 * every tool call the shim routes — where `String()` had been free. The
 * replacer truncates long strings during serialization instead, which measures
 * at 0 ms on the same input and renders identically at this preview length.
 *
 * The `try`/`catch` is load-bearing rather than defensive: `JSON.stringify`
 * throws on cycles and BigInt, `appendReasoningLog` is documented as never
 * throwing, and AI SDK results are `any`. Same idiom as `mcp-result-shaper.ts`.
 */
function previewOfResult(value: unknown): string {
  if (value === undefined) return '';
  let text: string;
  try {
    text =
      JSON.stringify(value, (_key, v: unknown) =>
        typeof v === 'string' && v.length > RESULT_PREVIEW_MAX_CHARS
          ? v.slice(0, RESULT_PREVIEW_MAX_CHARS)
          : v,
      ) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.slice(0, RESULT_PREVIEW_MAX_CHARS);
}

/**
 * How a capture finds a tool's redaction metadata.
 *
 * A lookup rather than the registry itself, so nothing has to hand a *registry*
 * around to get two booleans off `ToolMeta`. `RunDefinitionResult` publishes one
 * of these; before it, the persona path was given the un-augmented registry —
 * every tool's `execute` with the deny, write-scope and confirm gates stripped
 * off — on the public result of every dispatch in the product, to read
 * `sensitiveArgs`. Same reasoning as the `toolBytes: () => number` accessor
 * beside it: publish the answer, not the thing that can answer.
 */
export type ToolMetaLookup = (toolName: string) => ToolMeta | undefined;

/** A lookup over a registry, for the callers that hold one. */
export function metaLookup(registry: Record<string, unknown>): ToolMetaLookup {
  return (name) => readToolMeta(registry[name]);
}

/**
 * Builds a compact record of tool calls for the reasoning log.
 *
 * Each call's args and result preview are scrubbed against the tool's
 * `ToolMeta.sensitiveArgs` / `sensitiveResult` before persistence.
 */
export function captureToolCalls(
  steps: any[] | undefined,
  // REQUIRED, and that is the fix rather than passing it at one more call site.
  // Optional, it made an UNREDACTED log the default: `specialist-run.ts` omitted
  // it and a persona's `shell` command went to disk verbatim, which since #501
  // is read back and fed to a model. Required, a third dispatch path that
  // forgets is a compile error instead of a silent privacy leak.
  metaFor: ToolMetaLookup,
): Array<{
  tool: string;
  args: unknown;
  resultPreview: string;
}> {
  if (!steps) return [];
  const out: Array<{ tool: string; args: unknown; resultPreview: string }> = [];
  for (const step of steps) {
    const calls = step?.toolCalls ?? [];
    const results = step?.toolResults ?? [];
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i];
      const tr = results[i];
      const meta = metaFor(tc.toolName);
      out.push({
        tool: tc.toolName,
        args: meta ? redactArgs(tc.args, meta.sensitiveArgs) : tc.args,
        // Short-circuit BEFORE serializing: a redacted preview was previously
        // computed and thrown away, which now means materializing a
        // secret-bearing payload into a transient string for no reason.
        resultPreview: meta?.sensitiveResult ? REDACTED : previewOfResult(tr?.result),
      });
    }
  }
  return out;
}
