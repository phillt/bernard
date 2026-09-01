import { describe, it, expect } from 'vitest';
import { subAgentDefinition } from '../sub.js';
import { taskDefinition } from '../task.js';
import { pacActorDefinition } from '../pac-actor.js';
import { mcpDelegateDefinition } from '../mcp-delegate.js';
import {
  makeCtx,
  toolsOf,
  inputFor,
  CREATE_TOOLS_DEFINITIONS,
  DELEGATE_TOOLS,
  RAW_MCP_TOOLS,
} from './_mcp-delegation-fixture.js';
import type { AgentContext } from '../../context.js';

/**
 * #305: sub-agent dispatches carried the full flat MCP bag (measured at 143
 * tools) while using 3-8 of them, all from a single server — delegation was
 * wired to `main` only. Every dispatch that assembles tools from
 * `ctx.mcp.tools` must now make the same choice `main` does.
 */
const anyInput = {} as never;

describe.each(CREATE_TOOLS_DEFINITIONS)(
  '$name agent MCP delegation tool assembly (#305)',
  ({ name, def }) => {
    const tools = (ctx: AgentContext) => toolsOf(def, ctx, inputFor(name));
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
  },
);

describe('delegation edge cases (#305)', () => {
  it('a caller-scoped registry still wins for the PAC actor', async () => {
    // How MCP delegation escalation scopes an actor to one server; if the
    // delegation gate overrode it, the escalated run would regain the full bag.
    const childTools = { [RAW_MCP_TOOLS[0]]: {}, ask_user: {} };
    const names = Object.keys(await toolsOf(pacActorDefinition, makeCtx(true), { childTools }));
    expect(names.sort()).toEqual(['ask_user', RAW_MCP_TOOLS[0]]);
  });

  it('the delegate helper carries no delegate tool, so recursion is bounded at depth 1', async () => {
    // `dispatchServerDelegate` scopes the helper to one server's tools plus
    // `ask_user`. Because that registry can never contain a `delegate_*` tool,
    // a helper cannot spawn another helper — no runtime depth guard needed.
    const childTools = { [RAW_MCP_TOOLS[0]]: {}, [RAW_MCP_TOOLS[1]]: {}, ask_user: {} };
    const names = Object.keys(await toolsOf(mcpDelegateDefinition, makeCtx(true), { childTools }));
    expect(names.filter((n) => n.startsWith('delegate_'))).toEqual([]);
  });

  it("task's prompt advertises exactly the tools it hands the agent", async () => {
    // `runDefinition` hands `systemPrompt` the registry `tools()` just returned
    // (#322), so this now holds by construction. Asserting set EQUALITY (not
    // just the delegate/raw names) is what caught the drift the old
    // two-registry version actually had: the prompt path passed no provenance,
    // so `cite` was handed but never advertised.
    const ctx = makeCtx(true);
    const handed = await toolsOf(taskDefinition, ctx, anyInput);
    const advertised = /Available tools: (.*)/.exec(
      await taskDefinition.systemPrompt(ctx, anyInput, handed as Record<string, never>),
    )?.[1];
    expect(advertised).toBeDefined();
    expect(advertised!.split(', ').sort()).toEqual(Object.keys(handed).sort());
  });

  it('falls open to the raw bag when a context carries MCP tools but no server map', async () => {
    // A caller that drops `serverNames`/`serverTools` would otherwise get
    // neither delegates nor raw tools — total loss of MCP, not a reduction.
    const ctx = makeCtx(true, {
      mcp: { tools: { [RAW_MCP_TOOLS[0]]: {} }, serverNames: [], serverTools: {} },
    });
    const names = Object.keys(await toolsOf(subAgentDefinition, ctx, anyInput));
    expect(names).toContain(RAW_MCP_TOOLS[0]);
    expect(names.filter((n) => n.startsWith('delegate_'))).toEqual([]);
  });
});
