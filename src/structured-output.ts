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
export function parseStructuredOutput<T>(text: string, schema: z.ZodType<T>): T | undefined {
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

export const WrapperResultSchema = z.object({
  status: z.enum(['ok', 'error']),
  result: z.any(),
  error: z.string().optional(),
  reasoning: z.array(z.string()).optional(),
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
    if (error !== undefined) out.error = error;
    if (reasoning !== undefined) out.reasoning = reasoning;
    return out;
  }
  return {
    status: 'error',
    result: 'Specialist did not produce valid structured output',
    error: 'parse_failed',
    reasoning: [text.trim().slice(0, 500)],
  };
}

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
  "error": "<short error message, only when status is 'error'>",
  "reasoning": ["<short rationale for each significant decision or tool call>"]
}

Rules:
- Emit the JSON only once, as your last message.
- \`reasoning\` is an array of short strings. One entry per significant tool call explaining WHY you chose it (not what it returned).
- Never include confidence scores — the downstream pipeline ignores them.
- If a tool call fails irrecoverably, set \`status\` to "error", put the cause in \`error\`, and still include your reasoning.`;
