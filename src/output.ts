import type { CoreMessage } from 'ai';
import { getContextWindow, COMPRESSION_THRESHOLD } from './context.js';
import { debugLog, isDebugEnabled, getSessionLogPath } from './logger.js';
import { getThemeColors } from './theme.js';

let toolDetailsVisible = false;

/**
 * Enables or disables full display of tool-call arguments and result bodies.
 * Tool names and call lines are always shown regardless. Consumed by the Ink
 * tool-call renderers via {@link isToolDetailsVisible}; non-Ink callers can
 * still call this setter to persist the preference for the current session.
 */
export function setToolDetailsVisible(enabled: boolean): void {
  toolDetailsVisible = enabled;
}

export function isToolDetailsVisible(): boolean {
  return toolDetailsVisible;
}

/**
 * Token-usage statistics displayed alongside the thinking spinner / status bar.
 *
 * `turnPromptTokens` / `turnCompletionTokens` are **per-turn** odometers: reset
 * at the top of every `Agent.processInput` and accumulated across the full turn
 * — main-agent steps *and* the sub-agents / tool-wrappers / PAC phases spawned
 * during the turn (the work offloaded off the main context still cost tokens).
 * `latestPromptTokens` is the **main agent's** most-recent prompt size and is
 * what the context gauge measures — sub-agent steps never touch it, so the bar
 * tracks only the main agent's context fullness (#234).
 */
export interface SpinnerStats {
  startTime: number;
  turnPromptTokens: number;
  turnCompletionTokens: number;
  latestPromptTokens: number;
  /**
   * Per-turn Anthropic prompt-cache token counters (#269). `read` = input tokens
   * served from cache (billed at ~10%); `write` = tokens written to cache (billed
   * at ~125%). Both 0 when caching is off or the provider isn't Anthropic.
   */
  turnCacheReadTokens: number;
  turnCacheWriteTokens: number;
  model: string;
  contextWindowOverride?: number;
}

/** Token counts can arrive NaN/undefined when a turn errors early; treat those as 0. */
export function finiteOr0(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

export function formatTokenCount(n: number): string {
  // Token fields can be NaN/undefined when a turn errors before any usage is
  // reported — render those as 0 rather than letting "NaNk" reach the footer.
  if (!Number.isFinite(n)) return '0';
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
  // Coalesce non-finite token fields (a turn can error before usage is
  // reported) so NaN never leaks into the readout or the percentage.
  const promptTokens = finiteOr0(stats.turnPromptTokens);
  const completionTokens = finiteOr0(stats.turnCompletionTokens);
  const latestPromptTokens = finiteOr0(stats.latestPromptTokens);

  if (promptTokens === 0 && completionTokens === 0) {
    return `Thinking (${elapsed})`;
  }

  const up = formatTokenCount(promptTokens);
  const down = formatTokenCount(completionTokens);
  const contextWindow = getContextWindow(stats.model, stats.contextWindowOverride);
  const thresholdTokens = contextWindow * COMPRESSION_THRESHOLD;
  const remainingPct = Math.max(
    0,
    Math.round(((thresholdTokens - latestPromptTokens) / thresholdTokens) * 100),
  );

  // Surface prompt-cache reads when present (#269): tokens served from cache at
  // the ~90% discount. e.g. "12k⚡cached".
  const cacheRead = finiteOr0(stats.turnCacheReadTokens);
  const cacheSegment = cacheRead > 0 ? ` | ${formatTokenCount(cacheRead)}⚡cached` : '';

  return `Thinking (${elapsed} | ${up}↑ ${down}↓${cacheSegment} | ${remainingPct}% until compression)`;
}

// Spinner is a no-op in Phase D — Ink renders its own animated status line.
export function startSpinner(_message?: string | (() => string)): void {}
export function stopSpinner(): void {}

const BERNARD_BANNER = [
  '██████╗ ███████╗██████╗ ███╗   ██╗ █████╗ ██████╗ ██████╗ ',
  '██╔══██╗██╔════╝██╔══██╗████╗  ██║██╔══██╗██╔══██╗██╔══██╗',
  '██████╔╝█████╗  ██████╔╝██╔██╗ ██║███████║██████╔╝██║  ██║',
  '██╔══██╗██╔══╝  ██╔══██╗██║╚██╗██║██╔══██║██╔══██╗██║  ██║',
  '██████╔╝███████╗██║  ██║██║ ╚████║██║  ██║██║  ██║██████╔╝',
  '╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ',
];

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

/**
 * Wraps `text` in an ANSI color escape. Accepts a `#rrggbb` hex string
 * (rendered as a truecolor 24-bit escape, supported by every modern terminal)
 * or a named ANSI color from the small allowlist below. Unknown values fall
 * through uncolored so the splash still renders on terminals without color.
 */
function colorize(text: string, color: string): string {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
  }
  const named: Record<string, string> = {
    black: '30',
    red: '31',
    green: '32',
    yellow: '33',
    blue: '34',
    magenta: '35',
    cyan: '36',
    white: '37',
    gray: '90',
    whiteBright: '97',
    redBright: '91',
    greenBright: '92',
    yellowBright: '93',
    blueBright: '94',
    magentaBright: '95',
    cyanBright: '96',
  };
  const code = named[color];
  return code ? `\x1b[${code}m${text}${RESET}` : text;
}

