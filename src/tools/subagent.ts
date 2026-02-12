import { generateText, tool } from 'ai';
import { z } from 'zod';
import { getModel } from '../providers/index.js';
import { createTools, type ToolOptions } from './index.js';
import { printSubAgentStart, printSubAgentEnd, printToolCall, printToolResult, printAssistantText } from '../output.js';
import type { BernardConfig } from '../config.js';
import type { MemoryStore } from '../memory.js';

const MAX_CONCURRENT_AGENTS = 4;

let activeAgentCount = 0;
let nextAgentId = 1;

const SUB_AGENT_SYSTEM_PROMPT = `You are a focused sub-agent of Bernard, an AI CLI assistant. You have been delegated a specific task. Complete it efficiently and report your findings concisely.

Guidelines:
- Focus only on the assigned task.
- Use tools as needed to accomplish the task.
- Be thorough but concise in your final response.
- If a command fails, try alternatives before giving up.
- Your response will be returned to the main agent for synthesis.`;

/** Reset module state — for testing only. */
export function _resetSubAgentState(): void {
  activeAgentCount = 0;
  nextAgentId = 1;
}

export function createSubAgentTool(
  config: BernardConfig,
  options: ToolOptions,
  memoryStore: MemoryStore,
  mcpTools?: Record<string, any>,
) {
  return tool({
    description: 'Delegate a task to an independent sub-agent that runs in parallel. Each sub-agent gets its own tool set and works independently. Call this tool multiple times in a single response to run tasks in parallel.',
    parameters: z.object({
      task: z.string().describe('The task for the sub-agent to complete'),
      context: z.string().optional().describe('Optional additional context to help the sub-agent'),
    }),
    execute: async ({ task, context }, execOptions) => {
      if (activeAgentCount >= MAX_CONCURRENT_AGENTS) {
        return `Error: Maximum concurrent sub-agents (${MAX_CONCURRENT_AGENTS}) reached. Wait for existing sub-agents to finish.`;
      }

      const id = nextAgentId++;
      activeAgentCount++;
      const prefix = `sub:${id}`;

      printSubAgentStart(id, task);

      try {
        const baseTools = createTools(options, memoryStore, mcpTools);

        let userMessage = `Task: ${task}`;
        if (context) {
          userMessage += `\n\nContext: ${context}`;
        }

        const result = await generateText({
          model: getModel(config.provider, config.model),
          tools: baseTools,
          maxSteps: 10,
          maxTokens: config.maxTokens,
          system: SUB_AGENT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
          abortSignal: execOptions.abortSignal,
          onStepFinish: ({ text, toolCalls, toolResults }) => {
            for (const tc of toolCalls) {
              printToolCall(tc.toolName, tc.args as Record<string, unknown>, prefix);
            }
            for (const tr of toolResults) {
              printToolResult(tr.toolName, tr.result, prefix);
            }
            if (text) {
              printAssistantText(text, prefix);
            }
          },
        });

        printSubAgentEnd(id);
        return result.text;
      } catch (err: unknown) {
        printSubAgentEnd(id);
        const message = err instanceof Error ? err.message : String(err);
        return `Sub-agent error: ${message}`;
      } finally {
        activeAgentCount--;
      }
    },
  });
}
