import { memo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Box, Text, measureElement, useInput } from 'ink';
import { getThemeColors } from '../theme.js';
import { useDimensionsCtx } from './DimensionsContext.js';
import { useMouseWheel } from './useMouseWheel.js';
import { ErrorPanel } from './ErrorPanel.js';
import { MessageBlock, StreamingAssistantMessage, type StaticItem } from './Thread.js';
import { formatPosition, listPosition } from './overlays/viewer-util.js';
import type { MessageStore } from './message-store.js';

/** Lines moved per mouse-wheel tick / arrow press. */
const WHEEL_STEP = 3;

interface TranscriptViewportProps {
  /** Append-only log of finalized turns. */
  items: StaticItem[];
  messageStore?: MessageStore;
  busy?: boolean;
  interrupted?: boolean;
  streamingToolDetails?: boolean;
  /**
   * True when the input line is empty (or disabled while busy), so Home/End may
   * jump the transcript without stealing those keys from the line editor. Plain
   * arrows and letter keys are deliberately NOT bound — Ink broadcasts every
   * keypress to all `useInput`s with no stop-propagation, so they would collide
   * with history recall / text entry in `<Prompt>`.
   */
  promptEmpty?: boolean;
  /** Whether mouse-wheel capture is active (BERNARD_DISABLE_MOUSE off). */
  mouseEnabled?: boolean;
  /** Optional content rendered above the first turn (e.g. the welcome splash). */
  header?: ReactNode;
}

const MemoMessageBlock = memo(MessageBlock);

/**
 * Full-screen transcript: a fixed-height, line-scrollable window over the
 * append-only turn log plus the in-flight streaming turn. Replaces Ink's
 * `<Static>` (which writes to terminal scrollback — unavailable in the
 * alternate screen buffer).
 *
 * Scrolling is implemented with the standard Ink technique: render the full
 * content in an inner column shifted up by `marginTop={-offset}` inside an
 * `overflow="hidden"` viewport box. This reuses the existing `<MessageBlock>` /
 * `<StreamingAssistantMessage>` components verbatim (no second rendering path to
 * drift from), and `measureElement` gives the real content + viewport heights so
 * the offset is clamped exactly and "stick to bottom" tracks streaming growth.
 */
