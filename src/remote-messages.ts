import { DEFAULT_CAPABILITIES, type InboxKind } from './inbox/types.js';

/**
 * What a delivered message is allowed to do, and how that is worded (#462/#493).
 *
 * A pure decision module in the `cost-guardrail.ts` / `memory-notice.ts` shape,
 * and at `src/` root beside them for a reason the first cut got wrong: four
 * surfaces render this same choice — the keystroke menu, `/agent-options`, the
 * setup wizard and `say-cli`'s refusal — and a label written four times drifts
 * into four different claims. Under `src/ui/` the wizard could not import it
 * (`profiles-wizard-data.ts` is host-agnostic by contract), so it hand-wrote its
 * own rows and they had already disagreed on arrival.
 *
 * ## Why the keystroke is not one of the modes
 *
 * Acting on a message you are looking at is **per-message human consent**, which
 * is strictly stronger than the blanket kind `--accept-remote-prompts` grants in
 * advance to every local writer. So it is always available and gated by nothing;
 * these modes govern only what happens with **nobody watching**.
 *
 * That is also why `ask` can be the default without the feature being useless.
 * The reason the flag existed at all was that retyping a message was the only
 * alternative — the footer said "type to act on it" and typing did no such
 * thing, because a notice never reaches `agent.history`.
 */
export type RemoteMessageMode = 'ask' | 'prompts' | 'all';

/** The keystroke, named once, so every surface says the same thing. */
export const ACT_KEY = '↵';

/** The chord that opens the scope menu. */
export const OPTIONS_KEY = '^o';

/**
 * How the affordance is described in prose, mid-sentence.
 *
 * Interpolated into the panel footer and into the degraded-prompt sentence, so a
 * reader meets one wording wherever they meet it.
 */
export const ACT_HINT = `press ${ACT_KEY} to act on it, ${OPTIONS_KEY} for options`;

/**
 * What the session advertises it can be asked to do.
 *
 * Returns the LIST, not an options spread. The spread was meant to keep
 * `DEFAULT_CAPABILITIES` from being written down twice, and achieved the
 * opposite: a caller that needed a value — re-advertising on a mode change —
 * could not use it, so it hand-wrote `mode === 'ask' ? ['notice'] : [...]`,
 * which is both a second copy of the constant AND the negative predicate this
 * module exists to refuse. A shape nobody can call is not a single source.
 */
export function capabilitiesFor(mode: RemoteMessageMode): readonly InboxKind[] {
  return acceptsPrompts(mode) ? PROMPT_CAPABILITIES : DEFAULT_CAPABILITIES;
}

const PROMPT_CAPABILITIES: readonly InboxKind[] = ['notice', 'prompt'];

/**
 * Whether a message of this kind runs with nobody pressing anything.
 *
 * **Both predicates test for the permissive values and never against `ask`**,
 * which is the difference between failing open and failing closed. Written as
 * `mode !== 'ask'` they are both TRUE for `undefined` — and a caller can hand
 * one `undefined` without a type error, because every `BernardConfig` in the
 * test suite is a literal and a field nobody listed is simply absent. That is
 * not hypothetical: it is how the first cut of this shipped, and it made a
 * session that had opted in to nothing advertise `prompt` and run an arbitrary
 * turn for any local writer. Caught by #493's own guarantee tests, which is what
 * they are for.
 */
export function runsUnattended(mode: RemoteMessageMode, kind: InboxKind): boolean {
  if (mode === 'all') return true;
  return kind === 'prompt' && acceptsPrompts(mode);
}

/**
 * True when this mode runs something with nobody watching.
 *
 * Exported because a third surface needed it and tested `mode !== 'ask'`
 * instead — the hint bar, which then announced `messages: undefined` on every
 * session whose config literal omitted the field. That is the same fail-open
 * this module's docstring is about, reached a third time by a caller who could
 * not see the rule from outside. A predicate nobody can borrow gets rewritten.
 */
export function isAutomatic(mode: RemoteMessageMode): boolean {
  return mode === 'prompts' || mode === 'all';
}

const acceptsPrompts = isAutomatic;

/** The row for one mode. By VALUE, never by index: the table's order is
 *  documented as least- to most-permissive, so a reorder would silently
 *  relabel a menu row that reached in positionally. */
export function modeRow(value: RemoteMessageMode): { label: string; description: string } {
  const hit = REMOTE_MESSAGE_MODES.find((m) => m.value === value);
  // Unreachable through the type, and the table is the thing being indexed, so
  // a throw here would be a worse failure than a blank description.
  return hit ?? { label: value, description: '' };
}

/** One row per mode, for the settings menus. Order is least- to most-permissive. */
export const REMOTE_MESSAGE_MODES: ReadonlyArray<{
  value: RemoteMessageMode;
  label: string;
  description: string;
}> = [
  {
    value: 'ask',
    label: 'Ask me',
    description: `Show the message; ${ACT_KEY} acts on it. Nothing runs on its own.`,
  },
  {
    value: 'prompts',
    label: 'Run messages sent with --run',
    description: 'What --accept-remote-prompts has always meant. A plain message still waits.',
  },
  {
    value: 'all',
    label: 'Run every message',
    description: 'Any local process that can write your state directory can start a turn.',
  },
];
