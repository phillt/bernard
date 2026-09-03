/**
 * Refuses, or defuses, a dispatch carrying an image to a model that cannot
 * read one (#427).
 *
 * Two arms, split on `historyMode`, and the split is the safety property.
 *
 * An **ephemeral** dispatch throws: nothing has been billed, the caller can
 * fix it, and the five dispatch boundaries already shape a throw into each
 * tool's own failure contract via `runDispatchOrFail`.
 *
 * A **persistent** history must never throw. The main agent's `this.history`
 * carries image parts across every `/model` and `/provider` switch, forever —
 * so a model change would brick every subsequent turn on a conversation that
 * once contained a screenshot. It sanitizes instead, replacing the bytes with
 * the same `[Image attached]` placeholder used before persisting to disk.
 *
 * Those are separate functions with `historyMode` as the discriminator rather
 * than one function with a branch, because the persistent arm's guarantee is
 * that it *cannot* throw — and that is not something a type can state.
 */

/**
 * The refusal an ephemeral dispatch throws.
 *
 * Names the RESOLVED provider and model — not the session's — because they
 * routinely differ: a specialist may be pinned, a role may re-tier it, and
 * `specialist_run` / `tool_wrapper_run` both accept per-call overrides. And it
 * names the override, because that is the thing the caller can actually do.
 */
export function visionRefusal(provider: string, model: string): string {
  return (
    `Cannot dispatch an attachment to ${provider}/${model}, which does not accept images. ` +
    'Pass `provider` and `model` on this call to choose one that does, or describe the ' +
    'content in text instead.'
  );
}
