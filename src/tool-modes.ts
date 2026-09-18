/**
 * What Bernard is allowed to do, and how that is worded (#144/#179/#212/#447).
 *
 * A pure table in the `remote-messages.ts` shape, at `src/` root for the reason
 * that module records: `profiles-wizard-data.ts` is host-agnostic by contract,
 * so a table under `src/ui/` is one the setup wizard cannot import and therefore
 * one it hand-writes. That already happened here — three surfaces spelled the
 * same three answers three different ways:
 *
 * - setup: `Read-only (least privilege)` / `Write (allow all tools)` /
 *   `⚠ Unrestricted (no permission checks)`
 * - `/agent-options`: `Read-only (least privilege)` / `Write` /
 *   `Run Without Permission Checks or Safeguards`
 * - the `/agent-options` parent row's own description, a third paraphrase
 *
 * And one of them was simply WRONG: "allow all tools" is what `unrestricted`
 * does. `write` lets a write RUN and leaves the confirm gate standing, so the
 * two rows a reader most needs to tell apart were described as the same thing.
 *
 * ## One question, because from the reader's seat it always was one
 *
 * `toolMode` and `confirmMode` were asked on consecutive screens, and the
 * middle row's label — `Ask only about risky things` — described the PAIR:
 * `write` plus `confirmMode: 'auto'`. Answer the next screen with `off` and the
 * label a reader had just accepted became false, with nothing on either screen
 * connecting them. The split is an implementation fact ("is it allowed to run"
 * against "do I get a prompt"), not a distinction anybody is choosing between.
 *
 * So there is one question now, and {@link TOOL_MODE_SETTINGS} is its decode:
 * every row writes all three keys, which is what makes a row that cannot be
 * contradicted. `toolModeFor` is the inverse, and both live here rather than at
 * the two call sites, because a decode written twice is two decodes.
 *
 * ### Three rows, not four — `read-only` and `write`+`strict` stop on the same calls
 *
 * The obvious merge has four rows, one per coherent combination. It collapses
 * to three because of what `risk.ts` actually classifies: an ordinary local
 * write is `medium`, an unclassified MCP tool is `medium`, a read is `low`. So
 * "block every write until allowed" and "confirm at medium and up" select the
 * IDENTICAL population — the difference is the wording of the prompt and the
 * breadth of the allowance it offers (the block gate's session allowance is
 * keyed on the tool NAME, the confirm gate's on `name:hash(args)`, so
 * `read-only`'s is the coarser of the two, which is not an argument for keeping
 * it as a row of its own). `toolModeFor` therefore reads `write`+`strict` back
 * as the first row, which is the same claim stated as code.
 *
 * ### What the merge cost, stated rather than discovered
 *
 * `strict` and `off` lose their rows in setup. That was very nearly a silent
 * capability removal: this registry is not `OPTIONS_REGISTRY` (four numeric
 * settings) and `/agent-options` had no confirm-mode row at all, so dropping
 * the question would have left `BERNARD_CONFIRM_MODE` and the per-job cron
 * field as the only ways to reach either value. {@link CONFIRM_MODES} and the
 * `/agent-options` row are what make "it stays reachable" true.
 *
 * And `write`+`off` — run everything, keep the write-scope and deny-rule
 * machinery — is now a state no row represents. It is deliberately NOT folded
 * into `⚠ Never ask`: `skipPermissions` short-circuits the profile's `deny`
 * rules too, so reading it as that row would turn a bare Enter into an
 * escalation. `toolModeFor` returns `null` and the step opens with nothing
 * ticked, which is this wizard's existing answer to a value its rows cannot
 * express — see `WizardChoiceStep`'s "never invents the answer it opens on".
 *
 * ## `unrestricted` is a row here and two fields on disk
 *
 * `ProfileSettings.toolMode` is `'read-only' | 'write'`; the third answer is
 * `skipPermissions`, which `toolModePolicy` short-circuits on before every other
 * rule. Presenting it as a third row is what `/agent-options` already did and is
 * right — a mode you can set and then contradict on the next screen is not a
 * mode — so the sentinel is written down once, here, rather than invented as
 * `'unrestricted'` in one caller and `'skip'` in another.
 */

/** The three answers, as a reader meets them. Least- to most-permissive. */
export type ToolModeChoice = 'read-only' | 'write' | typeof UNRESTRICTED;

/**
 * The third row's value, which is `skipPermissions` rather than a `toolMode`.
 *
 * Exported because every caller has to map it back to the two fields it really
 * sets, and a caller that spells the sentinel itself is a caller that can spell
 * it differently — which is how this arrived as `'unrestricted'` in the wizard
 * and `'skip'` in the menu.
 */
export const UNRESTRICTED = 'unrestricted';

/** The settings one row decides. A subset of `ProfileSettings`, restated so
 *  this module stays a leaf that `profiles.ts` can be imported beside. */
export interface ToolModeSettings {
  toolMode: 'read-only' | 'write';
  skipPermissions: boolean;
  confirmMode: 'off' | 'auto' | 'strict';
}

/**
 * What each row writes. **All three keys, always.**
 *
 * Writing only what changed is how the old two-key decode could leave
 * `skipPermissions: true` standing under a guarded mode — a mode that is set
 * and not in force. The same reasoning now covers `confirmMode`: a row that
 * leaves it alone is a row whose label the previous answer can still falsify.
 *
 * `⚠ Never ask` writes `confirmMode: 'auto'`, not `'off'`, even though the
 * level is inert while `skipPermissions` is set. `'off'` looks like the honest
 * spelling of that row and is the one thing here that must not be written: the
 * level is what is left holding the answer when the safeguards come BACK, and
 * `/tool-permissions` re-arms them by writing `skipPermissions` alone — so the
 * row would hand a reader who turned the safeguards back on a session that
 * still never asks, in the state `toolModeFor` calls un-representable. What an
 * inert field should hold is whatever is correct the moment it stops being
 * inert.
 */
