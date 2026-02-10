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
import { sendNotification, openAlertTerminal } from './notify.js';
import type { CronJob } from './types.js';

const DAEMON_SYSTEM_PROMPT = `You are Bernard, running in background daemon mode as a scheduled cron job.

Guidelines:
- Execute the task described in the user prompt.
- You have access to shell, memory, scratch, and datetime tools.
- IMPORTANT: Dangerous shell commands are automatically denied in daemon mode. There is no user present to confirm them.
- If you discover something that requires user attention, use the \`notify\` tool to send a desktop notification and open an alert terminal.
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

  try {
    const notifyTool = tool({
      description: 'Send a desktop notification to alert the user. Use this when you find something that requires user attention. This will also open a new terminal session with the alert context.',
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

        sendNotification(`Bernard: ${job.name}`, message, severity, log);
        openAlertTerminal(alert.id, log);

        return `Notification sent and terminal opened for alert ${alert.id}.`;
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
    });

    const output = result.text || '(no text output)';
    return { success: true, output };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Error: ${message}` };
  } finally {
    await mcpManager.close();
  }
}
