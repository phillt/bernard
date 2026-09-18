/**
 * A cron expression, parsed into the set of values each field accepts, plus a
 * wall-clock walk over the instants it matches (#400).
 *
 * **Why this exists rather than `node-cron`'s own matcher.** node-cron drives a
 * task with one long `setTimeout` to the next matching instant. Node timers run
 * on `CLOCK_MONOTONIC`, which does not advance while a Linux machine is
 * suspended, so a two-hour timer armed at 22:00 fires after two hours of *awake*
 * time — measured on the machine that filed #400, 55 of 71 hours were invisible
 * to it, and a `0 *\/2 * * *` job ran twice in 24 hours. The repair is to stop
 * arming long timers and re-derive every fire from the wall clock, which needs
 * "what is the next instant this expression matches, after an arbitrary date?".
 *
 * node-cron cannot answer that through its public API: `ScheduledTask.getNextRun`
 * is `timeMatcher.getNextMatch(new Date())`, always from *now*, and `TimeMatcher`
 * is not reachable — the package's `exports` map exposes only `.`, so a deep
 * import would break on any patch release (the same refusal `src/ui/keys.ts`
 * records for Ink's key parser). `execution:missed` is not a substitute either:
 * its payload is off by one (`runner.js` advances `expectedNextExecution` and
 * then reports the *advanced* value), so it names a boundary that already ran
 * and never names the first one that did not.
 *
 * **The parse deliberately mirrors node-cron's accepted syntax**, because
 * `cron.validate` remains the gate every write passes through and the
 * expressions already in users' `jobs.json` were written against it: five or six
 * fields, `*`, lists, `a-b` ranges, `*\/n` and `a-b/n` steps, month and weekday
 * names, weekday `7` as Sunday. Two semantics are inherited on purpose rather
 * than "corrected":
 *
 * - **Day-of-month AND day-of-week.** Vixie cron ORs the two when both are
 *   restricted; node-cron ANDs them unconditionally (`runOnDay && runOnWeekDay`),
 *   so `0 0 1 * 1` means "the 1st, if it is a Monday". Changing that here would
 *   silently re-time existing jobs.
 * - **Local time**, no timezone field. That is what node-cron does with no
 *   `timezone` option, which is how every existing job was scheduled.
 *
 * What is NOT inherited is node-cron's *walk*: `MatcherWalker.matchNext` resolves
 * a weekday mismatch by incrementing the **year** until the weekday happens to
 * line up, which is wrong for any weekday-constrained expression. This module
 * walks fields in the ordinary way, and `schedule-clock.test.ts` pins both the
 * agreement on everything else and the divergence here.
 *
 * Pure: no imports, no clock of its own, every instant passed in. That is what
 * lets the scheduler's tests drive it with `vi.setSystemTime` instead of
 * suspending an operating system.
 */

/** The values one cron field accepts, already expanded from ranges and steps. */
export interface CronFields {
  readonly second: ReadonlySet<number>;
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
}

/**
 * The six fields, in expression order, with their bounds and any name aliases.
 *
 * A table rather than six parallel parse branches: bounds, aliases and the
 * order a field appears in are one fact each, and `parseCronFields` is derived
 * from it, so adding a field (or widening one) is a row rather than an edit in
 * three places. `schedule-clock.test.ts` walks it to assert the parsed object's
 * keys are exactly these names.
 */
const FIELD_SPECS = [
  { key: 'second', min: 0, max: 59 },
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dayOfMonth', min: 1, max: 31 },
  {
    key: 'month',
    min: 1,
    max: 12,
    names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
    nameOffset: 1,
  },
  {
    key: 'dayOfWeek',
    min: 0,
    max: 6,
    // Long forms are listed first and replaced first: substituting `sun` ahead
    // of `sunday` would leave the literal `day` behind.
    names: [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sun',
      'mon',
      'tue',
      'wed',
      'thu',
      'fri',
      'sat',
    ],
    nameOffset: 0,
    /** Vixie's second spelling of Sunday, which `cron.validate` accepts. */
    alias: new Map([[7, 0]]),
  },
] as const satisfies ReadonlyArray<{
  key: keyof CronFields;
  min: number;
  max: number;
  names?: readonly string[];
  nameOffset?: number;
  alias?: ReadonlyMap<number, number>;
}>;

/**
 * How far `nextMatchAfter` will walk before giving up.
 *
 * Bounded because an expression can legitimately have no match for years
 * (`0 0 29 2 *` waits up to four), and because the search is driven by dates
 * that came off disk. The walk skips whole months and days when they cannot
 * match, so a four-year gap costs a few thousand steps, not a few million;
 * the cap is loose enough that reaching it means the expression matches
 * nothing at all.
 */
const MAX_WALK_STEPS = 200_000;

