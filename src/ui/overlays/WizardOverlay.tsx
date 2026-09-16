import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { getThemeColorsFor, type ThemeColors } from '../../theme.js';
import { ThemePreviewProvider, useThemeColors } from '../ThemeContext.js';
import { truncate } from '../../text.js';
import { HintRow, KEY, HINT_CANCEL, HINT_MOVE, ctrlKey, type KeyHint } from '../hints.js';
import { isDismissKey } from './overlay-contract.js';
import { useListCursor, useListWindow } from './use-list-cursor.js';
import { chromeRows, overlayViewport } from './menu-geometry.js';
import { formatPosition, listPosition, wrapText } from './viewer-util.js';
import { useDimensionsCtx } from '../DimensionsContext.js';
import { useLineEditor } from '../use-line-editor.js';
import { useRawKeys } from '../useRawKeys.js';
import { BoundedLine, OVERLAY_RESERVED_COLUMNS } from '../BoundedLine.js';
import { MenuRow } from './MenuRow.js';
import {
  answerStep,
  choiceRows,
  answeredSoFar,
  editStep,
  goBack,
  initialWizardState,
  isAnswered,
  isInfoStep,
  actionRows,
  CONTINUE_LABEL,
  railFor,
  nextLabelFor,
  rowNote,
  type StepCheckResult,
  rowTrailing,
  unavailableReason,
  stepError,
  summarizeAnswer,
  useFreeform,
  type WizardAnswer,
  type WizardResult,
  type RailEntry,
  type WizardSpec,
  type WizardStep,
  choiceValueOf,
} from './wizard-types.js';

/** Back. Not Esc — `overlay-contract.ts`'s rule is that Esc always dismisses. */
const BACK_HINT = { key: ctrlKey('b'), label: 'back' };
/**
 * Forward, and it ACTS rather than moving the cursor onto Continue.
 *
 * Symmetric with `ctrl+b`, which goes back rather than focusing Back — a pair
 * where one commits and the other only points at a button would be two rules
 * wearing one shape. It is a chord rather than `→` because a text step spends
 * the arrow keys on its buffer, and a shortcut that works on four step kinds
 * and silently does nothing on the fifth is the inconsistency this replaces.
 * (`→` still reaches Continue from an option ROW, where it is free.)
 */
const NEXT_HINT = { key: ctrlKey('n'), label: 'continue' };
/** The line editor claims ctrl-a/e/w/u/k/d and declines every other chord, so
 *  ^B and ^N are both free — verified against `use-line-editor.tsx`. */
function isBackKey(input: string, key: { ctrl?: boolean }): boolean {
  return key.ctrl === true && input === 'b';
}
function isNextKey(input: string, key: { ctrl?: boolean }): boolean {
  return key.ctrl === true && input === 'n';
}
/** Run the step's own check. Free at every layer — `t` is unclaimed. */
function isCheckKey(input: string, key: { ctrl?: boolean }): boolean {
  return key.ctrl === true && input === 't';
}

/** Where Enter lands on a text step: the buffer, or one of its controls. */
type Focus = 'input' | 'back' | 'check' | 'next';

interface WizardOverlayProps {
  spec: WizardSpec;
  onResolve: (result: WizardResult) => void;
  /** Rows consumed by chrome OUTSIDE this overlay — the banner, legacy inline mode. */
  reserveRows?: number;
  /**
   * The wizard owns the whole frame, so centre the card vertically too.
   *
   * Set by the standalone setup host and by the REPL in full-screen, where an
   * overlay replaces the transcript. Left off in legacy inline mode, where the
   * overlay is appended below a live transcript and prompt that a full-height
   * box would push off the screen.
   */
  fill?: boolean;
  masthead?: WizardSpec['masthead'];
}

/**
 * A step-by-step wizard (#473).
 *
 * One question per screen, back and edit, and a check-your-answers review
 * before anything resolves. `wizard-types.ts` owns the state machine; this file
 * owns keys and pixels.
 *
 * **It owns the whole batch**, which is what separates it from
 * `runProfileWizardInk` — that sequences `await requestMenu(...)` per field, so
 * each step is a full unmount with no memory of the last, and it cannot offer
 * "change your answer to question 2" because question 2's overlay is gone. It
 * also takes an `AbortSignal` at the request layer, which that flow does not:
 * an aborted turn there cancels one overlay and the wizard opens the next.
 *
 * **No progress fraction anywhere**, and that is a finding rather than an
 * omission. Randomised progress feedback in web surveys measured 12.7% breakoff
 * with none against 21.8% when the indicator implied slow progress. An adaptive
 * interview cannot know its own length, so a fraction is a guess in the
 * direction that nearly doubled abandonment. `spec.intro` states the shape in
 * words, once.
 *
 * **Sober chrome on purpose.** The one peer-reviewed study of CLI
 * accessibility finds unstructured two-dimensional output is the core barrier
 * for screen readers, with box-drawing borders announced character by
 * character. So: no borders, no animation, and every step answerable by typing
 * plus Enter.
 */
