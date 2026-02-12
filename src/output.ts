import chalk from 'chalk';
import type { CoreMessage } from 'ai';

const MAX_TOOL_OUTPUT_LENGTH = 2000;
const MAX_REPLAY_LENGTH = 200;

// Rotating colors for sub-agent prefixes
const PREFIX_COLORS = [chalk.magenta, chalk.blue, chalk.green, chalk.yellow] as const;

function formatPrefix(prefix?: string): string {
  if (!prefix) return '';
  // Extract numeric id from "sub:N"
  const match = prefix.match(/^sub:(\d+)$/);
  const colorIndex = match ? (parseInt(match[1], 10) - 1) % PREFIX_COLORS.length : 0;
  const colorFn = PREFIX_COLORS[colorIndex];
  return colorFn(`[${prefix}] `);
}

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

export function printAssistantText(text: string, prefix?: string): void {
  stopSpinner();
  if (text.trim()) {
    const label = formatPrefix(prefix);
    console.log(label + chalk.white(text));
  }
}

export function printToolCall(toolName: string, args: Record<string, unknown>, prefix?: string): void {
  stopSpinner();
  const label = formatPrefix(prefix);
  const argsStr = toolName === 'shell'
    ? String(args.command || '')
    : JSON.stringify(args);
  console.log(label + chalk.yellow(`  ▶ ${toolName}`) + chalk.gray(`: ${argsStr}`));
}

export function printToolResult(toolName: string, result: unknown, prefix?: string): void {
  stopSpinner();
  const label = formatPrefix(prefix);
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

  const lines = output.split('\n').map(line => label + chalk.gray(`  ${line}`)).join('\n');
  console.log(lines);
}

export function printError(message: string): void {
  stopSpinner();
  console.error(chalk.red(`Error: ${message}`));
}

export function printInfo(message: string): void {
  console.log(chalk.gray(message));
}

export function printConversationReplay(messages: CoreMessage[]): void {
  console.log(chalk.dim('  Previous conversation:'));

  for (const msg of messages) {
    if (msg.role === 'tool') continue;

    const text = extractText(msg);
    if (!text) continue;

    const truncated = text.length > MAX_REPLAY_LENGTH
      ? text.slice(0, MAX_REPLAY_LENGTH) + '…'
      : text;

    const prefix = msg.role === 'user' ? '  you> ' : '  assistant> ';
    console.log(chalk.dim(prefix + truncated));
  }

  console.log(chalk.dim('  ———'));
  console.log();
}

function extractText(msg: CoreMessage): string | null {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return null;

  const textParts = msg.content
    .filter((p): p is { type: 'text'; text: string } => typeof p === 'object' && p !== null && 'type' in p && p.type === 'text')
    .map(p => p.text);

  return textParts.length > 0 ? textParts.join(' ') : null;
}

export function printSubAgentStart(id: number, task: string): void {
  const colorFn = PREFIX_COLORS[(id - 1) % PREFIX_COLORS.length];
  const displayTask = task.length > 80 ? task.slice(0, 80) + '…' : task;
  console.log(colorFn(`┌─ sub:${id} — ${displayTask}`));
}

export function printSubAgentEnd(id: number): void {
  const colorFn = PREFIX_COLORS[(id - 1) % PREFIX_COLORS.length];
  console.log(colorFn(`└─ sub:${id} done`));
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