/** Expands one comma-separated field into the set of values it admits. */
function parseField(
  raw: string,
  spec: {
    min: number;
    max: number;
    names?: readonly string[];
    nameOffset?: number;
    alias?: ReadonlyMap<number, number>;
  },
): Set<number> | null {
  let text = raw.toLowerCase();
  if (spec.names) {
    for (const [i, name] of spec.names.entries()) {
      // Names wrap round for the weekday field, whose long and short spellings
      // share one list: index 7 is `sun` again, so `i % 7` names the same day.
      const value = (i % (spec.max - spec.min + 1)) + (spec.nameOffset ?? 0);
      text = text.split(name).join(String(value));
    }
  }

  const out = new Set<number>();
  for (const term of text.split(',')) {
    const [body, stepText] = term.split('/');
    if (stepText !== undefined && !/^\d+$/.test(stepText)) return null;
    const step = stepText === undefined ? 1 : parseInt(stepText, 10);
    if (step <= 0) return null;

    let from: number;
    let to: number;
    if (body === '*') {
      from = spec.min;
      to = spec.max;
    } else if (/^\d+-\d+$/.test(body)) {
      const [a, b] = body.split('-').map((n) => parseInt(n, 10));
      // node-cron swaps a reversed range rather than rejecting it.
      from = Math.min(a, b);
      to = Math.max(a, b);
    } else if (/^\d+$/.test(body)) {
      from = parseInt(body, 10);
      to = stepText === undefined ? from : spec.max;
    } else {
      return null;
    }

    for (let v = from; v <= to; v += step) {
      const mapped = spec.alias?.get(v) ?? v;
      if (mapped < spec.min || mapped > spec.max) return null;
      out.add(mapped);
    }
  }
  return out.size > 0 ? out : null;
}

/**
 * Parses a cron expression, or returns `null` if it cannot be expanded.
 *
 * `null` is deliberately not the same answer as `cron.validate` returning
 * false — that stays the gate at every write. This one guards the *scheduler*:
 * a record on disk whose expression validates but does not expand here must be
 * refused loudly and skipped, never silently treated as "never fires".
 */
export function parseCronFields(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  // Five fields is the common spelling; node-cron prepends a `0` seconds field.
  const fields = parts.length === 5 ? ['0', ...parts] : parts;
  if (fields.length !== FIELD_SPECS.length) return null;

  const parsed: Partial<Record<keyof CronFields, Set<number>>> = {};
  for (const [i, spec] of FIELD_SPECS.entries()) {
    const values = parseField(fields[i], spec);
    if (!values) return null;
    parsed[spec.key] = values;
  }
  return parsed as CronFields;
}

/** True when `date`'s local calendar parts satisfy every field. */
export function matchesAt(fields: CronFields, date: Date): boolean {
  return (
    fields.second.has(date.getSeconds()) &&
    fields.minute.has(date.getMinutes()) &&
    fields.hour.has(date.getHours()) &&
    fields.dayOfMonth.has(date.getDate()) &&
    fields.month.has(date.getMonth() + 1) &&
    fields.dayOfWeek.has(date.getDay())
  );
}

/**
 * Advances `d` to the start of the next whole `unit`, always forward.
 *
 * The monotonicity guard is not decoration: these are local-time setters, and a
 * daylight-saving transition can land the result on the same instant (a local
 * time that does not exist is normalised onto one that does). Without it the
 * walk could sit still and burn its whole step budget.
 */
function rollForward(d: Date, unit: 'month' | 'day' | 'hour' | 'minute' | 'second'): void {
  const before = d.getTime();
  switch (unit) {
    case 'month':
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      break;
    case 'day':
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      break;
    case 'hour':
      d.setHours(d.getHours() + 1, 0, 0, 0);
      break;
    case 'minute':
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      break;
    case 'second':
      d.setSeconds(d.getSeconds() + 1, 0);
      break;
  }
  if (d.getTime() <= before) d.setTime(before + 1000);
}

/**
 * The first instant strictly after `after` that the expression matches, or
 * `null` if there is none within {@link MAX_WALK_STEPS}.
 *
 * Coarse units are skipped whole — a month that cannot match costs one step,
 * not 44,640 — which is what keeps a four-year wait affordable.
 */
export function nextMatchAfter(fields: CronFields, after: Date): Date | null {
  const d = new Date(after.getTime());
  d.setMilliseconds(0);
  d.setSeconds(d.getSeconds() + 1);

  for (let step = 0; step < MAX_WALK_STEPS; step++) {
    if (!fields.month.has(d.getMonth() + 1)) {
      rollForward(d, 'month');
      continue;
    }
    if (!fields.dayOfMonth.has(d.getDate()) || !fields.dayOfWeek.has(d.getDay())) {
      rollForward(d, 'day');
      continue;
    }
    if (!fields.hour.has(d.getHours())) {
      rollForward(d, 'hour');
      continue;
    }
    if (!fields.minute.has(d.getMinutes())) {
      rollForward(d, 'minute');
      continue;
    }
    if (!fields.second.has(d.getSeconds())) {
      rollForward(d, 'second');
      continue;
    }
    return d;
  }
  return null;
}

/** How many boundaries a walk found, and whether it stopped at its ceiling. */
export interface MatchCount {
  count: number;
  capped: boolean;
}

/**
 * Counts the boundaries in `[first, until]`, given that `first` is one of them.
 *
 * `first` is assumed to match because every caller gets it from
 * {@link nextMatchAfter}; re-deriving it here would mean a second answer to a
 * question already settled.
 *
 * Capped because the interval is a *wall-clock* gap that can be arbitrarily
 * large — a laptop shut for a fortnight against a one-minute schedule is twenty
 * thousand boundaries — and the only consumer of the number is a count printed
 * on a list row. `capped` is carried out rather than swallowed so that row can
 * say `500+` instead of quietly claiming 500.
 */
export function countBoundaries(
  fields: CronFields,
  first: Date,
  until: Date,
  cap: number,
): MatchCount {
  if (first.getTime() > until.getTime()) return { count: 0, capped: false };
  let count = 1;
  let cursor = first;
  while (count < cap) {
    const next = nextMatchAfter(fields, cursor);
    if (!next || next.getTime() > until.getTime()) return { count, capped: false };
    count++;
    cursor = next;
  }
  return { count, capped: true };
}