export function WizardOverlay({ spec, onResolve, reserveRows = 0, fill }: WizardOverlayProps) {
  const [state, setState] = useState(() => initialWizardState(spec.steps));
  // The row the cursor is on, while it is on the previewing step. Held HERE
  // rather than in `WizardChoiceStep`, which is a child of `WizardCard`: state
  // down there repaints the rows and leaves the border, the rail, the header
  // and the footer on the old theme, so the frame comes out half-painted.
  const [highlighted, setHighlighted] = useState<string | null>(null);

  // `answerStep` parks on `review` after the last answer, so a spec that opted
  // out of the review resolves from here. In an effect, not in render: this
  // calls back into the host, which sets state — doing that mid-render updates
  // one component while another is rendering.
  const settled = state.phase === 'review' && spec.skipReview === true;
  useEffect(() => {
    if (settled) onResolve({ cancelled: false, answers: state.answers });
    // Keyed on `settled` alone, deliberately: the answers are frozen once the
    // state is terminal, and depending on their identity would resolve twice.
  }, [settled]);

  // Which theme the wizard is painted in right now (#447).
  //
  // The highlighted row while the reader is ON that step, falling back to the
  // answer it already holds — which is what makes a chosen theme stick for the
  // rest of the walk, and what makes arrowing to `ocean` and back to `bernard`
  // before Continue land on `bernard`. `null` at every other moment, which is
  // the provider's "leave it on the active theme".
  const previewAt = spec.steps.findIndex((s) => s.preview === 'theme');
  const previewKey =
    previewAt < 0
      ? null
      : ((state.index === previewAt ? highlighted : null) ??
        choiceValueOf(spec.steps[previewAt], state.answers[previewAt]));
  const previewColors = previewKey === null ? null : getThemeColorsFor(previewKey);
  // Wrapped once around whichever branch renders, so the card and everything
  // inside it agree. `null` renders the provider anyway: its presence is then
  // not a second thing to keep in step with the preview state.
  const framed = (node: ReactNode): ReactNode => (
    <ThemePreviewProvider colors={previewColors}>{node}</ThemePreviewProvider>
  );

  const cancel = (): void => onResolve({ cancelled: true, answered: answeredSoFar(state) });
  // Back off the front of a spec that declared `backExits` hands the journey
  // back to whatever opened this wizard, rather than being a control that is
  // simply missing at every seam between stages.
  const exitsBack = spec.backExits === true && state.index === 0 && state.phase === 'asking';
  const back = (): void =>
    exitsBack
      ? onResolve({ cancelled: true, answered: answeredSoFar(state), back: true })
      : setState(goBack);
  const submit = (answer: WizardAnswer): void => setState((s) => answerStep(s, spec.steps, answer));
  // Every step kind draws the same card, so the line above it is threaded once
  // here rather than reached for out of `spec` in four render branches.
  const masthead = spec.masthead;

  if (settled) return null;

  if (state.phase === 'review') {
    return framed(
      <WizardReview
        spec={spec}
        answers={state.answers}
        reserveRows={reserveRows}
        rail={railFor(spec.steps, spec.steps.length, spec.railContext)}
        fill={fill}
        masthead={masthead}
        onBack={back}
        onEdit={(index) => setState((s) => editStep(s, index))}
        onCommit={() => onResolve({ cancelled: false, answers: state.answers })}
        onCancel={cancel}
      />,
    );
  }

  const step = spec.steps[state.index];
  const header = state.index === 0 && spec.intro ? spec.intro : undefined;
  const rail = railFor(spec.steps, state.index, spec.railContext);
  const asText = state.freeform || step.field.kind === 'text';
  // An edit goes back to the review it came from; the escape hatch goes back to
  // its own choices.
  const canGoBack = state.index > 0 || state.phase === 'editing' || state.freeform || exitsBack;

  if (!state.freeform && isInfoStep(step)) {
    return framed(
      <WizardInfoStep
        key={`${step.id}-info`}
        step={step}
        rail={rail}
        canGoBack={canGoBack}
        fill={fill}
        masthead={masthead}
        onSubmit={submit}
        onBack={back}
        onCancel={cancel}
      />,
    );
  }

  return framed(
    asText ? (
      <WizardTextStep
        // Keyed so the editor remounts with this step's own answer rather than
        // carrying the previous one's buffer.
        key={`${step.id}-text`}
        step={step}
        intro={header}
        rail={rail}
        initial={
          typeof state.answers[state.index] === 'string'
            ? (state.answers[state.index] as string)
            : ''
        }
        canGoBack={canGoBack}
        fill={fill}
        masthead={masthead}
        onSubmit={submit}
        onBack={back}
        onCancel={cancel}
      />
    ) : (
      <WizardChoiceStep
        key={`${step.id}-choice`}
        step={step}
        intro={header}
        rail={rail}
        current={state.answers[state.index]}
        canGoBack={canGoBack}
        fill={fill}
        masthead={masthead}
        onSubmit={submit}
        onOther={() => setState(useFreeform)}
        onBack={back}
        onCancel={cancel}
        reserveRows={reserveRows}
        // Only the declaring step reports. That is a saved root re-render per
        // keystroke on every other question, NOT what makes the preview
        // correct — a report from elsewhere is never read, because `previewKey`
        // consults `highlighted` only while the walk is ON the previewing step.
        // Said plainly because removing this conditional changes no behaviour,
        // and a comment calling it a guard would be the misleading kind.
        //
        // `setHighlighted` is passed directly rather than wrapped: a fresh
        // closure each render would re-fire the child's effect every render.
        {...(step.preview === 'theme' ? { onHighlight: setHighlighted } : {})}
      />
    ),
  );
}

/**
 * The card every wizard screen is drawn in.
 *
 * Centred and bounded rather than flush-left and full-width, which is the one
 * thing that makes a long walk read as a sequence of pages instead of a
 * terminal that keeps reprinting. At 100+ columns an unbounded question wrapped
 * to the full width and the eye had to travel the whole line for a four-word
 * label.
 *
 * **The border is a considered reversal, not an oversight.** This component
 * shipped with "no borders", citing the finding that unstructured
 * two-dimensional output is the core barrier for CLI screen readers and that
 * box-drawing characters are announced one at a time. The barrier that finding
 * names is two-dimensional LAYOUT — columns, tables, content whose meaning
 * depends on position — and what is inside this frame is a single linear
 * column, read top to bottom, exactly as before. A border around it adds two
 * announced rows per screen and changes no reading order. It is also already
 * the house surface: `Prompt` draws one on every frame of every session, and
 * `TranscriptPanel` around every error and notice. The rest of the original
 * rule stands and is deliberately kept: no animation, no colour-only meaning,
 * and every step answerable by typing plus Enter.
 */
const CARD_WIDTH = 68;
const CARD_MIN_WIDTH = 32;
/**
 * Rows the frame spends before any content: the border (2), vertical padding
 * (2), the header bar's rule, the button row, the hint line under the card, and
 * the overlay's own top margin. The header's own text is counted separately
 * because it wraps at a different width from the body.
 *
 * One constant rather than a sum spelled out at each call site, because the
 * three budgets then agree by construction instead of by hand — which is the
 * argument `OVERLAY_FOOTER_ROWS` already makes for the footer it replaces.
 */
const CARD_CHROME_ROWS = 8;
/** Border (2) + horizontal padding (2 each side). Charged to the input's width. */
const CARD_CHROME_COLUMNS = 6;
/** Columns the progress rail and its gutter take out of the card. */
const RAIL_WIDTH = 24;
/** The divider between rail and body: its border (1) plus the body's inset (2). */
const BODY_DIVIDER_COLUMNS = 3;
/**
 * Below this the rail is dropped and the card narrows back.
 *
 * A rail that squeezes the question into 30 columns costs more than the
 * orientation it buys, and the content is what the reader is here for. The
 * alternative — always reserving it — makes the wizard unusable in a split
 * pane, which is where a terminal spends much of its life.
 */
const RAIL_MIN_COLUMNS = 100;
/** Below this the check control is dropped and `ctrl+t` carries it alone. */
const CHECK_CONTROL_MIN_WIDTH = 48;

function showRail(columns: number, rail: RailEntry[] | undefined): boolean {
  return rail !== undefined && rail.length > 0 && columns >= RAIL_MIN_COLUMNS;
}

/**
 * The dots between a row's label and its right-aligned tail.
 *
 * At least one on each side, so a row too long to lead still reads as two
 * pieces rather than running them together. It takes the tail's WIDTH rather
 * than the tail itself: the detail and the tick are painted in different
 * colours, so they are separate `<Text>` nodes and there is no one string to
 * measure.
 */
function leaders(head: string, tailWidth: number, span: number): string {
  const gap = span - head.length - tailWidth - 2;
  return ` ${'·'.repeat(Math.max(1, gap))} `;
}

/**
 * How wide the splash block is: the widest of its three parts.
 *
 * The block is CENTRED in the card and its parts are aligned to the block's own
 * edges, not the card's — so the small line sits at the banner's left shoulder
 * and the tagline at its right, which is what makes them read as belonging to
 * the lettering rather than to the box below it.
 *
 * The widest part rather than the banner's width, because a tagline longer than
 * the lettering would otherwise be right-aligned into space the block does not
 * own and spill past it.
 *
 * Measured with `stringWidth` rather than `.length` — the rows are box-drawing
 * characters today and a future banner need not be.
 */
function mastheadWidth(m: NonNullable<WizardSpec['masthead']>): number {
  const parts = [...m.banner, m.intro ?? '', m.tagline ?? ''];
  return Math.max(...parts.map((l) => stringWidth(l)));
}

