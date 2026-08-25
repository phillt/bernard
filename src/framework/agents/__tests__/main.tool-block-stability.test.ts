import { describe, it, expect } from 'vitest';
import { mainAgentDefinition } from '../main.js';
import { makeCtx } from './_mcp-delegation-fixture.js';
import type { AgentContext } from '../../context.js';
import { toolsOf } from './_mcp-delegation-fixture.js';

/**
 * The main agent's tool block must be BYTE-IDENTICAL across turns (#253, #269).
 *
 * `applyAnthropicPromptCache` converts the system string into a cached system
 * message, which caches the tool block along with it. That block is the first
 * and largest cached prefix and cannot carry a mid-array breakpoint, so any
 * per-turn variation invalidates the whole prefix — trading a few thousand
 * tokens of schema for the ~90% discount on all of it, a net loss of roughly 6x.
 *
 * This is not hypothetical. `evaluate` was once gated on the per-turn
 * `isReactEffective` and had to be moved to the session-stable `isReactPossible`
 * for exactly this reason. That fix has been protected only by a comment until
 * now; this is the test.
 *
 * If this fails, something turn-scoped leaked into tool assembly. The fix is to
 * make it session-stable (config-derived), not to relax the assertion.
 */
async function toolBlock(ctx: AgentContext): Promise<string> {
  const tools = await toolsOf(mainAgentDefinition, ctx, { planStore: {}, systemPrompt: '' });
  // Names + descriptions are what actually go on the wire and what a cache
  // breakpoint hashes over. Sorted so a key-order change alone isn't flagged.
  return JSON.stringify(
    Object.entries(tools)
      .map(([name, t]) => [name, (t as { description?: string }).description ?? ''])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

describe('main agent tool block is stable across turns (#253)', () => {
  it('does not vary with the per-turn policy decision', async () => {
    const react = makeCtx(true, {
      policyDecision: { strategyId: 'react', toolMode: { mode: 'write' } },
    } as Partial<AgentContext>);
    const normal = makeCtx(true, {
      policyDecision: { strategyId: 'normal', toolMode: { mode: 'read-only' } },
    } as Partial<AgentContext>);
    expect(await toolBlock(react)).toBe(await toolBlock(normal));
  });

  it('does not vary between two identically-configured turns', async () => {
    expect(await toolBlock(makeCtx(true))).toBe(await toolBlock(makeCtx(true)));
  });

  it('carries no cron_* schemas — they consolidate into one `cron` tool', async () => {
    const names = Object.keys(
      await toolsOf(mainAgentDefinition, makeCtx(true), { planStore: {}, systemPrompt: '' }),
    );
    expect(names).toContain('cron');
    expect(names).toContain('cron_logs');
    expect(names).toContain('cron_notes');
    expect(names.filter((n) => /^cron_(create|list|get|update|delete|run)$/.test(n))).toEqual([]);
  });
});
