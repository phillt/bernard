/** Result of an `askUser` interaction. */
export type AskUserResult = { answer: string } | { cancelled: true };

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
   * Callback that asks the user a question, either by free-form input or by
   * picking from `choices`. When `allowOther` is true and `choices` is given,
   * the implementation appends an escape-hatch option (labelled `otherLabel`
   * if provided, otherwise a generic default) that falls back to free-form
   * input. Omitted in non-interactive environments (cron daemon).
   */
  askUser?: (
    question: string,
    choices: string[] | undefined,
    allowOther: boolean,
    otherLabel: string | undefined,
    signal?: AbortSignal,
  ) => Promise<AskUserResult>;
}

/** Outcome of a shell tool invocation. */
export interface ShellResult {
  /** Combined stdout/stderr output of the command. */
  output: string;
  /** `true` when the command exited with a non-zero status or timed out. */
  is_error: boolean;
}
