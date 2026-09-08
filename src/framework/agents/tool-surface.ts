import { mcpToolSurface } from '../../tools/delegate.js';
import type { AgentContext } from '../context.js';
import type { AgentDefinition, ResolvedToolSurface } from './types.js';
import type { DispatchProfile } from './dispatch-profile.js';

export type { ResolvedToolSurface };

/**
 * Resolves the surface for one dispatch.
 *
 * Precedence is **record, then definition, then derivation**, which is the same
 * order `resolveSiteModel` uses for a model and reads the same way: the most
 * specific statement wins. `surface` derives from `historyMode` unless the
 * definition declares {@link AgentDefinition.toolSurface}, and since #508 a
 * specialist record may narrow or widen it for itself. The derivation is safe
 * for every registered definition — `cron`, `pac-planner`, `pac-critic` and
 * `mcp-delegate` build registries with no overlap with the worker exclusions —
 * with exactly one exception, `tool-wrapper`, which declares `'full'` next to
 * its reason.
 *
 * The record beating the definition is deliberate, and `tool-wrapper` is why:
 * its `'full'` was chosen for three bundled wrappers and has applied to every
 * wrapper anyone has written since, so a record must be able to say "not me".
 * Widening is bounded by `targetTools`, a fence for every kind since #507.
 */
export function resolveToolSurface(
  ctx: AgentContext,
  def: Pick<AgentDefinition<any, any>, 'historyMode' | 'toolSurface'>,
  profile: DispatchProfile = {},
): ResolvedToolSurface {
  return {
    surface:
      profile.toolSurface ??
      def.toolSurface ??
      (def.historyMode === 'ephemeral' ? 'worker' : 'full'),
    mcpTools: mcpToolSurface(ctx),
  };
}