export interface WelcomeMcpSummary {
  /** Total connected MCP servers. */
  connected: number;
  /** Number of failed-to-connect servers (rendered as a warning when > 0). */
  failed: number;
  /** Total tools surfaced across all connected servers. */
  tools: number;
}

const TAGLINE = 'Valet to your digital world.';
const BORDER_COLOR = '#555555';
const MIN_BOX_WIDTH = 64;
// Must match the `paddingX` on the root <Box> in src/ui/App.tsx so the
// splash printed pre-Ink lines up with the prompt / hint bar / status bar
// rendered inside the Ink tree.
const APP_PADDING_X = 2;

export function printWelcome(providers: string[], version?: string, mcp?: WelcomeMcpSummary): void {
  const accent = getThemeColors().accent;
  const bannerWidth = Math.max(...BERNARD_BANNER.map((l) => l.length));
  const termCols = process.stdout.columns ?? 80;
  const margin = ' '.repeat(APP_PADDING_X);
  const totalWidth = Math.max(MIN_BOX_WIDTH, termCols - 2 * APP_PADDING_X);
  const inner = totalWidth - 2;
  const pad = 2;

  const subtle = (s: string) => colorize(s, BORDER_COLOR);
  const dimText = (s: string) => DIM + s + RESET;
  const wall = subtle('│');
  const horizontal = subtle('─'.repeat(inner));
  const topBorder = subtle('╭') + horizontal + subtle('╮');
  const midBorder = subtle('├') + horizontal + subtle('┤');
  const bottomBorder = subtle('╰') + horizontal + subtle('╯');
  const emptyRow = wall + ' '.repeat(inner) + wall;

  const bannerRow = (line: string): string => {
    const padded = line.padEnd(bannerWidth, ' ');
    const left = Math.floor((inner - bannerWidth) / 2);
    const right = inner - bannerWidth - left;
    return wall + ' '.repeat(left) + colorize(padded, accent) + ' '.repeat(right) + wall;
  };

  const taglineRow = (): string => {
    const left = Math.floor((inner - TAGLINE.length) / 2);
    const right = inner - TAGLINE.length - left;
    return wall + ' '.repeat(left) + dimText(TAGLINE) + ' '.repeat(right) + wall;
  };

  const dataRow = (label: string, value: string): string => {
    const content = inner - 2 * pad;
    // Reserve room for at least 3 dots between the label and the value so a
    // long Providers / MCP string can't push past the right border.
    const maxValueLen = Math.max(1, content - label.length - 3);
    const trimmed =
      value.length > maxValueLen ? value.slice(0, Math.max(1, maxValueLen - 1)) + '…' : value;
    const dotCount = content - label.length - trimmed.length;
    const dots = subtle('.'.repeat(dotCount));
    return wall + ' '.repeat(pad) + label + dots + trimmed + ' '.repeat(pad) + wall;
  };

  const rows: string[] = [];
  rows.push(topBorder);
  rows.push(emptyRow);
  for (const line of BERNARD_BANNER) rows.push(bannerRow(line));
  rows.push(emptyRow);
  rows.push(taglineRow());
  rows.push(emptyRow);
  rows.push(midBorder);
  rows.push(emptyRow);
  if (version) rows.push(dataRow('Version', `v${version}`));
  const providerLabel = providers.length > 0 ? providers.join(', ') : '(none configured)';
  rows.push(dataRow('Providers', providerLabel));
  if (mcp && (mcp.connected > 0 || mcp.failed > 0)) {
    const parts: string[] = [];
    if (mcp.connected > 0) {
      const srv = `${mcp.connected} server${mcp.connected === 1 ? '' : 's'}`;
      const tls = `${mcp.tools} tool${mcp.tools === 1 ? '' : 's'}`;
      parts.push(`${srv} · ${tls}`);
    }
    if (mcp.failed > 0) parts.push(`${mcp.failed} failed`);
    rows.push(dataRow('MCP', parts.join(' · ')));
  }
  if (isDebugEnabled()) {
    rows.push(dataRow('Debug', 'enabled'));
    rows.push(dataRow('Session log', getSessionLogPath()));
  }
  rows.push(emptyRow);
  rows.push(bottomBorder);

  console.log();
  for (const row of rows) console.log(margin + row);
  console.log();
}

