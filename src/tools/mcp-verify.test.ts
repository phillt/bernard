import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../mcp.js', () => ({
  getMCPServer: vi.fn(),
  verifyMCPServer: vi.fn(),
}));

const { getMCPServer, verifyMCPServer } = await import('../mcp.js');
const { createMCPVerifyTool } = await import('./mcp-verify.js');

const mockGet = getMCPServer as ReturnType<typeof vi.fn>;
const mockVerify = verifyMCPServer as ReturnType<typeof vi.fn>;

// The AI SDK tool execute signature takes (args, options); we only use args.
const run = (args: { key: string; timeoutMs?: number }) =>
  (createMCPVerifyTool().execute as (a: typeof args) => Promise<string>)(args);

describe('mcp_verify tool', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockVerify.mockReset();
  });

  it('errors without probing when the server is not configured', async () => {
    mockGet.mockReturnValue(undefined);
    const out = await run({ key: 'nope' });
    expect(out).toContain('no MCP server named "nope"');
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('formats a successful verify with count + sample tools', async () => {
    mockGet.mockReturnValue({ command: 'npx', args: ['x'] });
    mockVerify.mockResolvedValue({
      ok: true,
      toolCount: 3,
      toolNames: ['a', 'b', 'c'],
      durationMs: 120,
      timedOut: false,
    });
    const out = await run({ key: 'figma' });
    expect(out).toContain('✓ "figma" connected in 120ms');
    expect(out).toContain('3 tool(s)');
    expect(out).toContain('a, b, c');
  });

  it('formats a timeout failure with the [timed out] marker + reason', async () => {
    mockGet.mockReturnValue({ command: 'npx' });
    mockVerify.mockResolvedValue({
      ok: false,
      toolCount: 0,
      toolNames: [],
      durationMs: 15000,
      timedOut: true,
      error: 'Timed out after 15000ms — … "--stdio" …',
    });
    const out = await run({ key: 'figma' });
    expect(out).toContain('✗ "figma" failed');
    expect(out).toContain('[timed out]');
    expect(out).toContain('--stdio');
  });

  it('threads timeoutMs through to verifyMCPServer', async () => {
    mockGet.mockReturnValue({ command: 'npx' });
    mockVerify.mockResolvedValue({ ok: true, toolCount: 0, toolNames: [], durationMs: 5, timedOut: false });
    await run({ key: 'x', timeoutMs: 5000 });
    expect(mockVerify).toHaveBeenCalledWith(expect.anything(), { timeoutMs: 5000 });
  });
});
