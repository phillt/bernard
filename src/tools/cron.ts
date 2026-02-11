import { tool } from 'ai';
import { z } from 'zod';
import cron from 'node-cron';
import { CronStore } from '../cron/store.js';
import { isDaemonRunning, startDaemon, stopDaemon } from '../cron/client.js';

export function createCronTool() {
  const store = new CronStore();

  return tool({
    description:
      'Manage scheduled background tasks (cron jobs). Jobs run periodically in a background daemon, executing AI prompts with tool access. Use "get" to read full job details including prompt text and last result. Use "update" to modify a job\'s name, schedule, or prompt. Use the notify tool in job prompts when user attention is needed.',
    parameters: z.object({
      action: z.enum(['create', 'list', 'get', 'update', 'delete', 'enable', 'disable', 'status']).describe('The action to perform'),
      name: z.string().optional().describe('Job name (required for create). For update, include the new name here.'),
      schedule: z.string().optional().describe('Cron expression, e.g. "0 * * * *" for hourly (required for create). For update, include the new schedule here.'),
      prompt: z.string().optional().describe('The AI prompt to execute on schedule (required for create). For update, include the full new prompt text here.'),
      id: z.string().optional().describe('Job ID (required for get/update/delete/enable/disable)'),
    }),
    execute: async ({ action, name, schedule, prompt, id }): Promise<string> => {
      switch (action) {
        case 'create': {
          if (!name) return 'Error: name is required for create action.';
          if (!schedule) return 'Error: schedule is required for create action.';
          if (!prompt) return 'Error: prompt is required for create action.';

          if (!cron.validate(schedule)) {
            return `Error: Invalid cron expression "${schedule}". Use standard cron format (e.g. "0 * * * *" for hourly, "*/5 * * * *" for every 5 minutes).`;
          }

          try {
            const job = store.createJob(name, schedule, prompt);

            // Auto-start daemon
            if (!isDaemonRunning()) {
              try {
                startDaemon();
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return `Job "${job.name}" created (${job.id}) but daemon failed to start: ${msg}`;
              }
            }

            return `Cron job created:\n  ID: ${job.id}\n  Name: ${job.name}\n  Schedule: ${job.schedule}\n  Daemon: running`;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error creating job: ${msg}`;
          }
        }

        case 'list': {
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
        }

        case 'get': {
          if (!id) return 'Error: id is required for get action.';

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
        }

        case 'update': {
          if (!id) return 'Error: id is required for update action.';
          if (!name && !schedule && !prompt) {
            const received = Object.entries({ action, name, schedule, prompt, id })
              .filter(([, v]) => v !== undefined)
              .map(([k]) => k)
              .join(', ');
            return 'Error: update requires at least one field to change (name, schedule, prompt) as a parameter in this tool call. '
              + 'Example: {"action":"update","id":"...","prompt":"new prompt text"}. '
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
        }

        case 'delete': {
          if (!id) return 'Error: id is required for delete action.';

          const deleted = store.deleteJob(id);
          if (!deleted) return `Error: No job found with ID "${id}".`;

          // Auto-stop daemon if no enabled jobs remain
          const remaining = store.loadJobs().filter(j => j.enabled);
          if (remaining.length === 0 && isDaemonRunning()) {
            stopDaemon();
            return `Job deleted. No enabled jobs remain — daemon stopped.`;
          }

          return `Job "${id}" deleted.`;
        }

        case 'enable': {
          if (!id) return 'Error: id is required for enable action.';

          const job = store.updateJob(id, { enabled: true });
          if (!job) return `Error: No job found with ID "${id}".`;

          // Auto-start daemon
          if (!isDaemonRunning()) {
            try {
              startDaemon();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return `Job "${job.name}" enabled but daemon failed to start: ${msg}`;
            }
          }

          return `Job "${job.name}" enabled. Daemon running.`;
        }

        case 'disable': {
          if (!id) return 'Error: id is required for disable action.';

          const job = store.updateJob(id, { enabled: false });
          if (!job) return `Error: No job found with ID "${id}".`;

          // Auto-stop daemon if no enabled jobs remain
          const remaining = store.loadJobs().filter(j => j.enabled);
          if (remaining.length === 0 && isDaemonRunning()) {
            stopDaemon();
            return `Job "${job.name}" disabled. No enabled jobs remain — daemon stopped.`;
          }

          return `Job "${job.name}" disabled.`;
        }

        case 'status': {
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
        }

        default:
          return `Unknown action: ${action}`;
      }
    },
  });
}
