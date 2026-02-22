import { tool } from 'ai';
import { z } from 'zod';

/** Creates a tool that returns the current local date and time as a human-readable string. */
export function createDateTimeTool() {
  return tool({
    description:
      'Get the current date and time including hours and minutes. Use this when the user asks for the current time or when you need a precise timestamp.',
    parameters: z.object({}),
    execute: async (): Promise<string> => {
      const now = new Date();
      return now.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      });
    },
  });
}
