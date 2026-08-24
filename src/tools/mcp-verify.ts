import { tool } from 'ai';
import { z } from 'zod';
import { getMCPServer, verifyMCPServer, getActiveMCPManager } from '../mcp.js';
import { attachMeta } from '../framework/tools/adapter.js';

/** Caps a name list for readable output. */
function sampleNames(names: string[], max = 8): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown}, …` : shown;
}

/**
 * Reconciles a successful fresh probe against the tools actually wired into the
 * running session, so "healthy" reflects what the agent can really call — not
 * just what an isolated spawn reports. Returns a `\n`-joined block, or `''` when
 * there's no live manager (headless/tests) or nothing noteworthy to add.
 */
function liveStateReport(key: string, probeToolNames: string[]): string {
  const mgr = getActiveMCPManager();
  if (!mgr) return '';
  const reg = mgr.getLiveRegistration(key, probeToolNames);
  const lines: string[] = [];

  if (!reg.connected) {
    // The exact "healthy but not there" case: the probe spawns and lists tools
    // fine, but this session never loaded the server (it failed / timed out at
    // startup), so none of its tools are callable until a restart.
    lines.push(
      `⚠ In THIS session the "${key}" server is NOT loaded — it wasn't connected when the tool set was built at startup, so the probe's tools are not callable here. Restart Bernard to pick it up.`,
    );
    if (reg.shadowed.length > 0) {
      lines.push(
        `   (${reg.shadowed.length} of its tool name(s) are currently provided by another server: ${sampleNames(reg.shadowed.map((s) => `${s.tool} → "${s.owner}"`))}.)`,
      );
    }
    return lines.join('\n');
  }

  // Connected live — report how the probe's tools actually resolve right now.
  if (reg.shadowed.length === 0 && reg.missing.length === 0) {
    lines.push(`✓ Live: all ${reg.live.length} tool(s) are active in this session.`);
    return lines.join('\n');
  }
  lines.push(
    `⚠ Live: only ${reg.live.length} of ${probeToolNames.length} probed tool(s) route to "${key}" in this session.`,
  );
  if (reg.shadowed.length > 0) {
    lines.push(
      `   ${reg.shadowed.length} shadowed by another server (calls go elsewhere): ${sampleNames(reg.shadowed.map((s) => `${s.tool} → "${s.owner}"`))}.`,
    );
  }
  if (reg.missing.length > 0) {
    lines.push(
      `   ${reg.missing.length} not in this session's tool set (restart to refresh): ${sampleNames(reg.missing)}.`,
    );
  }
  return lines.join('\n');
}

/**
 * Creates the `mcp_verify` tool: test-connects a configured MCP server and
 * reports whether it actually works, **without restarting Bernard**. This is
 * the "check it" half of MCP management — after adding/editing a server, call
 * this to confirm it speaks the protocol and surfaces tools, instead of
 * blindly trusting a written config (and discovering a hang on next launch).
 */
export function createMCPVerifyTool() {
  return attachMeta(
    tool({
      description:
        "Test-connect a configured MCP server WITHOUT restarting Bernard. Spawns/connects it with a timeout, lists its tools, and reports success + tool count or the failure reason (e.g. handshake timeout from an HTTP server launched as stdio, missing --stdio flag, bad API-key env var, or command not found). ALSO reconciles the probe against THIS running session: whether the server is actually loaded and whether its tools are callable now or shadowed by another server / missing (needing a restart) — so a server that is 'healthy' in isolation but not wired into the current session is reported as such. Always run this after adding or editing an MCP server.",
      parameters: z.object({
        key: z
          .string()
          .describe('Name/key of the MCP server in the config to verify (see mcp_config list).'),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(60_000)
          .optional()
          .describe('Connection timeout in milliseconds (default 15000).'),
      }),
      execute: async ({ key, timeoutMs }): Promise<string> => {
        const config = getMCPServer(key);
        if (!config) {
          return `Error: no MCP server named "${key}" is configured. Use mcp_config { action: "list" } to see configured servers.`;
        }
        const r = await verifyMCPServer(config, timeoutMs ? { timeoutMs } : {});
        if (r.ok) {
          const sample = r.toolNames.slice(0, 10).join(', ');
          const more = r.toolCount > r.toolNames.slice(0, 10).length ? ', …' : '';
          const probeLine = `✓ "${key}" connected in ${r.durationMs}ms — ${r.toolCount} tool(s)${sample ? `: ${sample}${more}` : ''}.`;
          const live = liveStateReport(key, r.toolNames);
          return live ? `${probeLine}\n${live}` : probeLine;
        }
        // Probe failed, but the server may still be loaded live — e.g. a cold
        // `npx` start times out on the fresh probe while the session (warmed at
        // launch) has it. Say so rather than implying it's dead.
        const status = getActiveMCPManager()
          ?.getServerStatuses()
          .find((s) => s.name === key);
        const liveNote =
          status?.connected && status.toolCount > 0
            ? `\n✓ Note: "${key}" IS currently loaded in this session (${status.toolCount} tool(s)) — the probe's fresh cold-start may just be slower than the timeout.`
            : '';
        return `✗ "${key}" failed to connect after ${r.durationMs}ms${r.timedOut ? ' [timed out]' : ''}: ${r.error}${liveNote}`;
      },
    }),
    {
      // A read-only diagnostic probe: it spawns the *user's own configured*
      // server briefly and only lists tools (no tool is invoked).
      name: 'mcp_verify',
      audience: 'main',
      kind: 'read',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
    },
  );
}
