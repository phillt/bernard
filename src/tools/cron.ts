import { tool } from 'ai';
import { z } from 'zod';
import cron from 'node-cron';
import { CronStore } from '../cron/store.js';
import type { CronJob } from '../cron/types.js';
import { CronLogStore } from '../cron/log-store.js';
import { deleteCronJob } from '../cron/lifecycle.js';
import { duplicateJob, failureStreak, jobCountNotice, jobSignals } from '../cron/health.js';
import { isDaemonRunning, startDaemon, stopDaemon } from '../cron/client.js';
import { debugLog } from '../logger.js';
import { attachActionMeta } from '../framework/tools/adapter.js';

function ensureDaemon(): string | null {
  if (!isDaemonRunning()) {
    try {
      startDaemon();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return msg;
    }
  }
  return null;
}

function stopIfNoEnabledJobs(store: CronStore): string {
  const remaining = store.loadJobs().filter((j) => j.enabled);
  if (remaining.length === 0 && isDaemonRunning()) {
    stopDaemon();
    return ' No enabled jobs remain — daemon stopped.';
  }
  return '';
}

/**
 * Cron actions that only read state. Everything else mutates jobs or the
 * daemon. Drives both the read-only block gate (#179) via `isWriteAction` and
 * the risk tier used by the confirm gate (#144).
 */
export const CRON_READ_ACTIONS: ReadonlySet<string> = new Set(['list', 'get', 'status']);

interface CronArgs {
  action: string;
  id?: string;
  name?: string;
  schedule?: string;
  prompt?: string;
  catchUp?: boolean;
}

interface CronDeps {
  store: CronStore;
  logStore: CronLogStore;
}

type CronHandler = (deps: CronDeps, args: CronArgs) => Promise<string>;

/**
 * Uniform "you left out a required field" message.
 *
 * Shared by all three cron tools: consolidation moved required-field checks out
 * of zod and into the handlers, so this wording is the only thing telling the
 * model what it left out — it should read identically everywhere.
 */
export function missing(action: string, field: string, example: string): string {
  return `Error: "${action}" requires \`${field}\`. Example: ${example}`;
}

/**
 * Renders a job's health signals as indented lines, or nothing when it is well.
 *
 * The decision is `health.ts`'s; this is only how the tool says it. Four
 * surfaces render the same signals and a rule written at four call sites is four
 * rules that drift, which is why the labels and remedies come from the table
 * rather than from here.
 */
function signalLines(deps: CronDeps, job: CronJob, indent: string): string {
  const signals = jobSignals({ job, failureStreak: failureStreak(job, deps.logStore) });
  if (signals.length === 0) return '';
  return signals.map((s) => `\n${indent}\u26a0 ${s.label} — ${s.remedy}`).join('');
}

/**
 * Per-action handlers for the consolidated `cron` tool (#253).
 *
 * Exported so the behaviour can be unit-tested directly, without going through
 * zod parsing and the AI-SDK tool envelope.
 *
 * **Why every field is optional in the schema:** one tool serving ten actions
 * cannot express "id is required, but only for these six". Each handler
 * therefore validates its own inputs and returns an actionable message rather
 * than throwing — the same shape `cron_update` already used for its
 * "at least one field" check.
 *
 * Named `CRON_ACTIONS.list` etc. rather than lifted to module scope on purpose:
 * `cronList` / `cronRun` / `cronDelete` / `cronBounce` are already exported from
 * `src/cron/cli.ts` and imported by `src/index.ts`, and duplicating those names
 * here would be a confusing near-collision.
 */
