/**
 * Telling the user when a curated memory did not fit (#528).
 *
 * Past `MAX_PERSISTENT_MEMORY_CHARS` the renderer drops whole entries. The
 * model is told — a `### (truncated)` block names the count and points at the
 * `memory` tool — but the *user* was told nothing at all, on any surface. The
 * file is still on disk, still listed by `/memory`, and simply stops being
 * shown. That is worse than a deletion in one specific respect: the user
 * believes the memory is there, it *is* there, and Bernard cannot see it.
 *
 * A pure decision module in the `cost-guardrail.ts` shape, for the same reason:
 * the caller owns the once-per-session latch and the surfacing, so what is worth
 * saying can be tested without a terminal.
 *
 * **Names the keys, and that is the point.** "3 memories were dropped" is not
 * actionable; `pr-review-workflow` is — the user can shorten it, retire it, or
 * raise the budget. Bounded, because the store is not.
 */

const KEYS_NAMED = 5;

export interface MemoryCapNoticeInput {
  /** Keys `packMemory` could not fit this turn. */
  dropped: string[];
  /** Whether the notice already fired this session (rate-limit to once). */
  alreadyWarned: boolean;
}

/**
 * Returns a user-facing notice when memory was dropped this turn and we have
 * not already said so — otherwise `null`.
 *
 * Deliberately does not restate the byte cap's value: it is env-overridable, so
 * a hard-coded number here would go stale for exactly the users who raised it.
 * The env var is named instead, because it is the remedy.
 */
export function memoryCapNotice(input: MemoryCapNoticeInput): string | null {
  if (input.alreadyWarned) return null;
  if (input.dropped.length === 0) return null;
  const named = input.dropped.slice(0, KEYS_NAMED);
  const rest = input.dropped.length - named.length;
  const list = named.map((k) => `\`${k}\``).join(', ') + (rest > 0 ? `, and ${rest} more` : '');
  const count = input.dropped.length;
  return (
    `⚠ ${count} curated ${count === 1 ? 'memory' : 'memories'} did not fit the context budget ` +
    `and ${count === 1 ? 'was' : 'were'} not shown to the model this turn: ${list}. ` +
    `${count === 1 ? 'It is' : 'They are'} still on disk. Shorten or retire an entry, or raise ` +
    `\`BERNARD_MAX_PERSISTENT_MEMORY_CHARS\`.`
  );
}
