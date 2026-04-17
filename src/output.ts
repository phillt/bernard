import type { CoreMessage } from 'ai';
import { getContextWindow, COMPRESSION_THRESHOLD } from './context.js';
import { getTheme } from './theme.js';
import type { Step, StepStatus } from './plan-store.js';
import { debugLog } from './logger.js';

const MAX_TOOL_OUTPUT_LENGTH = 2000;
const MAX_REPLAY_LENGTH = 200;

let toolDetailsVisible = false;

/**
 * Enables or disables printing of tool-call arguments and tool result bodies.
 * Tool names and call lines (▶ toolName) are always shown regardless.
 */
export function setToolDetailsVisible(enabled: boolean): void {
  toolDetailsVisible = enabled;
}

// Tools rendered through dedicated channels (printPlan, printThought,
// printEvaluation) — their generic call/result lines would be duplicate noise.
const silentTools = new Set<string>(['plan', 'think', 'evaluate']);

// Pinned regions: a generic persistent-footer mechanism. Each region is a
// block of lines keyed by id that stays anchored just above the prompt.
// Only active when stdout is a TTY; in pipe/test mode the regions are stored
// but never rendered, so chat output stays clean.

const pinnedRegions = new Map<string, string[]>();
let pinnedLineCount = 0;

function pinSupported(): boolean {
  return !!process.stdout.isTTY;
}

function erasePinnedRegions(): void {
  if (!pinSupported() || pinnedLineCount === 0) return;
  process.stdout.write(`\x1b[${pinnedLineCount}A`);
  process.stdout.write(`\r\x1b[J`);
  pinnedLineCount = 0;
}

function renderPinnedRegions(): void {
  if (!pinSupported() || pinnedRegions.size === 0) return;
  let count = 0;
  for (const lines of pinnedRegions.values()) {
    for (const line of lines) {
      process.stdout.write(line + '\n');
      count++;
    }
  }
  pinnedLineCount = count;
}

function sameLines(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Pins or updates a named region of lines above the prompt.
 * Passing an empty array removes the region. No-op when the new content
 * matches what is already pinned under that id.
 */
export function setPinnedRegion(id: string, lines: string[]): void {
  if (lines.length === 0) {
    if (!pinnedRegions.has(id)) return;
    erasePinnedRegions();
    pinnedRegions.delete(id);
    renderPinnedRegions();
    return;
  }
  if (sameLines(pinnedRegions.get(id), lines)) return;
  erasePinnedRegions();
  pinnedRegions.set(id, lines);
  renderPinnedRegions();
}

/** Removes a named pinned region. */
export function clearPinnedRegion(id: string): void {
  setPinnedRegion(id, []);
}

function emit(message: string): void {
  erasePinnedRegions();
  console.log(message);
  renderPinnedRegions();
}

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
  /** Optional context window override (0 or undefined = auto-detect). */
  contextWindowOverride?: number;
}

/**
 * Formats a token count into a compact human-readable string (e.g. `"3.2k"`).
 */
export function formatTokenCount(n: number): string {
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
  const contextWindow = getContextWindow(stats.model, stats.contextWindowOverride);
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
  const match = prefix.match(/^(?:sub|task|spec):(\d+)$/);
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
    emit(label + getTheme().text(text));
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
  // Debug log fires regardless of visibility so `.logs/<date>.log` keeps
  // full tool args even when tool-details are hidden (see issue #116).
  debugLog(`onStepFinish:toolCall:${toolName}`, args);
  if (silentTools.has(toolName)) return;
  const label = formatPrefix(prefix);
  if (!toolDetailsVisible) {
    emit(label + getTheme().toolCall(`  ▶ ${toolName}`));
    return;
  }
  const argsStr = toolName === 'shell' ? String(args.command || '') : JSON.stringify(args);
  emit(label + getTheme().toolCall(`  ▶ ${toolName}`) + getTheme().muted(`: ${argsStr}`));
}

/**
 * Prints a tool's return value, truncated to {@link MAX_TOOL_OUTPUT_LENGTH} characters.
 *
 * Handles string results, `{ output: string }` shapes, and arbitrary objects.
 */
export function printToolResult(toolName: string, result: unknown, prefix?: string): void {
  stopSpinner();
  debugLog(`onStepFinish:toolResult:${toolName}`, result);
  if (silentTools.has(toolName)) return;
  if (!toolDetailsVisible) return;
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
  emit(lines);
}

/** Prints an error message to stderr in the theme's error color. */
export function printError(message: string): void {
  stopSpinner();
  console.error(getTheme().error(`Error: ${message}`));
}

/** Prints an informational message in the theme's muted color. */
export function printInfo(message: string): void {
  emit(getTheme().muted(message));
}

