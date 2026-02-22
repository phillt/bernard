import { tool } from 'ai';
import { z } from 'zod';
import { CronLogStore } from '../cron/log-store.js';
import { debugLog } from '../logger.js';

/**
 * Creates tools for inspecting and managing cron job execution logs.
 *
 * Includes listing recent runs, viewing full execution traces, aggregate
 * statistics, and log rotation/cleanup.
 */
export function createCronLogTools() {
  const logStore = new CronLogStore();

  return {
    cron_logs_list: tool({
      description:
        'List recent cron job execution runs. Returns one-line summaries (no step details). Use cron_logs_get for full traces.',
      parameters: z.object({
        job_id: z.string().describe('Job ID to list runs for'),
        limit: z.number().min(1).max(50).default(10).describe('Number of runs to return (max 50)'),
        offset: z.number().min(0).default(0).describe('Offset for pagination'),
      }),
      execute: async ({ job_id, limit, offset }): Promise<string> => {
        debugLog('cron_logs_list:execute', { job_id, limit, offset });

        const entries = logStore.getEntries(job_id, limit, offset);
        if (entries.length === 0) {
          const total = logStore.getEntryCount(job_id);
          if (total === 0) return `No execution logs found for job "${job_id}".`;
          return `No more entries (total: ${total}, offset: ${offset}).`;
        }

        const total = logStore.getEntryCount(job_id);
        const lines = entries.map((e) => {
          const status = e.success ? 'OK' : 'ERR';
          const dur = `${e.durationMs}ms`;
          const stepCount = e.steps.length;
          const toolCallCount = e.steps.reduce((n, s) => n + s.toolCalls.length, 0);
          return `  [${status}] ${e.completedAt} | ${dur} | ${stepCount} steps, ${toolCallCount} tool calls | run:${e.runId}`;
        });

        return `Execution logs for job "${job_id}" (showing ${entries.length} of ${total}, offset ${offset}):\n${lines.join('\n')}`;
      },
    }),

    cron_logs_get: tool({
      description:
        'Get the full execution trace for a specific cron job run, including all steps, tool calls, and results.',
      parameters: z.object({
        job_id: z.string().describe('Job ID'),
        run_id: z.string().describe('Run ID (from cron_logs_list output)'),
      }),
      execute: async ({ job_id, run_id }): Promise<string> => {
        debugLog('cron_logs_get:execute', { job_id, run_id });

        const entry = logStore.getEntry(job_id, run_id);
        if (!entry) return `No log entry found for job "${job_id}", run "${run_id}".`;

        let result = `Run: ${entry.runId}\n`;
        result += `Job: ${entry.jobName} (${entry.jobId})\n`;
        result += `Status: ${entry.success ? 'success' : 'error'}\n`;
        if (entry.error) result += `Error: ${entry.error}\n`;
        result += `Started: ${entry.startedAt}\n`;
        result += `Completed: ${entry.completedAt}\n`;
        result += `Duration: ${entry.durationMs}ms\n`;
        result += `Tokens: ${entry.totalUsage.promptTokens} prompt + ${entry.totalUsage.completionTokens} completion = ${entry.totalUsage.totalTokens} total\n`;
        result += `Prompt: ${entry.prompt}\n`;
        result += `\n--- Steps (${entry.steps.length}) ---\n`;

        for (const step of entry.steps) {
          result += `\nStep ${step.stepIndex} [${step.timestamp}] (${step.finishReason}):\n`;
          if (step.text) {
            result += `  Text: ${step.text}\n`;
          }
          for (const tc of step.toolCalls) {
            result += `  Tool call: ${tc.toolName}(${JSON.stringify(tc.args)})\n`;
          }
          for (const tr of step.toolResults) {
            const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
            const truncated =
              resultStr.length > 500 ? resultStr.slice(0, 500) + '... (truncated)' : resultStr;
            result += `  Tool result [${tr.toolName}]: ${truncated}\n`;
          }
        }

        result += `\n--- Final Output ---\n${entry.finalOutput}`;
        return result;
      },
    }),

    cron_logs_summary: tool({
      description:
        'Get aggregate statistics for a cron job: success rate, average duration, total token usage, recent run count.',
      parameters: z.object({
        job_id: z.string().describe('Job ID to summarize'),
      }),
      execute: async ({ job_id }): Promise<string> => {
        debugLog('cron_logs_summary:execute', { job_id });

        const total = logStore.getEntryCount(job_id);
        if (total === 0) return `No execution logs found for job "${job_id}".`;

        // Read all entries for summary (capped at most recent 500)
        const entries = logStore.getEntries(job_id, 500, 0);

        const successes = entries.filter((e) => e.success).length;
        const failures = entries.length - successes;
        const successRate = ((successes / entries.length) * 100).toFixed(1);
        const avgDuration = Math.round(
          entries.reduce((s, e) => s + e.durationMs, 0) / entries.length,
        );
        const totalTokens = entries.reduce((s, e) => s + e.totalUsage.totalTokens, 0);
        const avgTokens = Math.round(totalTokens / entries.length);

        let result = `Summary for job "${job_id}" (${entries.length} runs analyzed of ${total} total):\n`;
        result += `  Success rate: ${successRate}% (${successes} ok, ${failures} errors)\n`;
        result += `  Avg duration: ${avgDuration}ms\n`;
        result += `  Total tokens: ${totalTokens} (avg ${avgTokens}/run)\n`;

        if (entries.length > 0) {
          result += `  Latest run: ${entries[0].completedAt} (${entries[0].success ? 'ok' : 'error'})`;
        }

        return result;
      },
    }),

    cron_logs_cleanup: tool({
      description:
        'Rotate or delete cron job execution logs. Use "rotate" to keep only the most recent entries, or "delete" to remove all logs for a job.',
      parameters: z.object({
        job_id: z.string().describe('Job ID'),
        action: z
          .enum(['rotate', 'delete'])
          .describe('Action: "rotate" keeps recent entries, "delete" removes all'),
        keep: z
          .number()
          .min(1)
          .max(10000)
          .default(500)
          .describe('Number of recent entries to keep (only for rotate)'),
      }),
      execute: async ({ job_id, action, keep }): Promise<string> => {
        debugLog('cron_logs_cleanup:execute', { job_id, action, keep });

        if (action === 'delete') {
          const deleted = logStore.deleteJobLogs(job_id);
          if (!deleted) return `No log file found for job "${job_id}".`;
          return `All execution logs deleted for job "${job_id}".`;
        }

        const countBefore = logStore.getEntryCount(job_id);
        if (countBefore === 0) return `No execution logs found for job "${job_id}".`;

        logStore.rotate(job_id, keep);
        const countAfter = logStore.getEntryCount(job_id);

        return `Rotated logs for job "${job_id}": ${countBefore} → ${countAfter} entries (kept last ${keep}).`;
      },
    }),
  };
}
