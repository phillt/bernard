import type { CoreMessage } from 'ai';
import { getContextWindow, COMPRESSION_THRESHOLD } from './context.js';
import { getTheme } from './theme.js';

const MAX_TOOL_OUTPUT_LENGTH = 2000;
const MAX_REPLAY_LENGTH = 200;

export interface SpinnerStats {
  startTime: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  latestPromptTokens: number;
  model: string;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
}

export function buildSpinnerMessage(stats: SpinnerStats): string {
  const elapsed = formatElapsed(Date.now() - stats.startTime);

  if (stats.totalPromptTokens === 0 && stats.totalCompletionTokens === 0) {
    return `Thinking (${elapsed})`;
  }

  const up = formatTokenCount(stats.totalPromptTokens);
  const down = formatTokenCount(stats.totalCompletionTokens);
  const contextWindow = getContextWindow(stats.model);
  const thresholdTokens = contextWindow * COMPRESSION_THRESHOLD;
  const remainingPct = Math.max(0, Math.round((thresholdTokens - stats.latestPromptTokens) / thresholdTokens * 100));

  return `Thinking (${elapsed} | ${up}\u2191 ${down}\u2193 | ${remainingPct}% until compression)`;
}

function formatPrefix(prefix?: string): string {
  if (!prefix) return '';
  const prefixColors = getTheme().prefixColors;
  const match = prefix.match(/^sub:(\d+)$/);
  const colorIndex = match ? (parseInt(match[1], 10) - 1) % prefixColors.length : 0;
  const colorFn = prefixColors[colorIndex];
  return colorFn(`[${prefix}] `);
}

// Spinner state
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrameIndex = 0;

export function startSpinner(message: string | (() => string) = 'Thinking'): void {
  if (spinnerTimer) return; // already running
  spinnerFrameIndex = 0;
  const getMessage = typeof message === 'function' ? message : () => message;
  process.stdout.write('\x1B[?25l'); // hide cursor
  spinnerTimer = setInterval(() => {
    const frame = SPINNER_FRAMES[spinnerFrameIndex % SPINNER_FRAMES.length];
    process.stdout.write(`\r\x1B[2K${getTheme().accent(frame)} ${getTheme().muted(getMessage())}`);
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
  console.log(getTheme().accentBold('\n  Bernard') + getTheme().muted(' — AI CLI Assistant'));
  console.log(getTheme().muted(`  Provider: ${provider} | Model: ${model}`));
  console.log(getTheme().muted('  Type /help for commands, exit to quit\n'));
}

export function printAssistantText(text: string, prefix?: string): void {
  stopSpinner();
  if (text.trim()) {
    const label = formatPrefix(prefix);
    console.log(label + getTheme().text(text));
  }
}

export function printToolCall(toolName: string, args: Record<string, unknown>, prefix?: string): void {
  stopSpinner();
  const label = formatPrefix(prefix);
  const argsStr = toolName === 'shell'
    ? String(args.command || '')
    : JSON.stringify(args);
  console.log(label + getTheme().toolCall(`  ▶ ${toolName}`) + getTheme().muted(`: ${argsStr}`));
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
    output = output.slice(0, MAX_TOOL_OUTPUT_LENGTH) + getTheme().muted('\n  ... (truncated)');
  }

  const lines = output.split('\n').map(line => label + getTheme().muted(`  ${line}`)).join('\n');
  console.log(lines);
}

export function printError(message: string): void {
  stopSpinner();
  console.error(getTheme().error(`Error: ${message}`));
}

export function printInfo(message: string): void {
  console.log(getTheme().muted(message));
}

export function printConversationReplay(messages: CoreMessage[]): void {
  console.log(getTheme().dim('  Previous conversation:'));

  for (const msg of messages) {
    if (msg.role === 'tool') continue;

    const text = extractText(msg);
    if (!text) continue;

    const truncated = text.length > MAX_REPLAY_LENGTH
      ? text.slice(0, MAX_REPLAY_LENGTH) + '…'
      : text;

    const prefix = msg.role === 'user' ? '  you> ' : '  assistant> ';
    console.log(getTheme().dim(prefix + truncated));
  }

  console.log(getTheme().dim('  ———'));
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
  const prefixColors = getTheme().prefixColors;
  const colorFn = prefixColors[(id - 1) % prefixColors.length];
  const displayTask = task.length > 80 ? task.slice(0, 80) + '…' : task;
  console.log(colorFn(`┌─ sub:${id} — ${displayTask}`));
}

export function printSubAgentEnd(id: number): void {
  const prefixColors = getTheme().prefixColors;
  const colorFn = prefixColors[(id - 1) % prefixColors.length];
  console.log(colorFn(`└─ sub:${id} done`));
}

export function printHelp(): void {
  const t = getTheme();
  console.log(t.accent('\nCommands:'));
  console.log(t.text('  /help') + t.muted('    — Show this help'));
  console.log(t.text('  /clear') + t.muted('   — Clear conversation history and scratch notes'));
  console.log(t.text('  /memory') + t.muted('  — List persistent memories'));
  console.log(t.text('  /scratch') + t.muted(' — List session scratch notes'));
  console.log(t.text('  /mcp') + t.muted('      — List MCP servers and tools'));
  console.log(t.text('  /cron') + t.muted('     — Show cron jobs and daemon status'));
  console.log(t.text('  /facts') + t.muted('    — Show RAG facts in current context window'));
  console.log(t.text('  /provider') + t.muted(' — Switch LLM provider'));
  console.log(t.text('  /model') + t.muted('    — Switch model for current provider'));
  console.log(t.text('  /theme') + t.muted('    — Switch color theme'));
  console.log(t.text('  /options') + t.muted('  — View and set options (max-tokens, shell-timeout)'));
  console.log(t.text('  /update') + t.muted('   — Check for and install updates'));
  console.log(t.text('  exit') + t.muted('      — Quit Bernard'));
  console.log();
}
