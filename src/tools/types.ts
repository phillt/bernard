/** Options shared by all tool implementations. */
export interface ToolOptions {
  /** Maximum time in milliseconds a shell command may run before being killed. */
  shellTimeout: number;
  /** Callback that prompts the user for confirmation before executing a dangerous command. */
  confirmDangerous: (command: string) => Promise<boolean>;
}

/** Outcome of a shell tool invocation. */
export interface ShellResult {
  /** Combined stdout/stderr output of the command. */
  output: string;
  /** `true` when the command exited with a non-zero status or timed out. */
  is_error: boolean;
}
