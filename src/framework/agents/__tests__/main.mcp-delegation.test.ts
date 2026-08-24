import { describe, it, expect } from 'vitest';
import { mainAgentDefinition } from '../main.js';
import { makeCtx } from './_mcp-delegation-fixture.js';
import { resolveToolSurface } from '../tool-surface.js';

/**
 * Per-server MCP delegation (#296): with delegation on, the main agent must
 * carry exactly one `delegate_<server>` tool per connected server and NONE of
 * that server's raw per-tool schemas. With delegation off, the raw MCP tools
 * are exposed directly and no delegate tool exists.
 */
const input = { planStore: {}, systemPrompt: '' } as unknown as Parameters<
  typeof mainAgentDefinition.tools
>[1];

function toolNames(mcpDelegation: boolean): string[] {
  const ctx = makeCtx(mcpDelegation);
  return Object.keys(
    mainAgentDefinition.tools(ctx, input, resolveToolSurface(ctx, mainAgentDefinition)),
  );
}

describe('main agent MCP delegation tool assembly (#296)', () => {
  it('with delegation ON, exposes one delegate_<server> per server and zero raw MCP schemas', () => {
    const names = toolNames(true);
    expect(names).toContain('delegate_google');
    expect(names).toContain('delegate_slack');
    // The whole point: no per-tool MCP schema is resident in the main registry.
    expect(names).not.toContain('google__gmail_list');
    expect(names).not.toContain('google__gmail_get');
    expect(names).not.toContain('slack__post_message');
    // Exactly one delegate per connected server.
    expect(names.filter((n) => n.startsWith('delegate_')).sort()).toEqual([
      'delegate_google',
      'delegate_slack',
    ]);
  });

  it('with delegation OFF, exposes raw MCP tools directly and no delegate tools', () => {
    const names = toolNames(false);
    expect(names).toContain('google__gmail_list');
    expect(names).toContain('google__gmail_get');
    expect(names).toContain('slack__post_message');
    expect(names.filter((n) => n.startsWith('delegate_'))).toEqual([]);
  });
});
