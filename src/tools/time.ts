import { tool } from 'ai';
import { z } from 'zod';

export function militaryToMinutes(time: number): number {
  const hours = Math.floor(time / 100);
  const minutes = time % 100;
  return hours * 60 + minutes;
}

export function calcRangeMinutes(start: number, end: number): number {
  const startMin = militaryToMinutes(start);
  const endMin = militaryToMinutes(end);
  if (endMin >= startMin) return endMin - startMin;
  return 24 * 60 - startMin + endMin;
}

export function formatHours(totalMinutes: number): string {
  if (totalMinutes === 0) return '0 minutes';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return parts.join(' ');
}

export function createTimeTools() {
  return {
    time_range: tool({
      description:
        'Calculate the duration between two military/24-hour times. Handles next-day wrap (e.g. 2300 to 0100 = 2 hours).',
      parameters: z.object({
        start: z
          .number()
          .describe('Start time in military format (e.g. 800 for 8:00 AM, 1530 for 3:30 PM)'),
        end: z.number().describe('End time in military format'),
      }),
      execute: async ({ start, end }): Promise<string> => {
        const minutes = calcRangeMinutes(start, end);
        return formatHours(minutes);
      },
    }),

    time_range_total: tool({
      description: 'Calculate the total duration across multiple military time ranges.',
      parameters: z.object({
        ranges: z
          .array(
            z.object({
              start: z.number().describe('Start time in military format'),
              end: z.number().describe('End time in military format'),
            }),
          )
          .describe('Array of time ranges'),
      }),
      execute: async ({ ranges }): Promise<string> => {
        const total = ranges.reduce((sum, { start, end }) => sum + calcRangeMinutes(start, end), 0);
        return formatHours(total);
      },
    }),
  };
}
