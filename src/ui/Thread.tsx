import { useSyncExternalStore, type ReactNode } from 'react';
import { Box, Text, useStdout } from 'ink';
import type {
  CoreMessage,
  CoreUserMessage,
  CoreAssistantMessage,
  CoreToolMessage,
  TextPart,
  ImagePart,
  ToolCallPart,
  ToolResultPart,
} from 'ai';

type ReasoningPart = { type: 'reasoning'; text: string };
type RedactedReasoningPart = { type: 'redacted-reasoning'; data: string };
import { getThemeColors } from '../theme.js';
import { truncate } from '../text.js';
import { renderMarkdown } from './markdown.js';
import type { MessageStore, StreamEvent } from './message-store.js';

interface ThreadProps {
  history: CoreMessage[];
  /**
   * Phase C (#214): when `busy === true`, `<Thread>` mounts a
   * `<StreamingAssistantMessage>` below the static history that subscribes
   * to `messageStore` and renders per-token deltas + inline tool-call /
   * tool-result blocks as they arrive. Omitted (or `busy === false`) means
   * the static-history `<Thread>` path runs identically to Phase B.
   */
  messageStore?: MessageStore;
  busy?: boolean;
  /** Rendered as a dim notice below the transcript when the last turn was Esc-cancelled. */
  interrupted?: boolean;
  /**
   * Per-history-index map of the user's original text when the rewriter
   * replaced it before dispatch. `UserMessage` reads this to show the original
   * (not the rewritten) text and tag it with the rewrite icon next to the
   * timestamp. Same icon is used in `/agent-options` so the meaning is shared.
   */
  rewriteOriginals?: ReadonlyMap<number, string>;
  /**
   * Per-history-index timestamp + duration of completed turns. Rendered as a
   * dim footer (`hh:mm · 1.2s`) under every assistant message that has an
   * entry — mirrors the timestamp `<UserMessage>` shows under the outbound
   * message. Owned by `<App>` so the footer persists across follow-up turns.
   */
  turnTimings?: ReadonlyMap<number, { endedAt: number; durationMs: number }>;
  /**
   * Whether to show full tool-call arguments and result bodies in the
   * transcript. Tool names are always shown; only the args summary next to
   * the name and the `↳ …` result row are suppressed when this is false.
   * Mirrors the `Tool details` setting in `/agent-options`.
   */
  toolDetails?: boolean;
}

/** Icon used wherever the prompt-rewriter feature surfaces in the UI. */
export const REWRITE_ICON = '✎';

/**
 * Renders the conversation as a flowing list of message blocks. Reads the
 * AI SDK's `CoreMessage[]` shape directly — same array `Agent.getHistory()`
 * returns. Re-renders when `<App>` bumps `historyVersion` after a turn ends.
 *
 * Streaming-output migration (Phase C) will keep this component but feed it
 * from an in-memory message store so the in-flight assistant message updates
 * token-by-token. Phase B renders the message in bulk at turn end.
 */
