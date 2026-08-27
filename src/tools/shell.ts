import { z } from 'zod';
import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolOptions, ShellResult } from './types.js';
import { isReadOnlyShellInvocation } from '../tool-permissions.js';
import type { BernardTool } from '../framework/tools/types.js';
import { ok, err } from '../framework/tools/types.js';
import { normalizeToolText } from '../text.js';
import { ERROR_SNIPPET_MAX } from '../tool-result-shape.js';

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

// Glob characters would let the shell expand the path past the prefix check.
const GLOB_RE = /[*?[\]{}!]/;

// Quotes or expansion sigils inside a token signal an attempt to inject more
// shell work — the safelist only handles literal paths.
const UNSAFE_TOKEN_CHARS = /['"`$\\]/;

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
    if (GLOB_RE.test(t)) return false;
    if (UNSAFE_TOKEN_CHARS.test(t)) return false;
    if (t.split('/').includes('..')) return false;
    // Resolve against cwd to catch `bernard-x/../..` traversal that would
    // escape the tmp prefix once the shell evaluates it.
    const resolved = path.resolve(t);
    return resolved.startsWith(BERNARD_TMP_PREFIX);
  });
}

const SHELL_DESCRIPTION =
  'Execute a shell command in the current working directory and return its output. Use this for git commands, running scripts, and any terminal task. For reading and editing files, prefer file_read_lines and file_edit_lines.';

const SHELL_PARAMETERS = z.object({
  command: z.string().describe('The shell command to execute'),
});

type ShellArgs = z.infer<typeof SHELL_PARAMETERS>;

/**
 * Creates the shell execution tool that runs commands in the user's terminal.
 *
 * Dangerous commands are intercepted and require explicit user confirmation
 * before execution, unless they match a safelist of Bernard-owned operations.
 *
 * Returns a {@link BernardTool}; the AI-SDK adapter preserves the historical
 * `{output, is_error}` shape via `serializeForModel`.
 *
 * @param options - Shell timeout and dangerous-command confirmation callback.
 */
export function createShellTool(options: ToolOptions): BernardTool<ShellArgs, ShellResult> {
  return {
    meta: {
      name: 'shell',
      kind: 'dangerous',
      category: 'shell',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
      // Per-call refinement (#212): simple invocations of known read-only
      // commands (`ls`, `git status`, …) are read-shaped — they drop to low
      // risk (no confirm prompt) and pass the read-only-mode block gate.
      // Complex lines (pipes/redirects/subshells/newlines) and unknown
      // commands stay write-shaped, keeping the historic dangerous/high path.
      isWriteAction: (args: unknown) => {
        const cmd = (args as Record<string, unknown> | undefined)?.command;
        return typeof cmd === 'string' ? !isReadOnlyShellInvocation(cmd) : true;
      },
    },
    description: SHELL_DESCRIPTION,
    parameters: SHELL_PARAMETERS,
    execute: async ({ command }, execOptions) => {
      // The unified `confirmAction` gate (#144/#212) is installed centrally in
      // `runDefinition` (`augmentTools`) and is profile-, session-, and
      // skip-permissions-aware; it already gates dangerous shell calls
      // (meta.kind: 'dangerous' → high risk). When it's wired (the REPL),
      // calling `confirmDangerous` here too would prompt a SECOND time and
      // ignore every "always allow" / "allow for session" / skip-permissions
      // decision the user already made (#212). So only fall back to the legacy
      // `confirmDangerous` callback when the unified gate is ABSENT — covers
      // tests and callers that haven't migrated.
      if (!options.confirmAction && isDangerous(command) && !isSafelisted(command)) {
        const confirmed = await options.confirmDangerous(command, execOptions?.abortSignal);
        if (!confirmed) {
          return ok({ output: 'Command cancelled by user.', is_error: false });
        }
      }

      try {
        const stdout = execSync(command, {
          encoding: 'utf-8',
          timeout: options.shellTimeout,
          maxBuffer: 1024 * 1024 * 10, // 10MB
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return ok({ output: normalizeToolText(stdout) || '(no output)', is_error: false });
      } catch (e: unknown) {
        const execError = e as { stderr?: string; stdout?: string; message?: string };
        const stderr = normalizeToolText(execError.stderr || '');
        const stdout = normalizeToolText(execError.stdout || '');
        const rawMessage = execError.message || 'Command failed';
        const output = [stdout, stderr].filter(Boolean).join('\n') || normalizeToolText(rawMessage);
        return err({
          type: 'exec_failed',
          message: output,
          snippet: output.slice(0, ERROR_SNIPPET_MAX),
        });
      }
    },
    serializeForModel: (r) =>
      r.status === 'ok' ? r.result : { output: r.error.message, is_error: true },
  };
}
