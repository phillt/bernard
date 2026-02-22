import type { CoreMessage } from 'ai';
import { getContextWindow, COMPRESSION_THRESHOLD } from './context.js';
import { getTheme } from './theme.js';

const MAX_TOOL_OUTPUT_LENGTH = 2000;
const MAX_REPLAY_LENGTH = 200;

/** Cumulative token-usage statistics displayed alongside the thinking spinner. */
export interface SpinnerStats {
  /** Epoch timestamp (ms) when the current agent step began. */
  startTime: number;
  /** Running total of prompt tokens consumed across all steps. */
  totalPromptTokens: number;
  /** Running total of completion tokens generated across all steps. */
  totalCompletionTokens: number;
  /** Prompt tokens for the most recent LLM call (used for compression headroom). */
  latestPromptTokens: number;
  /** Model identifier, used to look up the context-window size. */
  model: string;
}

/**
 * Formats a token count into a compact human-readable string (e.g. `"3.2k"`).
 * @internal
 */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
}

/**
 * Formats a millisecond duration as `"Xs"` or `"XmYs"`.
 * @internal
 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
}

/**
 * Builds the dynamic status text shown next to the spinner animation.
 *
 * Displays elapsed time, cumulative token counts (up/down arrows),
 * and percentage of context window remaining before compression triggers.
 */
export function buildSpinnerMessage(stats: SpinnerStats): string {
  const elapsed = formatElapsed(Date.now() - stats.startTime);

  if (stats.totalPromptTokens === 0 && stats.totalCompletionTokens === 0) {
    return `Thinking (${elapsed})`;
  }

  const up = formatTokenCount(stats.totalPromptTokens);
  const down = formatTokenCount(stats.totalCompletionTokens);
  const contextWindow = getContextWindow(stats.model);
  const thresholdTokens = contextWindow * COMPRESSION_THRESHOLD;
  const remainingPct = Math.max(
    0,
    Math.round(((thresholdTokens - stats.latestPromptTokens) / thresholdTokens) * 100),
  );

  return `Thinking (${elapsed} | ${up}\u2191 ${down}\u2193 | ${remainingPct}% until compression)`;
}

/**
 * Wraps an optional sub-agent prefix (e.g. `"sub:2"`) in a colored bracket label.
 * Returns an empty string when no prefix is provided.
 * @internal
 */
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

/**
 * Starts a braille-dot spinner animation on stdout.
 *
 * Hides the cursor and redraws at 80 ms intervals. If a spinner is already
 * running the call is a no-op. Call {@link stopSpinner} to clear it.
 *
 * @param message - Static string or callback returning a dynamic status line.
 */
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

/** Stops the spinner, clears its line, and restores the cursor. */
export function stopSpinner(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
  process.stdout.write('\r\x1B[2K'); // clear line
  process.stdout.write('\x1B[?25h'); // show cursor
}

/** Prints the branded welcome banner with provider, model, and optional version info. */
export function printWelcome(provider: string, model: string, version?: string): void {
  const ver = version ? getTheme().muted(` v${version}`) : '';
  console.log(getTheme().accentBold('\n  Bernard') + ver + getTheme().muted(' — AI CLI Assistant'));
  console.log(getTheme().muted(`  Provider: ${provider} | Model: ${model}`));
  if (process.env.BERNARD_DEBUG === 'true' || process.env.BERNARD_DEBUG === '1') {
    console.log(getTheme().warning('  DEBUG mode enabled — logging to .logs/'));
  }
  console.log(getTheme().muted('  Type /help for commands, exit to quit\n'));
}

/** Prints an assistant response, stopping any active spinner first. */
export function printAssistantText(text: string, prefix?: string): void {
  stopSpinner();
  if (text.trim()) {
    const label = formatPrefix(prefix);
    console.log(label + getTheme().text(text));
  }
}

/**
 * Prints a one-line summary of a tool invocation.
 *
 * For the `shell` tool the raw command string is shown; for all others
 * the args object is JSON-serialized.
 */
export function printToolCall(
  toolName: string,
  args: Record<string, unknown>,
  prefix?: string,
): void {
  stopSpinner();
  const label = formatPrefix(prefix);
  const argsStr = toolName === 'shell' ? String(args.command || '') : JSON.stringify(args);
  console.log(label + getTheme().toolCall(`  ▶ ${toolName}`) + getTheme().muted(`: ${argsStr}`));
}

/**
 * Prints a tool's return value, truncated to {@link MAX_TOOL_OUTPUT_LENGTH} characters.
 *
 * Handles string results, `{ output: string }` shapes, and arbitrary objects.
 */
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

  const lines = output
    .split('\n')
    .map((line) => label + getTheme().muted(`  ${line}`))
    .join('\n');
  console.log(lines);
}

/** Prints an error message to stderr in the theme's error color. */
export function printError(message: string): void {
  stopSpinner();
  console.error(getTheme().error(`Error: ${message}`));
}

/** Prints an informational message in the theme's muted color. */
export function printInfo(message: string): void {
  console.log(getTheme().muted(message));
}

/**
 * Prints a dimmed summary of a prior conversation for session-resume context.
 *
 * Each message is truncated to {@link MAX_REPLAY_LENGTH} characters.
 * Tool-role messages are skipped.
 */
export function printConversationReplay(messages: CoreMessage[]): void {
  console.log(getTheme().dim('  Previous conversation:'));

  for (const msg of messages) {
    if (msg.role === 'tool') continue;

    const text = extractText(msg);
    if (!text) continue;

    const truncated =
      text.length > MAX_REPLAY_LENGTH ? text.slice(0, MAX_REPLAY_LENGTH) + '…' : text;

    const prefix = msg.role === 'user' ? '  you> ' : '  assistant> ';
    console.log(getTheme().dim(prefix + truncated));
  }

  console.log(getTheme().dim('  ———'));
  console.log();
}

/**
 * Extracts the plain-text content from a {@link CoreMessage}.
 * Returns `null` if the message has no text parts.
 * @internal
 */
function extractText(msg: CoreMessage): string | null {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return null;

  const textParts = msg.content
    .filter(
      (p): p is { type: 'text'; text: string } =>
        typeof p === 'object' && p !== null && 'type' in p && p.type === 'text',
    )
    .map((p) => p.text);

  return textParts.length > 0 ? textParts.join(' ') : null;
}

/** Prints a colored top-border line when a sub-agent begins executing a task. */
export function printSubAgentStart(id: number, task: string): void {
  const prefixColors = getTheme().prefixColors;
  const colorFn = prefixColors[(id - 1) % prefixColors.length];
  const displayTask = task.length > 80 ? task.slice(0, 80) + '…' : task;
  console.log(colorFn(`┌─ sub:${id} — ${displayTask}`));
}

/** Prints a colored bottom-border line when a sub-agent finishes. */
export function printSubAgentEnd(id: number): void {
  const prefixColors = getTheme().prefixColors;
  const colorFn = prefixColors[(id - 1) % prefixColors.length];
  console.log(colorFn(`└─ sub:${id} done`));
}

/** Prints the REPL help menu listing all available slash commands. */
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
  console.log(
    t.text('  /options') + t.muted('  — View and set options (max-tokens, shell-timeout)'),
  );
  console.log(t.text('  /update') + t.muted('   — Check for and install updates'));
  console.log(t.text('  exit') + t.muted('      — Quit Bernard'));
  console.log();
}
