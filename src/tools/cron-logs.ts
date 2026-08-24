import { tool } from 'ai';
import { z } from 'zod';
import { CronLogStore } from '../cron/log-store.js';
import { CronNotesStore } from '../cron/notes-store.js';
import { debugLog } from '../logger.js';
import { attachMeta } from '../framework/tools/adapter.js';

/** Log actions that only read. `cleanup` is the sole mutator. */
export const CRON_LOGS_READ_ACTIONS: ReadonlySet<string> = new Set(['list', 'get', 'summary']);

export const CRON_LOGS_ACTION_NAMES = ['list', 'get', 'summary', 'cleanup'] as const;
export type CronLogsAction = (typeof CRON_LOGS_ACTION_NAMES)[number];

interface CronLogsArgs {
  action: CronLogsAction;
  job_id: string;
  run_id?: string;
  limit?: number;
  offset?: number;
  /**
   * Cleanup mode. Named `mode`, not `action`: the pre-consolidation
   * `cron_logs_cleanup` called this `action`, which now belongs to the outer
   * dispatch enum (#253).
   */
  mode?: 'rotate' | 'delete';
  keep?: number;
}

interface CronLogsDeps {
  logStore: CronLogStore;
  notesStore: CronNotesStore;
}

type CronLogsHandler = (deps: CronLogsDeps, args: CronLogsArgs) => Promise<string>;

/** Per-action handlers, exported for direct unit testing (#253). */
export const CRON_LOGS_ACTIONS: Record<CronLogsAction, CronLogsHandler> = {
  list: async ({ logStore }, { job_id, limit = 10, offset = 0 }) => {
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

  get: async ({ logStore, notesStore }, { job_id, run_id }) => {
    if (!run_id) {
      return 'Error: "get" requires `run_id` (from a list action). Example: {"action":"get","job_id":"<id>","run_id":"<run>"}';
    }
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

    const notes = notesStore.entriesForRun(job_id, run_id);
    if (notes.length > 0) {
      result += `\n\n## Notes written during this run\n`;
      result += notes.map((n) => `- ${n.timestamp} — ${n.text}`).join('\n');
    }

    return result;
  },

  summary: async ({ logStore }, { job_id }) => {
    const total = logStore.getEntryCount(job_id);
    if (total === 0) return `No execution logs found for job "${job_id}".`;

    // Read all entries for summary (capped at most recent 500)
    const entries = logStore.getEntries(job_id, 500, 0);

    const successes = entries.filter((e) => e.success).length;
    const failures = entries.length - successes;
    const successRate = ((successes / entries.length) * 100).toFixed(1);
    const avgDuration = Math.round(entries.reduce((s, e) => s + e.durationMs, 0) / entries.length);
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

  cleanup: async ({ logStore }, { job_id, mode, keep = 500 }) => {
    if (!mode) {
      return 'Error: "cleanup" requires `mode` ("rotate" keeps recent entries, "delete" removes all). Example: {"action":"cleanup","job_id":"<id>","mode":"rotate","keep":500}';
    }
    if (mode === 'delete') {
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
};

/**
 * Consolidated cron-log tool (#253) — one action-enum tool replacing
 * `cron_logs_list` / `_get` / `_summary` / `_cleanup`.
 */
export function createCronLogTool() {
  const deps: CronLogsDeps = { logStore: new CronLogStore(), notesStore: new CronNotesStore() };

  return {
    cron_logs: attachMeta(
      tool({
        description: `Inspect and manage cron job execution logs.

Actions: list · get · summary · cleanup
  list    — recent runs for a job (limit/offset)
  get     — full trace of one run; needs run_id from list
  summary — success rate, avg duration, token totals
  cleanup — needs mode: "rotate" (keep the last \`keep\`) or "delete" (remove all)`,
        parameters: z.object({
          action: z.enum(CRON_LOGS_ACTION_NAMES).describe('The log operation to perform'),
          job_id: z.string().describe('Job ID'),
          run_id: z.string().optional().describe('Run ID from a list action — required by get'),
          limit: z
            .number()
            .min(1)
            .max(50)
            .optional()
            .describe('list: runs to return (max 50, default 10)'),
          offset: z.number().min(0).optional().describe('list: pagination offset (default 0)'),
          mode: z
            .enum(['rotate', 'delete'])
            .optional()
            .describe('cleanup: "rotate" keeps recent entries, "delete" removes all'),
          keep: z
            .number()
            .min(1)
            .max(10000)
            .optional()
            .describe('cleanup+rotate: entries to keep (default 500)'),
        }),
        execute: async (args): Promise<string> => {
          debugLog('cron_logs:execute', args);
          return CRON_LOGS_ACTIONS[args.action](deps, args);
        },
      }),
      {
        name: 'cron_logs',
        kind: 'write',
        deterministic: false,
        sideEffect: 'local',
        cacheable: false,
        isWriteAction: (args: unknown) => {
          const a = (args as { action?: unknown } | undefined)?.action;
          return typeof a !== 'string' || !CRON_LOGS_READ_ACTIONS.has(a);
        },
      },
    ),
  };
}
