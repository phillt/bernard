import type { AppletDesign } from './design-model.js';
import { checkDesign, type DesignIssue } from './design-checks.js';

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

/**
 * A stashed plan: the typed design, and the prose each stage produced.
 *
 * **The bodies are not decoration, and re-running one stage is why.** A
 * downstream brief splices the prior stage's body VERBATIM — that is
 * deliberate, so a scope cannot be paraphrased away between hops — and the
 * only other rendering of a design is `renderDesignLines`, which its own
 * docstring calls a SUMMARY. So a re-run seeded from the typed design alone
 * would hand the next stage a different, shorter input than the first run
 * did, which is the paraphrase hazard the verbatim splice exists to prevent,
 * reintroduced by the feature meant to improve the plan.
 *
 * They are kept here rather than persisted with the brief because they are
 * scaffolding for re-planning, not a record of what the applet IS: the design
 * is what outlives the turn, and `AppletBriefStore` holds that.
 */
export interface StashedPlan {
  design: AppletDesign;
  /** Stage label (`scope`, `interface`, …) to the body it produced. */
  bodies: Record<string, string>;
}

const stashed = new Map<string, StashedPlan>();

/** Stashes a plan and returns the id `create` claims it with. */
export function stashDesign(design: AppletDesign, bodies: Record<string, string> = {}): string {
  const id = `plan-${Math.random().toString(36).slice(2, 10)}`;
  stashed.set(id, { design, bodies });
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
  const plan = stashed.get(planId);
  if (plan) stashed.delete(planId);
  return plan?.design;
}

/**
 * Reads a stashed plan WITHOUT consuming it.
 *
 * `claimDesign` deletes on read, which is right for `create` — a design
 * belongs to one applet — and wrong for a re-run, which reads the plan,
 * replans one stage of it, and stashes the result. Claiming there would
 * destroy the plan being revised, and the second re-run of a session would
 * find nothing.
 *
 * Separate function rather than a flag on `claimDesign`, so the destructive
 * one stays destructive at every call site that has always been.
 */
export function peekPlan(planId: string | undefined): StashedPlan | undefined {
  if (!planId) return undefined;
  return stashed.get(planId);
}

/** Test seam: forget everything stashed. */
export function resetStashedDesigns(): void {
  stashed.clear();
}

/**
 * The one place a `planId` is minted, and the rule that a plan already known
 * to be wrong does not get one.
 *
 * The gate belongs at the MINT rather than at each caller, and it was at two
 * callers: `applet plan` and the driver's `applet_design` each re-ran
 * `checkDesign`, each filtered for refusals, and each carried its own
 * wording of "no id was issued" — which is the state in which a third
 * minting site issues an id for a refused plan with every test green but its
 * own. Here, holding an id is the same fact as having passed the checks.
 *
 * Refusals only, never warnings: `refuse` means DECIDABLE, and everything
 * decidable is something the plan itself got wrong. The spec the caller
 * renders already lists them, so a blocked result names how many and leaves
 * the sentence about what to do next to the caller, which knows who it is
 * talking to.
 */
export function issuePlanId(
  design: AppletDesign,
  bodies: Record<string, string>,
): { planId: string; blocked?: undefined } | { planId?: undefined; blocked: DesignIssue[] } {
  const blocked = checkDesign(design).filter((i) => i.level === 'refuse');
  if (blocked.length > 0) return { blocked };
  return { planId: stashDesign(design, bodies) };
}
