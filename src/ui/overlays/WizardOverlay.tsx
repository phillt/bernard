import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemeColors } from '../../theme.js';
import { HintRow, KEY, HINT_CANCEL, HINT_MOVE } from '../hints.js';
import { isDismissKey } from './overlay-contract.js';
import { useListCursor, useListWindow } from './use-list-cursor.js';
import { chromeRows, overlayViewport } from './menu-geometry.js';
import { formatPosition, listPosition } from './viewer-util.js';
import { useDimensionsCtx } from '../DimensionsContext.js';
import { useLineEditor } from '../use-line-editor.js';
import { useRawKeys } from '../useRawKeys.js';
import { BoundedLine, OVERLAY_RESERVED_COLUMNS } from '../BoundedLine.js';
import { MenuRow } from './MenuRow.js';
import { OverlayFooter, OVERLAY_FOOTER_ROWS } from './OverlayFooter.js';
import {
  answerStep,
  choiceRows,
  answeredSoFar,
  editStep,
  goBack,
  initialWizardState,
  isAnswered,
  summarizeAnswer,
  useFreeform,
  type WizardAnswer,
  type WizardResult,
  type WizardSpec,
  type WizardStep,
} from './wizard-types.js';

/** Back. Not Esc — `overlay-contract.ts`'s rule is that Esc always dismisses. */
const BACK_HINT = { key: '^b', label: 'back' };
/** The line editor claims ctrl-a/e/w/u/k/d and declines every other chord, so ^B is free. */
function isBackKey(input: string, key: { ctrl?: boolean }): boolean {
  return key.ctrl === true && input === 'b';
}