export const TOOL_MODE_SETTINGS: Readonly<Record<ToolModeChoice, ToolModeSettings>> = {
  'read-only': { toolMode: 'read-only', skipPermissions: false, confirmMode: 'auto' },
  write: { toolMode: 'write', skipPermissions: false, confirmMode: 'auto' },
  [UNRESTRICTED]: { toolMode: 'write', skipPermissions: true, confirmMode: 'auto' },
};

/**
 * Which row is in force, or `null` when no row says what the stored triple does.
 *
 * `skipPermissions` is tested first because that is the order `toolModePolicy`
 * itself short-circuits in: with it set, the other two decide nothing, so any
 * pair beside it still reads as the last row.
 *
 * `confirmMode` is then ignored under `read-only`, because what asks there is
 * the block gate, which the confirm level does not reach.
 */
export function toolModeFor(s: Partial<ToolModeSettings>): ToolModeChoice | null {
  if (s.skipPermissions === true) return UNRESTRICTED;
  if (s.toolMode === 'read-only') return 'read-only';
  if (s.toolMode !== 'write') return null;
  // `write` + `strict` is NOT folded onto the first row, and the collapse the
  // module docstring argues for is a statement about what the two postures
  // STOP — which is true, and is not what this function decides.
  //
  // It is the PRESELECTOR. `setup-wizard.ts` and `App.tsx` both decode a row
  // through `{...TOOL_MODE_SETTINGS[value]}`, which writes all three keys
  // unconditionally, so returning `read-only` here meant a `write`+`strict`
  // user opened `/setup` on a row that was not their state and, by accepting
  // what was shown, silently became `read-only` + `auto` — losing writes in one
  // direction and `strict` in the other, having changed nothing.
  //
  // That is this wizard's own "a step never invents the answer it opens on",
  // which is a rule about what Continue WRITES rather than about what a label
  // claims. It is also the `⚠ Never ask` row's argument two functions up,
  // applied consistently: `confirmMode` is the value left holding the answer
  // when the safeguards come back, so a row must not overwrite a level the user
  // set. Both un-representable pairs now answer `null` and the step opens with
  // nothing ticked, which is the honest preselection.
  return s.confirmMode === 'auto' ? 'write' : null;
}

/**
 * One row per answer, for every surface that asks.
 *
 * `description` is a sentence that ADDS to whatever framing the surface already
 * shows — what the row costs you, not a restatement of what it is. The setup
 * wizard renders it on its reserved note row and `/agent-options` under the row.
 * The parenthetical helper text it replaces could be neither: it competed with
 * the label for the same space, and it had to be stripped back off before the
 * answer could be decoded.
 *
 * **Kept under about fifty characters**, because the wizard's note row is
 * reserved as exactly ONE row and truncates to it — so a longer sentence is not
 * wrapped, it is cut. The bound is the structural guard; short copy is what
 * keeps it from firing.
 */
export const TOOL_MODES: ReadonlyArray<{
  value: ToolModeChoice;
  label: string;
  description: string;
}> = [
  {
    value: 'read-only',
    label: 'Ask before every change',
    description: 'Each one waits for you, and can be allowed for the session.',
  },
  {
    value: 'write',
    label: 'Ask only about risky things',
    // This used to point at the next question, because the label was only true
    // in combination with it. The row writes `confirmMode` itself now, so the
    // note can finally say which calls it means.
    description: 'Dangerous shell, or anything leaving your machine.',
  },
  {
    value: UNRESTRICTED,
    label: '⚠ Never ask',
    // `toolModePolicy` short-circuits on `skipPermissions` BEFORE every other
    // rule, so this does not merely relax the confirm gate — it dissolves the
    // block gate and the profile's own deny rules with it.
    description: 'At your own risk: nothing blocked, nothing confirmed.',
  },
];

/**
 * The finer control under the middle row, for `/agent-options` only.
 *
 * Not a setup question, and that is the merge: which calls count as risky is a
 * refinement of an answer already given, and asking it as a peer is what let a
 * reader contradict themselves one screen later. It stays here rather than in a
 * fourth near-identical module because it is the same question at a second
 * grain, and a surface that renders both should read them off one table.
 *
 * `Off` is deliberately offered even though it produces the state `toolModeFor`
 * calls un-representable: it is a real posture for someone who wants the
 * write-scope and deny-rule machinery without the prompts, and refusing to
 * offer it from the one surface that can is how a setting becomes env-only by
 * accident rather than by decision.
 */
export const CONFIRM_MODES: ReadonlyArray<{
  value: 'auto' | 'strict' | 'off';
  label: string;
  description: string;
}> = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Only the riskiest: dangerous shell, or leaving your machine.',
  },
  {
    value: 'strict',
    label: 'Strict',
    description: 'Also stops before ordinary file writes.',
  },
  {
    value: 'off',
    label: 'Off',
    description: 'Never prompts. Deny rules and write scopes still apply.',
  },
];

/**
 * The label of the row in force, for an annotation that opens this question.
 *
 * `toolModeFor` answers with the VALUE, and a caller wanting something to show
 * has to map it — which `/agent-options` did by hand, producing `⚠ unrestricted`
 * against the row's own `⚠ Never ask`. That is exactly the drift this module
 * exists to end, surviving inside the file that adopted it. `null` for a
 * combination no row represents, which the caller renders as `custom`.
 */
export function toolModeLabel(settings: Partial<ToolModeSettings>): string | null {
  const value = toolModeFor(settings);
  return value === null ? null : (TOOL_MODES.find((m) => m.value === value)?.label ?? null);
}
