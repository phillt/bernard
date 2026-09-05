import { z } from 'zod';

/**
 * Scans a string for the first balanced JSON object starting at `start`
 * (which must point at a `{`). Returns the slice containing the object,
 * or `undefined` if no balanced block is found.
 *
 * Respects string literals so braces inside quoted strings don't break depth.
 */
export function extractJsonBlock(text: string, start: number): string | undefined {
  if (text[start] !== '{') return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Attempts to parse a JSON object from `text` and validate it with `schema`.
 *
 * Strategy:
 * 1. Try `JSON.parse` on the trimmed input directly.
 * 2. Otherwise scan for each top-level `{` and try bracket-counted extraction.
 *
 * @returns The validated object on success, or `undefined` if nothing parses.
 */
export function parseStructuredOutput<S extends z.ZodTypeAny>(
  text: string,
  schema: S,
): z.output<S> | undefined {
  // Generic over the schema, not over `T`: `z.ZodType<T>` defaults its Input to
  // T, so a schema carrying a `.transform` (see `nullableOptional`) would infer
  // the pre-transform type and hand callers back the `null`s it just removed.
  const trimmed = text.trim();

  // 1. Direct parse
  try {
    const parsed = JSON.parse(trimmed);
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // fall through
  }

  // 2. Scan forward for balanced blocks
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '{') {
      const block = extractJsonBlock(trimmed, i);
      if (block) {
        try {
          const parsed = JSON.parse(block);
          const result = schema.safeParse(parsed);
          if (result.success) return result.data;
        } catch {
          // try next
        }
        i += block.length - 1;
      }
    }
  }

  return undefined;
}

/**
 * Minimal structured result emitted by tool-wrapper specialists.
 *
 * Intentionally narrow (no confidence scores — models are poor at calibrating
 * those; see issue #106 discussion). `reasoning` is the most valuable field
 * for debugging — it explains why each tool call was made.
 */
export interface WrapperResult {
  status: 'ok' | 'error';
  result: unknown;
  error?: string;
  reasoning?: string[];
}

/**
 * An optional field that also tolerates an explicit `null` (#341).
 *
 * A model shown a JSON template with four keys emits four keys, and puts `null`
 * in the one that does not apply — which is the reasonable reading of the shape
 * we hand it. `z.string().optional()` accepts `string | undefined` but **not**
 * `null`, so `{"status":"ok","result":{...},"error":null}` failed validation and
 * the whole payload was discarded as `parse_failed`. Observed at 18 of 37
 * wrapper runs in one session — every one of them work that had already
 * succeeded, thrown away and reported to the parent as an error.
 *
 * Widening the schema is only half the job — `null` must also be **normalized
 * away**, because the public types declare `error?: string` and downstream
 * sites test `!== undefined` before spreading the field into the reasoning log
 * and the parent agent's JSON. The `.transform` does that here, at the parse
 * boundary, so every consumer keeps its pre-existing `!== undefined` check and
 * no caller has to remember. Normalizing at each consumer instead needs the
 * question "did we cover them all?" answered by hand, once per field.
 *
 * The key stays optional in the inferred type: `isOptional()` is
 * `safeParse(undefined).success`, which survives the `ZodEffects` wrapper.
 */
export function nullableOptional<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform((v) => v ?? undefined);
}

export const WrapperResultSchema = z.object({
  status: z.enum(['ok', 'error']),
  result: z.any(),
  error: nullableOptional(z.string()),
  reasoning: nullableOptional(z.array(z.string())),
});

/**
 * The `result` text {@link wrapWrapperResult} mints when it could not parse the
 * specialist's final message.
 *
 * Named rather than inlined because a downstream consumer has to be able to
 * tell *our* parse failure from a `parse_failed` the **model** wrote (#370).
 * `error` is free-form — {@link STRUCTURED_OUTPUT_RULES} explicitly instructs
 * the specialist to "put the cause in `error`" — so a specialist reporting a
 * downstream parse failure legitimately emits
 * `{"status":"error","error":"parse_failed"}` with its own prose in `result`.
 * Matching on `error` alone conflated the two.
 */
