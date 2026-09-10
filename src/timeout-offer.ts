/**
 * @module timeout-offer
 *
 * Which timeouts may offer to raise themselves, and once per session (#477).
 *
 * When something times out, Bernard reported that it took too long and stopped
 * there. The evidence that this is worth fixing is a hand-edit: the `smart`
 * profile on a real install carries `shellTimeout: 50000` against `default`'s
 * `30000`, raised by hand because nothing offered to.
 *
 * ## The distinction this module exists to hold
 *
 * **A budget that expresses how long work is expected to take may be raised. A
 * guard that exists to detect that something has STOPPED RESPONDING may not.**
 * Getting that backwards would train people to raise exactly the guards that stop
 * a wedged turn, so the offerable set is written down here as data rather than
 * decided at each call site — the `AUTHORITY_ACTION_FIELDS` idiom, and a test
 * asserts the two stall guards are absent.
 *
 * `BERNARD_PROVIDER_STALL_TIMEOUT_MS` (90 s) and
 * `BERNARD_STREAM_STALL_TIMEOUT_MS` (120 s) are the excluded pair. Both are
 * liveness detectors: a dead connection stays dead, so doubling only buys a
 * 180-second wait for the same failure. #302 sized the first at 3.3x the worst
 * legitimate time-to-first-byte across 1,230 real requests precisely so it never
 * fires on slow-but-alive, which is the measurement that makes raising it wrong
 * rather than merely unhelpful.
 *
 * `BERNARD_CRON_JOB_TIMEOUT_MS` is excluded for a different reason: nobody is
 * there to answer. That is enforced by the absence of `askUser` rather than by
 * this table, and the table says so.
 *
 * ## The ladder is the step-limit one
 *
 * `Agent.processInput`'s step-limit continuation (#292) already built "offer a
 * concrete higher budget with a scope": once / this session / save to my profile,
 * with every side effect driven off the chosen scope. This reuses that shape
 * rather than inventing a second one, because a user who has learned one ceiling
 * prompt should recognise the next.
 */

/** A budget a timeout can be attributed to. */
export type TimeoutBudget = 'shell' | 'mcp-connect' | 'dispatch';

interface OfferableBudget {
  /** The `ProfileSettings` key a `profile`-scoped acceptance writes. */
  settingKey: 'shellTimeout';
  /** What the user types to set it themselves, named in the message. */
  command: string;
  /** Why raising this one is a statement about work rather than about liveness. */
  rationale: string;
}

/**
 * The budgets that may be offered, and nothing else.
 *
 * A table rather than a predicate at each site: the cost of a wrong answer is
 * asymmetric (offering to raise a liveness guard is a correctness bug, declining
 * to offer a work budget is only an annoyance), and a table is what a test can
 * walk. Keyed on the budget rather than on an env var name, because the same
 * ceiling is reachable from a profile setting, an env var and a `/options` row.
 *
 * `mcp-connect` and `dispatch` are deliberately absent **for now** rather than
 * forever: #477 lists both as legitimately offerable, but their offers do not
 * happen at a tool boundary — a connect timeout fires during startup, before a
 * prompt channel exists in the shape this uses — so they are a separate change.
 * Adding a row here is most of the work when they land.
 */
export const OFFERABLE_BUDGETS: Readonly<
  Record<'shell', OfferableBudget> & Partial<Record<TimeoutBudget, OfferableBudget>>
> = {
  shell: {
    settingKey: 'shellTimeout',
    command: '/options shell-timeout',
    rationale: 'how long a command is expected to take, which only the user knows',
  },
};

/**
 * Whether a timeout on this budget may ask to be raised.
 *
 * **This is not what holds the safety property.** The only production call is
 * `claimOffer('shell')` with a literal, so this always returns `true` there —
 * what stops a liveness guard being offered is the ABSENCE of a row above, and a
 * `provider-stall` row would not even type-check against {@link TimeoutBudget}.
 * Worth stating because the runtime check reads as the enforcement and somebody
 * may defend it as such.
 */
function isOfferable(budget: TimeoutBudget): boolean {
  return budget in OFFERABLE_BUDGETS;
}

/**
 * The scopes an acceptance can have, mirroring the step-limit prompt's.
 *
 * `once` deliberately does NOT write anything: it retries at the higher value and
 * leaves the setting alone, which is what makes accepting safe for someone who
 * only wants this one command to finish.
 */
