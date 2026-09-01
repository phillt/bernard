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

/** The probe half of a reconciliation test; only `registration` varies. */
function probeOk(toolNames = ['browser_navigate', 'browser_click'], durationMs = 800) {
  mockGet.mockReturnValue({ command: 'npx' });
  mockVerify.mockResolvedValue({
    ok: true,
    toolCount: toolNames.length,
    toolNames,
    durationMs,
    timedOut: false,
  });
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
    expect(out).toContain('✓ VERDICT: "figma" is correctly configured and working');
    expect(out).toContain('connected in 120ms');
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
    expect(out).toContain('✗ VERDICT: "figma" failed');
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
    // `connected: false` covers two opposite situations; see
    // `LiveRegistration.knownAtStartup`.
    it('a JUST-ADDED server reads as success — restart is a next step, not a fault', async () => {
      probeOk(['browser_navigate', 'browser_click'], 800);
      mockActiveManager.mockReturnValue(
        fakeManager({
          registration: {
            connected: false,
            knownAtStartup: false, // never attempted — added after launch
            live: [],
            missing: ['browser_navigate', 'browser_click'],
          },
        }),
      );
      const out = await run({ key: 'browsermcp' });
      expect(out).toContain('✓ VERDICT: "browsermcp" is correctly configured and working');
      expect(out).toContain('do not re-add or remove it');
      expect(out).toContain('added after startup, which is expected');
      expect(out).toContain('Restart Bernard');
      expect(out).not.toContain('⚠');
    });

    it('a server that FAILED at startup reads as needing attention, with the reason', async () => {
      probeOk(['browser_navigate', 'browser_click'], 800);
      mockActiveManager.mockReturnValue(
        fakeManager({
          registration: {
            connected: false,
            knownAtStartup: true, // was in the config at launch and did not connect
            error: 'handshake timeout',
            live: [],
            missing: ['browser_navigate', 'browser_click'],
          },
        }),
      );
      const out = await run({ key: 'playwright' });
      expect(out).toContain('⚠ VERDICT:');
      expect(out).toContain('needs attention');
      expect(out).toContain('failed to connect (handshake timeout)');
    });

    it('confirms all tools are active when the server is live and unshadowed', async () => {
      probeOk(['browser_navigate', 'browser_click'], 90);
      mockActiveManager.mockReturnValue(
        fakeManager({
          registration: {
            connected: true,
            knownAtStartup: true,
            live: ['browser_navigate', 'browser_click'],
            missing: [],
          },
        }),
      );
      const out = await run({ key: 'playwright' });
      expect(out).toContain('Live: all 2 tool(s) are active');
    });

    // Replaced the old "reports tools shadowed by another server" case. Since
    // #413 each server registers under a key carrying its own hash, so one
    // server's tool can no longer be routed to another and `shadowed` is gone.
    // What remains reachable is a partial registration: the live session
    // predates a tool the server now exports.
    it('reports a partial registration when the session is missing some tools', async () => {
      probeOk(['browser_navigate', 'browser_click'], 90);
      mockActiveManager.mockReturnValue(
        fakeManager({
          registration: {
            connected: true,
            knownAtStartup: true,
            live: ['browser_click'],
            missing: ['browser_navigate'],
          },
        }),
      );
      const out = await run({ key: 'playwright' });
      expect(out).toContain('only 1 of 2');
      expect(out).toContain('restart to refresh');
      expect(out).toContain('⚠ VERDICT:');
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
      // Not `✗`: the probe's cold start was slow, but the session already has
      // the server and its tools are callable, so reporting a failure would
      // send the caller to fix something that works.
      expect(out).toContain('⚠ VERDICT:');
      expect(out).not.toContain('✗');
      expect(out).toContain('Probe failed after 15000ms [timed out]');
      expect(out).toContain('IS currently loaded in this session (23 tool(s))');
    });
  });
});