// Render path is now Ink (StreamingAssistantMessage + ToolCallEvent components
// wired via the output sink in src/framework/hooks/output.ts). Writing to stdout
// here would corrupt the Ink renderer while it's mounted. Kept as exports for
// API compatibility with non-REPL callers; in-REPL they're no-ops.
export function printAssistantText(_text: string, _prefix?: string): void {}

export function printToolCall(
  toolName: string,
  args: Record<string, unknown>,
  _prefix?: string,
): void {
  debugLog(`onStepFinish:toolCall:${toolName}`, args);
}

export function printToolResult(toolName: string, result: unknown, _prefix?: string): void {
  debugLog(`onStepFinish:toolResult:${toolName}`, result);
}

export function printError(message: string): void {
  console.error(`Error: ${message}`);
}

export function printInfo(message: string): void {
  console.log(message);
}

export function printDim(message: string): void {
  console.log(message);
}

export function printWarning(message: string): void {
  console.log(message);
}

// In-REPL no-ops — the legacy markers (▶ tool calls, ◉ thinking, ┌─ sub:1)
// would corrupt Ink's render. The equivalent information surfaces through the
// streaming sink (StreamEvent kinds: tool-call, tool-result, text-delta).
export function printToolFailure(
  _category: string,
  _snippet: string,
  _hint: string,
  _severity: 'low' | 'normal' | 'critical' = 'normal',
): void {}

export function printConversationReplay(_messages: CoreMessage[]): void {}

export function printThought(_thought: string, _prefix?: string): void {}

export function printEvaluation(_evaluation: string, _prefix?: string): void {}

export function printSubAgentStart(_id: number, _task: string): void {}

export function printSubAgentEnd(_id: number): void {}

export function printSpecialistStart(_id: number, _specialistName: string, _task: string): void {}

export function printSpecialistEnd(_id: number): void {}

export function printTaskStart(_task: string): void {}

export function printTaskEnd(_result: string): void {}

export function printHelp(): void {
  const lines = [
    '\nCommands:',
    '  /help    — Show this help',
    '  /clear   — Clear conversation (--save/-s to summarize first)',
    '  /compact — Compress conversation history in-place',
    '  /task    — Run an isolated task (no history, structured output)',
    '  /image   — Attach an image: /image <path> [prompt]',
    '  /memory  — List persistent memories',
    '  /scratch — List session scratch notes',
    '  /mcp     — List MCP servers and tools',
    '  /cron    — Show cron jobs and daemon status',
    '  /facts   — Show RAG facts in current context window',
    '  /lineup  — Edit the active lineup (per-role × premium/mid/cheap grid)',
    '  /lineups — List, switch, or create tier lineups',
    '  /models  — Browse the model catalog and add custom providers',
    '  /provider — Manage providers (alias of /models)',
    '  /theme   — Switch color theme',
    '  /routines — List saved routines',
    '  /create-routine — Create a routine with guided AI assistance',
    '  /create-task — Create a task routine with guided AI assistance',
    '  /specialists — List specialist agents',
    '  /create-specialist — Create a specialist with guided AI assistance',
    '  /candidates — Review specialist suggestions',
    '  /options — View and set options',
    '  /agent-options — Configure agent behavior',
    '  /update  — Check for and install updates',
    '  exit     — Quit Bernard',
    '',
  ];
  console.log(lines.join('\n'));
}
