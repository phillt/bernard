import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../mcp.js', () => ({
  getMCPServer: vi.fn(),
  verifyMCPServer: vi.fn(),
  getActiveMCPManager: vi.fn(),
}));

const { getMCPServer, verifyMCPServer, getActiveMCPManager } = await import('../mcp.js');
const { createMCPVerifyTool } = await import('./mcp-verify.js');

const mockGet = getMCPServer as ReturnType<typeof vi.fn>;
const mockVerify = verifyMCPServer as ReturnType<typeof vi.fn>;
const mockActiveManager = getActiveMCPManager as ReturnType<typeof vi.fn>;

// The AI SDK tool execute signature takes (args, options); we only use args.
const run = (args: { key: string; timeoutMs?: number }) =>
  (createMCPVerifyTool().execute as (a: typeof args) => Promise<string>)(args);

/** A stub live manager exposing just the accessors mcp_verify consults. */
function fakeManager(opts: {
  registration?: ReturnType<
    NonNullable<ReturnType<typeof getActiveMCPManager>>['getLiveRegistration']
  >;
  statuses?: Array<{ name: string; connected: boolean; toolCount: number; error?: string }>;
}) {
  return {
    getLiveRegistration: vi.fn(() => opts.registration),
    getServerStatuses: vi.fn(() => opts.statuses ?? []),
  } as unknown as ReturnType<typeof getActiveMCPManager>;
}

describe('mcp_verify tool', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockVerify.mockReset();
    mockActiveManager.mockReset();
    mockActiveManager.mockReturnValue(null); // no live manager unless a test sets one
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
    mockVerify.mockResolvedValue({
      ok: true,
      toolCount: 0,
      toolNames: [],
      durationMs: 5,
      timedOut: false,
    });
    await run({ key: 'x', timeoutMs: 5000 });
    expect(mockVerify).toHaveBeenCalledWith(expect.anything(), { timeoutMs: 5000 });
  });

  describe('live-session reconciliation', () => {
    it('flags a probe-healthy server that is NOT loaded in this session', async () => {
      mockGet.mockReturnValue({ command: 'npx' });
      mockVerify.mockResolvedValue({
        ok: true,
        toolCount: 2,
        toolNames: ['browser_navigate', 'browser_click'],
        durationMs: 800,
        timedOut: false,
      });
      mockActiveManager.mockReturnValue(
        fakeManager({
          registration: {
            connected: false,
            live: [],
            shadowed: [],
            missing: ['browser_navigate', 'browser_click'],
          },
        }),
      );
      const out = await run({ key: 'playwright' });
      // The exact "healthy but not there" signal.
      expect(out).toContain('✓ "playwright" connected in 800ms');
      expect(out).toContain('NOT loaded');
      expect(out).toContain('Restart Bernard');
    });

    it('confirms all tools are active when the server is live and unshadowed', async () => {
      mockGet.mockReturnValue({ command: 'npx' });
      mockVerify.mockResolvedValue({
        ok: true,
        toolCount: 2,
        toolNames: ['browser_navigate', 'browser_click'],
        durationMs: 90,
        timedOut: false,
      });
      mockActiveManager.mockReturnValue(
        fakeManager({
          registration: {
            connected: true,
            live: ['browser_navigate', 'browser_click'],
            shadowed: [],
            missing: [],
          },
        }),
      );
      const out = await run({ key: 'playwright' });
      expect(out).toContain('✓ Live: all 2 tool(s) are active');
    });

    it('reports tools shadowed by another server', async () => {
      mockGet.mockReturnValue({ command: 'npx' });
      mockVerify.mockResolvedValue({
        ok: true,
        toolCount: 2,
        toolNames: ['browser_navigate', 'browser_click'],
        durationMs: 90,
        timedOut: false,
      });
      mockActiveManager.mockReturnValue(
        fakeManager({
          registration: {
            connected: true,
            live: ['browser_click'],
            shadowed: [{ tool: 'browser_navigate', owner: 'other-server' }],
            missing: [],
          },
        }),
      );
      const out = await run({ key: 'playwright' });
      expect(out).toContain('only 1 of 2');
      expect(out).toContain('shadowed');
      expect(out).toContain('browser_navigate → "other-server"');
    });

    it('on probe failure, notes the server IS loaded live (slow cold-start)', async () => {
      mockGet.mockReturnValue({ command: 'npx' });
      mockVerify.mockResolvedValue({
        ok: false,
        toolCount: 0,
        toolNames: [],
        durationMs: 15000,
        timedOut: true,
        error: 'Timed out after 15000ms',
      });
      mockActiveManager.mockReturnValue(
        fakeManager({ statuses: [{ name: 'playwright', connected: true, toolCount: 23 }] }),
      );
      const out = await run({ key: 'playwright' });
      expect(out).toContain('✗ "playwright" failed');
      expect(out).toContain('IS currently loaded in this session (23 tool(s))');
    });
  });
});
