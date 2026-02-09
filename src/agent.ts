import { generateText, type CoreMessage } from 'ai';
import { getModel } from './providers/index.js';
import { createTools, type ToolOptions } from './tools/index.js';
import { printAssistantText, printToolCall, printToolResult } from './output.js';
import type { BernardConfig } from './config.js';
import type { MemoryStore } from './memory.js';

const BASE_SYSTEM_PROMPT = `You are Bernard, a helpful AI assistant with shell access. You can execute terminal commands to help users with their tasks.

Guidelines:
- Use the shell tool to run commands when the user asks about files, git, processes, or anything requiring terminal access.
- Be concise in your responses.
- When showing command output, summarize the key points rather than repeating everything verbatim.
- If a command fails, explain what went wrong and suggest alternatives.
- Always confirm before running destructive commands (the tool will handle confirmation).
- You are running on the user's local machine. Be careful with commands that modify or delete data.
- Use the memory tool to persist important facts about the user or project that should be recalled in future sessions (e.g. preferences, project conventions, key decisions).
- Use the scratch tool to track progress on complex multi-step tasks within the current session. Scratch notes survive context compression but are discarded when the session ends.`;

function buildSystemPrompt(memoryStore: MemoryStore, mcpServerNames?: string[]): string {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  let prompt = BASE_SYSTEM_PROMPT + `\n\nToday's date is ${today}.`;

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

MCP (Model Context Protocol) servers provide additional tools. Configuration file: ~/.bernard/mcp.json

Format:
\`\`\`json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-name", "/path"],
      "env": {}
    }
  }
}
\`\`\`

You can add or edit MCP servers by modifying this file with the shell tool. Changes take effect after restarting Bernard.`;

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

  constructor(config: BernardConfig, toolOptions: ToolOptions, memoryStore: MemoryStore, mcpTools?: Record<string, any>, mcpServerNames?: string[]) {
    this.config = config;
    this.toolOptions = toolOptions;
    this.memoryStore = memoryStore;
    this.mcpTools = mcpTools;
    this.mcpServerNames = mcpServerNames;
  }

  async processInput(userInput: string): Promise<void> {
    this.history.push({ role: 'user', content: userInput });

    try {
      const result = await generateText({
        model: getModel(this.config.provider, this.config.model),
        tools: createTools(this.toolOptions, this.memoryStore, this.mcpTools),
        maxSteps: 20,
        maxTokens: this.config.maxTokens,
        system: buildSystemPrompt(this.memoryStore, this.mcpServerNames),
        messages: this.history,
        onStepFinish: ({ text, toolCalls, toolResults }) => {
          for (const tc of toolCalls) {
            printToolCall(tc.toolName, tc.args as Record<string, unknown>);
          }
          for (const tr of toolResults) {
            printToolResult(tr.toolName, tr.result);
          }
          if (text) {
            printAssistantText(text);
          }
        },
      });

      // Append all response messages to history for continuity
      this.history.push(...result.response.messages as CoreMessage[]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Agent error: ${message}`);
    }
  }

  clearHistory(): void {
    this.history = [];
    this.memoryStore.clearScratch();
  }
}
