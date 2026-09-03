import { useSyncExternalStore, type ReactNode } from 'react';
import { Box, Static, Text, useStdout } from 'ink';
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
import { toolFailureFor, type ToolFailure } from '../tool-failure.js';
import { getThemeColors } from '../theme.js';
import { truncate } from '../text.js';
import { formatCostSuffix } from '../usage-report.js';
import { formatFriendlyTimestamp } from '../output.js';
import { renderMarkdown } from './markdown.js';
import { useDimensionsCtx } from './DimensionsContext.js';
import { ErrorPanel } from './ErrorPanel.js';
import type { ErrorPanelData } from './error-format.js';
import type { MessageStore, StreamEvent } from './message-store.js';

/**
 * One finalized transcript entry. `<App>` builds these at turn boundaries and
 * appends them to the append-only log it feeds into `<Static>` (#232). Each
 * item snapshots everything `<MessageBlock>` needs at commit time — the
 * rewrite original (known at turn start) and the timing footer (known at turn
 * end) — because a Static item is written to terminal scrollback once and can
 * never be re-rendered. `toolDetails` is captured per-item for the same
 * reason: toggling the setting only affects subsequent turns.
 */
export interface StaticItem {
  /** Stable, monotonic id (never the history index — that shifts on /compact). */
  key: string;
  /** The finalized message. Omitted for synthetic items like {@link error}. */
  message?: CoreMessage;
  rewriteOriginal?: string;
  timing?: { endedAt: number; durationMs: number };
  /** Estimated priced cost (USD) of this turn (#258), shown beside the timing
   *  footer. Undefined when the turn was aborted or no tokens were priced. */
  costUsd?: number;
  toolDetails: boolean;
  /**
   * When set, this item is a failed-turn notice rendered as `<ErrorPanel>`
   * instead of a message. Lives in the UI transcript only — never pushed into
   * the agent's LLM history.
   */
  error?: ErrorPanelData;
}

interface ThreadProps {
  /**
   * Append-only log of finalized turns (#232). Rendered through Ink's
   * `<Static>` so each entry is written to terminal scrollback exactly once
   * and never repainted — that is what makes scrolling up hold position.
   */
  staticItems: StaticItem[];
  /**
   * Phase C (#214): when `busy === true`, `<Thread>` mounts a
   * `<StreamingAssistantMessage>` below the static history that subscribes
   * to `messageStore` and renders per-token deltas + inline tool-call /
   * tool-result blocks as they arrive. Omitted (or `busy === false`) means
   * only the finalized `<Static>` log renders.
   */
  messageStore?: MessageStore;
  busy?: boolean;
  /** Rendered as a dim notice below the transcript when the last turn was Esc-cancelled. */
  interrupted?: boolean;
  /**
   * Whether the in-flight `<StreamingAssistantMessage>` shows full tool-call
   * arguments and result bodies. Read live from `config.toolDetails` so the
   * current turn responds to a mid-turn toggle; finalized items carry their
   * own snapshot in `StaticItem.toolDetails`.
   */
  streamingToolDetails?: boolean;
}

/** Icon used wherever the prompt-rewriter feature surfaces in the UI. */
export const REWRITE_ICON = '✎';

/**
 * Renders the conversation. Finalized turns flow through Ink's `<Static>`
 * (#232): each `StaticItem` is written to terminal scrollback exactly once and
 * is never repainted, so scrolling up holds position even as the dynamic
 * region below (streaming message, spinner, prompt, status bar) keeps
 * repainting. `<App>` owns the append-only `staticItems` log and appends to it
 * at turn boundaries; only `/clear` remounts this component (via a key bump)
 * to reset `<Static>`'s internal high-water cursor.
 */
