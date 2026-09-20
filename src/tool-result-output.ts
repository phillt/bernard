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
};

/** The `ai@5` envelope: a value plus how to render it back to the model. */
interface ToolResultOutputEnvelope {
  type: string;
  value: unknown;
}

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
  if (TOOL_RESULT_OUTPUT_TARGET === 'result') {
    if ('result' in p && p.result === value && !('output' in p)) return part;
    const { output: _dropped, ...rest } = p;
    return { ...rest, result: value } as T;
  }
  const existing = asEnvelope(p.output);
  if (existing && existing.value === value && !('result' in p)) return part;
  const { result: _dropped, ...rest } = p;
  // `text` is the only type an older history can be read back as without
  // guessing: a v4 `result` records no rendering intent, and claiming `json`
  // for a value that happens to be an object would change how the model is
  // shown it.
  const type = existing?.type ?? (typeof value === 'string' ? 'text' : 'json');
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
