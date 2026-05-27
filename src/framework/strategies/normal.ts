import type { AgentResult } from '../runner.js';
import type { ExecutionStrategy, StrategyContext } from './types.js';

/**
 * Leaf strategy: runs a single iteration with no overrides. All wrapping
 * strategies bottom out here.
 */
export class NormalStrategy implements ExecutionStrategy {
  async run(ctx: StrategyContext): Promise<AgentResult> {
    return ctx.iterate({ extra: [] });
  }
}
