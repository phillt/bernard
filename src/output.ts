import type { CoreMessage } from 'ai';
import { getContextWindow, COMPRESSION_THRESHOLD } from './context.js';
import type { Step } from './plan-store.js';
import { debugLog } from './logger.js';
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

/** Cumulative token-usage statistics displayed alongside the thinking spinner. */
export interface SpinnerStats {
  startTime: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  latestPromptTokens: number;
  model: string;
  contextWindowOverride?: number;
}

export function formatTokenCount(n: number): string {
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
  const contextWindow = getContextWindow(stats.model, stats.contextWindowOverride);
  const thresholdTokens = contextWindow * COMPRESSION_THRESHOLD;
  const remainingPct = Math.max(
    0,
    Math.round(((thresholdTokens - stats.latestPromptTokens) / thresholdTokens) * 100),
  );

  return `Thinking (${elapsed} | ${up}↑ ${down}↓ | ${remainingPct}% until compression)`;
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

export function printWelcome(
  provider: string,
  model: string,
  version?: string,
  baseURL?: string,
  mcp?: WelcomeMcpSummary,
): void {
  const accent = getThemeColors().accent;

  console.log();
  for (const line of BERNARD_BANNER) {
    console.log('  ' + colorize(line, accent));
  }
  console.log();
  const ver = version ? `v${version}` : '';
  const line1 = [ver, 'local AI CLI agent'].filter(Boolean).join('  ·  ');
  const line2 = `${provider}  /  ${model}`;
  const line3 = '/help for commands  ·  exit to quit';
  console.log('  ' + colorize(line1, accent));
  console.log('  ' + DIM + line2 + RESET);
  if (baseURL) console.log('  ' + DIM + `endpoint  ${baseURL}` + RESET);
  if (mcp && (mcp.connected > 0 || mcp.failed > 0)) {
    const parts: string[] = [];
    if (mcp.connected > 0) {
      parts.push(`${mcp.connected} server${mcp.connected === 1 ? '' : 's'} · ${mcp.tools} tools`);
    }
    if (mcp.failed > 0) parts.push(`${mcp.failed} failed`);
    console.log('  ' + DIM + `mcp       ${parts.join('  ·  ')}` + RESET);
  }
  if (process.env.BERNARD_DEBUG === 'true' || process.env.BERNARD_DEBUG === '1') {
    console.log('  ' + DIM + 'debug logging enabled' + RESET);
  }
  console.log('  ' + DIM + line3 + RESET);
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

export function printPlan(_steps: Step[], _prefix?: string): void {}

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
    '  /provider — Switch LLM provider',
    '  /model   — Switch model for current provider',
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
