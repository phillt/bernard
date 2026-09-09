/**
 * Library id validation for the knowledge corpus (#516).
 *
 * **A pure leaf with no imports at all**, and that is the whole reason the
 * module exists rather than the rule living beside the store. `declaredScope`
 * (`framework/agents/dispatch-profile.ts`) runs before EVERY dispatch, the main
 * agent included, and its call site sits outside the only `try` in that
 * function — so the predicate it uses to validate a scope entry must not be
 * able to touch disk and must not be able to throw. Importing the store to ask
 * "is this a valid library id?" would put `node:sqlite` and `node:fs` on the
 * pre-dispatch path of every turn.
 *
 * **Shape, never existence.** A well-formed id naming a library that does not
 * exist yet is KEPT in a scope, not dropped. That is the difference between
 * this and `knowledgeScope`'s predicate, which is an existence check against
 * the frozen domain registry — and it is why a library name in *that* field
 * resolves to `[]`, i.e. silent deny-all. A scope naming a library that is not
 * there already fails closed at search time, because it matches nothing; there
 * is no second mechanism needed and a great deal of harm in guessing.
 */

/**
 * Lowercase alphanumerics and hyphens, 1-64 characters, not hyphen-initial.
 *
 * The id becomes a directory name, so it is deliberately narrower than a
 * filesystem allows: no dots (`..`), no separators, no case (a
 * case-insensitive filesystem would collide `Docs` and `docs` into one store).
 */
export const LIBRARY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Rejects, never sanitises — `AppletStore`'s rule, for its reason: a repaired
 * id addresses a different corpus than the caller named. Note this is the
 * opposite of `MemoryStore.sanitizeKey`, which repairs; that store's ids are
 * user-typed prose and its keys are repaired nowhere else, while these name a
 * directory the user created by hand with `bernard knowledge create`.
 */
export function isValidLibraryId(value: unknown): value is string {
  return typeof value === 'string' && LIBRARY_ID_RE.test(value);
}