export const CRON_ACTIONS = {
  create: async ({ store }, { name, schedule, prompt, catchUp }) => {
    if (!name || !schedule || !prompt) {
      return missing(
        'create',
        'name, schedule and prompt',
        '{"action":"create","name":"Nightly","schedule":"0 2 * * *","prompt":"..."}',
      );
    }
    if (!cron.validate(schedule)) {
      return `Error: Invalid cron expression "${schedule}". Use standard cron format (e.g. "0 * * * *" for hourly, "*/5 * * * *" for every 5 minutes).`;
    }

    // Nothing deduped, and 42 identical jobs were the result (#401): same
    // schedule, same prompt, all enabled, all still firing at midnight months
    // later. A refusal rather than the warning the issue asks for, because a
    // warning that still writes the row is what would have happened 42 times —
    // the tool has no confirm channel, so the only thing that can actually stop
    // it is not creating it. Both ways forward are named, and the caller can
    // always change the schedule or the prompt if it really wants two.
    const twin = duplicateJob(store.loadJobs(), schedule, prompt);
    if (twin?.enabled) {
      return (
        `Error: an enabled job already runs this exact prompt on this exact schedule: ` +
        `"${twin.name}" (${twin.id}). Creating a second one would do the same work twice at ` +
        `the same moment. Update that job instead ({"action":"update","id":"${twin.id}",...}), ` +
        `or change the schedule or the prompt.`
      );
    }

    try {
      const job = store.createJob(name, schedule, prompt, { catchUp });
      const jobs = store.loadJobs();
      // Said at the one moment that would have stopped the pile: while the count
      // is still small enough to prune.
      const notice = jobCountNotice(jobs.length, jobs.filter((j) => j.enabled).length);
      const twinNote = twin
        ? `\nNote: a disabled job has the same schedule and prompt — "${twin.name}" (${twin.id}). ` +
          'Enable that one instead if this was meant to bring it back.'
        : '';
      const daemonErr = ensureDaemon();
      if (daemonErr) {
        return `Job "${job.name}" created (${job.id}) but daemon failed to start: ${daemonErr}${twinNote}`;
      }
      return (
        `Cron job created:\n  ID: ${job.id}\n  Name: ${job.name}\n  Schedule: ${job.schedule}\n` +
        `  Catch up missed runs: ${job.catchUp === true}\n  Daemon: running${twinNote}` +
        (notice ? `\n\n${notice}` : '')
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error creating job: ${msg}`;
    }
  },

  list: async (deps) => {
    const jobs = deps.store.loadJobs();
    if (jobs.length === 0) return 'No cron jobs configured.';
    const lines = jobs.map((j) => {
      const status = j.enabled ? 'enabled' : 'disabled';
      const lastRun = j.lastRun
        ? `last run: ${j.lastRun} (${j.lastRunStatus || 'unknown'})`
        : 'never run';
      return (
        `  - ${j.name} [${status}]\n    ID: ${j.id}\n    Schedule: ${j.schedule}\n    ${lastRun}` +
        signalLines(deps, j, '    ')
      );
    });
    const notice = jobCountNotice(jobs.length, jobs.filter((j) => j.enabled).length);
    return `Cron jobs (${jobs.length}):\n${lines.join('\n')}` + (notice ? `\n\n${notice}` : '');
  },

  get: async (deps, { id }) => {
    if (!id) return missing('get', 'id', '{"action":"get","id":"<job-id>"}');
    const job = deps.store.getJob(id);
    if (!job) return `Error: No job found with ID "${id}".`;
    let result = `Job details:\n`;
    result += `  ID: ${job.id}\n`;
    result += `  Name: ${job.name}\n`;
    result += `  Schedule: ${job.schedule}\n`;
    result += `  Enabled: ${job.enabled}\n`;
    result += `  Catch up missed runs: ${job.catchUp === true}\n`;
    result += `  Created: ${job.createdAt}\n`;
    result += `  Prompt: ${job.prompt}`;
    if (job.nextRunAt) result += `\n  Next run: ${job.nextRunAt}`;
    if (job.lastRun) {
      result += `\n  Last run: ${job.lastRun}`;
      result += `\n  Last status: ${job.lastRunStatus || 'unknown'}`;
      if (job.lastResult) {
        result += `\n  Last result: ${job.lastResult}`;
      }
    }
    return result + signalLines(deps, job, '  ');
  },

  update: async ({ store }, { id, name, schedule, prompt, catchUp }) => {
    if (!id) return missing('update', 'id', '{"action":"update","id":"<id>","prompt":"..."}');
    if (!name && !schedule && !prompt && catchUp === undefined) {
      const received = Object.entries({ id, name, schedule, prompt, catchUp })
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k)
        .join(', ');
      return (
        'Error: update requires at least one field to change (name, schedule, prompt, catchUp) as a parameter in this tool call. ' +
        'Example: {"action":"update","id":"...","prompt":"new prompt text"}. ' +
        `Received parameters: ${received}.`
      );
    }
    if (schedule && !cron.validate(schedule)) {
      return `Error: Invalid cron expression "${schedule}". Use standard cron format (e.g. "0 * * * *" for hourly, "*/5 * * * *" for every 5 minutes).`;
    }
    const updates: Partial<CronJob> = {};
    if (name) updates.name = name;
    if (schedule) updates.schedule = schedule;
    if (prompt) updates.prompt = prompt;
    if (catchUp !== undefined) updates.catchUp = catchUp;
    const job = store.updateJob(id, updates);
    if (!job) return `Error: No job found with ID "${id}".`;
    return (
      `Job updated:\n  ID: ${job.id}\n  Name: ${job.name}\n  Schedule: ${job.schedule}\n` +
      `  Enabled: ${job.enabled}\n  Catch up missed runs: ${job.catchUp === true}`
    );
  },

  delete: async (deps, { id }) => {
    if (!id) return missing('delete', 'id', '{"action":"delete","id":"<job-id>"}');
    // The whole sweep, not just the row (#585): logs, notes and the run
    // workspace go with it.
    const deleted = deleteCronJob(id, deps);
    if (!deleted) return `Error: No job found with ID "${id}".`;
    const suffix = stopIfNoEnabledJobs(deps.store);
    if (suffix) return `Job deleted.${suffix}`;
    return `Job "${id}" deleted.`;
  },

  enable: async ({ store }, { id }) => {
    if (!id) return missing('enable', 'id', '{"action":"enable","id":"<job-id>"}');
    const job = store.updateJob(id, { enabled: true });
    if (!job) return `Error: No job found with ID "${id}".`;
    const daemonErr = ensureDaemon();
    if (daemonErr) return `Job "${job.name}" enabled but daemon failed to start: ${daemonErr}`;
    return `Job "${job.name}" enabled. Daemon running.`;
  },

  disable: async ({ store }, { id }) => {
    if (!id) return missing('disable', 'id', '{"action":"disable","id":"<job-id>"}');
    const job = store.updateJob(id, { enabled: false });
    if (!job) return `Error: No job found with ID "${id}".`;
    const suffix = stopIfNoEnabledJobs(store);
    if (suffix) return `Job "${job.name}" disabled.${suffix}`;
    return `Job "${job.name}" disabled.`;
  },

  run: async ({ store }, { id }) => {
    if (!id) return missing('run', 'id', '{"action":"run","id":"<job-id>"}');
    const job = store.getJob(id);
    if (!job) return `Error: No job found with ID "${id}".`;
    if (job.lastRunStatus === 'running') {
      return `Error: Job "${job.name}" is already running. Wait for it to finish before triggering another run.`;
    }
    const disabledNote = job.enabled ? '' : '\nNote: this job is currently disabled.\n';
    const startTime = new Date().toISOString();
    store.updateJob(id, { lastRun: startTime, lastRunStatus: 'running' });
    try {
      const logs: string[] = [];
      // Deferred, following `delegate.ts`'s precedent and for the same
      // reason: `cron/runner.ts` reaches `framework/agents/index.js`, which
      // reaches `main.ts`, which imports `createTools` from `tools/index.ts` —
      // this module's own parent. Statically that cycle was resolved at load
      // time; once `tools/index.ts` began deferring its `main`-audience
      // imports (#452) it became a cycle resolved at CALL time, which
      // deadlocks under `vi.resetModules()`. Deferring the one edge that
      // actually needs the agent runtime breaks it, and makes `cron.js` cheap
      // to load besides.
      const { runJob } = await import('../cron/runner.js');
      const result = await runJob(job, (msg) => logs.push(msg));
      store.updateJob(id, {
        lastRunStatus: result.success ? 'success' : 'error',
        lastResult: result.output.slice(0, 2000),
      });
      const status = result.success ? 'Success' : 'Error';
      let response = `${disabledNote}Job "${job.name}" — ${status}\n\nOutput:\n${result.output}`;
      if (logs.length > 0) response += `\n\nLogs:\n${logs.join('\n')}`;
      return response;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      store.updateJob(id, { lastRunStatus: 'error', lastResult: message.slice(0, 2000) });
      return `${disabledNote}Job "${job.name}" — Error\n\nThrew: ${message}`;
    }
  },

  status: async (deps) => {
    const running = isDaemonRunning();
    const jobs = deps.store.loadJobs();
    const enabled = jobs.filter((j) => j.enabled).length;
    const alerts = deps.store.listAlerts().filter((a) => !a.acknowledged);
    // Aggregate rather than per-job here: `status` answers "is everything all
    // right", and the row-level labels belong to `list` and `get`.
    const unwell = jobs.filter(
      (j) => jobSignals({ job: j, failureStreak: failureStreak(j, deps.logStore) }).length > 0,
    );
    let result = `Daemon: ${running ? 'running' : 'stopped'}\n`;
    result += `Jobs: ${jobs.length} total, ${enabled} enabled\n`;
    if (unwell.length > 0) {
      result += `Jobs needing attention: ${unwell.length} — ${unwell
        .map((j) => `${j.name} (${j.id})`)
        .join(', ')}\n`;
    }
    result += `Unacknowledged alerts: ${alerts.length}`;
    if (alerts.length > 0) {
      result += '\n\nRecent alerts:';
      for (const alert of alerts.slice(0, 5)) {
        result += `\n  - [${alert.timestamp}] ${alert.jobName}: ${alert.message}`;
      }
    }
    const notice = jobCountNotice(jobs.length, enabled);
    return notice ? `${result}\n\n${notice}` : result;
  },

  bounce: async ({ store }) => {
    const wasRunning = isDaemonRunning();
    if (wasRunning) {
      stopDaemon();
      // Brief delay for process cleanup
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const enabled = store.loadJobs().filter((j) => j.enabled);
    if (enabled.length === 0) {
      return wasRunning
        ? 'Daemon stopped. No enabled jobs — not restarting.'
        : 'Daemon was not running. No enabled jobs — nothing to do.';
    }
    try {
      startDaemon();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Daemon ${wasRunning ? 'stopped but' : 'was not running and'} failed to restart: ${msg}`;
    }
    return `Daemon restarted. ${enabled.length} enabled job${enabled.length === 1 ? '' : 's'}.`;
  },
} satisfies Record<string, CronHandler>;

export type CronAction = keyof typeof CRON_ACTIONS;

/**
 * The zod enum's members, derived from the handler table rather than declared
 * beside it — a parallel list can drift, and a schema that accepts an action
 * with no handler dispatches to `undefined` at call time.
 */
export const CRON_ACTION_NAMES = Object.keys(CRON_ACTIONS) as [CronAction, ...CronAction[]];

/**
 * The consolidated cron tool (#253) — one action-enum tool replacing ten
 * `cron_*` tools, matching the shape `routine`, `specialist`, `memory` and
 * `scratch` already use. Ten schemas cost ~4.5k chars of every request's tool
 * block; one costs a fraction of that, with no runtime indirection.
 *
 * `kind: 'write'` with an `isWriteAction` refinement (the `createMemoryTool`
 * pattern) so read actions still pass the read-only block gate untouched.
 */
export function createCronTool() {
  const deps: CronDeps = { store: new CronStore(), logStore: new CronLogStore() };

  return {
    cron: attachActionMeta(
      tool({
        description: `Manage scheduled cron jobs — background AI prompts that run on a schedule via an independent daemon, whether or not a session is open.

Actions: create · list · get · update · delete · enable · disable · run · status · bounce
  create   — needs name, schedule, prompt
  update   — needs id plus at least one of name/schedule/prompt/catchUp (replaces that field entirely)
  get/delete/enable/disable/run — need id
  list/status/bounce — need nothing else

The daemon auto-starts when a job is created or enabled, and auto-stops when no enabled jobs remain. "bounce" restarts it (useful after a code update).

A job only runs while the machine is awake and the daemon is up. A fire the machine slept through is recorded as missed and, by default, dropped. Set catchUp for a job that monitors something ("check for replies every 2h"), where running late beats not running at all; leave it off for anything time-of-day specific, where firing hours late is worse than skipping.`,
        parameters: z.object({
          action: z.enum(CRON_ACTION_NAMES).describe('The cron operation to perform'),
          id: z
            .string()
            .optional()
            .describe('Job ID — required by get/update/delete/enable/disable/run'),
          name: z
            .string()
            .optional()
            .describe('Job name — required by create, optional for update'),
          schedule: z
            .string()
            .optional()
            .describe(
              'Cron expression, e.g. "0 * * * *" hourly or "*/5 * * * *" every 5 min — required by create, optional for update',
            ),
          prompt: z
            .string()
            .optional()
            .describe(
              'The AI prompt to execute on each run — required by create, optional for update',
            ),
          catchUp: z
            .boolean()
            .optional()
            .describe(
              'Run ONE missed fire when the machine wakes or the daemon restarts, instead of dropping it. Default false. For monitors, not for time-of-day actions.',
            ),
        }),
        execute: async (args): Promise<string> => {
          debugLog('cron:execute', args);
          return CRON_ACTIONS[args.action as CronAction](deps, args);
        },
      }),
      { name: 'cron', readActions: CRON_READ_ACTIONS },
    ),
  };
}
