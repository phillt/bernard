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
export type AskUserBatchResult =
  | { answers: string[] }
  | { cancelled: true; answered: string[] };

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
   * Callback that asks the user one or more questions in sequence. The
   * implementation owns any progress UI (e.g. a tab strip for batches of
   * 2+). On mid-batch cancellation, returns whatever was answered so far.
   * Omitted in non-interactive environments (cron daemon).
   */
  askUser?: (
    questions: AskUserQuestion[],
    signal?: AbortSignal,
  ) => Promise<AskUserBatchResult>;
}

/** Outcome of a shell tool invocation. */
export interface ShellResult {
  /** Combined stdout/stderr output of the command. */
  output: string;
  /** `true` when the command exited with a non-zero status or timed out. */
  is_error: boolean;
}
