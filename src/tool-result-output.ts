/**
 * Where a `tool-result` part keeps its value (#sdk-boundary).
 *
 * One question, asked in four places, answered four different ways before
 * this:
 *
 * ```
 * src/context.ts:96      const tr = part as { toolName?: string; result: unknown };
 * src/context.ts:425     msg.content.map((part: any) => … part.result …)
 * src/ui/Thread.tsx:785  renderResultSnippet(part.result)          // typed ToolResultPart
 * src/tools/ask-user-history.ts:154  (part as { result?: unknown }).result
 * ```
 *
 * A required cast, an explicit `any`, the SDK's own type, and an optional
 * cast. The next SDK major renames the field, and those four react
 * differently: one fails to compile (loud), one silently yields `undefined`
 * (`truncateToolResults` then stops truncating and every oversized result goes
 * back to the provider in full), one silently yields `undefined` (the
 * transcript renders `↳ undefined` under every tool call), and one silently
 * yields `undefined` (`ask_user` answers stop being injected into history).
 * Three of the four fail invisibly, and each in a different subsystem.
 * `src/image.ts` already records what four independent copies of one predicate
 * cost.
 *
 * ## The asymmetry that makes a mechanical rename wrong
 *
 * At STEP level — `StepResult.toolResults[i]` — the value is raw. Inside a
 * `role:'tool'` MESSAGE the part carries an ENVELOPE, `{type, value}`, because
 * a message part has to say how the value should be rendered back to the
 * model. So a find-and-replace across the two is right in one place and wrong
 * in the other, which is precisely the kind of edit an SDK bump invites. This
 * module owns the MESSAGE-part side only; step-level readers are unaffected
 * and must not call it.
 *
 * ## What it does today
 *
 * On `ai@4` the message part is `{type:'tool-result', toolCallId, toolName,
 * result}` — no envelope — so every function here is an identity pass on a
 * well-formed part, and {@link replaceToolResultOutput} returns the input by
 * REFERENCE when nothing needs converting. That is deliberate: it makes
 * adopting this provably free rather than merely cheap.
 *
 * The `output` branches are not dead code. They are the shape `ai@5` requires,
 * written and tested now so the bump flips {@link TOOL_RESULT_OUTPUT_TARGET}
 * and the direction of the conversion rather than discovering the problem on a
 * user's first turn after upgrading; and they are the rollback path, since a
 * history written by a bumped Bernard has to stay readable by an older one.
 *
 * ## The error distinction crosses, and it has to
 *
 * `LanguageModelV2ToolResultOutput` has FIVE members, not two — `text`, `json`,
 * `error-text`, `error-json` and `content` — so a downgrade that kept only the
 * VALUE would re-upgrade by guessing the type back from
 * `typeof value === 'string'`, and an `error-text` result would come back as an
 * ordinary `text` one. A result the provider was told was a failure would be
 * shown to the model as a success: the silent-failure class this whole boundary
 * exists to close, on the one path it introduces. It would also become
 * permanent, because `load` migrates in memory and `save` writes what the agent
 * holds.
 *
 * So the error bit is mapped through each vocabulary's OWN error channel rather
 * than by smuggling a v5 key into a v4 file: `ai@4`'s `ToolResultPart.isError`
 * and `ai@5`'s `error-*` output types. That is better than carrying `output`
 * alongside `result` in two ways. It round-trips with no duplicated value on
 * disk — which matters because `truncateToolResults` rewrites these parts, so a
 * retained envelope would hold the pre-truncation value and quietly undo the
 * size bound. And it is not merely recoverable but LIVE: `ai@4`'s
 * `convertToLanguageModelPrompt` forwards `isError`, and `@ai-sdk/anthropic`
 * emits it as `is_error`, so a downgraded error result is still flagged to the
 * provider. A stray `output` key would be ignored by that converter, leaving the
 * error unflagged on the wire for as long as the rollback lasted.
 *
 * **Residual, stated rather than discovered:** `content` degrades to `json`. The
 * VALUE survives intact and no failure is reclassified — only the rendering tag
 * is lost. `ai@4`'s analogue is `experimental_content`, whose element shape
 * genuinely differs from v5's (`{type:'image', data, mimeType}` against
 * `{type:'media', data, mediaType}`), so mapping it is a real conversion rather
 * than a passthrough, and minting an `experimental_`-prefixed field is a
 * commitment this module should not make quietly.
 */

/**
 * Which shape a `tool-result` message part must be in to reach the provider —
 * the installed SDK's, not a preference.
 *
 * `ai@4` wants a bare `result`. `ai@5` wants `output: {type, value}` and types
 * it as required. Flipping this constant, and the `TARGET === 'result'`
 * branches it guards, is the whole of this module's SDK bump.
 */
export const TOOL_RESULT_OUTPUT_TARGET: 'result' | 'output' = 'result';

