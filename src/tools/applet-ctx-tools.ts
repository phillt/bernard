import { createAppletTool } from './applet.js';
import { AppRegistry } from '../apps/registry.js';
import { makeAppletStyler } from './applet-styling.js';
import { makeAppletPlanner } from './applet-planning.js';
import type { AgentContext } from '../framework/context.js';

/**
 * The `applet` tool with its two ctx-taking passes wired in — what `main.ts`
 * builds, and the only instance in the process that has them.
 *
 * This replaces `applet-styling.ts`'s `createAppletToolWithStyling`, which was
 * the same function with one callback. Renamed rather than extended because
 * that name becomes false the moment it also builds a planner, and a stale name
 * on a composition root is worse than a new file: the next reader trusts it. The
 * two `make*` halves stay in their own modules, each next to the brief it
 * builds and the specialist it routes to.
 *
 * It exists as its own module for one reason: `main.ts` reaches it through a
 * single deferred `import()`, and folding the two `make*` halves in here keeps
 * that one edge rather than three. Each half stays beside the brief it builds
 * and the specialist it routes to.
 *
 * `seed: false` because `createTools` already constructed a seeding registry
 * this same turn, so re-seeding would be filesystem work for a result already on
 * disk. Schema and description are untouched, so the tool block stays
 * byte-identical and the prompt cache is unaffected.
 *
 * The recursion guard that makes both passes safe is argued once, in
 * `applet-planning.ts`; it is not restated here.
 */
export function createMainAppletTool(ctx: AgentContext) {
  return createAppletTool(new AppRegistry({ seed: false }), {
    requestConsent: ctx.toolOptions.requestPermissionConsent,
    style: makeAppletStyler(ctx),
    plan: makeAppletPlanner(ctx),
  });
}
