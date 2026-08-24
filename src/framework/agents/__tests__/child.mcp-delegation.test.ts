import { describe, it, expect } from 'vitest';
import { subAgentDefinition } from '../sub.js';
import { taskDefinition } from '../task.js';
import { specialistDefinition } from '../specialist.js';
import { pacActorDefinition } from '../pac-actor.js';
import { mcpDelegateDefinition } from '../mcp-delegate.js';
import { makeCtx, DELEGATE_TOOLS, RAW_MCP_TOOLS } from './_mcp-delegation-fixture.js';
import type { AgentContext } from '../../context.js';

/**
 * #305: sub-agent dispatches carried the full flat MCP bag (measured at 143
 * tools) while using 3-8 of them, all from a single server — delegation was
 * wired to `main` only. Every dispatch that assembles tools from
 * `ctx.mcp.tools` must now make the same choice `main` does.
 */
const anyInput = {} as never;
const specialistInput = { planStore: {} } as never;

/** `(name, tools(ctx, input))` for each definition that can carry MCP. */
const DEFINITIONS: ReadonlyArray<{
  name: string;
  tools: (ctx: AgentContext) => Promise<Record<string, unknown>>;
}> = [
  { name: 'sub', tools: async (ctx) => subAgentDefinition.tools!(ctx, anyInput) },
  { name: 'task', tools: async (ctx) => taskDefinition.tools!(ctx, anyInput) },
  { name: 'specialist', tools: async (ctx) => specialistDefinition.tools!(ctx, specialistInput) },
  { name: 'pac-actor', tools: async (ctx) => pacActorDefinition.tools!(ctx, anyInput) },
];

describe.each(DEFINITIONS)('$name agent MCP delegation tool assembly (#305)', ({ tools }) => {
  it('with delegation ON, carries delegate_<server> tools and no raw MCP schemas', async () => {
    const names = Object.keys(await tools(makeCtx(true)));
    expect(names.filter((n) => n.startsWith('delegate_')).sort()).toEqual([...DELEGATE_TOOLS]);
    for (const raw of RAW_MCP_TOOLS) expect(names).not.toContain(raw);
  });

  it('with delegation OFF, carries raw MCP tools and no delegate tools', async () => {
    const names = Object.keys(await tools(makeCtx(false)));
    for (const raw of RAW_MCP_TOOLS) expect(names).toContain(raw);
    expect(names.filter((n) => n.startsWith('delegate_'))).toEqual([]);
  });
});

describe('delegation edge cases (#305)', () => {
  it('a caller-scoped registry still wins for the PAC actor', () => {
    // How MCP delegation escalation scopes an actor to one server; if the
    // delegation gate overrode it, the escalated run would regain the full bag.
    const childTools = { google__gmail_list: {}, ask_user: {} };
    const names = Object.keys(pacActorDefinition.tools!(makeCtx(true), { childTools } as never));
    expect(names.sort()).toEqual(['ask_user', 'google__gmail_list']);
  });

  it('the delegate helper carries no delegate tool, so recursion is bounded at depth 1', () => {
    // `dispatchServerDelegate` scopes the helper to one server's tools plus
    // `ask_user`. Because that registry can never contain a `delegate_*` tool,
    // a helper cannot spawn another helper — no runtime depth guard needed.
    const childTools = { google__gmail_list: {}, google__gmail_get: {}, ask_user: {} };
    const names = Object.keys(mcpDelegateDefinition.tools!(makeCtx(true), { childTools } as never));
    expect(names.filter((n) => n.startsWith('delegate_'))).toEqual([]);
  });

  it("task's prompt advertises exactly the tools it hands the agent", async () => {
    // `task.systemPrompt` builds a throwaway registry purely to interpolate
    // `Available tools: …`. Assembled separately from `tools()`, it would
    // advertise 143 tools the agent no longer has.
    const ctx = makeCtx(true);
    const prompt = await taskDefinition.systemPrompt(ctx, anyInput);
    const advertised = /Available tools: (.*)/.exec(prompt)?.[1].split(', ');
    expect(advertised).toBeDefined();
    for (const name of DELEGATE_TOOLS) expect(advertised).toContain(name);
    for (const raw of RAW_MCP_TOOLS) expect(advertised).not.toContain(raw);
  });

  it('falls open to the raw bag when a context carries MCP tools but no server map', async () => {
    // A caller that drops `serverNames`/`serverTools` would otherwise get
    // neither delegates nor raw tools — total loss of MCP, not a reduction.
    const ctx = makeCtx(true, {
      mcp: { tools: { google__gmail_list: {} }, serverNames: [], serverTools: {} },
    });
    const names = Object.keys(subAgentDefinition.tools!(ctx, anyInput));
    expect(names).toContain('google__gmail_list');
    expect(names.filter((n) => n.startsWith('delegate_'))).toEqual([]);
  });
});
