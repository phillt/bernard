import { tool } from 'ai';
import { z } from 'zod';
import cron from 'node-cron';
import { CronStore } from '../cron/store.js';
import { CronLogStore } from '../cron/log-store.js';
import { isDaemonRunning, startDaemon, stopDaemon } from '../cron/client.js';
import { debugLog } from '../logger.js';

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
  const remaining = store.loadJobs().filter(j => j.enabled);
  if (remaining.length === 0 && isDaemonRunning()) {
    stopDaemon();
    return ' No enabled jobs remain — daemon stopped.';
  }
  return '';
}

export function createCronTools() {
  const store = new CronStore();
  const logStore = new CronLogStore();

  return {
    cron_create: tool({
      description: 'Create a new scheduled cron job that runs an AI prompt on a schedule.',
      parameters: z.object({
        name: z.string().describe('Job name'),
        schedule: z.string().describe('Cron expression (e.g. "0 * * * *" for hourly, "*/5 * * * *" for every 5 min)'),
        prompt: z.string().describe('The AI prompt to execute on each run'),
      }),
      execute: async ({ name, schedule, prompt }): Promise<string> => {
        debugLog('cron_create:execute', { name, schedule, prompt });

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
    }),

    cron_list: tool({
      description: 'List all cron jobs with their status and last run info.',
      parameters: z.object({}),
      execute: async (): Promise<string> => {
        debugLog('cron_list:execute', {});

        const jobs = store.loadJobs();
        if (jobs.length === 0) return 'No cron jobs configured.';

        const lines = jobs.map(j => {
          const status = j.enabled ? 'enabled' : 'disabled';
          const lastRun = j.lastRun
            ? `last run: ${j.lastRun} (${j.lastRunStatus || 'unknown'})`
            : 'never run';
          return `  - ${j.name} [${status}]\n    ID: ${j.id}\n    Schedule: ${j.schedule}\n    ${lastRun}`;
        });

        return `Cron jobs (${jobs.length}):\n${lines.join('\n')}`;
      },
    }),

    cron_get: tool({
      description: 'Get full details of a cron job including prompt text and last result.',
      parameters: z.object({
        id: z.string().describe('Job ID'),
      }),
      execute: async ({ id }): Promise<string> => {
        debugLog('cron_get:execute', { id });

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
    }),

    cron_update: tool({
      description: `Update a cron job's name, schedule, or prompt. You MUST include the new values as parameters.
Examples:
  Change prompt: { "id": "<id>", "prompt": "new prompt text" }
  Change schedule: { "id": "<id>", "schedule": "*/30 * * * *" }
  Change multiple: { "id": "<id>", "name": "New name", "prompt": "new prompt" }`,
      parameters: z.object({
        id: z.string().describe('Job ID'),
        name: z.string().optional().describe('New job name'),
        schedule: z.string().optional().describe('New cron expression'),
        prompt: z.string().optional().describe('New AI prompt text — replaces the existing prompt entirely'),
      }),
      execute: async ({ id, name, schedule, prompt }): Promise<string> => {
        debugLog('cron_update:execute', { id, name, schedule, prompt });

        if (!name && !schedule && !prompt) {
          const received = Object.entries({ id, name, schedule, prompt })
            .filter(([, v]) => v !== undefined)
            .map(([k]) => k)
            .join(', ');
          return 'Error: update requires at least one field to change (name, schedule, prompt) as a parameter in this tool call. '
            + 'Example: {"id":"...","prompt":"new prompt text"}. '
            + `Received parameters: ${received}.`;
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
    }),

    cron_delete: tool({
      description: 'Delete a cron job.',
      parameters: z.object({
        id: z.string().describe('Job ID'),
      }),
      execute: async ({ id }): Promise<string> => {
        debugLog('cron_delete:execute', { id });

        const deleted = store.deleteJob(id);
        if (!deleted) return `Error: No job found with ID "${id}".`;

        logStore.deleteJobLogs(id);

        const suffix = stopIfNoEnabledJobs(store);
        if (suffix) return `Job deleted.${suffix}`;

        return `Job "${id}" deleted.`;
      },
    }),

    cron_enable: tool({
      description: 'Enable a disabled cron job.',
      parameters: z.object({
        id: z.string().describe('Job ID'),
      }),
      execute: async ({ id }): Promise<string> => {
        debugLog('cron_enable:execute', { id });

        const job = store.updateJob(id, { enabled: true });
        if (!job) return `Error: No job found with ID "${id}".`;

        const daemonErr = ensureDaemon();
        if (daemonErr) {
          return `Job "${job.name}" enabled but daemon failed to start: ${daemonErr}`;
        }

        return `Job "${job.name}" enabled. Daemon running.`;
      },
    }),

    cron_disable: tool({
      description: 'Disable an active cron job.',
      parameters: z.object({
        id: z.string().describe('Job ID'),
      }),
      execute: async ({ id }): Promise<string> => {
        debugLog('cron_disable:execute', { id });

        const job = store.updateJob(id, { enabled: false });
        if (!job) return `Error: No job found with ID "${id}".`;

        const suffix = stopIfNoEnabledJobs(store);
        if (suffix) return `Job "${job.name}" disabled.${suffix}`;

        return `Job "${job.name}" disabled.`;
      },
    }),

    cron_status: tool({
      description: 'Check cron daemon status and job counts.',
      parameters: z.object({}),
      execute: async (): Promise<string> => {
        debugLog('cron_status:execute', {});

        const running = isDaemonRunning();
        const jobs = store.loadJobs();
        const enabled = jobs.filter(j => j.enabled).length;
        const alerts = store.listAlerts().filter(a => !a.acknowledged);

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
    }),

    cron_bounce: tool({
      description: 'Restart the cron daemon. Useful after code updates or if the daemon is misbehaving.',
      parameters: z.object({}),
      execute: async (): Promise<string> => {
        debugLog('cron_bounce:execute', {});

        const wasRunning = isDaemonRunning();
        if (wasRunning) {
          stopDaemon();
          // Brief delay for process cleanup
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        const enabled = store.loadJobs().filter(j => j.enabled);
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
    }),
  };
}
