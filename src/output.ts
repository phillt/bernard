import type { CoreMessage } from 'ai';
import { getContextWindow, COMPRESSION_THRESHOLD } from './context.js';
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

const silentTools = new Set<string>(['plan', 'think', 'evaluate']);

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

function formatPrefix(prefix?: string): string {
  if (!prefix) return '';
  return `[${prefix}] `;
}

// Spinner is a no-op in Phase D — Ink renders its own animated status line.
export function startSpinner(_message?: string | (() => string)): void {}
export function stopSpinner(): void {}

export function printWelcome(
  provider: string,
  model: string,
  version?: string,
  baseURL?: string,
): void {
  const ver = version ? ` v${version}` : '';
  console.log(`\n  Bernard${ver} — AI CLI Assistant`);
  console.log(`  Provider: ${provider} | Model: ${model}`);
  if (baseURL) {
    console.log(`  Endpoint: ${baseURL}`);
  }
  if (process.env.BERNARD_DEBUG === 'true' || process.env.BERNARD_DEBUG === '1') {
    console.log('  DEBUG mode enabled — logging to .logs/');
  }
  console.log('  Type /help for commands, exit to quit\n');
}

export function printAssistantText(text: string, prefix?: string): void {
  if (text.trim()) {
    console.log(formatPrefix(prefix) + text);
  }
}

export function printToolCall(
  toolName: string,
  args: Record<string, unknown>,
  prefix?: string,
): void {
  debugLog(`onStepFinish:toolCall:${toolName}`, args);
  if (silentTools.has(toolName)) return;
  const label = formatPrefix(prefix);
  if (!toolDetailsVisible) {
    console.log(`${label}  ▶ ${toolName}`);
    return;
  }
  const argsStr = toolName === 'shell' ? String(args.command || '') : JSON.stringify(args);
  console.log(`${label}  ▶ ${toolName}: ${argsStr}`);
}

export function printToolResult(toolName: string, result: unknown, prefix?: string): void {
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
    output = output.slice(0, MAX_TOOL_OUTPUT_LENGTH) + '\n  ... (truncated)';
  }

  const lines = output
    .split('\n')
    .map((line) => `${label}  ${line}`)
    .join('\n');
  console.log(lines);
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

export function printToolFailure(
  category: string,
  snippet: string,
  hint: string,
  _severity: 'low' | 'normal' | 'critical' = 'normal',
): void {
  const firstLine = snippet.split('\n')[0]?.slice(0, 200) ?? '';
  console.log(`  ${category}: ${firstLine}`);
  console.log(`  → ${hint}`);
}

export function printConversationReplay(messages: CoreMessage[]): void {
  console.log('  Previous conversation:');

  for (const msg of messages) {
    if (msg.role === 'tool') continue;

    const text = extractText(msg);
    if (!text) continue;

    const truncated =
      text.length > MAX_REPLAY_LENGTH ? text.slice(0, MAX_REPLAY_LENGTH) + '…' : text;

    const prefix = msg.role === 'user' ? '  you> ' : '  assistant> ';
    console.log(prefix + truncated);
  }

  console.log('  ———');
  console.log();
}

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
      return '✓';
    case 'in_progress':
      return '◐';
    case 'cancelled':
      return '⊘';
    case 'error':
      return '✗';
    case 'pending':
      return '○';
  }
}

export function printPlan(steps: Step[], prefix?: string): void {
  if (steps.length === 0) return;
  const label = formatPrefix(prefix);
  console.log(`${label}  ◆ Plan:`);
  for (const s of steps) {
    const icon = iconForStatus(s.status);
    const note = s.note ? ` — ${s.note}` : '';
    console.log(`${label}    ${icon} ${s.id}. ${s.description}${note}`);
  }
}

export function printThought(thought: string, prefix?: string): void {
  const label = formatPrefix(prefix);
  console.log(`${label}◉ thinking`);
  for (const line of thought.split('\n')) {
    console.log(label + line);
  }
  console.log(label);
}

export function printEvaluation(evaluation: string, prefix?: string): void {
  const label = formatPrefix(prefix);
  console.log(`${label}⌖ evaluating`);
  for (const line of evaluation.split('\n')) {
    console.log(label + line);
  }
  console.log(label);
}

export function printSubAgentStart(id: number, task: string): void {
  const displayTask = task.length > 80 ? task.slice(0, 80) + '…' : task;
  console.log(`┌─ sub:${id} — ${displayTask}`);
}

export function printSubAgentEnd(id: number): void {
  console.log(`└─ sub:${id} done`);
}

export function printSpecialistStart(id: number, specialistName: string, task: string): void {
  const displayTask = task.length > 80 ? task.slice(0, 80) + '…' : task;
  console.log(`┌─ spec:${id} [${specialistName}] — ${displayTask}`);
}

export function printSpecialistEnd(id: number): void {
  console.log(`└─ spec:${id} done`);
}

export function printTaskStart(task: string): void {
  const displayTask = task.length > 80 ? task.slice(0, 80) + '…' : task;
  console.log(`┌─ task — ${displayTask}`);
}

export function printTaskEnd(result: string): void {
  try {
    const parsed = JSON.parse(result);
    const MAX_TASK_OUTPUT_LENGTH = 80;
    const output = parsed.output
      ? `: ${parsed.output.length > MAX_TASK_OUTPUT_LENGTH ? parsed.output.slice(0, MAX_TASK_OUTPUT_LENGTH) + '…' : parsed.output}`
      : '';
    console.log(`└─ task ${parsed.status}${output}`);
  } catch {
    console.log('└─ task done');
  }
}

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
