export interface ToolOptions {
  shellTimeout: number;
  confirmDangerous: (command: string) => Promise<boolean>;
}

export interface ShellResult {
  output: string;
  is_error: boolean;
}