export const WRAPPER_PARSE_FAILURE_RESULT = 'Specialist did not produce valid structured output';

/**
 * Whether this envelope is the one {@link wrapWrapperResult} mints on a parse
 * failure of its own, as opposed to one the model authored (#370).
 *
 * Both fields are required, and that is the whole point: `error` is a field the
 * model writes, `result` here is a constant we write. A model-authored
 * `parse_failed` carries its own `result` and so does not match.
 */
export function isWrapperParseFailure(w: WrapperResult): boolean {
  return (
    w.status === 'error' && w.error === 'parse_failed' && w.result === WRAPPER_PARSE_FAILURE_RESULT
  );
}

/**
 * Wraps raw specialist text output into a {@link WrapperResult}. Missing or
 * malformed JSON becomes a structured error (not silent success).
 */
export function wrapWrapperResult(text: string): WrapperResult {
  const parsed = parseStructuredOutput(text, WrapperResultSchema);
  if (parsed) {
    const { status, result, error, reasoning } = parsed;
    const out: WrapperResult = { status, result };
    // `nullableOptional` already turned any `null` into `undefined`, so these
    // are the same checks as before #341.
    if (error !== undefined) out.error = error;
    if (reasoning !== undefined) out.reasoning = capReasoning(reasoning);
    return out;
  }
  return {
    status: 'error',
    result: WRAPPER_PARSE_FAILURE_RESULT,
    error: 'parse_failed',
    reasoning: [text.trim().slice(0, REASONING_MAX_CHARS)],
  };
}

/**
 * Defense-in-depth cap on the `reasoning` array (#175). Keeps at most
 * {@link REASONING_MAX_ENTRIES} entries and trims each to
 * {@link REASONING_MAX_CHARS} characters. The prompt asks the model to stay
 * within these bounds; this enforces them when it doesn't.
 */
export function capReasoning(reasoning: string[]): string[] {
  return reasoning
    .slice(0, REASONING_MAX_ENTRIES)
    .map((entry) =>
      entry.length > REASONING_MAX_CHARS ? entry.slice(0, REASONING_MAX_CHARS) : entry,
    );
}

/** Maximum number of `reasoning` entries kept after parsing (#175). */
export const REASONING_MAX_ENTRIES = 5;
/** Maximum length of a single `reasoning` entry after parsing (#175). */
export const REASONING_MAX_CHARS = 200;

/**
 * Rules appended to a tool-wrapper specialist's system prompt. Instructs the
 * child to emit a JSON object as its final message.
 */
export const STRUCTURED_OUTPUT_RULES = `

## Output Format (STRICT)

Your FINAL message MUST be a single valid JSON object with this shape and nothing else — no prose before or after, no markdown code fences:

{
  "status": "ok" | "error",
  "result": <any valid JSON value representing the outcome>,
  "error": "<short error message — include this key ONLY when status is 'error'>",
  "reasoning": ["<short rationale for each significant decision or tool call>"]
}

Rules:
- Be minimal. The JSON IS the output — no narrative, no explanations, no apologies outside the JSON.
- OMIT a key you have nothing to put in rather than sending \`null\`. On success, \`error\` should be absent, not \`"error": null\`.
- Emit the JSON only once, as your last message.
- \`result\` is the concrete outcome (a path, a value, a short summary). Do NOT restate the user's request, and do NOT echo raw tool output the caller already has.
- \`reasoning\` is OPTIONAL. Include at most ${REASONING_MAX_ENTRIES} entries, each one short sentence (≤25 words / ~${REASONING_MAX_CHARS} characters). Omit \`reasoning\` entirely when \`status\` is "ok" and the call was straightforward. Excess entries / overlong entries are truncated downstream — keep them short to stay in control of what survives.
- One reasoning entry per significant tool call, explaining WHY you chose it (not what it returned).
- Never include confidence scores — the downstream pipeline ignores them.
- If a tool call fails irrecoverably, set \`status\` to "error", put the cause in \`error\`, and include a brief \`reasoning\` entry naming the failed step.`;

