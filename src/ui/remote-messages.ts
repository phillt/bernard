import type { InboxKind } from '../inbox/types.js';

/**
 * What a delivered message is allowed to do, and how that is worded (#462/#493).
 *
 * A pure decision module in the `cost-guardrail.ts` / `memory-notice.ts` shape:
 * three surfaces render this same choice — the keystroke menu, `/agent-options`,
 * and the setup wizard — and a label written three times drifts into three
 * different claims about what the setting does.
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
 * Spread into `InboxWatcherOptions`, because the field is optional there and
 * `DEFAULT_CAPABILITIES` is the honest value for `ask` — passing `['notice']`
 * explicitly would be a second place that constant is written down.
 */
export function capabilitiesFor(mode: RemoteMessageMode): {
  capabilities?: readonly InboxKind[];
} {
  return acceptsPrompts(mode) ? { capabilities: ['notice', 'prompt'] as const } : {};
}

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

function acceptsPrompts(mode: RemoteMessageMode): boolean {
  return mode === 'prompts' || mode === 'all';
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
