import type { CronJob } from './types.js';

/**
 * What is wrong with a cron job, and with the pile of them (#401).
 *
 * Three findings from one real install, none of which anything in the tree
 * could say out loud: 42 identical jobs had been created without a murmur, the
 * eight of them that ever ran had all failed the same way in June and stayed
 * enabled ever since, and nothing anywhere reported that there were 42. The
 * first is prevented at the write, the other two are *surfaced* — and surfacing
 * is why this is a table rather than a condition written where it is printed.
 *
 * A job's health renders in four places: `cronList` (the CLI listing), and the
 * `cron` tool's `list`, `get` and `status`. A rule stated at four call sites is
 * four rules that will disagree — the argument `apps/permission-consent.ts`
 * already makes for its own three surfaces — so each signal is declared once,
 * with its own detector and its own words, and every surface renders whatever
 * {@link jobSignals} hands it. A new signal is a row; nothing downstream
 * changes. `health.test.ts` walks the table in both directions: every declared
 * id is reachable from a job, and every surface really prints it.
 *
 * Pure but for a type import: detection takes the job and whatever the caller
 * has already read, never a store. That keeps the decisions testable without a
 * filesystem, and keeps the cost of *finding* a failure streak at the caller,
 * which is the only party that knows whether it can afford the read.
 */

/**
 * Consecutive failed runs before a job is called failing.
 *
 * Three, not one: `runJob` already retries internally ("Failed after 3
 * attempts"), so a single log entry is three attempts and three entries is
 * nine. One failure is an incident, two can still be one bad afternoon at a
 * provider; three consecutive says the job itself is broken. Below that the
 * job shows `error` on its row like it always has, which is the honest amount
 * of noise for something that may well fix itself.
 */
export const FAILURE_STREAK_N = 3;

/**
 * Total jobs at which a listing starts saying the count is getting large.
 *
 * `MAX_JOBS` is 50 and is a hard refusal; this is the point at which someone
 * should look, with room left to act before creates start being rejected. It is
 * also roughly where a listing stops fitting on a screen, which is the practical
 * reason nobody noticed 42.
 */
export const JOB_COUNT_WARN_AT = 20;

/** Everything a signal may look at. Assembled by the caller, never read here. */
export interface JobHealthInput {
  job: CronJob;
  /**
   * Consecutive failures at the head of this job's run log, as the caller
   * measured them. Zero when the caller did not or could not look.
   */
  failureStreak: number;
}

/** One rendered signal: what is wrong, and what to do about it. */
export interface JobSignal {
  id: JobSignalId;
  /** A short phrase for a list row. */
  label: string;
  /** The action that clears it, named concretely. */
  remedy: string;
}

/** The kinds of thing that can be wrong with a job. */
export type JobSignalId = 'failing' | 'missed';

interface JobSignalSpec {
  detect: (input: JobHealthInput) => boolean;
  label: (input: JobHealthInput) => string;
  remedy: (input: JobHealthInput) => string;
}

/**
 * Keyed by id so TypeScript enforces that every {@link JobSignalId} has a
 * detector — a `readonly JobSignalSpec[]` would let one be declared in the union
 * and never implemented, which is the drift the table exists to prevent.
 */
const JOB_SIGNALS: Record<JobSignalId, JobSignalSpec> = {
  failing: {
    detect: ({ failureStreak }) => failureStreak >= FAILURE_STREAK_N,
    label: ({ failureStreak }) => `failing — its last ${failureStreak} runs all failed`,
    remedy: ({ job }) =>
      `check \`bernard cron-logs ${job.id}\`, then disable it with \`bernard cron-stop ${job.id}\` if it cannot be fixed`,
  },
  missed: {
    detect: ({ job }) => (job.missedRuns ?? 0) > 0,
    label: ({ job }) =>
      `${job.missedRuns} scheduled fire(s) missed since its last on-time run` +
      (job.lastMissedAt ? ` (most recently ${job.lastMissedAt})` : ''),
    remedy: ({ job }) =>
      job.catchUp
        ? 'catch-up is on, so one run happens on wake; the rest are skipped deliberately'
        : 'the machine was asleep or the daemon was down — set catchUp to run one of them on wake',
  },
};

