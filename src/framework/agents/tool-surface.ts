import { mcpToolSurface } from '../../tools/delegate.js';
import type { AgentContext } from '../context.js';
import type { AgentDefinition, ResolvedToolSurface } from './types.js';

export type { ResolvedToolSurface };

/**
 * Resolves the surface for one dispatch.
 *
 * `surface` derives from `historyMode` unless the definition declares
 * {@link AgentDefinition.toolSurface}. The derivation is safe for every
 * registered definition — `cron`, `pac-planner`, `pac-critic` and
 * `mcp-delegate` build registries with no overlap with the worker exclusions —
 * with exactly one exception, `tool-wrapper`, which declares `'full'` next to
 * its reason.
 */
export function resolveToolSurface(
  ctx: AgentContext,
  def: Pick<AgentDefinition<any, any>, 'historyMode' | 'toolSurface'>,
): ResolvedToolSurface {
  return {
    surface: def.toolSurface ?? (def.historyMode === 'ephemeral' ? 'worker' : 'full'),
    mcpTools: mcpToolSurface(ctx),
  };
}
