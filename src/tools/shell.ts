import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolOptions, ShellResult } from './types.js';
import { isReadOnlyShellInvocation } from '../tool-permissions.js';
import type { BernardTool } from '../framework/tools/types.js';
import { ok, err } from '../framework/tools/types.js';
import {
  OFFERABLE_BUDGETS,
  claimOffer,
  doubled,
  offerChoices,
  shellTimeoutMessage,
} from '../timeout-offer.js';
import { saveActiveSettings } from '../profiles.js';
import { debugLog } from '../logger.js';
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
/**
 * The shell's own wording for "I could not execute that".
 *
 * Matched against stderr, and only when stdout is empty. Deliberately the
 * specific phrasings a shell emits rather than a bare /not found/, which would
 * catch a program legitimately reporting zero results.
 */
const COMMAND_MISSING_RE = /(command not found|: not found|is not recognized)/i;

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

/** One `spawnSync` invocation, so the retry below reuses it rather than a copy. */
function run(command: string, timeout: number) {
  return spawnSync(command, {
    shell: true,
    encoding: 'utf-8',
    timeout,
    maxBuffer: 1024 * 1024 * 10, // 10MB
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Whether `spawnSync` killed the child for running too long.
 *
 * `code` is the reliable signal; `signal` is checked as well because a kill
 * delivered as SIGTERM with no code is what some platforms report, and the
 * alternative — matching the message string — is the thing #477 is fixing one
 * level up.
 */
function isTimeoutError(e: unknown): boolean {
  if (!e) return false;
  const err = e as { code?: string; signal?: string };
  return err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
}

/**
 * Asks whether to retry with a higher shell timeout, and applies the chosen scope.
 *
 * Returns the new budget when the user accepted, `undefined` otherwise. The
 * once / session / profile ladder is the step-limit continuation's (#292), reused
 * rather than reinvented so a user who has met one ceiling prompt recognises the
 * next — and `once` deliberately writes nothing, which is what makes accepting
 * safe for someone who only wants this one command to finish.
 *
 * Fails closed: a prompt channel that throws, an Esc, or an answer that matches no
 * row all yield `undefined` and the timeout is reported as it would have been.
 */
async function offerHigherShellTimeout(
  options: ToolOptions,
  command: string,
  budgetMs: number,
): Promise<number | undefined> {
  const next = doubled(budgetMs);
  const spec = OFFERABLE_BUDGETS.shell;
  if (!spec) return undefined;
  const choices = offerChoices(next, spec.command);
  let answer;
  try {
    answer = await options.askUser?.([
      {
        question: `\`${command}\` hit the ${budgetMs} ms shell timeout. That budget is ${spec.rationale}. How should I proceed?`,
        choices: choices.map((c) => c.label),
        allowOther: false,
      },
    ]);
  } catch {
    return undefined;
  }
  if (!answer || !('answers' in answer)) return undefined;
  const raw = answer.answers[0];
  const picked = Array.isArray(raw) ? raw[0] : raw;
  const scope = choices.find((c) => c.label === picked)?.scope;
  if (!scope || scope === 'decline') return undefined;

  // A live bump of the shared config, exactly as the step-limit ladder does it.
  // Through the callback rather than by assigning `options.shellTimeout`, which
  // is a getter over that config: one source of truth, so `/options
  // shell-timeout` cannot disagree with what the tool actually uses.
  if (scope !== 'once') options.raiseShellTimeout?.(next);
  if (scope === 'profile') {
    try {
      saveActiveSettings({ [spec.settingKey]: next });
    } catch {
      // Best-effort persist; the session bump above still applies.
    }
  }
  debugLog('shell:timeout-raised', { from: budgetMs, to: next, scope });
  return next;
}

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
        // `spawnSync`, not `execSync`, for ONE reason: `execSync` returns
        // stdout and nothing else, so on the success path stderr is captured
        // by the child and then discarded — there is no way to read it.
        //
        // That silently loses the most diagnostic string a shell produces.
        // `execSync` throws only on a non-zero exit, and in a PIPELINE the exit
        // status is the last stage's, so `rg foo src | head -5` with no `rg`
        // installed exits 0 and returns clean, empty, successful output. A real
        // session burned ~30 minutes and 50 messages on exactly that: the model
        // ran a search, was told "(no output)" with `is_error: false`, and
        // correctly concluded the string it was hunting did not exist. It did,
        // 46 times — `rg: not found` had gone to a stream nobody read.
        //
        // Sibling of #363/#364 (a tool that fails while returning), with a
        // mechanism no result-shape check could ever see: the evidence was not
        // in the result at all.
        let budgetMs = options.shellTimeout;
        let proc = run(command, budgetMs);

        // **The timeout branch, which did not exist (#477).** `spawnSync` reports
        // a kill through `proc.error` with `code: 'ETIMEDOUT'`, and throwing it
        // into the generic `catch` below produced `spawnSync /bin/sh ETIMEDOUT` —
        // naming neither the command nor the budget it exceeded, and discarding
        // the partial output `spawnSync` had already collected.
        if (isTimeoutError(proc.error)) {
          const partial = [
            normalizeToolText(proc.stdout || ''),
            normalizeToolText(proc.stderr || ''),
          ]
            .filter(Boolean)
            .join('\n');
          // Offered once per session, and only because `shell` is in
          // `OFFERABLE_BUDGETS` — the two stall guards are absent from that table
          // on purpose, since they detect that something stopped responding
          // rather than express how long work should take. No `askUser` means
          // headless (cron, `bernard script`), where the improved message still
          // lands and the offer is simply skipped.
          if (options.askUser && claimOffer('shell')) {
            const raised = await offerHigherShellTimeout(options, command, budgetMs);
            if (raised) {
              budgetMs = raised;
              proc = run(command, budgetMs);
              if (!isTimeoutError(proc.error)) {
                // The retry got somewhere. Fall through to the ordinary result
                // handling below rather than duplicating it here.
                if (proc.error) throw proc.error;
              }
            }
          }
          if (isTimeoutError(proc.error)) {
            const message = shellTimeoutMessage(command, budgetMs, partial);
            return err({
              type: 'timeout',
              message,
              snippet: message.slice(0, ERROR_SNIPPET_MAX),
            });
          }
        }
        if (proc.error) throw proc.error;
        const outText = normalizeToolText(proc.stdout || '');
        const errText = normalizeToolText(proc.stderr || '');
        if (proc.status !== 0) {
          const output = [outText, errText].filter(Boolean).join('\n') || 'Command failed';
          return err({
            type: 'exec_failed',
            message: output,
            snippet: output.slice(0, ERROR_SNIPPET_MAX),
          });
        }
        // A command that NEVER RAN is a failure, whatever the pipeline exited.
        // This is deliberately narrower than the "any stderr" rule rejected
        // above: nothing on stdout, and stderr carrying the shell's own
        // could-not-execute wording. `rg foo src | head` with no `rg` installed
        // exits 0 because `head` did, and reporting that as success is not a
        // warning — it is an answer to a search that never happened.
        //
        // Saying so also makes it LEARNABLE. `detectToolError` gates
        // `recordOutcome`, and `classifyError` already rates a shell
        // "not found" as `not_found` + correctable — so the tool profile picks
        // up "this binary is missing here" once, instead of the model reaching
        // for it again every session.
        if (!outText && COMMAND_MISSING_RE.test(errText)) {
          return err({
            type: 'not_found',
            message: errText,
            snippet: errText.slice(0, ERROR_SNIPPET_MAX),
          });
        }
        // Deliberately NOT `[stdout, stderr].join()` on success. Plenty of
        // working commands write progress and warnings to stderr, and folding
        // that into every result would be noise on the common path. The silent
        // case is the narrow one: nothing on stdout, something on stderr. There
        // it is the only information available, so it replaces "(no output)".
        // `is_error` stays false — the pipeline really did exit 0, and claiming
        // otherwise would mislabel every command that warns and succeeds.
        return ok({ output: outText || errText || '(no output)', is_error: false });
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