/**
 * The splash above the card, or nothing when it would not fit.
 *
 * Dropped WHOLE rather than wrapped: block lettering cannot reflow, so a banner
 * too wide for the card is worse present than absent — the rule the rail
 * follows, for the same reason.
 */
function mastheadBlock(
  m: NonNullable<WizardSpec['masthead']>,
  cardCols: number,
  // Passed rather than read: this is a plain function called from JSX, not a
  // component, so `useThemeColors()` here would be a hook outside a render —
  // and one sitting after the early return above, which is worse.
  colors: ThemeColors,
): ReactNode {
  const block = mastheadWidth(m);
  if (block > cardCols) return null;
  return (
    // Centred in the card; the parts then align to the BLOCK's edges.
    <Box width={cardCols} justifyContent="center">
      <Box flexDirection="column" width={block}>
        {m.intro !== undefined && <Text color={colors.muted}>{m.intro}</Text>}
        {m.banner.map((line, i) => (
          // Keyed by index: these are rows of one picture, not items.
          <Text key={i} color={colors.accent}>
            {line}
          </Text>
        ))}
        {m.tagline !== undefined && (
          <Box justifyContent="flex-end">
            <Text color={colors.muted}>{m.tagline}</Text>
          </Box>
        )}
        <Text> </Text>
      </Box>
    </Box>
  );
}

function cardWidth(columns: number, withRail = false): number {
  const max = withRail ? CARD_WIDTH + RAIL_WIDTH : CARD_WIDTH;
  return Math.max(CARD_MIN_WIDTH, Math.min(max, columns - 4));
}

/** The width the CONTENT column gets, which is what every body row budget is against. */
function contentWidth(columns: number, rail: RailEntry[] | undefined): number {
  const withRail = showRail(columns, rail);
  return (
    cardWidth(columns, withRail) -
    CARD_CHROME_COLUMNS -
    // The rail AND the rule between it and the body, which is a real border
    // with a real inset. Omitting it made this three columns optimistic, so
    // text pre-wrapped to it was wrapped a second time by Ink and came out
    // ragged — visible immediately on the welcome page, which is all prose.
    (withRail ? RAIL_WIDTH + BODY_DIVIDER_COLUMNS : 0)
  );
}

/**
 * Where the walk is, as a list of sections down the left.
 *
 * Marked with a glyph AND a colour, never colour alone: a done section reads as
 * done in a monochrome terminal and to anyone who cannot separate the two
 * greens. `✓` / `▸` / `·` in place of a bar, because a bar is a fraction and a
 * fraction is the thing #473 measured as harmful — here the length is fixed and
 * known, which is why a rail is honest where a bar was not.
 */
function ProgressRail({ entries }: { entries: RailEntry[] }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="column" width={RAIL_WIDTH} flexShrink={0}>
      {entries.map((entry) => {
        const glyph = entry.state === 'done' ? '✓' : entry.state === 'current' ? '▸' : '·';
        const color =
          entry.state === 'current'
            ? colors.accent
            : entry.state === 'done'
              ? colors.success
              : colors.muted;
        return (
          <Text key={entry.label} color={color} bold={entry.state === 'current'}>
            {`${glyph} ${truncate(entry.label, RAIL_WIDTH - 4)}`}
          </Text>
        );
      })}
    </Box>
  );
}

