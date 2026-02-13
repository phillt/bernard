import { generateText, type CoreMessage } from 'ai';
import { getModel } from './providers/index.js';
import { createTools, type ToolOptions } from './tools/index.js';
import { createSubAgentTool } from './tools/subagent.js';
import { printAssistantText, printToolCall, printToolResult, printInfo } from './output.js';
import { debugLog } from './logger.js';
import { shouldCompress, compressHistory } from './context.js';
import type { BernardConfig } from './config.js';
import type { MemoryStore } from './memory.js';
import type { RAGStore, RAGSearchResult } from './rag.js';

const BASE_SYSTEM_PROMPT = `You are Bernard, a helpful AI assistant with shell access. You can execute terminal commands to help users with their tasks.

Guidelines:
- Use the shell tool to run commands when the user asks about files, git, processes, or anything requiring terminal access.
- Be concise in your responses.
- When showing command output, summarize the key points rather than repeating everything verbatim.
- If a command fails, explain what went wrong and suggest alternatives.
- Always confirm before running destructive commands (the tool will handle confirmation).
- You are running on the user's local machine. Be careful with commands that modify or delete data.
- Use the memory tool to persist important facts about the user or project that should be recalled in future sessions (e.g. preferences, project conventions, key decisions).
- Use the scratch tool to track progress on complex multi-step tasks within the current session. Scratch notes survive context compression but are discarded when the session ends.
- Use the cron_* tools (cron_create, cron_list, cron_get, cron_update, cron_delete, cron_enable, cron_disable, cron_status) to manage scheduled background tasks for recurring checks, monitoring, or periodic tasks. Jobs run in a background daemon and can use the notify tool to alert the user when attention is needed.
- Use the cron_logs_* tools (cron_logs_list, cron_logs_get, cron_logs_summary, cron_logs_cleanup) to review execution logs from cron job runs.
- Use the web_read tool to fetch and read web pages. Give it a URL and it returns the page content as markdown. Useful for reading documentation, articles, Stack Overflow answers, GitHub pages, or any URL the user shares or that appears in error messages.
- Your context may include a "Recalled Context" section with observations from past sessions. These are automatically retrieved — only reference them if directly relevant to what the user is asking.

## Parallel Execution

You have access to the agent tool which delegates tasks to independent sub-agents that run in parallel. **Always look for opportunities to use parallel sub-agents** — this is one of your biggest advantages over a basic chatbot.

When the user's request involves multiple independent pieces of work, dispatch them as parallel sub-agents rather than doing them one by one. Examples:
- User asks to "check if the API and database are running" → spawn two sub-agents, one for each
- User asks to "find all TODO comments and list recent git activity" → two parallel sub-agents
- User asks to "read these three config files and summarize differences" → one sub-agent per file, then you synthesize
- User asks to "research how to set up X" where X involves multiple docs/pages → one sub-agent per source
- User asks a complex question requiring multiple shell commands on unrelated topics → parallelize them

Do NOT use sub-agents for tasks that are sequential or depend on each other's results — handle those yourself step by step. Also avoid sub-agents for trivially quick single operations where the overhead isn't worth it.`;

/** @internal */
export function buildSystemPrompt(config: BernardConfig, memoryStore: MemoryStore, mcpServerNames?: string[], ragResults?: RAGSearchResult[]): string {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  let prompt = BASE_SYSTEM_PROMPT + `\n\nToday's date is ${today}.`;
  prompt += `\nYou are running as provider: ${config.provider}, model: ${config.model}. The user can switch with /provider and /model.`;

  if (ragResults && ragResults.length > 0) {
    prompt += '\n\n## Recalled Context\nThe following are automatically recalled observations from previous conversations.\nReference them only if directly relevant to the current discussion.';
    for (const r of ragResults) {
      prompt += `\n- ${r.fact}`;
    }
  }

  const memories = memoryStore.getAllMemoryContents();
  if (memories.size > 0) {
    prompt += '\n\n## Persistent Memory\n';
    for (const [key, content] of memories) {
      prompt += `\n### ${key}\n${content}\n`;
    }
  }

  const scratch = memoryStore.getAllScratchContents();
  if (scratch.size > 0) {
    prompt += '\n\n## Scratch Notes (session only)\n';
    for (const [key, content] of scratch) {
      prompt += `\n### ${key}\n${content}\n`;
    }
  }

  prompt += `\n\n## MCP Servers

MCP (Model Context Protocol) servers provide additional tools. Use the mcp_config tool to manage stdio-based MCP servers (command + args). Use the mcp_add_url tool to add URL-based MCP servers (SSE/HTTP endpoints) — just give it a name and URL. Changes take effect after restarting Bernard.`;

  if (mcpServerNames && mcpServerNames.length > 0) {
    prompt += `\n\nCurrently connected MCP servers: ${mcpServerNames.join(', ')}`;
  } else {
    prompt += '\n\nNo MCP servers are currently connected.';
  }

  return prompt;
}

