/**
 * @module watchers/duration
 *
 * Turning `2h`, `90m`, `until 15:30` into an instant. A pure leaf.
 *
 * Deliberately tiny and deliberately not a date library: the shapes a person
 * actually types at a prompt are a duration and a time today, and anything
 * richer is a parser nobody can predict the behaviour of. What it cannot read it
 * REFUSES — a sleep that silently lands at the wrong hour is worse than one that
 * did not start, because the user believes it is set.
 */

const DURATION_RE =
  /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `2h` / `90 minutes` / `45s` → milliseconds, or `null`. */
export function parseDuration(input: string): number | null {
  const m = DURATION_RE.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase()[0];
  const ms = UNIT_MS[unit];
  return ms ? Math.round(n * ms) : null;
}

/**
 * `until 15:30` / `until 3:30pm` → an instant, or `null`.
 *
 * Resolves against the LOCAL day and rolls to tomorrow when the time has already
 * passed, which is what "until 9am" means at 11pm. Rolling is the safe
 * direction: the alternative fires instantly and reads as a bug.
 */
export function parseUntil(input: string, now = new Date()): number | null {
  const m = /^until\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(input.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const suffix = m[3]?.toLowerCase();
  if (minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === 'pm' && hour !== 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime();
}

/** Either form, or `null` if neither reads. */
export function parseWhen(input: string, now = new Date()): number | null {
  const until = parseUntil(input, now);
  if (until !== null) return until;
  const duration = parseDuration(input);
  return duration === null ? null : now.getTime() + duration;
}

/**
 * `2h 5m` — for telling the user when a sleep will wake.
 *
 * Deliberately not `formatElapsed` (`src/output.ts`), and the difference is one
 * a reader will otherwise assume is an oversight: that one always prints both
 * units (`2h0m`, `5m0s`) because it labels a DURATION THAT HAPPENED, where a
 * trailing zero is information. This labels a wait that has not happened yet,
 * where `2h0m` reads as false precision about a time the user chose.
 *
 * Kept here rather than moved beside its sibling because `output.ts` is imported
 * almost everywhere and this is the only caller; the honest cost of the split is
 * this comment, which is cheaper than the edge.
 */
export function formatRelative(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
