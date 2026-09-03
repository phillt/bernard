import { tool } from 'ai';
import { z } from 'zod';
import cron from 'node-cron';
import { CronStore } from '../cron/store.js';
import { CronLogStore } from '../cron/log-store.js';
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
  create: async ({ store }, { name, schedule, prompt }) => {
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
    try {
      const job = store.createJob(name, schedule, prompt);
      const daemonErr = ensureDaemon();
      if (daemonErr) {
        return `Job "${job.name}" created (${job.id}) but daemon failed to start: ${daemonErr}`;
      }
      return `Cron job created:\n  ID: ${job.id}\n  Name: ${job.name}\n  Schedule: ${job.schedule}\n  Daemon: running`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error creating job: ${msg}`;
    }
  },

  list: async ({ store }) => {
    const jobs = store.loadJobs();
    if (jobs.length === 0) return 'No cron jobs configured.';
    const lines = jobs.map((j) => {
      const status = j.enabled ? 'enabled' : 'disabled';
      const lastRun = j.lastRun
        ? `last run: ${j.lastRun} (${j.lastRunStatus || 'unknown'})`
        : 'never run';
      return `  - ${j.name} [${status}]\n    ID: ${j.id}\n    Schedule: ${j.schedule}\n    ${lastRun}`;
    });
    return `Cron jobs (${jobs.length}):\n${lines.join('\n')}`;
  },

  get: async ({ store }, { id }) => {
    if (!id) return missing('get', 'id', '{"action":"get","id":"<job-id>"}');
    const job = store.getJob(id);
    if (!job) return `Error: No job found with ID "${id}".`;
    let result = `Job details:\n`;
    result += `  ID: ${job.id}\n`;
    result += `  Name: ${job.name}\n`;
    result += `  Schedule: ${job.schedule}\n`;
    result += `  Enabled: ${job.enabled}\n`;
    result += `  Created: ${job.createdAt}\n`;
    result += `  Prompt: ${job.prompt}`;
    if (job.lastRun) {
      result += `\n  Last run: ${job.lastRun}`;
      result += `\n  Last status: ${job.lastRunStatus || 'unknown'}`;
      if (job.lastResult) {
        result += `\n  Last result: ${job.lastResult}`;
      }
    }
    return result;
  },

  update: async ({ store }, { id, name, schedule, prompt }) => {
    if (!id) return missing('update', 'id', '{"action":"update","id":"<id>","prompt":"..."}');
    if (!name && !schedule && !prompt) {
      const received = Object.entries({ id, name, schedule, prompt })
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k)
        .join(', ');
      return (
        'Error: update requires at least one field to change (name, schedule, prompt) as a parameter in this tool call. ' +
        'Example: {"action":"update","id":"...","prompt":"new prompt text"}. ' +
        `Received parameters: ${received}.`
      );
    }
    if (schedule && !cron.validate(schedule)) {
      return `Error: Invalid cron expression "${schedule}". Use standard cron format (e.g. "0 * * * *" for hourly, "*/5 * * * *" for every 5 minutes).`;
    }
    const updates: Record<string, string> = {};
    if (name) updates.name = name;
    if (schedule) updates.schedule = schedule;
    if (prompt) updates.prompt = prompt;
    const job = store.updateJob(id, updates);
    if (!job) return `Error: No job found with ID "${id}".`;
    return `Job updated:\n  ID: ${job.id}\n  Name: ${job.name}\n  Schedule: ${job.schedule}\n  Enabled: ${job.enabled}`;
  },

  delete: async ({ store, logStore }, { id }) => {
    if (!id) return missing('delete', 'id', '{"action":"delete","id":"<job-id>"}');
    const deleted = store.deleteJob(id);
    if (!deleted) return `Error: No job found with ID "${id}".`;
    logStore.deleteJobLogs(id);
    const suffix = stopIfNoEnabledJobs(store);
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

  status: async ({ store }) => {
    const running = isDaemonRunning();
    const jobs = store.loadJobs();
    const enabled = jobs.filter((j) => j.enabled).length;
    const alerts = store.listAlerts().filter((a) => !a.acknowledged);
    let result = `Daemon: ${running ? 'running' : 'stopped'}\n`;
    result += `Jobs: ${jobs.length} total, ${enabled} enabled\n`;
    result += `Unacknowledged alerts: ${alerts.length}`;
    if (alerts.length > 0) {
      result += '\n\nRecent alerts:';
      for (const alert of alerts.slice(0, 5)) {
        result += `\n  - [${alert.timestamp}] ${alert.jobName}: ${alert.message}`;
      }
    }
    return result;
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
  update   — needs id plus at least one of name/schedule/prompt (replaces that field entirely)
  get/delete/enable/disable/run — need id
  list/status/bounce — need nothing else

The daemon auto-starts when a job is created or enabled, and auto-stops when no enabled jobs remain. "bounce" restarts it (useful after a code update).`,
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
