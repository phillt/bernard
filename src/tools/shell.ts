import { tool } from 'ai';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import type { ToolOptions, ShellResult } from './types.js';

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r/, // rm with -r flag
  /\brm\s+(-[^\s]*\s+)*-[^\s]*f/, // rm with -f flag
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\b>\s*\/dev\/sd/,
  /\bchmod\s+777\b/,
  /\bchown\s+-R\b/,
  /\breboot\b/,
  /\bshutdown\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bkill\s+-9\b/,
  /\bpkill\b/,
  /\bkillall\b/,
];

/** @internal */
export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

export function createShellTool(options: ToolOptions) {
  return tool({
    description:
      'Execute a shell command in the current working directory and return its output. Use this for file operations, git commands, running scripts, and any terminal task.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
    }),
    execute: async ({ command }): Promise<ShellResult> => {
      if (isDangerous(command)) {
        const confirmed = await options.confirmDangerous(command);
        if (!confirmed) {
          return { output: 'Command cancelled by user.', is_error: false };
        }
      }

      try {
        const stdout = execSync(command, {
          encoding: 'utf-8',
          timeout: options.shellTimeout,
          maxBuffer: 1024 * 1024 * 10, // 10MB
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { output: stdout || '(no output)', is_error: false };
      } catch (err: unknown) {
        const execError = err as { stderr?: string; stdout?: string; message?: string };
        const stderr = execError.stderr || '';
        const stdout = execError.stdout || '';
        const output =
          [stdout, stderr].filter(Boolean).join('\n') || execError.message || 'Command failed';
        return { output, is_error: true };
      }
    },
  });
}
