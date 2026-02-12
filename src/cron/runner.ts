import * as crypto from 'node:crypto';
import { generateText } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';
import { getModel } from '../providers/index.js';
import { loadConfig } from '../config.js';
import { MemoryStore } from '../memory.js';
import { createShellTool } from '../tools/shell.js';
import { createMemoryTool, createScratchTool } from '../tools/memory.js';
import { createDateTimeTool } from '../tools/datetime.js';
import { MCPManager } from '../mcp.js';
import { CronStore } from './store.js';
import { CronLogStore, type CronLogStep } from './log-store.js';
import { sendNotification } from './notify.js';
import type { CronJob } from './types.js';

const DAEMON_SYSTEM_PROMPT = `You are Bernard, running in background daemon mode as a scheduled cron job.

Guidelines:
- Execute the task described in the user prompt.
- You have access to shell, memory, scratch, and datetime tools.
- IMPORTANT: Dangerous shell commands are automatically denied in daemon mode. There is no user present to confirm them.
- If you discover something that requires user attention, use the \`notify\` tool to send a desktop notification. Clicking the notification will open a terminal with the alert context.
- You may also have access to MCP tools such as email, calendar, and others depending on configuration.
- Be concise in your analysis. Focus on actionable findings.
- If everything looks normal and no action is needed, simply report the results without notifying.`;

export interface RunJobResult {
  success: boolean;
  output: string;
}

export async function runJob(job: CronJob, log: (msg: string) => void): Promise<RunJobResult> {
  const config = loadConfig();
  const memoryStore = new MemoryStore();
  const store = new CronStore();

  const mcpManager = new MCPManager();
  let mcpTools: Record<string, any> = {};

  try {
    await mcpManager.connect();
    mcpTools = mcpManager.getTools();
    const serverNames = mcpManager.getConnectedServerNames();
    if (serverNames.length > 0) {
      log(`MCP servers connected: ${serverNames.join(', ')}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`MCP initialization failed, continuing without MCP tools: ${message}`);
  }

  const logStore = new CronLogStore();
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const steps: CronLogStep[] = [];
  let stepIndex = 0;

  try {
    const notifyTool = tool({
      description: 'Send a desktop notification to alert the user. Use this when you find something that requires user attention. Clicking the notification will open a terminal with the alert context.',
      parameters: z.object({
        message: z.string().describe('The alert message to show the user'),
        severity: z.enum(['low', 'normal', 'critical']).describe('Urgency level of the notification'),
      }),
      execute: async ({ message, severity }): Promise<string> => {
        const alert = store.createAlert({
          jobId: job.id,
          jobName: job.name,
          message,
          prompt: job.prompt,
          response: '', // Will be updated after generation completes
        });

        sendNotification({
          title: `Bernard: ${job.name}`,
          message,
          severity,
          alertId: alert.id,
          log,
        });

        return `Notification sent for alert ${alert.id}. Terminal will open when the user clicks the notification.`;
      },
    });

    const shellTool = createShellTool({
      shellTimeout: config.shellTimeout,
      confirmDangerous: async () => false, // Auto-deny in daemon mode
    });

    const tools = {
      shell: shellTool,
      memory: createMemoryTool(memoryStore),
      scratch: createScratchTool(memoryStore),
      datetime: createDateTimeTool(),
      notify: notifyTool,
      ...mcpTools,
    };

    const result = await generateText({
      model: getModel(config.provider, config.model),
      tools,
      maxSteps: 20,
      maxTokens: config.maxTokens,
      system: DAEMON_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: job.prompt }],
      onStepFinish: ({ text, toolCalls, toolResults, usage, finishReason }) => {
        const truncatedResults = (toolResults || []).map(tr => ({
          toolName: tr.toolName,
          toolCallId: tr.toolCallId,
          result: truncateResult(tr.result, 10240),
        }));
        steps.push({
          stepIndex: stepIndex++,
          timestamp: new Date().toISOString(),
          text: text || '',
          toolCalls: (toolCalls || []).map(tc => ({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            args: tc.args as Record<string, unknown>,
          })),
          toolResults: truncatedResults,
          usage: {
            promptTokens: usage?.promptTokens ?? 0,
            completionTokens: usage?.completionTokens ?? 0,
            totalTokens: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
          },
          finishReason: finishReason || 'unknown',
        });
      },
    });

    const output = result.text || '(no text output)';

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
        finalOutput: '',
        steps,
        totalUsage,
      });
    } catch {
      // best-effort logging
    }

    return { success: false, output: `Error: ${message}` };
  } finally {
    await mcpManager.close();
  }
}

function truncateResult(result: unknown, maxLen: number): unknown {
  if (typeof result === 'string' && result.length > maxLen) {
    return result.slice(0, maxLen) + `... (truncated, ${result.length} chars total)`;
  }
  return result;
}
