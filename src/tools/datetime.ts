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

/** Returns a human-readable date+time string for use in system prompts. */
export function formatCurrentDateTime(): string {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return `${date} at ${time}`;
}

/** Wraps user input with a local ISO 8601 timestamp prefix. */
export function timestampUserMessage(userInput: string): string {
  const now = new Date();
  const tzOffset = -now.getTimezoneOffset();
  const sign = tzOffset >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(tzOffset) % 60).padStart(2, '0');
  const localISO =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` +
    `T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}` +
    `${sign}${hh}:${mm}`;
  return `[${localISO}] ${userInput}`;
}

/** Strips a leading [ISO-timestamp] prefix from a message string. */
export function stripTimestamp(text: string): string {
  return text.replace(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]\s*/, '');
}