/** Prints a warning message in the theme's warning color. */
export function printWarning(message: string): void {
  stopSpinner();
  emit(getTheme().warning(message));
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
 * Extracts the plain-text content from a {@link CoreMessage} for display formatting.
 *
 * Unlike {@link extractText} in `context.ts` (which is used for serialization and compression),
 * this variant is scoped to output rendering only.
 *
 * @returns The joined text content, or `null` if the message has no text parts.
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

function iconForStatus(status: StepStatus): string {
  switch (status) {
    case 'done':
      return '\u2713';
    case 'in_progress':
      return '\u25D0';
    case 'cancelled':
      return '\u2298';
    case 'error':
      return '\u2717';
    case 'pending':
      return '\u25CB';
  }
}

/**
 * Pins the current plan as a bulleted, status-decorated list above the prompt.
 *
 * Uses the generic pinned-region mechanism keyed by `'plan'`, so the block
 * stays anchored while other chat-flow output scrolls above it.
 * Passing no steps removes the pinned plan.
 */
export function printPlan(steps: Step[], prefix?: string): void {
  stopSpinner();
  if (steps.length === 0) {
    clearPinnedRegion('plan');
    return;
  }
  const t = getTheme();
  const label = formatPrefix(prefix);
  const lines: string[] = [label + t.accent('  \u25C6 Plan:')];
  for (const s of steps) {
    const icon = iconForStatus(s.status);
    const note = s.note ? t.muted(` \u2014 ${s.note}`) : '';
    lines.push(label + t.muted(`    ${icon} ${s.id}. ${s.description}`) + note);
  }
  setPinnedRegion('plan', lines);
}

/** Prints a visible thought line. */
export function printThought(thought: string, prefix?: string): void {
  stopSpinner();
  const t = getTheme();
  const label = formatPrefix(prefix);
  emit(label + t.accent(`  ${thought}`));
}

/** Prints a visible post-action self-evaluation prefixed with a magnifying glass. */
export function printEvaluation(evaluation: string, prefix?: string): void {
  stopSpinner();
  const t = getTheme();
  const label = formatPrefix(prefix);
  emit(label + t.warning(`  \uD83D\uDD0D ${evaluation}`));
}

/** Prints a colored top-border line when a sub-agent begins executing a task. */
export function printSubAgentStart(id: number, task: string): void {
  const prefixColors = getTheme().prefixColors;
  const colorFn = prefixColors[(id - 1) % prefixColors.length];
  const displayTask = task.length > 80 ? task.slice(0, 80) + '…' : task;
  emit(colorFn(`┌─ sub:${id} — ${displayTask}`));
}

/** Prints a colored bottom-border line when a sub-agent finishes. */
export function printSubAgentEnd(id: number): void {
  const prefixColors = getTheme().prefixColors;
  const colorFn = prefixColors[(id - 1) % prefixColors.length];
  emit(colorFn(`└─ sub:${id} done`));
}

/** Prints a colored top-border line when a specialist begins executing a task. */
export function printSpecialistStart(id: number, specialistName: string, task: string): void {
  const prefixColors = getTheme().prefixColors;
  const colorFn = prefixColors[(id - 1) % prefixColors.length];
  const displayTask = task.length > 80 ? task.slice(0, 80) + '…' : task;
  emit(colorFn(`┌─ spec:${id} [${specialistName}] — ${displayTask}`));
}

/** Prints a colored bottom-border line when a specialist finishes. */
export function printSpecialistEnd(id: number): void {
  const prefixColors = getTheme().prefixColors;
  const colorFn = prefixColors[(id - 1) % prefixColors.length];
  emit(colorFn(`└─ spec:${id} done`));
}

/** Prints a colored top-border line when a task begins executing. */
export function printTaskStart(task: string): void {
  const t = getTheme();
  const displayTask = task.length > 80 ? task.slice(0, 80) + '…' : task;
  emit(t.accent(`┌─ task — ${displayTask}`));
}

/** Prints a colored bottom-border line when a task finishes, showing structured result. */
export function printTaskEnd(result: string): void {
  const t = getTheme();
  try {
    const parsed = JSON.parse(result);
    const statusColor = parsed.status === 'success' ? t.accent : t.error;
    const MAX_TASK_OUTPUT_LENGTH = 80;
    const output = parsed.output
      ? `: ${parsed.output.length > MAX_TASK_OUTPUT_LENGTH ? parsed.output.slice(0, MAX_TASK_OUTPUT_LENGTH) + '…' : parsed.output}`
      : '';
    emit(statusColor(`└─ task ${parsed.status}${output}`));
  } catch {
    emit(t.accent(`└─ task done`));
  }
}

/** Prints a colored top-border line when the critic starts verifying. */
export function printCriticStart(prefix?: string): void {
  stopSpinner();
  const t = getTheme();
  const label = formatPrefix(prefix);
  emit(label + t.accent('┌─ critic — verifying response...'));
}

/** Prints a retry indicator when the critic triggers a correction loop. */
export function printCriticRetry(attempt: number, maxRetries: number, prefix?: string): void {
  stopSpinner();
  const t = getTheme();
  const label = formatPrefix(prefix);
  emit(label + t.warning(`├─ critic — retrying (${attempt}/${maxRetries})...`));
}

/** Parses a critic response into a structured verdict and explanation. */
export function parseCriticVerdict(text: string): { verdict: string; explanation: string } {
  const verdictMatch = text.match(/\bVERDICT:\s*(PASS|WARN|FAIL)\b/i);
  let verdict = 'UNKNOWN';
  let explanation = text.trim();

  if (verdictMatch) {
    verdict = verdictMatch[1].toUpperCase();
    explanation = text.replace(/^.*\bVERDICT:\s*(PASS|WARN|FAIL)\b[^\n]*/im, '').trim();
  }

  return { verdict, explanation };
}

/** Prints the critic's verdict with color based on PASS/WARN/FAIL. */
export function printCriticVerdict(text: string, prefix?: string): void {
  stopSpinner();
  const t = getTheme();
  const label = formatPrefix(prefix);
  const { verdict, explanation } = parseCriticVerdict(text);
  const colorFn = verdict === 'PASS' ? t.accent : verdict === 'WARN' ? t.warning : t.error;

  if (verdict === 'PASS' || verdict === 'WARN') {
    // Compact badge; include explanation only if single-line
    const isSingleLine = !!explanation && !explanation.includes('\n');
    const suffix = isSingleLine ? `: ${explanation}` : '';
    emit(label + colorFn(`└─ critic ${verdict}${suffix}`));
  } else {
    // FAIL/UNKNOWN: always show full explanation
    const suffix = explanation ? `: ${explanation}` : '';
    emit(label + colorFn(`└─ critic ${verdict}${suffix}`));
  }
}

/** Prints a re-verify indicator when the critic re-checks after a retry. */
export function printCriticReVerify(prefix?: string): void {
  stopSpinner();
  const t = getTheme();
  const label = formatPrefix(prefix);
  emit(label + t.accent('├─ critic — re-verifying response...'));
}

/** Prints the REPL help menu listing all available slash commands. */
export function printHelp(): void {
  const t = getTheme();
  const lines = [
    t.accent('\nCommands:'),
    t.text('  /help') + t.muted('    — Show this help'),
    t.text('  /clear') + t.muted('   — Clear conversation (--save/-s to summarize first)'),
    t.text('  /compact') + t.muted(' — Compress conversation history in-place'),
    t.text('  /task') + t.muted('    — Run an isolated task (no history, structured output)'),
    t.text('  /image') + t.muted('   — Attach an image: /image <path> [prompt]'),
    t.text('  /memory') + t.muted('  — List persistent memories'),
    t.text('  /scratch') + t.muted(' — List session scratch notes'),
    t.text('  /mcp') + t.muted('      — List MCP servers and tools'),
    t.text('  /cron') + t.muted('     — Show cron jobs and daemon status'),
    t.text('  /facts') + t.muted('    — Show RAG facts in current context window'),
    t.text('  /provider') + t.muted(' — Switch LLM provider'),
    t.text('  /model') + t.muted('    — Switch model for current provider'),
    t.text('  /theme') + t.muted('    — Switch color theme'),
    t.text('  /routines') + t.muted(' — List saved routines'),
    t.text('  /create-routine') + t.muted(' — Create a routine with guided AI assistance'),
    t.text('  /create-task') + t.muted(' — Create a task routine with guided AI assistance'),
    t.text('  /specialists') + t.muted(' — List specialist agents'),
    t.text('  /create-specialist') + t.muted(' — Create a specialist with guided AI assistance'),
    t.text('  /candidates') + t.muted(' — Review specialist suggestions'),
    t.text('  /critic') + t.muted('   — Toggle critic mode'),
    t.text('  /tool-details') + t.muted(' — Toggle visibility of tool call args and result output'),
    t.text('  /options') +
      t.muted('  — View and set options (max-tokens, max-steps, shell-timeout, token-window)'),
    t.text('  /agent-options') + t.muted(' — Configure specialist auto-creation settings'),
    t.text('  /update') + t.muted('   — Check for and install updates'),
    t.text('  /debug') + t.muted('    — Print diagnostic report for troubleshooting'),
    t.text('  exit') + t.muted('      — Quit Bernard'),
    '',
  ];
  emit(lines.join('\n'));
}
