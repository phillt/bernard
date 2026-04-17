/**
 * Default cap on characters returned from a sub-agent or specialist to the
 * parent agent's context. The user still sees full output via printToolResult
 * in onStepFinish.
 */
export const DEFAULT_SUBAGENT_RESULT_MAX_CHARS = 4000;

/**
 * Parses a raw env-var value into a positive integer cap.
 * Falls back to {@link DEFAULT_SUBAGENT_RESULT_MAX_CHARS} when the input is
 * missing, non-numeric, or below 1.
 */
export function parseSubagentResultMaxChars(raw: string | undefined): number {
  if (!raw) return DEFAULT_SUBAGENT_RESULT_MAX_CHARS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_SUBAGENT_RESULT_MAX_CHARS;
  return Math.floor(parsed);
}

/**
 * Resolved cap, honoring the BERNARD_SUBAGENT_RESULT_MAX_CHARS env var.
 * Read once at module load. Set the env var before launching Bernard to override.
 */
export const SUBAGENT_RESULT_MAX_CHARS = parseSubagentResultMaxChars(
  process.env.BERNARD_SUBAGENT_RESULT_MAX_CHARS,
);

/**
 * Caps a sub-agent or specialist result string to prevent context bloat in
 * the parent agent. The total returned length is guaranteed to be `<= maxChars`
 * — the truncation marker is included in the budget. When `maxChars` is
 * smaller than the marker itself, a truncated marker is returned.
 */
export function capSubagentResult(
  text: string,
  maxChars: number = SUBAGENT_RESULT_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const marker = `\n...[output truncated at ${maxChars} chars]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  return text.slice(0, maxChars - marker.length) + marker;
}
