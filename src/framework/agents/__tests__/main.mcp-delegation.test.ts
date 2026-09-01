import { describe, it, expect } from 'vitest';
import { mainAgentDefinition } from '../main.js';
import { makeCtx, toolsOf, DELEGATE_TOOLS, RAW_MCP_TOOLS } from './_mcp-delegation-fixture.js';

/**
 * Per-server MCP delegation (#296): with delegation on, the main agent must
 * carry exactly one `delegate_<server>` tool per connected server and NONE of
 * that server's raw per-tool schemas. With delegation off, the raw MCP tools
 * are exposed directly and no delegate tool exists.
 */
const input = { planStore: {}, systemPrompt: '' } as unknown as Parameters<
  typeof mainAgentDefinition.tools
>[1];

async function toolNames(mcpDelegation: boolean): Promise<string[]> {
  return Object.keys(await toolsOf(mainAgentDefinition, makeCtx(mcpDelegation), input));
}

describe('main agent MCP delegation tool assembly (#296)', () => {
  it('with delegation ON, exposes one delegate_<server> per server and zero raw MCP schemas', async () => {
    const names = await toolNames(true);
    expect(names).toContain(DELEGATE_TOOLS[0]);
    expect(names).toContain(DELEGATE_TOOLS[1]);
    // The whole point: no per-tool MCP schema is resident in the main registry.
    expect(names).not.toContain(RAW_MCP_TOOLS[0]);
    expect(names).not.toContain(RAW_MCP_TOOLS[1]);
    expect(names).not.toContain(RAW_MCP_TOOLS[2]);
    // Exactly one delegate per connected server.
    expect(names.filter((n) => n.startsWith('delegate_')).sort()).toEqual([
      DELEGATE_TOOLS[0],
      DELEGATE_TOOLS[1],
    ]);
  });

  it('with delegation OFF, exposes raw MCP tools directly and no delegate tools', async () => {
    const names = await toolNames(false);
    expect(names).toContain(RAW_MCP_TOOLS[0]);
    expect(names).toContain(RAW_MCP_TOOLS[1]);
    expect(names).toContain(RAW_MCP_TOOLS[2]);
    expect(names.filter((n) => n.startsWith('delegate_'))).toEqual([]);
  });
});