export class Agent {
  private history: CoreMessage[] = [];
  private config: BernardConfig;
  private toolOptions: ToolOptions;
  private memoryStore: MemoryStore;
  private mcpTools?: Record<string, any>;
  private mcpServerNames?: string[];
  private alertContext?: string;
  private ragStore?: RAGStore;
  private abortController: AbortController | null = null;
  private lastPromptTokens: number = 0;

  constructor(config: BernardConfig, toolOptions: ToolOptions, memoryStore: MemoryStore, mcpTools?: Record<string, any>, mcpServerNames?: string[], alertContext?: string, initialHistory?: CoreMessage[], ragStore?: RAGStore) {
    this.config = config;
    this.toolOptions = toolOptions;
    this.memoryStore = memoryStore;
    this.mcpTools = mcpTools;
    this.mcpServerNames = mcpServerNames;
    this.alertContext = alertContext;
    this.ragStore = ragStore;
    if (initialHistory) {
      this.history = [...initialHistory];
      this.lastPromptTokens = Math.ceil(JSON.stringify(initialHistory).length / 4);
    }
  }

  getHistory(): CoreMessage[] {
    return this.history;
  }

  abort(): void {
    this.abortController?.abort();
  }

  async processInput(userInput: string): Promise<void> {
    this.history.push({ role: 'user', content: userInput });

    this.abortController = new AbortController();

    try {
      // Check if context compression is needed
      const newMessageEstimate = Math.ceil(userInput.length / 4);
      if (shouldCompress(this.lastPromptTokens, newMessageEstimate, this.config.model)) {
        printInfo('Compressing conversation context...');
        this.history = await compressHistory(this.history, this.config, this.ragStore);
      }

      // RAG search for relevant memories
      let ragResults: RAGSearchResult[] | undefined;
      if (this.ragStore) {
        try {
          ragResults = await this.ragStore.search(userInput);
          if (ragResults.length > 0) {
            debugLog('agent:rag', { query: userInput.slice(0, 100), results: ragResults.length });
          }
        } catch (err) {
          debugLog('agent:rag:error', err instanceof Error ? err.message : String(err));
        }
      }

      let systemPrompt = buildSystemPrompt(this.config, this.memoryStore, this.mcpServerNames, ragResults);
      if (this.alertContext) {
        systemPrompt += '\n\n' + this.alertContext;
      }

      const baseTools = createTools(this.toolOptions, this.memoryStore, this.mcpTools);
      const tools = {
        ...baseTools,
        agent: createSubAgentTool(this.config, this.toolOptions, this.memoryStore, this.mcpTools),
      };

      const result = await generateText({
        model: getModel(this.config.provider, this.config.model),
        tools,
        maxSteps: 20,
        maxTokens: this.config.maxTokens,
        system: systemPrompt,
        messages: this.history,
        abortSignal: this.abortController.signal,
        onStepFinish: ({ text, toolCalls, toolResults }) => {
          for (const tc of toolCalls) {
            debugLog(`onStepFinish:toolCall:${tc.toolName}`, tc.args);
            printToolCall(tc.toolName, tc.args as Record<string, unknown>);
          }
          for (const tr of toolResults) {
            debugLog(`onStepFinish:toolResult:${tr.toolName}`, tr.result);
            printToolResult(tr.toolName, tr.result);
          }
          if (text) {
            printAssistantText(text);
          }
        },
      });

      // Track token usage for compression decisions
      if (result.usage?.promptTokens) {
        this.lastPromptTokens = result.usage.promptTokens;
      }

      // Append all response messages to history for continuity
      this.history.push(...result.response.messages as CoreMessage[]);
    } catch (err: unknown) {
      // If aborted by user, return silently — user message stays in history
      if (this.abortController?.signal.aborted) return;

      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Agent error: ${message}`);
    } finally {
      this.abortController = null;
    }
  }

  clearHistory(): void {
    this.history = [];
    this.memoryStore.clearScratch();
  }
}