/** A `tool-result` part, in either shape, before we know which. */
type ToolResultPartLike = {
  type?: unknown;
  result?: unknown;
  output?: unknown;
  /** `ai@4`'s own error channel. `ai@5` folds this into `output.type`. */
  isError?: unknown;
};

/** The `ai@5` output types that mean "this tool call failed". */
const ERROR_OUTPUT_TYPES: ReadonlySet<string> = new Set(['error-text', 'error-json']);

/**
 * The `ai@5` output type for a value that arrived without one.
 *
 * Exported because it is the half of the round trip no test can execute today:
 * it is reached only from the `output` branch of
 * {@link replaceToolResultOutput}, which {@link TOOL_RESULT_OUTPUT_TARGET}
 * currently guards off. Testing it directly is honest; asserting the round trip
 * by composing it with the live downgrade is what pins that the error bit
 * survives.
 */
export function toolResultOutputType(value: unknown, isError: boolean): string {
  if (isError) return typeof value === 'string' ? 'error-text' : 'error-json';
  return typeof value === 'string' ? 'text' : 'json';
}

/** The `ai@5` envelope: a value plus how to render it back to the model. */
interface ToolResultOutputEnvelope {
  type: string;
  value: unknown;
}

/**
 * Deliberately NOT `tool-result-shape.isPlainObject`, which is the obvious
 * reuse. That predicate requires a literal `Object.prototype`, correctly, since
 * it guards against a class instance arriving in an untrusted MCP payload. The
 * question here is a different one — "is this a message part I can read a field
 * off" — where a reader should be liberal, and importing it would give this
 * zero-import leaf an edge to `error-taxonomy.js` for one line.
 */
function asPart(part: unknown): ToolResultPartLike | null {
  return part !== null && typeof part === 'object' ? (part as ToolResultPartLike) : null;
}

function asEnvelope(value: unknown): ToolResultOutputEnvelope | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as { type?: unknown; value?: unknown };
  return typeof v.type === 'string' && 'value' in v ? (v as ToolResultOutputEnvelope) : null;
}

/**
 * The raw value a `tool-result` MESSAGE part carries, whichever shape it is in.
 *
 * Returns `undefined` for a part carrying neither — which is also what every
 * predecessor returned for a malformed part, so the callers' existing
 * `typeof x === 'string' ? … : JSON.stringify(x)` handling is unchanged.
 *
 * Do NOT call this on a step-level `toolResults[i]`: there the value is raw and
 * an envelope unwrap would be wrong. See the module docstring.
 */
export function unwrapToolResultOutput(part: unknown): unknown {
  const p = asPart(part);
  if (!p) return undefined;
  if ('result' in p) return p.result;
  const envelope = asEnvelope(p.output);
  return envelope ? envelope.value : p.output;
}

/**
 * A copy of `part` carrying `value`, in the shape the installed SDK requires.
 *
 * Returns `part` BY REFERENCE when it is already in the target shape and the
 * value is unchanged, so a caller that rewrites nothing allocates nothing —
 * which is what keeps `truncateToolResults`' "return the same array when
 * nothing changed" contract exact rather than approximate.
 */
export function replaceToolResultOutput<T>(part: T, value: unknown): T {
  const p = asPart(part);
  if (!p) return part;
  const existing = asEnvelope(p.output);
  if (TOOL_RESULT_OUTPUT_TARGET === 'result') {
    // A v4-origin part has no `output`, so it comes straight back and never
    // starts rewriting itself on every load.
    if ('result' in p && p.result === value && !('output' in p)) return part;
    const { output: _dropped, ...rest } = p;
    // The envelope's `type` is dropped, but its FAILURE bit is not: it moves to
    // `isError`, which is v4's own channel for exactly this and which the SDK
    // forwards to the provider. Without it, `error-text` would re-upgrade as
    // `text` and a failure would read as a success.
    return (
      existing && ERROR_OUTPUT_TYPES.has(existing.type)
        ? { ...rest, result: value, isError: true }
        : { ...rest, result: value }
    ) as T;
  }
  if (existing && existing.value === value && !('result' in p)) return part;
  // `isError` is not carried over: on `ai@5` the failure bit lives in the
  // output TYPE, so keeping both would be two channels saying one thing.
  const { result: _dropped, isError: _folded, ...rest } = p;
  const type = existing?.type ?? toolResultOutputType(value, p.isError === true);
  return { ...rest, output: { type, value } } as T;
}

/**
 * Puts a `tool-result` part into the shape the installed SDK requires,
 * returning it BY REFERENCE when it is already there.
 *
 * This is the read-side and write-side composed, which is what makes the
 * migration in `HistoryStore.load` one call rather than a second copy of the
 * same knowledge.
 */
export function normalizeToolResultPart<T>(part: T): T {
  const p = asPart(part);
  if (!p || p.type !== 'tool-result') return part;
  return replaceToolResultOutput(part, unwrapToolResultOutput(part));
}