/** Ids in a stable render order, derived from the table rather than restated. */
export const JOB_SIGNAL_IDS = Object.keys(JOB_SIGNALS) as JobSignalId[];

/** Every signal currently tripped by a job, in declaration order. */
export function jobSignals(input: JobHealthInput): JobSignal[] {
  const out: JobSignal[] = [];
  for (const id of JOB_SIGNAL_IDS) {
    const spec = JOB_SIGNALS[id];
    if (spec.detect(input)) out.push({ id, label: spec.label(input), remedy: spec.remedy(input) });
  }
  return out;
}

/** The minimum a caller must be able to do to measure a failure streak. */
export interface RunOutcomeReader {
  getEntries(jobId: string, limit?: number, offset?: number): Array<{ success: boolean }>;
}

/**
 * How many of a job's most recent logged runs failed in a row.
 *
 * **The `lastRunStatus` short-circuit is what makes this affordable in a
 * listing.** `CronLogStore.getEntries` reads a job's whole JSONL — up to 5 MB —
 * splits it and reverses it, so asking every job on a 43-job install would read
 * every log to answer a question that is `0` for all but the broken ones. The
 * job record already carries the answer for the common case: if the last run did
 * not fail there is no streak, and nothing is opened.
 */
export function failureStreak(job: CronJob, logs: RunOutcomeReader): number {
  if (job.lastRunStatus !== 'error') return 0;
  const entries = logs.getEntries(job.id, FAILURE_STREAK_N);
  // The raw count, capped by how many entries were asked for, so a job with two
  // logged failures reports 2 and stays below the threshold. "Its last three
  // runs failed" has to be about three runs that happened.
  let streak = 0;
  for (const entry of entries) {
    if (entry.success) break;
    streak++;
  }
  return streak;
}

/** Collapses the whitespace runs `cron.validate` tolerates so two spellings compare equal. */
function normalizeSchedule(schedule: string): string {
  return schedule.trim().replace(/\s+/g, ' ');
}

/**
 * An existing job that would do exactly the same work at exactly the same time.
 *
 * **Schedule and prompt, never the name.** The 42 shared a name too, but a name
 * is a label — two jobs differing only in what they are called still run the
 * same prompt at the same instant, and a model invents a fresh name each time it
 * is asked. That is the key `watchers/` already settled on for the same reason.
 *
 * Enabled matches are returned in preference to disabled ones, because the two
 * deserve different answers: an enabled twin is a mistake to refuse, a disabled
 * one is probably the job the caller meant to turn back on.
 */
export function duplicateJob(
  jobs: readonly CronJob[],
  schedule: string,
  prompt: string,
): CronJob | undefined {
  const wantSchedule = normalizeSchedule(schedule);
  const wantPrompt = prompt.trim();
  const matches = jobs.filter(
    (j) => normalizeSchedule(j.schedule) === wantSchedule && j.prompt.trim() === wantPrompt,
  );
  return matches.find((j) => j.enabled) ?? matches[0];
}

/**
 * A line about the size of the pile, or `null` when there is nothing to say.
 *
 * Returned rather than printed so the CLI and the tool can render it in their
 * own voice — the `apps/manage.ts` split — and so the create path can say it at
 * the one moment that would have stopped this: while the count is still 20.
 */
export function jobCountNotice(total: number, enabled: number): string | null {
  if (total < JOB_COUNT_WARN_AT) return null;
  return (
    `${total} cron jobs exist (${enabled} enabled). ` +
    'Prune the ones that are no longer wanted with `bernard cron-delete <id>` — every enabled job ' +
    'fires unattended and spends tokens.'
  );
}