export function Thread({
  staticItems,
  messageStore,
  busy,
  interrupted,
  streamingToolDetails = false,
}: ThreadProps) {
  const colors = getThemeColors();
  const { stdout } = useStdout();
  // Ink's <Static> hoists its output to the top, OUTSIDE the App's outer
  // paddingX={2} box and WITHOUT stretching items to the terminal width.
  // Two consequences each item must compensate for: (1) percentage widths
  // (UserMessage right-aligns with width="85%") collapse without an explicit
  // parent width, and (2) static rows would start at column 0 while the
  // dynamic region (streaming message, prompt) is indented by 2. Give every
  // item the full terminal width + matching horizontal padding so finalized
  // turns line up with the live region. Width is captured at commit time;
  // already-printed rows don't rewrap on resize (an accepted Static tradeoff).
  const itemWidth = stdout?.columns ?? 80;
  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item) => (
          <Box key={item.key} width={itemWidth} flexDirection="column" paddingX={2}>
            {item.error ? (
              <ErrorPanel data={item.error} />
            ) : item.message ? (
              <MessageBlock
                message={item.message}
                rewriteOriginal={item.rewriteOriginal}
                timing={item.timing}
                costUsd={item.costUsd}
                toolDetails={item.toolDetails}
              />
            ) : null}
          </Box>
        )}
      </Static>
      {busy && messageStore && (
        <StreamingAssistantMessage store={messageStore} toolDetails={streamingToolDetails} />
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
  // `useDimensionsCtx`, not `useStdout`: the context is subscribed to stdout's
  // `resize`, so markdown re-lays-out when the terminal does. `useStdout` is not
  // reactive, so the frame reflowed around a body still measured for the old
  // width. This component serves both render paths, so it showed up in
  // full-screen too. Every other consumer in the tree already reads the context.
  const { columns } = useDimensionsCtx();
  const colors = getThemeColors();
  // App's outer <Box> has paddingX={2}; keep the table/rule width inside it.
  const width = Math.max(40, columns - 4);
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

/**
 * One assistant text block — the markdown body, optionally prefixed inline by
 * the `❮` chevron. Shared by the committed `<AssistantMessage>` and the live
 * `<StreamGroupBody>` so both render text identically; the `streaming` flag is
 * the only legitimate difference (it heals partial mid-stream markdown).
 */
function AssistantTextBlock({
  text,
  prefix,
  streaming = false,
}: {
  text: string;
  prefix?: ReactNode;
  streaming?: boolean;
}) {
  return prefix ? (
    <Box>
      {prefix}
      <MarkdownLines text={text} streaming={streaming} />
    </Box>
  ) : (
    <MarkdownLines text={text} streaming={streaming} />
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
  // Each text-run and each tool-call renders as its own block with a top
  // margin (except the first) and its own chevron — mirroring how the
  // committed <AssistantMessage> renders one block per agent step. This is
  // what keeps the live view from reflowing/restyling when the turn ends.
  // Tool-call rendering itself is delegated to the shared <ToolCallBlock> so
  // the streaming and committed paths can't drift.
  const elements: ReactNode[] = [];
  let textBuffer = '';
  let textKey = 0;
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
  // Wrap each logical block so consecutive blocks get a blank line between
  // them (the first rides the outer wrapper's marginTop, matching the first
  // committed AssistantMessage of a turn).
  const pushBlock = (key: string, child: ReactNode) => {
    elements.push(
      <Box key={key} flexDirection="column" marginTop={elements.length === 0 ? 0 : 1}>
        {child}
      </Box>,
    );
  };
  const flushText = () => {
    if (textBuffer.length === 0) return;
    pushBlock(
      `t-${textKey++}`,
      <AssistantTextBlock
        text={textBuffer}
        prefix={inlineChevron ? chevron : undefined}
        streaming
      />,
    );
    textBuffer = '';
  };
  for (const ev of events) {
    if (ev.kind === 'text-delta') {
      textBuffer += ev.text;
      continue;
    }
    if (ev.kind === 'tool-call') {
      flushText();
      // `think` with an empty thought renders nothing — don't emit a block
      // (mirrors <ToolCallBlock> returning null + the static skip).
      if (ev.toolName === 'think' && !extractThought(ev.args)) continue;
      // `think` never shows a `↳` result row (its result is internal).
      const showResult = ev.toolName !== 'think' && toolDetails && resultsByCall.has(ev.callId);
      pushBlock(
        `c-${ev.callId}`,
        <>
          <ToolCallBlock
            part={{ toolName: ev.toolName, args: ev.args }}
            toolDetails={toolDetails}
            prefix={inlineChevron ? chevron : undefined}
          />
          {showResult && (
            <StreamingToolResult result={resultsByCall.get(ev.callId)!} toolName={ev.toolName} />
          )}
        </>,
      );
      continue;
    }
    // tool-result handled inline above; skip if it has a matching call.
    // If a result arrived without its call (shouldn't happen, but defensive),
    // render it as a standalone row so the user still sees it.
    if (toolDetails && !callsById.has(ev.callId)) {
      flushText();
      pushBlock(
        `r-${ev.callId}`,
        <Box marginLeft={2}>
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
  if (elements.length === 0 && inlineChevron) {
    elements.push(<Box key="chev-only">{chevron}</Box>);
  }
  return <>{elements}</>;
}

/** Severity → theme colour; `undefined` renders dim. */
const SEVERITY_COLOR: Record<ToolFailure['severity'], 'error' | 'warning' | undefined> = {
  critical: 'error',
  normal: 'warning',
  low: undefined,
};

/**
 * The recovery line beneath a failed tool result.
 *
 * The red result above says a call failed; this says what to do about it.
 * Before #353 this text (`Classification.playbook.user`) went to a
 * `printToolFailure` stub and was dropped, while the *model's* playbook leaked
 * into the result the user reads — so on a rate limit they saw "You are
 * rate-limited. Do not retry immediately. Suggest waiting…", an instruction
 * addressed to the model, instead of "wait or switch lineup with /lineups".
 */
function ToolFailureHint({ failure }: { failure: ToolFailure }) {
  const colors = getThemeColors();
  const key = SEVERITY_COLOR[failure.severity];
  return (
    <Text color={key ? colors[key] : undefined} dimColor={!key}>
      {failure.category} · {failure.hint}
    </Text>
  );
}

function StreamingToolResult({
  result,
  toolName,
}: {
  result: Extract<StreamEvent, { kind: 'tool-result' }>;
  toolName: string;
}) {
  const colors = getThemeColors();
  // Derived here rather than carried on the event: the committed path has to
  // derive it anyway (a `CoreMessage` has nowhere to put it), and one
  // mechanism cannot disagree with itself about whether a call failed.
  const failure = toolFailureFor(toolName, result.result);
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={result.isError ? colors.error : undefined} dimColor={!result.isError}>
        ↳ {renderResultSnippet(result.result)}
      </Text>
      {failure && <ToolFailureHint failure={failure} />}
    </Box>
  );
}

export function MessageBlock({
  message,
  rewriteOriginal,
  timing,
  costUsd,
  toolDetails,
}: {
  message: CoreMessage;
  rewriteOriginal?: string;
  timing?: { endedAt: number; durationMs: number };
  costUsd?: number;
  toolDetails: boolean;
}) {
  if (message.role === 'user')
    return <UserMessage message={message as CoreUserMessage} rewriteOriginal={rewriteOriginal} />;
  if (message.role === 'assistant')
    return (
      <AssistantMessage
        message={message as CoreAssistantMessage}
        timing={timing}
        costUsd={costUsd}
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
  costUsd,
  toolDetails,
}: {
  message: CoreAssistantMessage;
  timing?: { endedAt: number; durationMs: number };
  costUsd?: number;
  toolDetails: boolean;
}) {
  const colors = getThemeColors();
  const parts = normalizeAssistantContent(message.content);
  const costSuffix = formatCostSuffix(costUsd);
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
        <AssistantTextBlock
          key={idx}
          text={part.text}
          prefix={chevronUsed ? undefined : chevron}
        />,
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
            {costSuffix && ` · ${costSuffix}`}
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
  // Only `toolName`/`args` are read, so both the committed path (a full
  // `ToolCallPart`) and the streaming path (a `StreamEvent` tool-call, same
  // field names) can share this component.
  part: { toolName: string; args: unknown };
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
        // Recomputed rather than carried: the committed transcript is rebuilt
        // from `CoreMessage`s, which have no room for a sink-only field, and a
        // hint that only lived on the streaming event would disappear the
        // instant the turn ended.
        const failure = toolFailureFor(part.toolName, part.result);
        const isError = part.isError === true || failure !== undefined;
        return (
          <Box key={idx} flexDirection="column">
            <Text color={isError ? colors.error : undefined} dimColor={!isError}>
              ↳ {snippet}
            </Text>
            {failure && <ToolFailureHint failure={failure} />}
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
export function formatDuration(ms: number): string {
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
      ...steps.map(
        (s, i) => `${i + 1}. ${typeof s?.description === 'string' ? s.description : '?'}`,
      ),
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
