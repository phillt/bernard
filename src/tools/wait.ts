import { tool } from 'ai';
import { z } from 'zod';

export const MAX_WAIT_SECONDS = 300;
export const MIN_WAIT_SECONDS = 0.1;

export function createWaitTool() {
  return tool({
    description:
      'Pause execution for a specified number of seconds. ' +
      'Use when a task requires waiting within the current turn ' +
      '(e.g., server restart, build, deploy propagation). ' +
      `Min: ${MIN_WAIT_SECONDS}s, max: ${MAX_WAIT_SECONDS}s.`,
    parameters: z.object({
      seconds: z
        .number()
        .min(MIN_WAIT_SECONDS)
        .max(MAX_WAIT_SECONDS)
        .describe('Number of seconds to wait (0.1–300)'),
    }),
    execute: async ({ seconds }): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return `Waited ${seconds} second${seconds === 1 ? '' : 's'}.`;
    },
  });
}
