import { describe, it, expect } from 'vitest';
import { mcpAliasResolverFor } from '../mcp-alias.js';
import { mcpToolName } from '../../../mcp-names.js';
import type { AgentContext } from '../../context.js';

function ctxWith(toolNames: string[]): AgentContext {
  const tools: Record<string, unknown> = {};
  for (const n of toolNames) tools[n] = {};
  return { mcp: { tools, serverNames: [], serverTools: {} } } as unknown as AgentContext;
}

describe('mcpAliasResolverFor', () => {
  it('resolves a bare stored name to the one server that exports it', () => {
    const live = mcpToolName('playwright', 'browser_drag');
    expect(mcpAliasResolverFor(ctxWith([live]))?.('browser_drag')).toBe(live);
  });

  it('returns null when two servers export the name', () => {
    const ctx = ctxWith([
      mcpToolName('playwright', 'browser_click'),
      mcpToolName('browsermcp', 'browser_click'),
    ]);
    expect(mcpAliasResolverFor(ctx)?.('browser_click')).toBeNull();
  });

  it('is undefined when the session has no MCP tools, so gates keep exact matching', () => {
    expect(mcpAliasResolverFor(ctxWith([]))).toBeUndefined();
  });

  it('memoizes on the tool bag identity', () => {
    const ctx = ctxWith([mcpToolName('playwright', 'browser_drag')]);
    expect(mcpAliasResolverFor(ctx)).toBe(mcpAliasResolverFor(ctx));
  });

  // The reason this is built from ctx.mcp.tools and not the dispatch registry:
  // a delegate helper sees one server, and a locally-built index would call an
  // ambiguous name unambiguous and honor the wrong grant.
  it('sees every server even when a dispatch would only see one', () => {
    const ctx = ctxWith([
      mcpToolName('playwright', 'browser_click'),
      mcpToolName('browsermcp', 'browser_click'),
    ]);
    const oneServerView = ctxWith([mcpToolName('playwright', 'browser_click')]);
    expect(mcpAliasResolverFor(ctx)?.('browser_click')).toBeNull();
    expect(mcpAliasResolverFor(oneServerView)?.('browser_click')).not.toBeNull();
  });
});
