import type { AppletDesign } from './design-model.js';

/**
 * Designs waiting to be attached to an applet that does not exist yet.
 *
 * `plan` runs before `create`, often a turn or two before, and the applet has
 * no id until `create` returns — which is why `plan` deliberately writes no
 * brief: doing so would orphan one for an id `create` may never be called
 * with. So the design is held here and claimed by id.
 *
 * ## Why not a tool parameter the model fills in
 *
 * Because it would be re-typed. `AppletDesignSchema` is deeply nested, and
 * advertising it as an `applet` parameter puts its whole JSON Schema in the
 * main agent's prompt-cached prefix — #588 measured a far smaller vocabulary
 * change costing this one tool 9,183 → 13,333 bytes. Worse, a model
 * transcribing a design it was shown can drop a field, and the whole point of
 * the record is that it is the object the planners actually produced.
 *
 * So `plan` returns a short id, `create` passes it back, and what is stored is
 * the original. A model that forgets the id loses the record and keeps the
 * applet, which is the right way round.
 *
 * ## Its own leaf, and that is not tidiness
 *
 * This lives here rather than in `applet-planning.ts` because `applet.ts`
 * holds a plain callback for the planner precisely so it never acquires that
 * module's graph — `dispatchToolWrapper` reaches the whole agent runtime, and
 * `applet.ts` is built by `createTools` on every worker dispatch. Putting the
 * stash beside the planner and importing it from the tool measured
 * `applet.js` at 149 ms. This module imports one type, which is erased.
 *
 * Module-level rather than per-turn, following `providers/request-counter.ts`:
 * the tool is rebuilt every turn (`createMainAppletTool`), so a closure slot
 * would lose a design between planning it and building it — the common case.
 * Bounded because nothing else evicts: a REPL plans a handful of applets at
 * most, and the cron daemon and applet host hold a process open for days.
 */
const MAX_STASHED_DESIGNS = 8;
const stashed = new Map<string, AppletDesign>();

/** Stashes a design and returns the id `create` claims it with. */
export function stashDesign(design: AppletDesign): string {
  const id = `plan-${Math.random().toString(36).slice(2, 10)}`;
  stashed.set(id, design);
  // Oldest first: a `Map` iterates in insertion order, so this is a queue
  // without keeping a second structure to say which is oldest.
  while (stashed.size > MAX_STASHED_DESIGNS) {
    const oldest = stashed.keys().next().value;
    if (oldest === undefined) break;
    stashed.delete(oldest);
  }
  return id;
}

/**
 * Claims a stashed design, removing it.
 *
 * Removing, because a design belongs to one applet: leaving it would let a
 * second `create` reusing the id attach somebody else's plan, which is
 * exactly the incoherent record the model exists to prevent.
 */
export function claimDesign(planId: string | undefined): AppletDesign | undefined {
  if (!planId) return undefined;
  const design = stashed.get(planId);
  if (design) stashed.delete(planId);
  return design;
}

/** Test seam: forget everything stashed. */
export function resetStashedDesigns(): void {
  stashed.clear();
}
