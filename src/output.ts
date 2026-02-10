import chalk from 'chalk';

const MAX_TOOL_OUTPUT_LENGTH = 2000;

// Spinner state
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrameIndex = 0;

export function startSpinner(message = 'Thinking'): void {
  if (spinnerTimer) return; // already running
  spinnerFrameIndex = 0;
  process.stdout.write('\x1B[?25l'); // hide cursor
  spinnerTimer = setInterval(() => {
    const frame = SPINNER_FRAMES[spinnerFrameIndex % SPINNER_FRAMES.length];
    process.stdout.write(`\r${chalk.cyan(frame)} ${chalk.gray(message)}`);
    spinnerFrameIndex++;
  }, 80);
}

export function stopSpinner(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
  process.stdout.write('\r\x1B[2K'); // clear line
  process.stdout.write('\x1B[?25h'); // show cursor
}

export function printWelcome(provider: string, model: string): void {
  console.log(chalk.bold.cyan('\n  Bernard') + chalk.gray(' — AI CLI Assistant'));
  console.log(chalk.gray(`  Provider: ${provider} | Model: ${model}`));
  console.log(chalk.gray('  Type /help for commands, exit to quit\n'));
}

export function printAssistantText(text: string): void {
  stopSpinner();
  if (text.trim()) {
    console.log(chalk.white(text));
  }
}

export function printToolCall(toolName: string, args: Record<string, unknown>): void {
  stopSpinner();
  const argsStr = toolName === 'shell'
    ? String(args.command || '')
    : JSON.stringify(args);
  console.log(chalk.yellow(`  ▶ ${toolName}`) + chalk.gray(`: ${argsStr}`));
}

export function printToolResult(toolName: string, result: unknown): void {
  stopSpinner();
  let output: string;
  if (typeof result === 'string') {
    output = result;
  } else if (result && typeof result === 'object' && 'output' in result) {
    output = String((result as { output: string }).output);
  } else {
    output = JSON.stringify(result, null, 2);
  }

  if (output.length > MAX_TOOL_OUTPUT_LENGTH) {
    output = output.slice(0, MAX_TOOL_OUTPUT_LENGTH) + chalk.gray('\n  ... (truncated)');
  }

  const lines = output.split('\n').map(line => chalk.gray(`  ${line}`)).join('\n');
  console.log(lines);
}

export function printError(message: string): void {
  stopSpinner();
  console.error(chalk.red(`Error: ${message}`));
}

export function printInfo(message: string): void {
  console.log(chalk.gray(message));
}

export function printHelp(): void {
  console.log(chalk.cyan('\nCommands:'));
  console.log(chalk.white('  /help') + chalk.gray('    — Show this help'));
  console.log(chalk.white('  /clear') + chalk.gray('   — Clear conversation history and scratch notes'));
  console.log(chalk.white('  /memory') + chalk.gray('  — List persistent memories'));
  console.log(chalk.white('  /scratch') + chalk.gray(' — List session scratch notes'));
  console.log(chalk.white('  /mcp') + chalk.gray('      — List MCP servers and tools'));
  console.log(chalk.white('  /cron') + chalk.gray('     — Show cron jobs and daemon status'));
  console.log(chalk.white('  /provider') + chalk.gray(' — Switch LLM provider'));
  console.log(chalk.white('  /model') + chalk.gray('    — Switch model for current provider'));
  console.log(chalk.white('  /options') + chalk.gray('  — View and set options (max-tokens, shell-timeout)'));
  console.log(chalk.white('  exit') + chalk.gray('      — Quit Bernard'));
  console.log();
}
