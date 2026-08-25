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
    result: 'Specialist did not produce valid structured output',
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
