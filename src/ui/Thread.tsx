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

interface ThreadProps {
  history: CoreMessage[];
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
export function Thread({ history }: ThreadProps) {
  return (
    <Box flexDirection="column">
      {history.map((msg, idx) => (
        <MessageBlock key={idx} message={msg} />
      ))}
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
  const text = extractUserText(message);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>
        you
      </Text>
      <Text>{text}</Text>
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
  const argSummary = summariseArgs(part.args);
  return (
    <Box>
      <Text color={colors.toolCall}>⚙ {part.toolName}</Text>
      {argSummary && <Text dimColor>  {argSummary}</Text>}
    </Box>
  );
}

function ToolResultMessage({ message }: { message: CoreToolMessage }) {
  const colors = getThemeColors();
  const parts = Array.isArray(message.content) ? message.content : [];
  return (
    <Box flexDirection="column" marginLeft={2}>
      {parts.map((part: ToolResultPart, idx) => {
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

function normalizeAssistantContent(
  content: CoreAssistantMessage['content'],
): AssistantPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content as AssistantPart[];
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
