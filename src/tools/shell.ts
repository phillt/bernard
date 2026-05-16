import { tool } from 'ai';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
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

/**
 * Tests whether a shell command matches any dangerous pattern (rm -rf, sudo, mkfs, etc.).
 *
 * @internal Exported for testing only.
 * @param command - The raw shell command string to evaluate.
 * @returns `true` if the command matches a dangerous pattern.
 */
export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

// Reject commands containing these so the safelist can't be tricked into
// composing additional shell work outside its narrow scope.
const META_RE = /[;&|`>]|\$\(/;

/**
 * The agent's system prompt instructs the model to write temp scripts under
 * this prefix and clean them up afterward, so the cleanup must not require
 * confirmation.
 */
export const BERNARD_TMP_PREFIX = path.join(os.tmpdir(), 'bernard-');

/**
 * Commands that match a dangerous pattern but should bypass the confirmation
 * prompt because they operate exclusively on Bernard's own workspace.
 *
 * @internal Exported for testing only.
 */
export function isSafelisted(command: string): boolean {
  const trimmed = command.trim();
  if (!/^rm(\s|$)/.test(trimmed)) return false;
  if (META_RE.test(trimmed)) return false;

  const paths = trimmed
    .split(/\s+/)
    .slice(1)
    .filter((t) => !t.startsWith('-'));
  if (paths.length === 0) return false;

  return paths.every((t) => {
    const unquoted = t.replace(/^['"]/, '').replace(/['"]$/, '');
    return unquoted.startsWith(BERNARD_TMP_PREFIX);
  });
}

/**
 * Creates the shell execution tool that runs commands in the user's terminal.
 *
 * Dangerous commands are intercepted and require explicit user confirmation
 * before execution, unless they match a safelist of Bernard-owned operations.
 *
 * @param options - Shell timeout and dangerous-command confirmation callback.
 */
export function createShellTool(options: ToolOptions) {
  return tool({
    description:
      'Execute a shell command in the current working directory and return its output. Use this for git commands, running scripts, and any terminal task. For reading and editing files, prefer file_read_lines and file_edit_lines.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
    }),
    execute: async ({ command }, execOptions): Promise<ShellResult> => {
      if (isDangerous(command) && !isSafelisted(command)) {
        const confirmed = await options.confirmDangerous(command, execOptions?.abortSignal);
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
