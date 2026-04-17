/**
 * Maximum characters returned from a sub-agent or specialist to the parent agent's context.
 * The user still sees full output via printToolResult in onStepFinish.
 */
export const SUBAGENT_RESULT_MAX_CHARS = 4000;

/**
 * Caps a sub-agent or specialist result string to prevent context bloat in the parent agent.
 */
export function capSubagentResult(
  text: string,
  maxChars: number = SUBAGENT_RESULT_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n...[output truncated at ${maxChars} chars]`;
}