export function TranscriptViewport({
  items,
  messageStore,
  busy,
  interrupted,
  streamingToolDetails = false,
  promptEmpty = false,
  mouseEnabled = false,
  header,
}: TranscriptViewportProps) {
  const colors = getThemeColors();
  useDimensionsCtx(); // re-render (and re-measure) on terminal resize
  // Subscribe to the stream so a token delta re-renders this component (not just
  // the child below) — that's what re-runs the measure effect and lets the
  // bottom-stick offset follow the growing in-flight turn.
  const noopSubscribe = useRef(() => () => {}).current;
  const noopSnapshot = useRef(() => 0).current;
  useSyncExternalStore<unknown>(
    messageStore?.subscribe ?? noopSubscribe,
    messageStore?.getSnapshot ?? noopSnapshot,
  );
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [viewportH, setViewportH] = useState(0);
  const [contentH, setContentH] = useState(0);
  // Scroll offset in lines from the top of the content. `stick` pins the window
  // to the bottom so new output (and streaming deltas) stay in view until the
  // user scrolls up.
  const [offset, setOffset] = useState(0);
  const [stick, setStick] = useState(true);

  // Re-measure after every commit. measureElement is synchronous; the change
  // guards keep this from looping (heights settle within a frame or two). Runs
  // each streaming delta too — `messageStore` re-renders this component via the
  // child below — so `contentH` tracks the growing in-flight turn.
  useEffect(() => {
    if (outerRef.current) {
      const m = measureElement(outerRef.current);
      if (m.height > 0 && m.height !== viewportH) setViewportH(m.height);
    }
    if (innerRef.current) {
      const m = measureElement(innerRef.current);
      if (m.height !== contentH) setContentH(m.height);
    }
  });

  const maxOffset = Math.max(0, contentH - viewportH);
  const effectiveOffset = stick ? maxOffset : Math.min(offset, maxOffset);

  // Re-stick once the user scrolls back to the bottom so streaming resumes
  // following. Also keeps `stick` honest after a resize grows the viewport.
  useEffect(() => {
    if (!stick && effectiveOffset >= maxOffset) setStick(true);
  }, [stick, effectiveOffset, maxOffset]);

  const scrollBy = (deltaLines: number) => {
    if (maxOffset === 0) return; // nothing to scroll
    const base = stick ? maxOffset : Math.min(offset, maxOffset);
    const next = Math.max(0, Math.min(maxOffset, base + deltaLines));
    setStick(next >= maxOffset);
    setOffset(next);
  };

  useMouseWheel((event) => {
    scrollBy(event.direction === 'up' ? -WHEEL_STEP : WHEEL_STEP);
  }, mouseEnabled);

  useInput((input, key) => {
    const page = Math.max(1, viewportH - 1);
    if (key.pageUp) scrollBy(-page);
    else if (key.pageDown) scrollBy(page);
    // Home/End aren't named keys in Ink — match their raw escape sequences, and
    // only when the input line is empty so they don't fight the line editor.
    else if (promptEmpty && (input === '\x1b[H' || input === '\x1b[1~')) {
      setStick(false);
      setOffset(0);
    } else if (promptEmpty && (input === '\x1b[F' || input === '\x1b[4~')) {
      setStick(true);
      setOffset(maxOffset);
    }
  });

  // Rows hidden below the window. Also the old `scrolledUp`: when `stick`,
  // `effectiveOffset === maxOffset`, so it is 0 and the "new output" marker is
  // gated exactly as it was. No `Math.max` guard — `effectiveOffset` is
  // `<= maxOffset` by construction (see above). The rows hidden ABOVE are no
  // longer computed here: they are `effectiveOffset`, which is exactly
  // `listPosition`'s `first - 1`, so the position row already carries them.
  const below = maxOffset - effectiveOffset;
  // ONE fact, in the spelling every other windowed surface uses (`ViewerShell`,
  // `MenuOverlay`, `ModelGridOverlay`, `PlanPanel`, `HelpOverlay`). This used to
  // read `▲ 923 more rows above · rows 924–958 of 958`, which is the same number
  // three times: `listPosition` returns `first = offset + 1`, so the count above
  // is always `first - 1`, and at rest (`stick`) `last === total`. Forty-three
  // characters carrying `(first, size, total)` — and under `wrap="truncate"` a
  // narrow terminal loses the right half, i.e. the half that is not redundant.
  const position = formatPosition(listPosition(effectiveOffset, viewportH, contentH), 'rows');
  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* The position row, ABOVE the content it describes (#470) — it was below,
          so the reader had to travel past the thing being described to learn it
          was cut. A fixed-height sibling with no `flexGrow`, so moving it
          touches neither the flex distribution below nor either
          `measureElement`.

          `↓ new output` shares this row rather than sitting at the bottom, and
          that is a budget decision, not a preference: splitting them costs a
          SECOND permanently-reserved row, and `plan-window.ts` calibrates
          `MIN_TRANSCRIPT_ROWS` against the transcript spending exactly one. A
          conditionally-rendered bottom row would be worse still — layout height
          would then depend on the very state it is reporting.

          Reserved UNCONDITIONALLY — blank when the whole transcript fits, which
          is what `formatPosition` returning null means. Rendering it only while
          scrolled made the viewport's height depend on the budget that decides
          what is hidden (`OverlayFooter`'s rule) and said nothing at rest, the
          normal state after every turn. `wrap="truncate"` because it must stay
          exactly one row at any width, or the reservation is a lie.
          See CLAUDE.md (#435, #470). */}
      <Box justifyContent="space-between">
        <Text color={colors.muted} wrap="truncate">
          {position || ' '}
        </Text>
        {busy && below > 0 && <Text color={colors.accent}>↓ new output</Text>}
      </Box>
      {/* `flexBasis={0}` is load-bearing and NOT removable, however redundant it
          looks beside `flexGrow`. Ink 5 never maps `overflow` onto Yoga — it is
          a paint-time clip only — so with the default `auto` basis this box's
          flex base size is its CONTENT height, i.e. the whole inner column,
          which is `flexShrink={0}` and unbounded. That base size then enters the
          frame's negative-free-space distribution against the chrome, so
          `measureElement` returns a height that depends on the current scroll
          offset and the viewport becomes a damped iteration. A zero basis takes
          content out of the calculation: the box grows into exactly the free
          space the chrome leaves, in one pass. It also fixes the priority under
          a too-tall chrome — `flexGrow` does not apply to negative free space,
          so the transcript is already at zero before the prompt loses a row.
          Measurements and the full history: CLAUDE.md → TranscriptViewport
          (#435). Pinned by `Thread.test.tsx`.

          `overflowY`, NOT `overflow` — the difference is a user-visible bug
          (#464). `overflow: 'hidden'` sets BOTH clip axes, and Ink's horizontal
          clip runs every line through `sliceAnsi(line, from, stringWidth(line))`
          (`ink/build/output.js`). `slice-ansi@7` cannot parse OSC 8: its
          `parseAnsiCode` reads at most 19 bytes looking for a terminating `m`,
          so for a hyperlink it swallows `\x1b]8;;https://phone` as "an ANSI
          code" and then counts the rest of the URL — and the BEL — as VISIBLE
          characters. Its count reaches the true width after ~13 real
          characters and it stops, which is how a Zoom link rendered as
          `https://phone`. Different URLs cut at different points, so it recurs
          unpredictably.

          This box only ever wanted to clip the scroll window VERTICALLY.
          Dropping the horizontal clip fixes the whole class rather than the one
          escape, and keeps hyperlinks clickable instead of removing them as
          collateral. Nothing bleeds: Ink's own `<Text>` wrapping already bounds
          every line to the box width, so the horizontal clip was redundant work
          that could only cause harm. */}
      <Box ref={outerRef} flexDirection="column" flexGrow={1} flexBasis={0} overflowY="hidden">
        <Box ref={innerRef} flexDirection="column" marginTop={-effectiveOffset} flexShrink={0}>
          {header}
          {items.map((item) => (
            <Box key={item.key} flexDirection="column">
              {item.error ? (
                <ErrorPanel data={item.error} />
              ) : item.message ? (
                <MemoMessageBlock
                  message={item.message}
                  rewriteOriginal={item.rewriteOriginal}
                  timing={item.timing}
                  costUsd={item.costUsd}
                  toolDetails={item.toolDetails}
                />
              ) : null}
            </Box>
          ))}
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
      </Box>
    </Box>
  );
}
