import * as crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { assembleContext } from '../framework/context.js';
import { RAGStore, type RAGSearchResult } from '../rag.js';
import { debugLog } from '../logger.js';
import { MCPManager } from '../mcp.js';
import { CronStore } from './store.js';
import { CronLogStore, type CronLogStep } from './log-store.js';
import { CronNotesStore } from './notes-store.js';
import { sendNotification } from './notify.js';
import { classifyError } from '../error-taxonomy.js';
import { SpecialistStore } from '../specialists.js';
import { ToolProfileStore } from '../tool-profiles.js';
import type { CronJob } from './types.js';
import {
  definitions,
  registerBuiltinDefinitions,
  type CronInput,
} from '../framework/agents/index.js';
import { runDefinition } from '../framework/agents/run.js';

export {
  /** Re-exported so existing imports against the runner module keep working. */
  DAEMON_SYSTEM_PROMPT,
} from '../framework/agents/cron.js';

/** Outcome of a single cron job execution. */
export interface RunJobResult {
  success: boolean;
  output: string;
}

/**
 * Executes a cron job by running the agent loop (with tools) against the
 * job's prompt. Sets up the runtime context (MCP, RAG, stores), delegates the
 * actual agent loop to {@link cronDefinition} via `runDefinition`, then
 * writes a structured log entry to {@link CronLogStore}.
 *
 * @param job - The cron job definition to execute.
 * @param log - Callback for daemon-level logging.
 */
export async function runJob(job: CronJob, log: (msg: string) => void): Promise<RunJobResult> {
  registerBuiltinDefinitions();
  const config = loadConfig();
  const store = new CronStore();

  let ragStore: RAGStore | undefined;
  if (config.ragEnabled) {
    try {
      ragStore = new RAGStore();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`RAG initialization failed, continuing without RAG: ${msg}`);
    }
  }

  const mcpManager = new MCPManager();
  let mcpTools: Record<string, any> = {};
  let serverNames: string[] = [];

  try {
    await mcpManager.connect();
    mcpTools = mcpManager.getTools();
    serverNames = mcpManager.getConnectedServerNames();
    if (serverNames.length > 0) {
      log(`MCP servers connected: ${serverNames.join(', ')}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`MCP initialization failed, continuing without MCP tools: ${message}`);
  }

  const ctx = assembleContext({
    config,
    toolOptions: {
      shellTimeout: config.shellTimeout,
      confirmDangerous: async () => false,
      // Cron is headless: silently proceed through low/medium-risk tool calls, auto-deny high-risk
      // (per #144 — "never send email unless explicitly authorized"). The agent receives a
      // cancelled-shape result and can decide whether to surface the gap to the user.
      confirmAction: async (input) => input.risk !== 'high',
      // askUser intentionally omitted — no interactive user; the ask_user tool returns {unavailable}.
    },
    mcp: { tools: mcpTools, serverNames },
    rag: ragStore,
    // Cron's agent definition only touches ctx.stores.memory (see src/framework/agents/cron.ts).
    // Skip seeding for the two stores cron never uses so the daemon doesn't race the REPL on
    // first-run bundled-specialist / tool-profile writes (issue #163).
    stores: {
      specialists: new SpecialistStore({ seed: false }),
      toolProfiles: new ToolProfileStore({ seed: false }),
    },
  });

  const logStore = new CronLogStore();
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const steps: CronLogStep[] = [];
  const notesStore = new CronNotesStore();

  // RAG search using job prompt as query (same scoping as the previous inline runner).
  let ragResults: RAGSearchResult[] | undefined;
  if (ragStore) {
    try {
      ragResults = await ragStore.search(job.prompt);
      if (ragResults.length > 0) {
        debugLog('cron:rag', {
          jobId: job.id,
          query: job.prompt.slice(0, 100),
          results: ragResults.length,
        });
      }
    } catch (err) {
      debugLog('cron:rag:error', err instanceof Error ? err.message : String(err));
    }
  }

  try {
    const def = definitions.get<CronInput, string>('cron');
    const input: CronInput = {
      job,
      runId,
      steps,
      store,
      notesStore,
      log,
      serverNames,
      mcpTools,
      ragResults,
    };
    const { formatted: output } = await runDefinition(ctx, def, input);

    try {
      const totalUsage = steps.reduce(
        (acc, s) => ({
          promptTokens: acc.promptTokens + s.usage.promptTokens,
          completionTokens: acc.completionTokens + s.usage.completionTokens,
          totalTokens: acc.totalTokens + s.usage.totalTokens,
        }),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      );
      logStore.appendEntry({
        runId,
        jobId: job.id,
        jobName: job.name,
        prompt: job.prompt,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        success: true,
        finalOutput: output,
        steps,
        totalUsage,
      });
    } catch (logErr: unknown) {
      const logMsg = logErr instanceof Error ? logErr.message : String(logErr);
      log(`Warning: failed to write execution log: ${logMsg}`);
    }

    return { success: true, output };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const cls = classifyError({ message });

    try {
      const totalUsage = steps.reduce(
        (acc, s) => ({
          promptTokens: acc.promptTokens + s.usage.promptTokens,
          completionTokens: acc.completionTokens + s.usage.completionTokens,
          totalTokens: acc.totalTokens + s.usage.totalTokens,
        }),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      );
      logStore.appendEntry({
        runId,
        jobId: job.id,
        jobName: job.name,
        prompt: job.prompt,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        success: false,
        error: message,
        errorCategory: cls.category,
        finalOutput: '',
        steps,
        totalUsage,
      });
    } catch {
      // best-effort logging
    }

    // Best-effort failure alert. Headless cron has no user looking at stdout,
    // so the desktop notification is how the user finds out something broke.
    // Severity comes straight from the taxonomy: auth/permission ring loud,
    // transient/rate-limit ring quiet.
    //
    // Write `lastRunStatus: 'error'` here (rather than waiting for the
    // scheduler's post-runJob update) so the alert and the user's first /cron
    // status read see a consistent terminal state — otherwise a notification
    // can arrive while jobs.json still reads `lastRunStatus: 'running'`.
    try {
      store.updateJob(job.id, {
        lastErrorCategory: cls.category,
        lastRunStatus: 'error',
        lastResult: message.slice(0, 2000),
      });
      const alert = store.createAlert({
        jobId: job.id,
        jobName: job.name,
        message: `${cls.category}: ${message.split('\n')[0].slice(0, 200)}`,
        prompt: job.prompt,
        response: '',
      });
      sendNotification({
        title: `Bernard cron failed: ${job.name}`,
        message: `${cls.category} — ${cls.playbook.user}`,
        severity: cls.severity,
        alertId: alert.id,
        log,
      });
    } catch (alertErr) {
      log(
        `Warning: failed to send failure alert: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`,
      );
    }

    return { success: false, output: `Error: ${message}` };
  } finally {
    await mcpManager.close();
  }
}