interface WizardOverlayProps {
  spec: WizardSpec;
  onResolve: (result: WizardResult) => void;
  /** Rows consumed by chrome OUTSIDE this overlay — the banner, legacy inline mode. */
  reserveRows?: number;
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
export function WizardOverlay({ spec, onResolve, reserveRows = 0 }: WizardOverlayProps) {
  const [state, setState] = useState(() => initialWizardState(spec.steps));

  const cancel = (): void => onResolve({ cancelled: true, answered: answeredSoFar(state) });
  const back = (): void => setState(goBack);
  const submit = (answer: WizardAnswer): void => setState((s) => answerStep(s, spec.steps, answer));

  if (state.phase === 'review') {
    return (
      <WizardReview
        spec={spec}
        answers={state.answers}
        reserveRows={reserveRows}
        onEdit={(index) => setState((s) => editStep(s, index))}
        onCommit={() => onResolve({ cancelled: false, answers: state.answers })}
        onCancel={cancel}
      />
    );
  }

  const step = spec.steps[state.index];
  const header = state.index === 0 && spec.intro ? spec.intro : undefined;
  const asText = state.freeform || step.field.kind === 'text';
  // An edit goes back to the review it came from; the escape hatch goes back to
  // its own choices.
  const canGoBack = state.index > 0 || state.phase === 'editing' || state.freeform;

  return asText ? (
    <WizardTextStep
      // Keyed so the editor remounts with this step's own answer rather than
      // carrying the previous one's buffer.
      key={`${step.id}-text`}
      step={step}
      intro={header}
      initial={
        typeof state.answers[state.index] === 'string' ? (state.answers[state.index] as string) : ''
      }
      canGoBack={canGoBack}
      onSubmit={submit}
      onBack={back}
      onCancel={cancel}
    />
  ) : (
    <WizardChoiceStep
      key={`${step.id}-choice`}
      step={step}
      intro={header}
      canGoBack={canGoBack}
      onSubmit={submit}
      onOther={() => setState(useFreeform)}
      onBack={back}
      onCancel={cancel}
      reserveRows={reserveRows}
    />
  );
}

/** The question, plus its standing hint. Never a placeholder — see `wizard-types.ts`. */
function StepHeader({ step, intro }: { step: WizardStep; intro?: string }) {
  const colors = getThemeColors();
  return (
    <>
      {intro && (
        <>
          <Text color={colors.muted}>{intro}</Text>
          <Text> </Text>
        </>
      )}
      <Text color={colors.accent}>{step.question}</Text>
      {step.hint && <Text color={colors.muted}>{step.hint}</Text>}
      <Text> </Text>
    </>
  );
}

function WizardTextStep({
  step,
  intro,
  initial,
  canGoBack,
  onSubmit,
  onBack,
  onCancel,
}: {
  step: WizardStep;
  intro?: string;
  initial: string;
  canGoBack: boolean;
  onSubmit: (answer: string) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const colors = getThemeColors();
  const editor = useLineEditor(initial);
  // Ink drops the Home/End key NAMES, so they reach the editor only through the
  // raw-stdin decoder (#399). Without this they are dead here while working in
  // every other text surface — exactly the drift a copied component produces.
  useRawKeys((key) => {
    if (key === 'home') editor.toLineStart();
    else editor.toLineEnd();
  }, true);

  useInput((input, key) => {
    // Dismissal first, before the editor claims its chords. `isDismissKey`, not
    // the `q` variant: this surface has a buffer, so `q` must stay typeable.
    if (isDismissKey(input, key)) return onCancel();
    if (canGoBack && isBackKey(input, key)) return onBack();
    if (key.return) {
      const trimmed = editor.buffer.trim();
      // An empty answer HOLDS rather than cancelling. Cancelling on empty is
      // right for a one-shot prompt and wrong mid-wizard, where it would throw
      // away every answer already given on a stray Enter.
      if (trimmed.length === 0 && step.optional !== true) return;
      return onSubmit(trimmed);
    }
    editor.handleKey(input, key);
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <StepHeader step={step} intro={intro} />
      <BoundedLine
        buffer={editor.buffer}
        cursor={editor.cursor}
        showCursor
        cursorColor={colors.accent}
        cursorGlyph="▎"
        reserveColumns={OVERLAY_RESERVED_COLUMNS}
      />
      <Text> </Text>
      <HintRow
        hints={[
          { key: KEY.enter, label: step.optional ? 'next (optional)' : 'next' },
          ...(canGoBack ? [BACK_HINT] : []),
          HINT_CANCEL,
        ]}
      />
    </Box>
  );
}

function WizardChoiceStep({
  step,
  intro,
  canGoBack,
  onSubmit,
  onOther,
  onBack,
  onCancel,
  reserveRows,
}: {
  step: WizardStep;
  intro?: string;
  canGoBack: boolean;
  onSubmit: (answer: WizardAnswer) => void;
  onOther: () => void;
  onBack: () => void;
  onCancel: () => void;
  reserveRows: number;
}) {
  const { columns, rows } = useDimensionsCtx();
  const field = step.field as {
    kind: 'choice' | 'multi';
    choices: string[];
    allowOther?: boolean;
    otherLabel?: string;
  };
  const multi = field.kind === 'multi';
  // One rule, shared with `App.tsx`'s single-question path — see `choiceRows`.
  const { labels, isHatch } = choiceRows(field);

  const [checked, setChecked] = useState<Set<number>>(new Set());
  const commit = (index: number): void => {
    if (isHatch(index)) return onOther();
    if (!multi) return onSubmit(labels[index]);
    const picked = [...checked].sort((a, b) => a - b);
    onSubmit(picked.length > 0 ? picked.map((i) => labels[i]) : [labels[index]]);
  };
  const toggle = (index: number): void => {
    if (isHatch(index)) return onOther();
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const cursor = useListCursor({
    total: labels.length,
    onCommit: commit,
    ...(multi ? { onDigit: toggle, onToggle: toggle, toggleOnSpace: true } : {}),
  });

  useInput((input, key) => {
    if (isDismissKey(input, key)) return onCancel();
    if (canGoBack && isBackKey(input, key)) return onBack();
    cursor.handleKey(input, key);
  });

  const usable = columns - 4;
  const chrome =
    1 +
    chromeRows([intro, step.question, step.hint], usable) +
    (intro ? 1 : 0) +
    1 +
    OVERLAY_FOOTER_ROWS +
    reserveRows;
  const size = overlayViewport(rows, chrome);
  const { offset } = useListWindow(cursor.index, size, labels.length);
  const visible = labels.slice(offset, offset + size);
  const position = formatPosition(listPosition(offset, size, labels.length), 'options');

  return (
    <Box flexDirection="column" marginTop={1}>
      <StepHeader step={step} intro={intro} />
      {visible.map((label, i) => {
        const index = offset + i;
        return (
          <MenuRow
            key={`${index}-${label}`}
            selected={index === cursor.index}
            label={`${index + 1}. ${multi ? (checked.has(index) ? '[x] ' : '[ ] ') : ''}${label}`}
          />
        );
      })}
      <OverlayFooter
        position={position}
        hints={[
          HINT_MOVE,
          ...(multi ? [{ key: KEY.space, label: 'toggle' }] : []),
          { key: KEY.enter, label: multi ? 'confirm' : 'choose' },
          ...(canGoBack ? [BACK_HINT] : []),
          HINT_CANCEL,
        ]}
      />
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
  onEdit,
  onCommit,
  onCancel,
}: {
  spec: WizardSpec;
  answers: WizardAnswer[];
  reserveRows: number;
  onEdit: (index: number) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const colors = getThemeColors();
  const { columns, rows } = useDimensionsCtx();
  const title = spec.title ?? 'Here is what I heard';
  // One row per answer, then the commit row last.
  const total = spec.steps.length + 1;
  const commitIndex = spec.steps.length;
  const cursor = useListCursor({
    total,
    onCommit: (index) => (index === commitIndex ? onCommit() : onEdit(index)),
  });

  useInput((input, key) => {
    if (isDismissKey(input, key)) return onCancel();
    cursor.handleKey(input, key);
  });

  const usable = columns - 4;
  const chrome = 1 + chromeRows([title], usable) + 1 + OVERLAY_FOOTER_ROWS + reserveRows;
  const size = overlayViewport(rows, chrome);
  const { offset } = useListWindow(cursor.index, size, total);
  const position = formatPosition(listPosition(offset, size, total), 'answers');

  const rowFor = (index: number): string => {
    if (index === commitIndex) return 'Looks right — go ahead';
    const step = spec.steps[index];
    return `${step.summary ?? step.question} — ${summarizeAnswer(answers[index])}`;
  };
  const missing = spec.steps.filter((s, i) => !isAnswered(s, answers[i])).length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent}>{title}</Text>
      <Text> </Text>
      {Array.from({ length: Math.min(size, total - offset) }, (_, i) => offset + i).map((index) => (
        <MenuRow key={index} selected={index === cursor.index} label={rowFor(index)} />
      ))}
      <OverlayFooter
        position={position}
        hints={[HINT_MOVE, { key: KEY.enter, label: 'change or confirm' }, HINT_CANCEL]}
      />
      {missing > 0 && (
        <Text color={colors.muted}>{missing} still unanswered — pick one to fill it in.</Text>
      )}
    </Box>
  );
}