export function Thread({
  history,
  messageStore,
  busy,
  interrupted,
  rewriteOriginals,
  turnTimings,
  toolDetails = false,
}: ThreadProps) {
  const colors = getThemeColors();
  return (
    <Box flexDirection="column">
      {history.map((msg, idx) => (
        <MessageBlock
          key={idx}
          message={msg}
          rewriteOriginal={rewriteOriginals?.get(idx)}
          timing={turnTimings?.get(idx)}
          toolDetails={toolDetails}
        />
      ))}
      {busy && messageStore && (
        <StreamingAssistantMessage store={messageStore} toolDetails={toolDetails} />
      )}
      {!busy && interrupted && (
        <Box marginTop={1}>
          <Text color={colors.muted} italic>
            ⏹ you interrupted
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * In-flight turn view. Subscribes via `useSyncExternalStore` and renders
 * the accumulated text-deltas plus any tool-call / tool-result blocks that
 * have arrived so far. Unmounts when the turn ends (`busy` flips false) —
 * by then the AI SDK history has the finished message and the static
 * `<AssistantMessage>` takes over rendering it.
 */
export function StreamingAssistantMessage({
  store,
  toolDetails = false,
}: {
  store: MessageStore;
  toolDetails?: boolean;
}) {
  const colors = getThemeColors();
  const events = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (events.length === 0) return null;
  const groups = groupByLabel(events);
  return (
    <Box flexDirection="column" marginTop={1}>
      {groups.map((group, idx) => {
        // Sub-agent groups (label set) keep the labeled header above the
        // body. Main-agent groups (no label) inline the chevron with the
        // first line of body content, mirroring the static AssistantMessage.
        if (group.label !== undefined) {
          // Sub-agent / wrapper output never appears in the static post-turn
          // <Thread> (only main-agent assistant messages do). Mirror that
          // when tool details are off so streaming doesn't briefly leak
          // wrapper JSON / sub-agent text that vanishes once the turn ends.
          if (!toolDetails) return null;
          return (
            <Box key={idx} flexDirection="column">
              <Text color={colors.accent} bold>
                {group.label}
              </Text>
              <StreamGroupBody events={group.events} toolDetails={toolDetails} />
            </Box>
          );
        }
        return (
          <StreamGroupBody
            key={idx}
            events={group.events}
            toolDetails={toolDetails}
            inlineChevron
          />
        );
      })}
    </Box>
  );
}

interface EventGroup {
  label: string | undefined;
  events: StreamEvent[];
}

/**
 * Bucket events by `agentLabel` while preserving order. Sub-agent output
 * lands under e.g. a `sub:2` header; main-agent output (no label) lands
 * under `bernard`. New groups open whenever the label changes, so two
 * interleaved sub-agent dispatches render as two distinct labeled blocks
 * even if they share a label key.
 */
function groupByLabel(events: readonly StreamEvent[]): EventGroup[] {
  const out: EventGroup[] = [];
  for (const ev of events) {
    const label = ev.agentLabel;
    const tail = out[out.length - 1];
    if (tail && tail.label === label) {
      tail.events.push(ev);
    } else {
      out.push({ label, events: [ev] });
    }
  }
  return out;
}

/**
 * Assistant prose rendered as themed ANSI markdown. The rendered string is
 * split on newlines into one `<Text>` per line — a single multi-line ANSI
 * `<Text>` confuses Ink's width measurement (ink#907). `streaming` runs the
 * buffer through `healStreamMarkdown` first so incomplete mid-stream syntax
 * (`**partial`, open fences) doesn't flash raw delimiters.
 */
function MarkdownLines({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const { stdout } = useStdout();
  const colors = getThemeColors();
  // App's outer <Box> has paddingX={2}; keep the table/rule width inside it.
  const width = Math.max(40, (stdout?.columns ?? 80) - 4);
  const rendered = renderMarkdown(text, width, colors, streaming);
  return (
    <Box flexDirection="column">
      {rendered.split('\n').map((line, i) => (
        // Empty-string <Text> collapses to zero height; keep blank lines.
        <Text key={i}>{line.length === 0 ? ' ' : line}</Text>
      ))}
    </Box>
  );
}

function StreamGroupBody({
  events,
  toolDetails,
  inlineChevron = false,
}: {
  events: StreamEvent[];
  toolDetails: boolean;
  /** When true, prepend `<❮ >` inline with the first emitted element. */
  inlineChevron?: boolean;
}) {
  const colors = getThemeColors();
  const chevron = (
    <Text color={colors.accent} bold>
      {'❮  '}
    </Text>
  );
  let chevronPending = inlineChevron;
  // Concatenate text-deltas into a single rolling string so we don't render
  // one <Text> per token (which Ink would lay out as separate lines).
  const elements: ReactNode[] = [];
  let textBuffer = '';
  let textKey = 0;
  const flushText = () => {
    if (textBuffer.length === 0) return;
    if (chevronPending) {
      elements.push(
        <Box key={`t-${textKey++}`}>
          {chevron}
          <MarkdownLines text={textBuffer} streaming />
        </Box>,
      );
      chevronPending = false;
    } else {
      elements.push(<MarkdownLines key={`t-${textKey++}`} text={textBuffer} streaming />);
    }
    textBuffer = '';
  };
  // Pair tool-calls with their results by callId so the result renders
  // directly under its call instead of as a separate orphan block. The
  // callsById set lets the orphan check below run in O(1) rather than
  // re-scanning the event list per result — important once the list grows
  // (tool-heavy turns can produce dozens of call/result pairs).
  const resultsByCall = new Map<string, Extract<StreamEvent, { kind: 'tool-result' }>>();
  const callsById = new Set<string>();
  for (const ev of events) {
    if (ev.kind === 'tool-result') resultsByCall.set(ev.callId, ev);
    else if (ev.kind === 'tool-call') callsById.add(ev.callId);
  }
  for (const ev of events) {
    if (ev.kind === 'text-delta') {
      textBuffer += ev.text;
      continue;
    }
    if (ev.kind === 'tool-call') {
      flushText();
      if (ev.toolName === 'think') {
        const thought = extractThought(ev.args);
        if (thought) {
          elements.push(
            <Box key={`c-${ev.callId}`}>
              {chevronPending && chevron}
              <Text dimColor italic>
                💭 {thought}
              </Text>
            </Box>,
          );
          chevronPending = false;
        }
        continue;
      }
      if (ev.toolName === 'plan' && toolDetails) {
        const planLines = formatPlanLines(ev.args);
        if (planLines.length > 0) {
          elements.push(
            <Box key={`c-${ev.callId}`} flexDirection="column">
              <Box>
                {chevronPending && chevron}
                <Text color={colors.toolCall}>⚙ plan</Text>
              </Box>
              <PlanEchoLines lines={planLines} />
              {resultsByCall.has(ev.callId) && (
                <StreamingToolResult result={resultsByCall.get(ev.callId)!} />
              )}
            </Box>,
          );
          chevronPending = false;
          continue;
        }
      }
      const argsSummary = toolDetails ? summariseArgs(ev.args) : '';
      const headPrefix = chevronPending ? chevron : null;
      elements.push(
        <Box key={`c-${ev.callId}`} flexDirection="column">
          <Box>
            {headPrefix}
            <Text color={colors.toolCall}>⚙ {ev.toolName}</Text>
            {argsSummary && <Text dimColor> {argsSummary}</Text>}
          </Box>
          {toolDetails && resultsByCall.has(ev.callId) && (
            <StreamingToolResult result={resultsByCall.get(ev.callId)!} />
          )}
        </Box>,
      );
      chevronPending = false;
      continue;
    }
    // tool-result handled inline above; skip if it has a matching call.
    // If a result arrived without its call (shouldn't happen, but defensive),
    // render it as a standalone row so the user still sees it.
    if (toolDetails && !callsById.has(ev.callId)) {
      flushText();
      elements.push(
        <Box key={`r-${ev.callId}`} marginLeft={2}>
          <Text color={ev.isError ? colors.error : undefined} dimColor={!ev.isError}>
            ↳ {renderResultSnippet(ev.result)}
          </Text>
        </Box>,
      );
    }
  }
  flushText();
  // Group produced no renderable content (e.g. only suppressed think events)
  // but a chevron was promised — emit it on its own line so the assistant
  // turn still shows up.
  if (chevronPending) {
    elements.push(<Box key="chev-only">{chevron}</Box>);
  }
  return <>{elements}</>;
}

function StreamingToolResult({
  result,
}: {
  result: Extract<StreamEvent, { kind: 'tool-result' }>;
}) {
  const colors = getThemeColors();
  return (
    <Box marginLeft={2}>
      <Text color={result.isError ? colors.error : undefined} dimColor={!result.isError}>
        ↳ {renderResultSnippet(result.result)}
      </Text>
    </Box>
  );
}

function MessageBlock({
  message,
  rewriteOriginal,
  timing,
  toolDetails,
}: {
  message: CoreMessage;
  rewriteOriginal?: string;
  timing?: { endedAt: number; durationMs: number };
  toolDetails: boolean;
}) {
  if (message.role === 'user')
    return <UserMessage message={message as CoreUserMessage} rewriteOriginal={rewriteOriginal} />;
  if (message.role === 'assistant')
    return (
      <AssistantMessage
        message={message as CoreAssistantMessage}
        timing={timing}
        toolDetails={toolDetails}
      />
    );
  if (message.role === 'tool')
    return toolDetails ? <ToolResultMessage message={message as CoreToolMessage} /> : null;
  // System messages are agent-internal; don't render in the thread.
  return null;
}

function UserMessage({
  message,
  rewriteOriginal,
}: {
  message: CoreUserMessage;
  rewriteOriginal?: string;
}) {
  const colors = getThemeColors();
  const raw = extractUserText(message);
  const { body, timestamp } = parseUserMessage(raw);
  // When the prompt-rewriter replaced the user's text before dispatch we want
  // to surface the original to the user (the rewrite is an LLM-only detail).
  // `rewriteOriginal` is plain text — strip the timestamp wrapper from `body`
  // by replacing the body, leaving the parsed timestamp untouched.
  const display = rewriteOriginal ?? body;
  return (
    <Box flexDirection="column" marginTop={1} alignItems="flex-end">
      <Box width="85%" justifyContent="flex-end">
        <Text>{display}</Text>
        <Text color={colors.accent} bold>
          {' ❯'}
        </Text>
      </Box>
      <Box>
        {rewriteOriginal !== undefined && <Text dimColor>{REWRITE_ICON} </Text>}
        {timestamp && <Text dimColor>{formatFriendlyTimestamp(timestamp)}</Text>}
      </Box>
    </Box>
  );
}

function AssistantMessage({
  message,
  timing,
  toolDetails,
}: {
  message: CoreAssistantMessage;
  timing?: { endedAt: number; durationMs: number };
  toolDetails: boolean;
}) {
  const colors = getThemeColors();
  const parts = normalizeAssistantContent(message.content);
  const chevron = (
    <Text color={colors.accent} bold>
      {'❮  '}
    </Text>
  );
  // The chevron mirrors the user's right-aligned `❯` and rides the first
  // line of content. Walk parts in order and prepend it to the first
  // renderable part; remaining parts render unchanged.
  let chevronUsed = false;
  const rendered: ReactNode[] = [];
  for (let idx = 0; idx < parts.length; idx++) {
    const part = parts[idx];
    if (part.type === 'text') {
      rendered.push(
        chevronUsed ? (
          <MarkdownLines key={idx} text={part.text} />
        ) : (
          <Box key={idx}>
            {chevron}
            <MarkdownLines text={part.text} />
          </Box>
        ),
      );
      chevronUsed = true;
      continue;
    }
    if (part.type === 'reasoning') {
      rendered.push(
        chevronUsed ? (
          <Text key={idx} dimColor italic>
            {part.text}
          </Text>
        ) : (
          <Box key={idx}>
            {chevron}
            <Text dimColor italic>
              {part.text}
            </Text>
          </Box>
        ),
      );
      chevronUsed = true;
      continue;
    }
    if (part.type === 'tool-call') {
      // `think` with empty thought renders nothing — don't consume the
      // chevron slot in that case.
      if (part.toolName === 'think' && !extractThought(part.args)) continue;
      rendered.push(
        <ToolCallBlock
          key={idx}
          part={part}
          toolDetails={toolDetails}
          prefix={chevronUsed ? undefined : chevron}
        />,
      );
      chevronUsed = true;
      continue;
    }
    // 'redacted-reasoning' / unknown parts: skip silently.
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {!chevronUsed && chevron}
      {rendered}
      {timing && (
        <Box justifyContent="flex-end">
          <Text dimColor>
            {formatDuration(timing.durationMs)} ·{' '}
            {formatFriendlyTimestamp(new Date(timing.endedAt))}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function ToolCallBlock({
  part,
  toolDetails,
  prefix,
}: {
  part: ToolCallPart;
  toolDetails: boolean;
  /** Optional inline node rendered before the `⚙ name` text (the chevron). */
  prefix?: ReactNode;
}) {
  const colors = getThemeColors();
  if (part.toolName === 'think') {
    const thought = extractThought(part.args);
    if (!thought) return null;
    return (
      <Box>
        {prefix}
        <Text dimColor italic>
          💭 {thought}
        </Text>
      </Box>
    );
  }
  if (part.toolName === 'plan' && toolDetails) {
    const planLines = formatPlanLines(part.args);
    if (planLines.length > 0) {
      return (
        <Box flexDirection="column">
          <Box>
            {prefix}
            <Text color={colors.toolCall}>⚙ plan</Text>
          </Box>
          <PlanEchoLines lines={planLines} />
        </Box>
      );
    }
  }
  const argSummary = toolDetails ? summariseArgs(part.args) : '';
  return (
    <Box>
      {prefix}
      <Text color={colors.toolCall}>⚙ {part.toolName}</Text>
      {argSummary && <Text dimColor> {argSummary}</Text>}
    </Box>
  );
}

/** Indented dim lines under a `⚙ plan` row — the tool-details plan echo. */
function PlanEchoLines({ lines }: { lines: string[] }) {
  return (
    <Box flexDirection="column" marginLeft={2}>
      {lines.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function ToolResultMessage({ message }: { message: CoreToolMessage }) {
  const colors = getThemeColors();
  const parts = Array.isArray(message.content) ? message.content : [];
  const visible = parts.filter((p: ToolResultPart) => p.toolName !== 'think');
  if (visible.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {visible.map((part: ToolResultPart, idx) => {
        const snippet = renderResultSnippet(part.result);
        const isError = part.isError === true;
        return (
          <Box key={idx}>
            <Text color={isError ? colors.error : undefined} dimColor={!isError}>
              ↳ {snippet}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Strips the model-facing wrapper (`# Request` heading or `<user_request>`
 * tags) and the leading `[ISO-timestamp]` injected by `timestampUserMessage`,
 * returning the human-readable body plus the timestamp (if present) for
 * separate rendering.
 */
function parseUserMessage(raw: string): { body: string; timestamp: Date | null } {
  let text = raw;
  if (text.startsWith('# Request\n')) {
    text = text.slice('# Request\n'.length);
  } else if (text.startsWith('<user_request>\n')) {
    text = text.slice('<user_request>\n'.length);
    if (text.endsWith('\n</user_request>')) text = text.slice(0, -'\n</user_request>'.length);
  }
  const m = text.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\] /);
  if (m) {
    const parsed = new Date(m[1]);
    return {
      body: text.slice(m[0].length),
      timestamp: isNaN(parsed.getTime()) ? null : parsed,
    };
  }
  return { body: text, timestamp: null };
}

/**
 * Human-friendly elapsed time: `420ms`, `1.2s`, `47s`, `2m 3s`. Mirrors what
 * a developer would scan for in the corner of a chat client — exact under a
 * second, one decimal under ten, whole seconds up to a minute, then `m s`.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  // Round once, then carry over to minutes so we can't emit "60s" or
  // "1m 60s" when the float happens to round up at the boundary.
  const wholeSeconds = Math.round(seconds);
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  const m = Math.floor(wholeSeconds / 60);
  const s = wholeSeconds - m * 60;
  return `${m}m ${s}s`;
}

function formatFriendlyTimestamp(date: Date): string {
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (sameDay) return time;
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${day} · ${time}`;
}

function extractUserText(message: CoreUserMessage): string {
  if (typeof message.content === 'string') return message.content;
  const out: string[] = [];
  for (const part of message.content as Array<TextPart | ImagePart>) {
    if (part.type === 'text') out.push(part.text);
    else if (part.type === 'image') out.push('[image]');
  }
  return out.join('\n');
}

type AssistantPart = TextPart | ToolCallPart | ReasoningPart | RedactedReasoningPart;

function normalizeAssistantContent(content: CoreAssistantMessage['content']): AssistantPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content as AssistantPart[];
}

function extractThought(args: unknown): string {
  if (args && typeof args === 'object' && 'thought' in args) {
    const t = (args as { thought: unknown }).thought;
    if (typeof t === 'string') return t;
  }
  return '';
}

/**
 * Decodes a `plan` tool call's args into human-readable lines for the
 * transcript echo (shown only when tool details are on). Reads purely from
 * the recorded args — never from the live PlanStore, which would be stale or
 * wrong for older turns in the history.
 */
function formatPlanLines(args: unknown): string[] {
  if (args == null || typeof args !== 'object') return [];
  const a = args as Record<string, unknown>;
  const action = a['action'];
  if (action === 'create' && Array.isArray(a['steps'])) {
    const steps = a['steps'] as { description?: unknown }[];
    return [
      'create:',
      ...steps.map((s, i) => `${i + 1}. ${typeof s?.description === 'string' ? s.description : '?'}`),
    ];
  }
  if (action === 'add' && a['step'] != null && typeof a['step'] === 'object') {
    const s = a['step'] as { description?: unknown };
    return [`+ step: ${typeof s.description === 'string' ? s.description : '?'}`];
  }
  if (action === 'update') {
    const base = `step ${a['id']} → ${a['status']}`;
    const note = a['note'] ?? a['signoff'];
    return [typeof note === 'string' && note ? `${base} · ${truncate(note, 80)}` : base];
  }
  if (action === 'view') return ['(view)'];
  return [];
}

function summariseArgs(args: unknown): string {
  if (args == null) return '';
  try {
    const json = JSON.stringify(args);
    if (json.length <= 80) return json;
    return json.slice(0, 79) + '…';
  } catch {
    return '';
  }
}

function renderResultSnippet(result: unknown): string {
  if (result == null) return '(no result)';
  if (typeof result === 'string') return truncate(result, 200);
  try {
    return truncate(JSON.stringify(result), 200);
  } catch {
    return '(unserializable result)';
  }
}