/**
 * Whether a specialist must emit the `{status, result, error?, reasoning?}`
 * envelope as its final message.
 *
 * **One decision, two dispatch paths.** `tool_wrapper_run` and an applet action
 * both resolve this, and they used to disagree: the applet path defaulted an
 * undeclared specialist to `true` while `tool_wrapper_run` defaulted it to
 * `kind === 'tool-wrapper'`. The `specialist` tool's own parameter description
 * — the contract a model reads while creating one — promises the latter:
 * *"Default: true for tool-wrapper kind, false otherwise."*
 *
 * The disagreement was not theoretical. `agent-builder`, the bundled specialist
 * whose whole job is building the agent behind an applet button, sets neither
 * `kind` nor `structuredOutput`. So every agent it produced asked for a bare
 * result, was silently required to produce an envelope it had never been told
 * about, and failed `parse_failed` after burning a full dispatch — while the
 * identical record invoked through `tool_wrapper_run` worked. Two paths reading
 * one record and reaching opposite conclusions is the shape
 * `invocationRefusal` exists to prevent, so this is the same answer: a named
 * function neither call site is free to re-derive.
 *
 * Structurally typed rather than taking a `Specialist`, so this stays a
 * zod-only leaf — `specialists.ts` opens `node:fs`, and both callers hold the
 * record already.
 */
export function wantsStructuredOutput(
  specialist: { kind?: string; structuredOutput?: boolean } | null | undefined,
): boolean {
  // An explicit declaration always wins; `??` fires only when the field is
  // ABSENT, which is why aligning the default touched no bundled specialist —
  // every non-tool-wrapper one of those declares it outright.
  return specialist?.structuredOutput ?? specialist?.kind === 'tool-wrapper';
}

/** Keys named in the envelope, for telling "wrong shape" from "not JSON". */
const ENVELOPE_KEYS = ['status', 'result', 'error', 'reasoning'];

/**
 * Says what a specialist actually returned when its output would not parse.
 *
 * `parse_failed` on its own is unfalsifiable. A real session spent ~30 minutes
 * and 50 messages on one, because the log said `parse_failed` and the envelope
 * said `parse_failed` and nothing anywhere said what had been produced instead
 * — while the answer ("a bare scorecard, no `status` key") was sitting in
 * `WrapperResult.reasoning[0]` the whole time and was dropped one line before
 * it would have been logged.
 *
 * **Keys, never values.** The invocation log's standing rule is that argument
 * names are loggable and argument contents are not, and a specialist's output
 * can echo its input. Naming the keys is what makes the failure diagnosable;
 * printing the payload would be a disclosure this file has no business making.
 * It is also the more useful half — `url, title, outlet` identifies the shape
 * instantly, where 200 characters of prose would not.
 *
 * Reads the capped `reasoning[0]`, so the JSON is usually cut mid-object and
 * cannot be re-parsed. Hence a key scan rather than `JSON.parse`: it does not
 * distinguish nesting depth, which does not matter — the question is only ever
 * "is this the envelope, and if not, what is it?"
 */
export function describeParseFailure(reasoning: string[] | undefined): string {
  const text = reasoning?.[0]?.trim() ?? '';
  if (!text) {
    return 'The specialist returned nothing to parse — it may have run out of steps before answering.';
  }
  const keys = [...new Set([...text.matchAll(/"([A-Za-z_][\w-]*)"\s*:/g)].map((m) => m[1]))];
  if (keys.length === 0) {
    return `Expected a JSON {status, result} envelope; the specialist returned ${text.length}+ characters of non-JSON text.`;
  }
  const missing = ENVELOPE_KEYS.filter(
    (k) => !keys.includes(k) && k !== 'error' && k !== 'reasoning',
  );
  const seen = keys.slice(0, 8).join(', ');
  const more = keys.length > 8 ? `, +${keys.length - 8} more` : '';
  if (missing.length === 0) {
    return `The specialist returned a JSON object with the envelope keys (${seen}${more}) but it did not match the expected shape.`;
  }
  return (
    `Expected a JSON {status, result} envelope; the specialist returned an object with ` +
    `keys: ${seen}${more} — no ${missing.join(' or ')}. ` +
    `Either set structuredOutput on the specialist and tell it to emit the envelope, or leave it unset so the raw result is returned.`
  );
}
