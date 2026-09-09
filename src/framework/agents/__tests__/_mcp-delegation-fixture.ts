import type { BernardConfig } from '../../../config.js';
import { makePolicyInput } from '../../../policy/test-helpers.js';
import type { AgentContext } from '../../context.js';
import { resolveToolSurface } from '../tool-surface.js';
import type { AgentDefinition } from '../types.js';
import { subAgentDefinition } from '../sub.js';
import { taskDefinition } from '../task.js';
import { specialistDefinition } from '../specialist.js';
import { pacActorDefinition } from '../pac-actor.js';
import { flattenServerTools, mcpServerSegment, mcpToolName } from '../../../mcp-names.js';
import { makeTestContext } from '../../../__tests__/agent-context.js';

/**
 * Shared fixture for the per-server MCP delegation assertions (#296, #305).
 * Two MCP servers, three raw tools between them — enough to prove that a
 * definition carries `delegate_<server>` tools instead of per-tool schemas,
 * and that the mapping is per-server rather than per-tool.
 *
 * Lives in one place because five definitions must make the identical choice
 * (main, sub, task, specialist, pac-actor); a per-file copy of the context
 * would let one drift without any test noticing.
 */
export function baseConfig(mcpDelegation: boolean): BernardConfig {
  // Reuses the repo's one cast-free `BernardConfig` builder so new config
  // fields surface as compile errors here instead of silently defaulting.
  return makePolicyInput({ config: { mcpDelegation, coordinatorMode: 'off' } }).config;
}

/**
 * The registry keys the fixture's servers export.
 *
 * Derived through `mcpToolName` rather than written out, so the fixture tracks
 * the real naming scheme instead of encoding a snapshot of it (#413).
 */
export const RAW_MCP_TOOLS = [
  mcpToolName('google', 'gmail_list'),
  mcpToolName('google', 'gmail_get'),
  mcpToolName('slack', 'post_message'),
] as const;

/** The delegate tools that should replace them when delegation is on. */
export const DELEGATE_TOOLS = [
  `delegate_${mcpServerSegment('google')}`,
  `delegate_${mcpServerSegment('slack')}`,
] as const;

/** Per-server registry; `mcp.tools` is derived from it, never written twice. */
export const FIXTURE_SERVER_TOOLS: Record<string, Record<string, any>> = {
  google: {
    [mcpToolName('google', 'gmail_list')]: { description: 'list gmail' },
    [mcpToolName('google', 'gmail_get')]: { description: 'get email' },
  },
  slack: { [mcpToolName('slack', 'post_message')]: { description: 'post to slack' } },
};

/**
 * The MCP-shaped context these suites need, over the shared base (#318).
 *
 * Only the MCP half is local now: the stores, the config builder and the
 * deep-merge live in `src/__tests__/agent-context.ts`, because they are not
 * about MCP and the copies of them had already broken twice on disjoint file
 * sets. What stays here is the part that IS about MCP — a `tools` bag derived
 * from `serverTools` rather than written twice (#413).
 *
 * The `noopStore` Proxy this used to build is gone with them, and that is a
 * behaviour change worth stating: `new Proxy({}, { get: () => () => [] })`
 * answered `specialists.get(anyId)` with a truthy empty array, so every
 * `if (record)` guard took the "found" branch for ids nothing had seeded.
 */
export function makeCtx(
  mcpDelegation: boolean,
  overrides: Partial<AgentContext> = {},
): AgentContext {
  return makeTestContext({
    config: baseConfig(mcpDelegation),
    mcp: {
      // `tools` is DERIVED here exactly as `MCPManager.snapshot()` derives it,
      // so this fixture cannot encode a state the real assembler could never
      // produce — a flat bag and a per-server map that disagree (#413).
      tools: flattenServerTools(FIXTURE_SERVER_TOOLS),
      serverNames: ['google', 'slack'],
      serverTools: FIXTURE_SERVER_TOOLS,
    },
    ...overrides,
  } as unknown as Partial<AgentContext>);
}

/**
 * Calls a definition's `tools()` the way `runDefinition` does — through the
 * centrally-resolved surface (#315) rather than a hand-built one, so these
 * assertions exercise the real resolution rather than a test-local copy of it.
 */
export async function toolsOf(
  def: AgentDefinition<any, any>,
  ctx: AgentContext,
  input: unknown,
): Promise<Record<string, unknown>> {
  return def.tools(ctx, input, resolveToolSurface(ctx, def));
}

/**
 * The definitions that assemble their registry from `createTools` and so are
 * observably affected by the resolved surface. Shared because both
 * `child.mcp-delegation.test.ts` and `tool-surface.test.ts` iterate them, and a
 * per-file copy would let one drift.
 */
export const CREATE_TOOLS_DEFINITIONS: ReadonlyArray<{
  name: string;
  def: AgentDefinition<any, any>;
}> = [
  { name: 'sub', def: subAgentDefinition },
  { name: 'task', def: taskDefinition },
  { name: 'specialist', def: specialistDefinition },
  { name: 'pac-actor', def: pacActorDefinition },
];

/** `specialist` is the one definition whose input must carry a plan store. */
export function inputFor(name: string): unknown {
  return name === 'specialist' ? { planStore: {} } : {};
}
