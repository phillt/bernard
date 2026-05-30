import type { RiskLevel } from '../risk.js';

/**
 * Input passed to the unified pre-execution confirmation callback (issue #144).
 *
 * The augment layer assembles this from each intercepted tool call:
 * `toolName` and `args` come straight from the call, `risk` is derived from
 * the tool's `ToolMeta` via `riskFromMeta`, and `reason` is a short
 * human-readable description for the prompt UI.
 */
export interface ConfirmActionInput {
  /** Registry name of the tool about to run. */
  toolName: string;
  /** Raw arguments object the model passed (after any wrapper/shim rewriting). */
  args: unknown;
  /** Risk tier resolved from tool metadata. */
  risk: RiskLevel;
  /** One-line human description rendered to the user; e.g. the shell command. */
  reason: string;
}

/** A single question for the `askUser` callback. */
export interface AskUserQuestion {
  question: string;
  choices?: string[];
  /** When true and `choices` is present, the implementation appends an escape-hatch row that falls back to free-form input. */
  allowOther: boolean;
  /** Optional label for the escape-hatch row; defaults to a generic "Other" wording. */
  otherLabel?: string;
}

/** Result of an `askUser` batch interaction. `answered` is aligned by index with the input questions. */
export type AskUserBatchResult = { answers: string[] } | { cancelled: true; answered: string[] };

/** Options shared by all tool implementations. */
export interface ToolOptions {
  /** Maximum time in milliseconds a shell command may run before being killed. */
  shellTimeout: number;
  /**
   * Callback that prompts the user for confirmation before executing a dangerous command.
   * The optional `signal` lets callers abort the prompt (e.g. when the user presses Esc).
   */
  confirmDangerous: (command: string, signal?: AbortSignal) => Promise<boolean>;
  /**
   * Unified pre-execution confirmation callback (issue #144). Invoked by the
   * augment layer before each tool call when `policyDecision.toolMode.confirmThreshold`
   * indicates the call's risk crosses the threshold.
   *
   * Returns `true` to proceed; `false` to cancel (the tool's `execute` is
   * never called and the augment layer returns a cancelled-shape result).
   * When omitted, no gating happens — every call proceeds. Cron passes a
   * fixed `(input) => input.risk !== 'high'` so headless runs auto-deny
   * high-risk actions and silently pass through the rest.
   */
  confirmAction?: (input: ConfirmActionInput, signal?: AbortSignal) => Promise<boolean>;
  /**
   * Callback that asks the user one or more questions in sequence. The
   * implementation owns any progress UI (e.g. a tab strip for batches of
   * 2+). On mid-batch cancellation, returns whatever was answered so far.
   * Omitted in non-interactive environments (cron daemon).
   */
  askUser?: (questions: AskUserQuestion[], signal?: AbortSignal) => Promise<AskUserBatchResult>;
}

/** Outcome of a shell tool invocation. */
export interface ShellResult {
  /** Combined stdout/stderr output of the command. */
  output: string;
  /** `true` when the command exited with a non-zero status or timed out. */
  is_error: boolean;
}
