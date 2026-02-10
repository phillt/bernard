import { tool } from 'ai';
import { z } from 'zod';
import cron from 'node-cron';
import { CronStore } from '../cron/store.js';
import { isDaemonRunning, startDaemon, stopDaemon } from '../cron/client.js';

export function createCronTool() {
  const store = new CronStore();

  return tool({
    description:
      'Manage scheduled background tasks (cron jobs). Jobs run periodically in a background daemon, executing AI prompts with tool access. Use the notify tool in job prompts when user attention is needed.',
    parameters: z.object({
      action: z.enum(['create', 'list', 'delete', 'enable', 'disable', 'status']).describe('The action to perform'),
      name: z.string().optional().describe('Job name (required for create)'),
      schedule: z.string().optional().describe('Cron expression, e.g. "0 * * * *" for hourly (required for create)'),
      prompt: z.string().optional().describe('The AI prompt to execute on schedule (required for create)'),
      id: z.string().optional().describe('Job ID (required for delete/enable/disable)'),
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
