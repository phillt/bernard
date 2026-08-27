/**
 * Structural detection of a **non-throwing** tool failure (#363).
 *
 * A tool can fail in two ways. It can throw — which every layer already
 * handles — or it can return, successfully, a value whose *contents* say the
 * work did not happen. The second kind is invisible unless something inspects
 * the shape, and the shapes differ per tool: `shell` uses `is_error`, the file
 * tools use `{error}`, MCP uses the `CallToolResult` envelope's `isError`.
 *
 * ## Why its own module
 *
 * Three call sites need this answer and they sit in different layers:
 * `tool-profiles.detectToolError` (learning + UI coloring), `tools/augment`'s
 * inline pre-recording check (evidence registration + `tool:execute:end`
 * status), and `mcp-result-shaper` (which must not drop the flag while
 * truncating). `tool-profiles.ts` opens `node:fs` and `paths.ts` at import, so
 * making the shaper depend on it to ask a pure question about a plain object is
 * the same edge `tool-bytes.ts` was carved out to avoid.
 *
 * They also had *drifted*: augment's inline check tested `is_error === true ||
 * 'error' in result` while `detectToolError` tested `{error}` for exactly two
 * named file tools and a string prefix for everything else. Two predicates for
 * one question is how `file_write` (#342) shipped uncovered — its `{error}`
 * shape is identical to `file_edit_lines`', which *is* named — and how every
 * MCP tool went uncovered from the start. Measured on a real install: of 100
 * learned tool profiles, the only ones that had ever recorded a failure were
 * the handful whose shape was hard-coded. `open-browser-tab` sat at 84
 * successes / 0 errors across sessions where it demonstrably failed.
 *
 * This module is the single structural answer. Tool-*specific* string
 * conventions that can't be inferred from shape (`web_search`'s "returned no
 * results") deliberately stay with their tool in `detectToolError`.
 */

/** Max length of a returned error snippet, matching the historical cap. */
export const ERROR_SNIPPET_MAX = 200;

/**
 * A JSON-ish record, not a class instance. Exported because `mcp-result-shaper`
 * needs the same test and already imports this module — it had its own
 * byte-identical copy, which is the drift this module exists to stop.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

/** A string that is present and carries information — `''` is not a failure. */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/**
 * The failure text of an MCP `content` array, in one bounded pass.
 *
 * Entries carrying their own `isError: true` win: when a server flags the
 * individual item rather than the envelope, the unflagged siblings are
 * ordinary output that would dilute the snippet. When nothing is flagged the
 * whole content is the failure text.
 *
 * Both buckets stop growing at `limit` because the caller only ever keeps the
 * first `limit` characters. Accumulating past it means concatenating the entire
 * payload to throw all but 200 bytes away — for a full accessibility snapshot
 * (reachable with `BERNARD_MCP_RESULT_SHAPING=off`, which leaves `content`
 * uncapped) that is ~6 ms and a multi-megabyte transient, per failed call, on
 * the path between a tool returning and its value reaching the model. The scan
 * itself still visits every entry: a flagged entry may be last, and which
 * bucket wins is not known until the array is exhausted.
 */
function mcpFailureText(content: unknown, limit: number): string {
  if (!Array.isArray(content)) return '';
  const flagged: string[] = [];
  const all: string[] = [];
  let flaggedLen = 0;
  let allLen = 0;
  for (const item of content) {
    if (!isPlainObject(item)) continue;
    if (flaggedLen >= limit) break; // flagged already wins and is already full
    const text = nonEmptyString(item.text);
    if (!text) continue;
    if (item.isError === true) {
      flagged.push(text);
      flaggedLen += text.length + 1;
    }
    if (allLen < limit) {
      all.push(text);
      allLen += text.length + 1;
    }
  }
  return (flagged.length ? flagged : all).join('\n');
}

/**
 * True when `result` carries MCP's `isError` flag — on the envelope
 * (`{content, isError: true}`, what the spec defines) or on an individual
 * content entry (`{content: [{text, isError: true}], isError: false}`, which
 * real servers emit and which the envelope check alone misses). Both shapes
 * were observed from a single server within one session.
 *
 * The envelope test deliberately does not require a `content` array: the result
 * shaper re-stamps `isError` onto its truncation wrapper, which has no
 * `content`, and that wrapper still has to read as a failure.
 */
export function isMCPErrorResult(result: unknown): boolean {
  if (!isPlainObject(result)) return false;
  if (result.isError === true) return true;
  return (
    Array.isArray(result.content) &&
    result.content.some((item) => isPlainObject(item) && item.isError === true)
  );
}

/**
 * The failure text of a non-throwing tool result, or `undefined` when the
 * result looks like a success. Pure, total, and never throws — callers use it
 * on the hot path between a tool returning and its value reaching the model.
 *
 * Recognized shapes, in order:
 *  - MCP `CallToolResult` with `isError` on the envelope or a content entry
 *  - `{is_error: true}` (`shell`, and the legacy denied/cancelled markers)
 *  - `{error: <non-empty string>}` (every `file_*` tool, and others by shape)
 *  - a string beginning with `"Error"` (the historical MCP/`web_read` form)
 *
 * A non-string `error`, an empty `error`, or `isError: false` are all treated
 * as success — a truthiness test on the *key* would misread `{error: null}`,
 * which is what `structured-output`'s `nullableOptional` leaves behind.
 */
export function detectResultFailure(result: unknown): string | undefined {
  if (typeof result === 'string') {
    return result.startsWith('Error') ? result.slice(0, ERROR_SNIPPET_MAX) : undefined;
  }

  // Covers null/undefined and class instances too, so no separate nullish guard.
  if (!isPlainObject(result)) return undefined;

  if (isMCPErrorResult(result)) {
    // Falls back to a truncation wrapper's `preview`, then to a bare marker, so
    // the snippet is never empty — an empty snippet reads as success to
    // `recordOutcome`.
    const snippet =
      mcpFailureText(result.content, ERROR_SNIPPET_MAX) ||
      nonEmptyString(result.preview) ||
      'MCP tool reported isError';
    return snippet.slice(0, ERROR_SNIPPET_MAX);
  }

  if (result.is_error === true) {
    return String(result.output ?? '').slice(0, ERROR_SNIPPET_MAX);
  }

  const err = nonEmptyString(result.error);
  if (err) return err.slice(0, ERROR_SNIPPET_MAX);

  return undefined;
}
