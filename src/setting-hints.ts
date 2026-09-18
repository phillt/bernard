/**
 * @module setting-hints
 *
 * Announce a setting once, the first time Bernard actually uses it (#583).
 *
 * A setting the user never chose is a setting they do not know exists. #582's
 * quick path makes that the default state rather than an edge case: a first run
 * now settles three questions and leaves Bernard running on a couple of dozen
 * defaults nobody has seen. So when one of them first DOES something, say what
 * happened and where to change it — once, ever.
 *
 * ## There is no chokepoint where a setting is read, and a read-hook would be wrong
 *
 * `BernardConfig` is a plain resolved object: 58 `config.X` reads across 14
 * non-test files, no getter, no proxy. Even given one, "someone read the field"
 * is the wrong signal — `config.toolDetails` is read on every transcript-item
 * push. What is worth announcing is that Bernard DID something, which only the
 * code path knows. So a trigger is a named runtime MOMENT and it is, by
 * necessity, a line of code in a runtime path.
 *
 * That is the honest scope of #583's acceptance criterion ("adding a hint to a
 * setting is a data edit in the registry"): the SENTENCE and the LATCH are a
 * data edit, and the TRIGGER cannot be, because no registry can supply a call
 * site. Adding a hint to a setting that already has a trigger is one registry
 * entry; adding one to a setting whose moment nobody has named is that plus a
 * call.
 *
 * ## Once ever, per profile — and the cap that makes that survivable
 *
 * Once per session is noise by the third session. Once ever needs somewhere to
 * remember, and that is `ProfileSettings.shownHints`, written through
 * `saveActiveSettings` the way `app-grants.ts` writes its own map — so `config.ts`
 * gains nothing and a deleted profile takes its record with it.
 *
 * Because "once ever" means a missed hint never returns, the rate limit is the
 * load-bearing part rather than the polish: at most one per turn, so two hints
 * firing milliseconds apart in the pre-turn pipeline cannot have the first
 * overwritten by the second and marked shown anyway; and a session cap, because
 * one-per-turn alone still allows twenty in twenty turns.
 */

import { getActiveSettings, loadProfiles, saveActiveSettings } from './profiles.js';
import { debugLog } from './logger.js';
import { WIZARD_FIELDS, type HintTrigger, type SettingHint } from './profiles-wizard-data.js';

/**
 * At most this many in one session, however many turns it runs for.
 *
 * Two rather than a rounder number, and it BINDS today: three hints are
 * declared, so a session shows two and the third waits for the next one. A cap
 * set at or above the number of declared hints is inert — it would be code that
 * cannot run and a test that cannot fail — and a limit nobody has ever observed
 * working is one nobody can trust when there are ten hints.
 *
 * Two is also the right number on its own terms: a hint is an interruption, and
 * the reader came here to do something else.
 */
const SESSION_CAP = 2;

/** The hint declared for a trigger, or `null`. */
export function hintFor(trigger: HintTrigger): SettingHint | null {
  return WIZARD_FIELDS.find((f) => f.hint?.trigger === trigger)?.hint ?? null;
}

/**
 * The sentence a reader sees.
 *
 * The signpost is composed rather than written, which is what makes "every hint
 * names a door" a property instead of a habit — the one thing a hint must never
 * be is a statement the reader cannot act on.
 */
export function renderHint(hint: SettingHint): string {
  return `${hint.message} ${hint.surface} to change it.`;
}

/** Triggers already announced on this profile. */
export function loadShownHints(): Set<string> {
  try {
    const stored = getActiveSettings(loadProfiles().file).shownHints;
    return new Set(Array.isArray(stored) ? stored.filter((v) => typeof v === 'string') : []);
  } catch {
    // A profile that cannot be read means "nothing recorded", not a crash on a
    // path whose whole job is a one-line courtesy.
    return new Set();
  }
}

/** Records a trigger as announced. Never throws — a lost latch costs a repeat. */
export function markHintShown(trigger: HintTrigger): void {
  try {
    const shown = loadShownHints();
    if (shown.has(trigger)) return;
    shown.add(trigger);
    saveActiveSettings({ shownHints: [...shown].sort() });
  } catch (err) {
    debugLog('hints:persist-failed', { trigger, error: String(err) });
  }
}

/**
 * The live half: which hint, if any, to show right now.
 *
 * A holder rather than a free function because the two rate limits are state,
 * and the state is per session. Everything it can refuse it refuses BEFORE
 * touching disk, so a trigger that fires on every turn — recall injection does
 * — costs a set lookup and nothing more once it has been shown.
 */
export class FirstUseHints {
  private firedThisTurn = false;
  private shownThisSession = 0;
  /** Read lazily and kept, so a hot trigger does not re-read the profile. */
  private shown: Set<string> | null = null;

  /**
   * Reset the per-turn budget.
   *
   * Called from the pre-turn pipeline, which every turn runs first, rather than
   * from `runAgentTurn` — the boundary is the same and the pipeline is where
   * two of the three triggers live, so the reset and the things it bounds stay
   * in one file.
   */
  beginTurn(): void {
    this.firedThisTurn = false;
  }

  /**
   * The sentence to show for this trigger, or `null` to stay quiet.
   *
   * Taking it COMMITS it: the trigger is marked shown, so a caller that drops
   * the return value has spent the hint. That is deliberate — the alternative
   * is a two-call protocol whose second call is the one that gets forgotten,
   * and the failure there is a hint repeating forever.
   */
  take(trigger: HintTrigger): string | null {
    if (this.firedThisTurn) return null;
    if (this.shownThisSession >= SESSION_CAP) return null;
    const hint = hintFor(trigger);
    if (hint === null) return null;
    this.shown ??= loadShownHints();
    if (this.shown.has(trigger)) return null;

    this.shown.add(trigger);
    this.firedThisTurn = true;
    this.shownThisSession += 1;
    markHintShown(trigger);
    debugLog('hints:shown', { trigger });
    return renderHint(hint);
  }
}
