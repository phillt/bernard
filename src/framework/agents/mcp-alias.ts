/**
 * Per-dispatch alias resolver for tool names persisted before MCP tools were
 * namespaced per server (#413).
 *
 * Bernard registered MCP tools under their bare names for a long time, and
 * those bare names are on disk: in profile permission grants, tool-profile
 * filenames, specialist `targetTools`, and `BERNARD_LOOKUP_TOOLS`. Rather than
 * rewrite user data, a stored name is resolved forward at match time.
 *
 * ## Why the index is built from `ctx.mcp.tools` and not the caller's registry
 *
 * The resolver must see **every** connected server. Inside a
 * `delegate_<server>` helper the dispatch's own registry holds exactly one
 * server's tools, so an index built there would find a stored bare
 * `browser_click` unambiguous and honour a grant the user made while a
 * *different* server owned that name. Ambiguity is only visible from the
 * global view, and `ctx.mcp.tools` is that view at every dispatch depth
 * because the context is shared by reference into sub-agent and tool-wrapper
 * dispatches.
 *
 * Memoized on the tool bag's identity: `Agent.processInput` re-points
 * `this.ctx` every turn but `ctx.mcp` is rebuilt only when servers change, so
 * the same bag yields the same index without rebuilding it per dispatch.
 */

import { buildMCPAliasIndex, resolveMCPName } from '../../mcp-names.js';
import type { ToolNameAliasResolver } from '../../permissions/engine.js';
import type { AgentContext } from '../context.js';

interface Cached {
  live: ReadonlySet<string>;
  resolve: ToolNameAliasResolver;
}

const cache = new WeakMap<object, Cached>();

/**
 * Returns a resolver over every live MCP tool name (plus the `delegate_*` keys
 * derived from them), or `undefined` when the session has no MCP tools at all
 * — in which case there is nothing to alias and the gates keep their
 * pre-#413 exact-match behaviour.
 */
export function mcpAliasResolverFor(ctx: AgentContext): ToolNameAliasResolver | undefined {
  const bag = ctx.mcp?.tools;
  if (!bag) return undefined;
  const names = Object.keys(bag);
  if (names.length === 0) return undefined;

  const hit = cache.get(bag);
  if (hit) return hit.resolve;

  const live = new Set(names);
  const index = buildMCPAliasIndex(names);
  const resolve: ToolNameAliasResolver = (stored) => resolveMCPName(stored, live, index);
  cache.set(bag, { live, resolve });
  return resolve;
}
