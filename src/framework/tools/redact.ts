/**
 * Returns a shallow copy of `args` with any keys listed in `sensitiveArgs`
 * replaced by the string `'[REDACTED]'`. Used to scrub sensitive values out
 * of reasoning logs, cron step logs, and cache keys before they are persisted.
 *
 * Returns `args` unchanged when `sensitiveArgs` is empty/undefined or when
 * `args` is not a plain object.
 */
export const REDACTED = '[REDACTED]' as const;

export function redactArgs(args: unknown, sensitiveArgs: string[] | undefined): unknown {
  if (!sensitiveArgs || sensitiveArgs.length === 0) return args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of sensitiveArgs) {
    if (key in copy) copy[key] = REDACTED;
  }
  return copy;
}
