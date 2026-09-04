import { memo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Box, Text, measureElement, useInput } from 'ink';
import { getThemeColors } from '../theme.js';
import { useDimensionsCtx } from './DimensionsContext.js';
import { useMouseWheel } from './useMouseWheel.js';
import { useRawKeys } from './useRawKeys.js';
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
 * `overflowY="hidden"` viewport box. This reuses the existing `<MessageBlock>` /
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

  useInput((_, key) => {
    const page = Math.max(1, viewportH - 1);
    if (key.pageUp) scrollBy(-page);
    else if (key.pageDown) scrollBy(page);
  });

  // Home/End jump to the ends of the transcript, decoded off stdin because Ink
  // drops them before `useInput` (see `keys.ts`). This replaces a branch that
  // matched `input === '\x1b[H'` and could never fire — `input` is `''` for
  // these keys — so transcript Home/End had never worked despite being
  // advertised, from #288 until #399.
  //
  // `promptEmpty` is the arbitration, and it is the rule that dead branch
  // already chose: with text in the prompt, Home/End belong to the line editor.
  // The overlap when the prompt IS empty is harmless — Home/End on an empty
  // buffer move a cursor that is already at 0. An open overlay unmounts this
  // component entirely, so no overlay ever competes.
  useRawKeys((key) => {
    if (key === 'home') {
      setStick(false);
      setOffset(0);
    } else {
      setStick(true);
      setOffset(maxOffset);
    }
  }, promptEmpty);

  // Not stuck at the bottom. When `stick`, `effectiveOffset === maxOffset`, so
  // the "new output" marker is gated exactly as it was when this was a row
  // count — nothing counts rows here any more, so it is named for what it is.
  const scrolledUp = effectiveOffset < maxOffset;
  // ONE fact, in the spelling every other windowed surface uses. It used to
  // prepend `▲ N more rows above`, which is `first - 1` — the same number again
  // (#470). Why that mattered: CLAUDE.md → TranscriptViewport.
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
          {position ?? ' '}
        </Text>
        {busy && scrolledUp && <Text color={colors.accent}>↓ new output</Text>}
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

          `overflowY`, NOT `overflow` (#464). `overflow: 'hidden'` sets BOTH
          clip axes, and Ink's horizontal clip mis-slices OSC 8 hyperlinks — a
          Zoom URL rendered as `https://phone`. This box only ever wanted to clip
          VERTICALLY, and Ink's own `<Text>` wrapping already bounds every line
          to the box width, so the horizontal clip was redundant work that could
          only cause harm. Mechanism, measurements and the false lead that hid
          it: CLAUDE.md → TranscriptViewport (#464). Pinned by
          `TranscriptViewport.hyperlink.test.tsx`. */}
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