type OfferScope = 'once' | 'session' | 'profile' | 'decline';

interface OfferChoice {
  label: string;
  scope: OfferScope;
}

/**
 * Doubling is the honest default, and the message says so rather than implying a
 * measurement.
 *
 * A timed-out command reveals how long it was ALLOWED to run and nothing about
 * how long it would have taken — `spawnSync` kills it, so there is no observed
 * duration to derive a figure from. That is the difference from the max-tokens
 * tip, which computes `ceil(observed * 1.25 / 1024) * 1024` because it really did
 * observe a count.
 */
export function doubled(ms: number): number {
  return Math.min(ms * 2, MAX_SHELL_TIMEOUT_MS);
}

/**
 * The ceiling a doubling may not cross.
 *
 * The step-limit ladder this copies carries TWO bounds — a per-turn expansion
 * count and `REACT_MAX_STEPS_CEILING` — and only the first was copied. Without
 * this, a user already sitting at a hand-raised `shellTimeout` can accept their
 * way to a twenty-minute **synchronous** `spawnSync` on Ink's render thread.
 *
 * 600,000 is not invented here: `profiles-wizard-data.ts` already declares
 * `{kind:'int', min: 1_000, max: 600_000}` for this very setting, so without the
 * clamp a `profile`-scoped acceptance could persist a value the wizard's own
 * field would refuse to accept back. Restated rather than imported, because
 * importing it would give this zero-import leaf an edge to the wizard's data
 * module; a test pins the two together instead.
 */
export const MAX_SHELL_TIMEOUT_MS = 600_000;

/**
 * Renders a budget the way a person would say it.
 *
 * Sub-second values stay in milliseconds: `Math.round(300 / 1000)` is `0`, and a
 * row reading "Retry once with a 0s timeout" is worse than no row. Production
 * budgets are tens of seconds, so this only bites a hand-lowered one — which is
 * exactly the configuration somebody debugging would set.
 */
export function formatBudget(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/** The four rows of the prompt, in the order the step-limit ladder uses. */
export function offerChoices(nextMs: number, command: string): OfferChoice[] {
  const s = formatBudget;
  return [
    { label: `Retry once with a ${s(nextMs)} timeout`, scope: 'once' },
    { label: `Retry, and use ${s(nextMs)} for the rest of this session`, scope: 'session' },
    { label: `Retry, and save ${s(nextMs)} via ${command}`, scope: 'profile' },
    { label: 'Leave it — report the timeout', scope: 'decline' },
  ];
}

/**
 * Per-session latch, keyed on the budget.
 *
 * A command that times out in a loop must not ask five times — the max-tokens tip
 * is already once-per-turn-cluster for the same reason. Module-level because
 * "this session" is this process: a field on the tool would reset whenever the
 * registry is rebuilt, which is every turn.
 *
 * Keyed on the BUDGET, not on the command. Two different slow commands are one
 * ceiling, and the question being asked is about the ceiling.
 */
const asked = new Set<TimeoutBudget>();

/** True the first time only. Marks it asked, so the caller cannot forget to. */
export function claimOffer(budget: TimeoutBudget): boolean {
  if (!isOfferable(budget) || asked.has(budget)) return false;
  asked.add(budget);
  return true;
}

/** Test-only: forget what has been asked. */
export function _resetOffers(): void {
  asked.clear();
}

/**
 * What a timed-out shell command says now.
 *
 * The predecessor threw `proc.error` into a generic `catch` and the model — and
 * the transcript — got `spawnSync /bin/sh ETIMEDOUT`, which names neither the
 * command nor the budget it exceeded. The taxonomy classified it as `timeout`
 * correctly, so the user-facing line was "Timed out — operation took too long",
 * with no path from there to "the budget was 50 s and this needs 60".
 *
 * Partial output is kept when there is any: `spawnSync` fills `stdout`/`stderr`
 * with whatever the child produced before the kill, and throwing `proc.error`
 * discarded it — so a command that printed nine lines and hung on the tenth
 * reported nothing at all.
 */
export function shellTimeoutMessage(command: string, budgetMs: number, partial: string): string {
  const head = `\`${command}\` exceeded the ${budgetMs} ms shell timeout and was killed.`;
  return partial.trim() ? `${head}\nOutput before it was killed:\n${partial.trim()}` : head;
}
