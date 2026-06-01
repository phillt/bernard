import { useSyncExternalStore, type ReactNode } from 'react';
import { Box, Text } from 'ink';
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
}

/**
 * Renders the conversation as a flowing list of message blocks. Reads the
 * AI SDK's `CoreMessage[]` shape directly — same array `Agent.getHistory()`
 * returns. Re-renders when `<App>` bumps `historyVersion` after a turn ends.
 *
 * Streaming-output migration (Phase C) will keep this component but feed it
 * from an in-memory message store so the in-flight assistant message updates
 * token-by-token. Phase B renders the message in bulk at turn end.
 */
export function Thread({ history, messageStore, busy }: ThreadProps) {
  return (
    <Box flexDirection="column">
      {history.map((msg, idx) => (
        <MessageBlock key={idx} message={msg} />
      ))}
      {busy && messageStore && <StreamingAssistantMessage store={messageStore} />}
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
export function StreamingAssistantMessage({ store }: { store: MessageStore }) {
  const colors = getThemeColors();
  const events = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (events.length === 0) return null;
  const groups = groupByLabel(events);
  return (
    <Box flexDirection="column" marginTop={1}>
      {groups.map((group, idx) => (
        <Box key={idx} flexDirection="column">
          <Text color={colors.accent} bold>
            {group.label ?? 'bernard'}
          </Text>
          <StreamGroupBody events={group.events} />
        </Box>
      ))}
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

function StreamGroupBody({ events }: { events: StreamEvent[] }) {
  const colors = getThemeColors();
  // Concatenate text-deltas into a single rolling string so we don't render
  // one <Text> per token (which Ink would lay out as separate lines).
  const elements: ReactNode[] = [];
  let textBuffer = '';
  let textKey = 0;
  const flushText = () => {
    if (textBuffer.length === 0) return;
    elements.push(<Text key={`t-${textKey++}`}>{textBuffer}</Text>);
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
            <Text key={`c-${ev.callId}`} dimColor italic>
              💭 {thought}
            </Text>,
          );
        }
        continue;
      }
      const argsSummary = summariseArgs(ev.args);
      elements.push(
        <Box key={`c-${ev.callId}`} flexDirection="column">
          <Box>
            <Text color={colors.toolCall}>⚙ {ev.toolName}</Text>
            {argsSummary && <Text dimColor> {argsSummary}</Text>}
          </Box>
          {resultsByCall.has(ev.callId) && (
            <StreamingToolResult result={resultsByCall.get(ev.callId)!} />
          )}
        </Box>,
      );
      continue;
    }
    // tool-result handled inline above; skip if it has a matching call.
    // If a result arrived without its call (shouldn't happen, but defensive),
    // render it as a standalone row so the user still sees it.
    if (!callsById.has(ev.callId)) {
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

function MessageBlock({ message }: { message: CoreMessage }) {
  if (message.role === 'user') return <UserMessage message={message as CoreUserMessage} />;
  if (message.role === 'assistant')
    return <AssistantMessage message={message as CoreAssistantMessage} />;
  if (message.role === 'tool') return <ToolResultMessage message={message as CoreToolMessage} />;
  // System messages are agent-internal; don't render in the thread.
  return null;
}

function UserMessage({ message }: { message: CoreUserMessage }) {
  const colors = getThemeColors();
  const raw = extractUserText(message);
  const { body, timestamp } = parseUserMessage(raw);
  return (
    <Box flexDirection="column" marginTop={1} alignItems="flex-end">
      <Text color={colors.accent} bold>
        you
      </Text>
      <Text>{body}</Text>
      {timestamp && <Text dimColor>{formatFriendlyTimestamp(timestamp)}</Text>}
    </Box>
  );
}

function AssistantMessage({ message }: { message: CoreAssistantMessage }) {
  const colors = getThemeColors();
  const parts = normalizeAssistantContent(message.content);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>
        bernard
      </Text>
      {parts.map((part, idx) => {
        if (part.type === 'text') return <Text key={idx}>{part.text}</Text>;
        if (part.type === 'reasoning')
          return (
            <Text key={idx} dimColor italic>
              {part.text}
            </Text>
          );
        if (part.type === 'tool-call') return <ToolCallBlock key={idx} part={part} />;
        // 'redacted-reasoning' / unknown parts: skip silently.
        return null;
      })}
    </Box>
  );
}

function ToolCallBlock({ part }: { part: ToolCallPart }) {
  const colors = getThemeColors();
  if (part.toolName === 'think') {
    const thought = extractThought(part.args);
    if (!thought) return null;
    return (
      <Text dimColor italic>
        💭 {thought}
      </Text>
    );
  }
  const argSummary = summariseArgs(part.args);
  return (
    <Box>
      <Text color={colors.toolCall}>⚙ {part.toolName}</Text>
      {argSummary && <Text dimColor> {argSummary}</Text>}
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