function WizardCard({
  section,
  title,
  fill,
  masthead,
  rail,
  next,
  check,
  canGoBack,
  focus,
  position,
  hints,
  children,
}: {
  /** The group label. Rendered only when there is no rail to carry it. */
  section?: string;
  /** The splash above the card. See {@link WizardSpec.masthead}. */
  masthead?: WizardSpec['masthead'];
  title: string;
  /** Sections down the left. Dropped below {@link RAIL_MIN_COLUMNS}. */
  rail?: RailEntry[];
  /**
   * Centre vertically in the terminal as well as horizontally.
   *
   * Opt-in because it is only correct where the wizard OWNS the frame — the
   * standalone setup host, and the REPL in full-screen where an overlay
   * replaces the transcript. In legacy inline mode the overlay is appended
   * below a live transcript and prompt, and a full-height box there would shove
   * both off the screen to centre a card in space it does not own.
   */
  fill?: boolean;
  /** What Enter does, in the reader's words. */
  next: string;
  /** An optional middle control's label — absent draws nothing. */
  check?: string;
  canGoBack: boolean;
  /**
   * Which footer control the cursor is on.
   *
   * Arrowing past the last option moves onto the controls themselves rather
   * than into a list row that duplicates them — a "Continue" row and a Continue
   * button are two places to do one thing, and the reader has to work out
   * whether they differ.
   */
  focus?: 'back' | 'check' | 'next';
  /** `options 3–9 of 40`, or null when everything fits. */
  position?: string | null;
  /** The keys that are always available, for the line under the card. */
  hints: KeyHint[];
  children: ReactNode;
}) {
  const colors = useThemeColors();
  const { columns, rows } = useDimensionsCtx();
  const withRail = showRail(columns, rail);
  const width = cardWidth(columns, withRail);
  return (
    <Box
      flexDirection="column"
      justifyContent={fill === true ? 'center' : 'flex-start'}
      height={fill === true ? rows : undefined}
    >
      <Box flexDirection="column" alignItems="center">
        {/* Above the box and outside it, at the card's own width so the banner
            starts at its left border and the tagline ends at its right. Dropped
            whole when the banner would not fit — the same rule the rail
            follows, and for the same reason: block lettering that wraps is
            worse than block lettering that is absent. */}
        {masthead !== undefined &&
          masthead.banner.length > 0 &&
          mastheadBlock(masthead, width, colors)}
        <Box
          flexDirection="column"
          width={width}
          borderStyle="round"
          borderColor={colors.muted}
          paddingX={2}
          paddingY={1}
        >
          <Box flexDirection="row">
            {withRail && rail !== undefined && <ProgressRail entries={rail} />}
            <Box
              flexDirection="column"
              flexGrow={1}
              // The divider is the rail's right edge drawn as the body's left
              // one — a real border rather than a column of glyphs, so it spans
              // exactly the rows the body occupies however tall it gets.
              {...(withRail
                ? {
                    borderStyle: 'single' as const,
                    borderColor: colors.muted,
                    borderTop: false,
                    borderBottom: false,
                    borderRight: false,
                    paddingLeft: 2,
                  }
                : {})}
            >
              {/* The header belongs to the BODY, not to the card. Spanning the
                  full width it sat above the rail as well, which put it over a
                  column the reader is not looking at — and reading as a title
                  for the modal rather than for the page inside it. The rule is
                  the box's own bottom border, so it spans the body without
                  anyone computing a width. */}
              <Box
                borderStyle="single"
                borderColor={colors.muted}
                borderTop={false}
                borderLeft={false}
                borderRight={false}
              >
                <Text bold color={colors.accent}>
                  {title}
                </Text>
                <Box flexGrow={1} />
                {/* Redundant beside a rail that already marks the section, and
                    the two disagreeing would be worse than either alone. */}
                {!withRail && section !== undefined && section !== '' && (
                  <Text color={colors.muted}>{`  ${section}`}</Text>
                )}
              </Box>
              {children}
            </Box>
          </Box>

          {/* Where a dialog puts its buttons: primary action bottom-right, the
              way back immediately to its left. */}
          <Box>
            <Box flexGrow={1} />
            {canGoBack && (
              <>
                <Text
                  bold={focus === 'back'}
                  color={focus === 'back' ? colors.accent : colors.muted}
                >
                  {`${focus === 'back' ? '▸ ' : '  '}← Back`}
                </Text>
                <Text>{'   '}</Text>
              </>
            )}
            {check !== undefined && (
              <>
                {/* Between Back and the forward button, because that is the
                    order they are reached in and the order they read in: leave,
                    check, commit. Padded exactly like its neighbours — each
                    control keeps its width focused and unfocused, or the whole
                    row shifts sideways as focus moves. */}
                <Text
                  bold={focus === 'check'}
                  color={focus === 'check' ? colors.accent : colors.muted}
                >
                  {`${focus === 'check' ? '▸ ' : '  '}${check}${focus === 'check' ? '  ↵' : '   '}`}
                </Text>
                <Text>{'   '}</Text>
              </>
            )}
            {/* Accent means FOCUSED, on both controls and nowhere else. Painted
                as the primary colour whenever the cursor was merely not on Back,
                Continue read as highlighted from the moment the page opened — so
                the one thing the accent is for, saying where Enter will land,
                said nothing. The `↵` goes with it: on an option row Enter
                selects, and a return glyph sitting on Continue promises
                otherwise. */}
            <Text bold={focus === 'next'} color={focus === 'next' ? colors.accent : colors.muted}>
              {`${focus === 'next' ? '▸ ' : '  '}${next}${focus === 'next' ? '  ↵' : '   '}`}
            </Text>
          </Box>
        </Box>

        {/* Under the card, not in it: these keys are true on every screen, so
            inside the frame they read as being about this question. */}
        <Box width={width} paddingX={2}>
          <HintRow hints={hints} />
          <Box flexGrow={1} />
          <Text color={colors.muted}>{position ?? ' '}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * A page that asks nothing: body text, then Enter.
 *
 * It claims Enter and the dismiss key and nothing else — there is no buffer to
 * edit and no list to move through, so binding anything more would be inventing
 * keys for a page whose whole contract is "read this, then continue".
 */
function WizardInfoStep({
  step,
  rail,
  canGoBack,
  fill,
  masthead,
  onSubmit,
  onBack,
  onCancel,
}: {
  step: WizardStep;
  rail?: RailEntry[];
  canGoBack: boolean;
  fill?: boolean;
  masthead?: WizardSpec['masthead'];
  onSubmit: (answer: string) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const colors = useThemeColors();
  const { columns } = useDimensionsCtx();
  // Wrapped here rather than left to Ink, which wraps with `trim: false` and so
  // keeps the break space at the START of every continuation line — a ragged
  // left edge on the one screen that is nothing but prose. `wrapText` breaks on
  // words and trims, which is what it was written for.
  const body = (step.field.kind === 'info' ? step.field.body : []).flatMap((para) =>
    para === '' ? [''] : wrapText(para, contentWidth(columns, rail)),
  );

  // Focus starts on Continue and never leaves the controls: this step has no
  // body to move between, so there is nothing above them for ↑/↓ to reach — and
  // the hints below say ←/→ rather than ↑/↓ for exactly that reason. The
  // controls are reachable on every step; which keys reach them depends on what
  // else is on the page.
  const [focus, setFocus] = useState<'next' | 'back'>('next');

  useInput((input, key) => {
    if (isDismissKey(input, key)) return onCancel();
    if (canGoBack && isBackKey(input, key)) return onBack();
    if (isNextKey(input, key)) return onSubmit('');
    if (key.leftArrow === true && canGoBack) return setFocus('back');
    if (key.rightArrow === true) return setFocus('next');
    if (key.return) return focus === 'back' ? onBack() : onSubmit('');
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <WizardCard
        section={step.section}
        title={step.question}
        rail={rail}
        fill={fill}
        masthead={masthead}
        next={nextLabelFor(step, '', 'Continue')}
        canGoBack={canGoBack}
        focus={focus}
        hints={[
          ...(canGoBack ? [{ key: '←/→', label: 'switch' }] : []),
          ...(focus === 'back' ? [] : [{ key: KEY.enter, label: 'continue' }]),
          ...(canGoBack ? [BACK_HINT] : []),
          NEXT_HINT,
          HINT_CANCEL,
        ]}
      >
        {body.map((line, i) => (
          // Keyed by index because these are prose lines with no identity, and
          // a blank line is a legitimate — and repeatable — entry.
          <Text key={i} color={line === '' ? colors.muted : colors.text}>
            {line === '' ? ' ' : line}
          </Text>
        ))}
      </WizardCard>
    </Box>
  );
}

/** The question, plus its standing hint. Never a placeholder — see `wizard-types.ts`. */
/**
 * The prose above a step's answer: what the setting is for, then the standing
 * note about how the walk works.
 *
 * **Pre-wrapped, for the reason the info step already is.** Ink wraps with
 * `trim: false`, so it keeps the break space at the START of every continuation
 * line — and only where the break happens to land after one, which gives a left
 * edge that is ragged on some lines and not others. That was survivable while a
 * hint was one line; it stopped being so when the descriptions grew to say what
 * each setting is FOR rather than only what it does.
 */
function StepHeader({
  step,
  intro,
  rail,
}: {
  step: WizardStep;
  intro?: string;
  rail?: RailEntry[];
}) {
  const colors = useThemeColors();
  const { columns } = useDimensionsCtx();
  const width = contentWidth(columns, rail);
  const lines = (text: string): string[] => wrapText(text, width);
  return (
    <>
      {step.hint !== undefined &&
        lines(step.hint).map((line, i) => (
          // Keyed by index: these are prose lines with no identity of their own.
          <Text key={`h${i}`} color={colors.muted}>
            {line === '' ? ' ' : line}
          </Text>
        ))}
      {intro !== undefined && (
        <>
          <Text> </Text>
          {lines(intro).map((line, i) => (
            <Text key={`i${i}`} color={colors.muted}>
              {line === '' ? ' ' : line}
            </Text>
          ))}
        </>
      )}
      <Text> </Text>
    </>
  );
}

function WizardTextStep({
  step,
  intro,
  rail,
  initial,
  canGoBack,
  fill,
  masthead,
  onSubmit,
  onBack,
  onCancel,
}: {
  step: WizardStep;
  intro?: string;
  rail?: RailEntry[];
  initial: string;
  canGoBack: boolean;
  fill?: boolean;
  masthead?: WizardSpec['masthead'];
  onSubmit: (answer: string) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const colors = useThemeColors();
  const { columns } = useDimensionsCtx();
  const editor = useLineEditor(initial);
  // Ink drops the Home/End key NAMES, so they reach the editor only through the
  // raw-stdin decoder (#399). Without this they are dead here while working in
  // every other text surface — exactly the drift a copied component produces.
  useRawKeys((key) => {
    if (key === 'home') editor.toLineStart();
    else editor.toLineEnd();
  }, true);

  const [error, setError] = useState<string | undefined>(undefined);
  // Where Enter will land. A text step used to have no notion of this at all:
  // the footer drew controls the arrow keys could not reach, so ↓ did nothing
  // on the one surface where a reader has most reason to press it after typing.
  // Same three positions and the same keys as a choice step — the only
  // difference is that the thing above the controls is a buffer, not a list.
  const [focus, setFocus] = useState<Focus>('input');
  const onControl = focus !== 'input';
  // The controls that are actually on this page, left to right, matching the
  // order the card draws them. `←/→` step through THIS rather than jumping to
  // named positions: with a third control the absolute jumps skipped it.
  const controls: Focus[] = [
    ...(canGoBack ? (['back'] as const) : []),
    ...(step.check !== undefined ? (['check'] as const) : []),
    'next',
  ];
  const shift = (by: number): void => {
    const at = controls.indexOf(focus);
    const to = controls[at + by];
    if (to !== undefined) setFocus(to);
  };

  // The verdict of the last check, and whether one is running. Neither ever
  // reaches the wizard's state machine — see `WizardStep.check`.
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<StepCheckResult | undefined>(undefined);
  const inflight = useRef<AbortController | null>(null);

  // Required, not hygiene: a step REMOUNTS on every navigation, so Esc or Back
  // mid-probe would otherwise leave a socket open for the whole timeout — and
  // hang a test runner that waits for the process to go quiet.
  useEffect(() => () => inflight.current?.abort(), []);

  /** Forget a verdict that no longer describes the buffer, and stop earning one. */
  const dropCheck = (): void => {
    inflight.current?.abort();
    inflight.current = null;
    setChecking(false);
    setVerdict(undefined);
  };

  const runCheck = (): void => {
    // A second Enter while one runs is ignored rather than restarting it: the
    // label already reads the busy word, so a no-op is legible, and aborting to
    // start again would just double the requests.
    if (step.check === undefined || inflight.current !== null) return;
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setChecking(true);
    setVerdict(undefined);
    void step.check
      .run(editor.buffer.trim(), ctrl.signal)
      .then((result) => {
        // The signal IS the mounted flag: React 18 makes a post-unmount set a
        // silent no-op, so a second ref would be state to keep in sync for
        // nothing.
        if (ctrl.signal.aborted) return;
        setVerdict(result);
      })
      .finally(() => {
        if (ctrl.signal.aborted) return;
        inflight.current = null;
        setChecking(false);
      });
  };

  const commit = (): void => {
    const trimmed = editor.buffer.trim();
    // Validation BEFORE the empty rule, so a hook can own the empty case and
    // say something. Reversed, a required numeric field would hold silently
    // on a cleared buffer and read as a broken Enter key.
    const message = stepError(step, trimmed);
    if (message !== undefined) {
      setError(message);
      // Back to the buffer: the reader has to change it before anything else
      // can happen, and leaving focus on a control that just refused is how a
      // step reads as stuck.
      setFocus('input');
      return;
    }
    // An empty answer HOLDS rather than cancelling. Cancelling on empty is
    // right for a one-shot prompt and wrong mid-wizard, where it would throw
    // away every answer already given on a stray Enter.
    if (trimmed.length === 0 && step.optional !== true) return;
    onSubmit(trimmed);
  };

  useInput((input, key) => {
    // Dismissal first, before the editor claims its chords. `isDismissKey`, not
    // the `q` variant: this surface has a buffer, so `q` must stay typeable.
    if (isDismissKey(input, key)) return onCancel();
    if (canGoBack && isBackKey(input, key)) return onBack();
    if (isNextKey(input, key)) return commit();
    // From anywhere on the page, including the buffer — the chord acts, which is
    // what chords do here.
    if (step.check !== undefined && isCheckKey(input, key)) return runCheck();
    if (onControl) {
      if (key.upArrow === true) return setFocus('input');
      if (key.downArrow === true) return;
      if (key.leftArrow === true) return shift(-1);
      if (key.rightArrow === true) return shift(1);
      if (key.return === true) {
        if (focus === 'back') return onBack();
        // Explicit, not a fallthrough: a third focus value reaching a
        // `focus === 'back' ? … : commit()` ternary would silently COMMIT.
        if (focus === 'check') return runCheck();
        return commit();
      }
      // Anything else is typing, so the buffer takes it back. Swallowing it
      // would reproduce the complaint one key over — a keystroke that does
      // nothing, with nothing on screen explaining why.
      setFocus('input');
    } else if (key.downArrow === true) {
      // Onto the PRIMARY action, not the leftmost control. Back is reached
      // sideways from Continue (`←`), which is the rule the choice step already
      // follows — and with a third control between them, landing on the left
      // would put the cursor two presses from the thing ↓ is pressed to reach.
      return setFocus('next');
    }
    if (key.return) return commit();
    // Typing clears a standing rejection: the message described the buffer that
    // was refused, and it no longer describes this one. A verdict goes for the
    // same reason and it matters more — a green "Key is valid" beside a key that
    // is no longer the one tested is the worst thing this page could say.
    if (error !== undefined) setError(undefined);
    if (verdict !== undefined || checking) dropCheck();
    editor.handleKey(input, key);
  });

  // Dropped whole on a narrow card — the rule the rail and the masthead follow.
  // A control row cannot reflow any more than block lettering can; `ctrl+t` still
  // works, which is why its hint is not conditional on this.
  const roomForCheck = cardWidth(columns, showRail(columns, rail)) >= CHECK_CONTROL_MIN_WIDTH;
  const checkLabel =
    step.check === undefined || !roomForCheck
      ? undefined
      : checking
        ? step.check.busyLabel
        : step.check.label;
  // Three claimants on one reserved row. A validation error OUTRANKS a verdict,
  // because it blocks and a verdict does not — and a verdict arriving while an
  // error stands is dropped rather than queued.
  const rowTone: 'bad' | 'ok' | 'none' | 'unknown' =
    error !== undefined ? 'bad' : (verdict?.tone ?? 'none');
  const rowMessage = error ?? verdict?.message ?? '';

  return (
    <Box flexDirection="column" marginTop={1}>
      <WizardCard
        section={step.section}
        title={step.question}
        rail={rail}
        fill={fill}
        masthead={masthead}
        next={nextLabelFor(
          step,
          editor.buffer.trim(),
          step.optional === true ? 'Skip this' : 'Continue',
        )}
        canGoBack={canGoBack}
        focus={focus === 'input' ? undefined : focus}
        check={checkLabel}
        // Collapsed, and that is what buys the third control its place. Measured
        // at 80 columns this row was 74 with focus on the buffer and 89 on a
        // control, against a 64-column budget — it was ALREADY wrapping, before
        // anything was added. `←/→/↑/↓ move` replaces two entries, and `ctrl+b` /
        // `ctrl+n` go because they now duplicate controls that are visible in the
        // footer and reachable with those arrows. `ctrl+t` stays: it is the only
        // one of the three with no visible twin at narrow widths, where the check
        // control is dropped.
        hints={[
          { key: KEY.arrowsAll, label: 'move' },
          // Enter acts wherever the cursor is, and the focused control draws its
          // own `↵`, so this says the one thing the footer cannot.
          { key: KEY.enter, label: onControl ? 'choose' : 'continue' },
          ...(canGoBack ? [BACK_HINT] : []),
          NEXT_HINT,
          // Named only where the CONTROL is not drawn. Everywhere else the
          // button is visible, arrow-reachable and carries its own `↵`, so the
          // chord would be a second spelling of something already on screen —
          // on the one row that was already at its budget before this feature.
          // Narrow, the control is dropped and the chord is the only way in.
          ...(step.check !== undefined && checkLabel === undefined
            ? [{ key: ctrlKey('t'), label: 'test' }]
            : []),
          HINT_CANCEL,
        ]}
      >
        <StepHeader step={step} intro={intro} rail={rail} />
        {/* `minHeight`, because an EMPTY buffer with the caret hidden renders an
            empty `<Text>`, which Yoga measures at zero rows — so the card lost a
            row the moment focus moved onto a control, and gained it back on the
            way up. Layout height must not depend on where the cursor is. */}
        <Box flexDirection="column" minHeight={1}>
          <BoundedLine
            buffer={editor.buffer}
            cursor={editor.cursor}
            // The caret means "typing lands here". With focus on a control it
            // would say that while Enter went somewhere else — the same claim the
            // accent makes on the controls, made twice and contradicting itself.
            showCursor={!onControl}
            cursorColor={colors.accent}
            cursorGlyph="▎"
            reserveColumns={OVERLAY_RESERVED_COLUMNS + CARD_CHROME_COLUMNS}
          />
        </Box>
        {/* Reserved unconditionally — `OverlayFooter`'s rule. A row that appears
            only on rejection makes the step's height depend on the answer, and
            the frame reflows under the reader mid-correction. */}
        <Text
          color={
            rowTone === 'bad' ? colors.error : rowTone === 'ok' ? colors.success : colors.muted
          }
        >
          {truncate(rowMessage, contentWidth(columns, rail)) || ' '}
        </Text>
      </WizardCard>
    </Box>
  );
}

function WizardChoiceStep({
  step,
  intro,
  rail,
  current,
  canGoBack,
  fill,
  masthead,
  onSubmit,
  onOther,
  onBack,
  onCancel,
  reserveRows,
  onHighlight,
}: {
  step: WizardStep;
  intro?: string;
  rail?: RailEntry[];
  /** The answer this step currently holds — `initial` until the user changes it. */
  current: WizardAnswer | undefined;
  canGoBack: boolean;
  fill?: boolean;
  masthead?: WizardSpec['masthead'];
  onSubmit: (answer: WizardAnswer) => void;
  onOther: () => void;
  onBack: () => void;
  onCancel: () => void;
  reserveRows: number;
  /**
   * Reports the VALUE under the cursor, for a step that previews it (#447).
   *
   * Supplied only by a step declaring `preview`, so this is `undefined` for
   * every other question and nothing below changes for them.
   */
  onHighlight?: (value: string | null) => void;
}) {
  const colors = useThemeColors();
  const { columns, rows } = useDimensionsCtx();
  const field = step.field as {
    kind: 'choice' | 'multi';
    choices: string[];
    values?: readonly string[];
    allowOther?: boolean;
    otherLabel?: string;
  };
  const multi = field.kind === 'multi';
  // One rule, shared with `App.tsx`'s single-question path — see `choiceRows`.
  const { labels, isHatch } = choiceRows(field);
  // Rows after the options: the step's own actions, then Back. Both are
  // reachable with the arrow keys rather than only as a key legend — a control
  // you cannot move onto is one a reader has to be told about in words.
  const actions = actionRows(step);
  const BACK_ROW = '← Back';
  // Select-then-continue unless the step says picking IS the act. A page always
  // has something to move on with; only a page whose rows resolve it does not.
  const pickAdvances = (step.field as { pickAdvances?: boolean }).pickAdvances === true;
  const tail = [
    ...(actions.length > 0 ? actions : pickAdvances ? [] : [CONTINUE_LABEL]),
    ...(canGoBack ? [BACK_ROW] : []),
  ];
  const allRows = [...labels, ...tail];
  const isOption = (index: number): boolean => index < labels.length;

  // Open on the answer this step already carries, so a prepopulated settings
  // step reads "here is your current value" rather than "pick one, and good
  // luck finding which is live". The LIVE answer, not `step.initial`: coming
  // back to a step the user already changed must show what they chose.
  // `indexOf` on the label because that is what a choice answer is — the caller
  // owns any label-to-value mapping.
  const initialIndex = typeof current === 'string' ? labels.indexOf(current) : -1;

  const [checked, setChecked] = useState<Set<number>>(new Set());
  // The row marked `✓` — the answer this step will hand back. Seeded from the
  // answer it opened on, so accepting a prepopulated page is one keystroke on
  // Continue rather than a re-pick.
  //
  // `-1` when the answer it opened on is not among the rows, which is NOT the
  // same as "nothing chosen yet" and must not fall to row one. A value in force
  // that the list does not offer is reachable — the model catalog is
  // known-incomplete in both directions — and seeding row one there ticked it,
  // so the page said "this is your current value" about a value nobody held, and
  // Continue then wrote it. An invented answer is worse than a page that cannot
  // move on: a page that holds says so, and the caller's change test
  // (`answer === step.initial`) cannot tell an invented answer from a real one.
  const [chosen, setChosen] = useState(initialIndex);

  const submitChosen = (): void => {
    if (multi) {
      const picked = [...checked].sort((a, b) => a - b);
      return onSubmit(picked.map((i) => labels[i]));
    }
    const label = labels[chosen];
    if (label === undefined || unavailableReason(step, label) !== undefined) return;
    onSubmit(label);
  };

  /**
   * Whatever the footer's forward button does — which is not always "hand back
   * the selection".
   *
   * A step with its own ACTION rows draws the first of them as that button, and
   * the provider hub is one: its button reads "Continue to the next step" and
   * resolves with that label. `ctrl+n` bound straight to `submitChosen` did
   * nothing there, because a `pickAdvances` page carries no selection to submit
   * — the chord was advertised in the key line and silently inert on the one
   * screen a fresh install starts on.
   *
   * `undefined` when the page has no forward button at all (an `ask_user` menu,
   * where picking IS the act), and the hint is gated on the same value so it is
   * never advertised where it cannot work.
   */
  const nextRow = tail.find((r) => r !== BACK_ROW);
  const continueNow = (): void => {
    if (nextRow === undefined) return;
    // The same branch `commit` takes for a tail row, so the chord and the button
    // cannot mean different things.
    return nextRow === CONTINUE_LABEL ? submitChosen() : onSubmit(nextRow);
  };

  const commit = (index: number): void => {
    if (!isOption(index)) {
      const row = allRows[index];
      if (row === BACK_ROW) return onBack();
      // Back is navigation; the default Continue hands back what is selected,
      // and a step's own action resolves with its own label.
      return row === CONTINUE_LABEL ? submitChosen() : onSubmit(row);
    }
    if (isHatch(index)) return onOther();
    // A row that cannot be picked holds instead of selecting. The reason is
    // already on screen for the highlighted row, so refusing silently would be
    // the only thing that looked broken.
    if (unavailableReason(step, labels[index]) !== undefined) return;
    if (multi) {
      // Enter confirms the set where picking advances; otherwise it is one more
      // way to toggle, and the Continue control is what confirms.
      if (!pickAdvances) return toggle(index);
      const picked = [...checked].sort((a, b) => a - b);
      return onSubmit(picked.length > 0 ? picked.map((i) => labels[i]) : [labels[index]]);
    }
    if (!pickAdvances) return setChosen(index);
    onSubmit(labels[index]);
  };
  const toggle = (index: number): void => {
    if (!isOption(index)) return commit(index);
    if (isHatch(index)) return onOther();
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const cursor = useListCursor({
    total: allRows.length,
    // -1 would clamp to 0 anyway; stated so the "no match" case is a decision
    // rather than an accident of clamping.
    initialIndex: initialIndex >= 0 ? initialIndex : 0,
    onCommit: commit,
    ...(multi ? { onDigit: toggle, onToggle: toggle, toggleOnSpace: true } : {}),
  });

  // Where the two controls sit in the cursor order. Back is LAST, and reached
  // sideways from Continue rather than below it: they are one row on screen, so
  // ↓ walking through them would be the cursor moving down where nothing is.
  const continueAt = labels.length;
  const backAt = continueAt + 1;
  const inControls = cursor.index >= continueAt;

  useInput((input, key) => {
    if (isDismissKey(input, key)) return onCancel();
    if (canGoBack && isBackKey(input, key)) return onBack();
    if (isNextKey(input, key)) return continueNow();
    if (inControls) {
      // ↑ returns to the list, and to its END — the row the cursor left, not the
      // top, which is where it would land if this were a plain wrap.
      if (key.upArrow === true && labels.length > 0) return cursor.setIndex(labels.length - 1);
      if (key.downArrow === true) return;
      if (key.leftArrow === true && canGoBack) return cursor.setIndex(backAt);
      if (key.rightArrow === true) return cursor.setIndex(continueAt);
    } else if (key.rightArrow === true) {
      // From an option ROW, where the arrows have nothing else to mean. A text
      // step spends them on its buffer, which is why `ctrl+b`/`ctrl+n` exist and
      // are the shortcuts advertised — these are the cheap half that happens to
      // be free here, not the rule.
      return cursor.setIndex(continueAt);
    } else if (key.leftArrow === true && canGoBack) {
      // The other direction, because a reader who has just learned that → goes
      // forward reaches for ← without being told. Both land ON the control
      // rather than acting, which is what the controls being focusable is for —
      // the chords are the ones that act.
      return cursor.setIndex(backAt);
    }
    cursor.handleKey(input, key);
  });

  // Everything the card spends before the option rows: its border and padding,
  // the section label, the title, the wrapped hint and intro, the blank spacer,
  // the Next row (blank + line), a blank, and the footer.
  const usable = contentWidth(columns, rail);
  // What one row has to play with: the body, less `MenuRow`'s marker gutter.
  const rowSpan = usable - 2;
  // Frame, the title in the header bar (which is wider than the body), the
  // wrapped hint and intro, the blank before the intro, and `StepHeader`'s own
  // trailing blank. The section no longer costs a row of its own — it rides on
  // the header bar beside the title.
  const chrome =
    CARD_CHROME_ROWS +
    chromeRows([step.question], usable) +
    chromeRows([step.hint, intro], usable) +
    (intro === undefined ? 0 : 1) +
    1 +
    // The reason row under the options, reserved whether or not a row is
    // currently blocked.
    1 +
    reserveRows;
  const size = overlayViewport(rows, chrome);
  // The window is over the OPTIONS only — the tail lives in the footer, so the
  // list neither grows rows for it nor counts it in the position. A cursor
  // parked on a control is out of range here, and `clampOffset` already pins the
  // offset to the last full page for it, which is where the list was anyway.
  const { offset } = useListWindow(cursor.index, size, labels.length);
  const visible = labels.slice(offset, offset + size);
  const position = formatPosition(listPosition(offset, size, labels.length), 'options');

  // "Keep" when Enter would commit the value the step opened on, "Choose" when
  // it would commit a different one. On a prepopulated walk most screens are the
  // former, and a bare "choose" reads as though nothing is selected yet.
  const highlighted = isOption(cursor.index) ? labels[cursor.index] : undefined;
  // The value, never the label — see `WizardChoiceField.values`. `undefined`
  // while the cursor sits on a control, and that case deliberately reports
  // NOTHING rather than `null`: moving onto Continue would otherwise drop the
  // preview back to the active theme mid-question.
  const highlightedValue = isOption(cursor.index) ? (field.values?.[cursor.index] ?? null) : null;
  useEffect(() => {
    if (onHighlight === undefined || highlightedValue === null) return;
    onHighlight(highlightedValue);
  }, [onHighlight, highlightedValue]);
  const blocked = unavailableReason(step, highlighted);
  const onBackControl = cursor.index === backAt && canGoBack;
  const onOption = isOption(cursor.index);
  // Said on the reserved row rather than left to a Continue that simply does
  // nothing — `submitChosen` already refuses an out-of-range selection, and a
  // button that swallows Enter in silence is the only thing on the page that
  // looks broken.
  const nothingSelected =
    !multi && chosen < 0 && allRows[cursor.index] === CONTINUE_LABEL
      ? 'Nothing is selected yet — your current value is not one of these rows.'
      : undefined;
  // The control at the foot is the one that moves on, and it says so in its own
  // words — a step's action where it has one, otherwise the plain Continue. It
  // is NOT relabelled from whatever the cursor is touching: on a
  // select-then-continue page Enter over an option selects, which is not what
  // this button does, and a button that renames itself to a neighbour's action
  // is how a reader ends up pressing the wrong thing.
  const nextLabel = nextLabelFor(
    step,
    labels[chosen] ?? '',
    tail.find((r) => r !== BACK_ROW) ?? CONTINUE_LABEL,
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <WizardCard
        section={step.section}
        title={step.question}
        rail={rail}
        fill={fill}
        masthead={masthead}
        next={nextLabel}
        canGoBack={canGoBack}
        focus={onBackControl ? 'back' : onOption ? undefined : 'next'}
        position={position}
        hints={[
          HINT_MOVE,
          // What Enter does where the cursor actually is. The controls say what
          // THEY do; this says what the row under the cursor does, which on a
          // select-then-continue page is not the same thing.
          ...(onOption
            ? [
                {
                  key: KEY.enter,
                  label: blocked !== undefined ? 'unavailable' : multi ? 'toggle' : 'select',
                },
              ]
            : []),
          ...(multi ? [{ key: KEY.space, label: 'toggle' }] : []),
          // Only while there are two controls to move between — an arrow hint on
          // a page with one button describes a key that does nothing.
          ...(inControls && canGoBack ? [{ key: '←/→', label: 'switch' }] : []),
          ...(canGoBack ? [BACK_HINT] : []),
          // Never advertised on a page with no forward button: an `ask_user`
          // menu resolves on the pick itself, so there is nothing to continue to.
          ...(nextRow !== undefined ? [NEXT_HINT] : []),
          HINT_CANCEL,
        ]}
      >
        <StepHeader step={step} intro={intro} rail={rail} />
        {visible.map((label, i) => {
          const index = offset + i;
          const why = unavailableReason(step, label);
          const text = `${index + 1}. ${multi ? (checked.has(index) ? '[x] ' : '[ ] ') : ''}${label}`;
          // One tick, one place, one colour: hard right of the row, in the
          // theme's success green, wherever it appears. It marks a fact ABOUT
          // the row — chosen here, a key already stored on the provider hub —
          // where `>` marks where the cursor is; sitting inside the label, in
          // whatever colour the highlight happened to give it, the two read as
          // one. No tick where there is no selection to mark: on a
          // `pickAdvances` page Enter acts on the row rather than choosing it,
          // so a tick on row one would claim an answer nobody has given.
          const trailing = rowTrailing(step, label);
          const detailText = trailing?.text ?? '';
          const tick = trailing?.tick === true || (!multi && !pickAdvances && index === chosen);
          // `leaders` already ends in a space, so a tick with no detail beside it
          // needs none of its own — and the width it is measured at has to match
          // what is drawn, or the column it lands in drifts by one between a row
          // that carries a detail and one that does not.
          const tickText = detailText === '' ? '✓' : ' ✓';
          return (
            <MenuRow
              key={`${index}-${label}`}
              selected={index === cursor.index}
              // Muted even while highlighted: the row is unpickable wherever the
              // cursor happens to be, and letting the highlight style win would
              // say the opposite at exactly the moment the reader is looking.
              label={
                detailText === '' && !tick ? (
                  why === undefined ? (
                    text
                  ) : (
                    <Text color={colors.muted} bold={false}>
                      {text}
                    </Text>
                  )
                ) : (
                  <>
                    {/* Muted even while highlighted when the row cannot be
                        picked — and it keeps its detail, which is usually the
                        very thing that explains WHY it cannot. */}
                    <Text color={why === undefined ? undefined : colors.muted} bold={false}>
                      {text}
                    </Text>
                    <Text color={colors.muted}>
                      {leaders(text, detailText.length + (tick ? tickText.length : 0), rowSpan)}
                    </Text>
                    <Text color={colors.muted}>{detailText}</Text>
                    {tick && <Text color={colors.success}>{tickText}</Text>}
                  </>
                )
              }
            />
          );
        })}
        {/* Reserved unconditionally — `OverlayFooter`'s rule. A row that appears
            only on a blocked highlight makes the step's height depend on where
            the cursor is, and the frame jumps as it moves. */}
        {/* One reserved row, three things that can claim it, in order of
            urgency: why this row cannot be picked, what picking it costs, and
            why Continue is refusing. They cannot collide — a note belongs to a
            highlighted OPTION and `nothingSelected` only fires on a control. */}
        {/* Truncated, or the row it reserves is not one row: a note wider than
            the card wraps and the card grows under the cursor — which is the
            reflow the reservation above exists to prevent, arriving through the
            content instead of through the condition. The text step already
            bounds its own reserved row this way. */}
        <Text color={colors.muted}>
          {truncate(
            blocked ?? rowNote(step, highlighted) ?? nothingSelected ?? '',
            contentWidth(columns, rail),
          ) || ' '}
        </Text>
      </WizardCard>
    </Box>
  );
}

/**
 * Check your answers, before anything is acted on.
 *
 * The GOV.UK closing pattern, and the first variable-height surface in this
 * layer — every other overlay is a fixed dialog or a uniform list. Each row is
 * bounded to one terminal row by `summarizeAnswer`, so the window arithmetic
 * `clampOffset` already does still applies.
 */
function WizardReview({
  spec,
  answers,
  reserveRows,
  rail,
  fill,
  masthead,
  onBack,
  onEdit,
  onCommit,
  onCancel,
}: {
  spec: WizardSpec;
  answers: WizardAnswer[];
  reserveRows: number;
  rail?: RailEntry[];
  fill?: boolean;
  masthead?: WizardSpec['masthead'];
  /**
   * Re-open the last question.
   *
   * `goBack` has handled the review since it was written — and is tested — but
   * no renderer ever called it, so the one transition a reader most expects
   * from a summary screen was unreachable. Wired when the Back control became
   * part of the frame rather than a per-step hint.
   */
  onBack: () => void;
  onEdit: (index: number) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const colors = useThemeColors();
  const { columns, rows } = useDimensionsCtx();
  const title = spec.title ?? 'Here is what I heard';
  // One row per ANSWERABLE step, then the Continue control. Info pages carry no
  // answer, so a row for one would read "Welcome — (not answered)" and invite
  // the reader to go and fix something that is not broken. Real step indices
  // are kept so `onEdit` still addresses the right question.
  //
  // Committing is the CONTROL, not a last list row reading "Looks right — go
  // ahead": every other page in the wizard moves on with Continue, and a review
  // that needed a different gesture was the one screen where the reader had to
  // learn a second one.
  const rows_ = spec.steps
    .map((step, index) => ({ step, index }))
    .filter((r) => !isInfoStep(r.step));
  const commitIndex = rows_.length;
  const backIndex = commitIndex + 1;
  const total = backIndex + 1;
  const cursor = useListCursor({
    total,
    onCommit: (row) => {
      if (row === commitIndex) return onCommit();
      if (row === backIndex) return onBack();
      onEdit(rows_[row].index);
    },
  });

  const inControls = cursor.index >= commitIndex;
  useInput((input, key) => {
    if (isDismissKey(input, key)) return onCancel();
    if (isBackKey(input, key)) return onBack();
    if (isNextKey(input, key)) return onCommit();
    if (inControls) {
      if (key.upArrow === true && rows_.length > 0) return cursor.setIndex(rows_.length - 1);
      if (key.downArrow === true) return;
      if (key.leftArrow === true) return cursor.setIndex(backIndex);
      if (key.rightArrow === true) return cursor.setIndex(commitIndex);
    }
    cursor.handleKey(input, key);
  });

  const usable = contentWidth(columns, rail);
  // Frame, the title in the header bar, the blank under it, and whatever the
  // host reserves outside the overlay. The rail is a sibling COLUMN, so it costs
  // width and never rows — `railFor` keeps it to one row per section, which is
  // what stops it outgrowing the content it sits beside.
  const chrome = CARD_CHROME_ROWS + chromeRows([title], usable) + 1 + reserveRows;
  const size = overlayViewport(rows, chrome);
  const { offset } = useListWindow(cursor.index, size, rows_.length);
  const position = formatPosition(listPosition(offset, size, rows_.length), 'answers');

  // Bounded to ONE terminal row — the invariant the window arithmetic rests on,
  // and until the card narrowed the frame it was only half true: `summarizeAnswer`
  // caps the ANSWER at 60 characters and nothing capped the QUESTION, so a long
  // label plus a short answer wrapped to two rows and the window overflowed the
  // budget it had been given. `MenuRow` spends two columns on its marker gutter.
  const rowWidth = Math.max(8, usable - 2);
  const rowFor = (row: number): string => {
    const { step, index } = rows_[row];
    const answer = answers[index];
    const blank = Array.isArray(answer) ? answer.length === 0 : (answer ?? '').trim() === '';
    const shown =
      blank && step.emptySummary !== undefined ? step.emptySummary : summarizeAnswer(answer);
    return truncate(`${step.summary ?? step.question} — ${shown}`, rowWidth);
  };
  const missing = rows_.filter((r) => !isAnswered(r.step, answers[r.index])).length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <WizardCard
        section="Review"
        title={title}
        rail={rail}
        fill={fill}
        masthead={masthead}
        next="Save and finish"
        canGoBack
        focus={cursor.index === backIndex ? 'back' : inControls ? 'next' : undefined}
        position={position}
        hints={[
          HINT_MOVE,
          ...(cursor.index < commitIndex ? [{ key: KEY.enter, label: 'change' }] : []),
          ...(inControls ? [{ key: '←/→', label: 'switch' }] : []),
          BACK_HINT,
          NEXT_HINT,
          HINT_CANCEL,
        ]}
      >
        <Text> </Text>
        {Array.from({ length: Math.min(size, rows_.length - offset) }, (_, i) => offset + i).map(
          (index) => (
            <MenuRow key={index} selected={index === cursor.index} label={rowFor(index)} />
          ),
        )}
        {missing > 0 && (
          <Text color={colors.muted}>{missing} still unanswered — pick one to fill it in.</Text>
        )}
      </WizardCard>
    </Box>
  );
}
