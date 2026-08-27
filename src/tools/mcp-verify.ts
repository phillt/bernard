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
 * just what an isolated spawn reports.
 *
 * Returns `{ actionNeeded, lines }`. `actionNeeded` is what decides the
 * verdict line, and it is deliberately **false** for a server that simply
 * hasn't been loaded yet: see {@link buildVerdict}.
 */
function liveStateReport(
  key: string,
  probeToolNames: string[],
): { actionNeeded: boolean; lines: string[] } {
  const mgr = getActiveMCPManager();
  if (!mgr) return { actionNeeded: false, lines: [] };
  const reg = mgr.getLiveRegistration(key, probeToolNames);
  const lines: string[] = [];

  const collisionLine = (verb: string): string =>
    `   Name collision: ${reg.shadowed.length} of its tool name(s) ${verb} another server — ${sampleNames(
      reg.shadowed.map((t) => `${t.tool} → "${t.owner}"`),
    )}. MCP tool registration is last-writer-wins, so only one server can own a given name.`;

  if (!reg.connected) {
    if (!reg.knownAtStartup) {
      // Added since this session launched. Nothing is wrong: the tool set was
      // built before the server existed, so of course it isn't in it. Phrased
      // as a next step rather than a warning, because a caller that reads this
      // as failure deletes a config it just wrote correctly.
      lines.push(
        `   Not loaded in this session yet — it was added after startup, which is expected. Restart Bernard to use its tools.`,
      );
    } else {
      // In the config at launch and still not connected: this one really failed.
      lines.push(
        `   NOT loaded in this session: it was configured at startup but failed to connect${
          reg.error ? ` (${reg.error})` : ''
        }, so its tools are not callable here.`,
      );
    }
    if (reg.shadowed.length > 0) lines.push(collisionLine('are currently served by'));
    // A name collision needs a decision from the user either way; being
    // unloaded does not.
    return { actionNeeded: reg.knownAtStartup || reg.shadowed.length > 0, lines };
  }

  // Connected live — report how the probe's tools actually resolve right now.
  if (reg.shadowed.length === 0 && reg.missing.length === 0) {
    lines.push(`   Live: all ${reg.live.length} tool(s) are active in this session.`);
    return { actionNeeded: false, lines };
  }
  lines.push(
    `   Live: only ${reg.live.length} of ${probeToolNames.length} probed tool(s) route to "${key}" in this session.`,
  );
  if (reg.shadowed.length > 0) lines.push(collisionLine('are shadowed by'));
  if (reg.missing.length > 0) {
    lines.push(
      `   ${reg.missing.length} not in this session's tool set (restart to refresh): ${sampleNames(reg.missing)}.`,
    );
  }
  return { actionNeeded: true, lines };
}

/**
 * The first line of every `mcp_verify` result: one unambiguous verdict.
 *
 * The output used to open with `✓ … connected` and then append a `⚠` block, so
 * a healthy just-added server produced a result that read as both success and
 * warning at once. An agent scanning it concluded the add had failed, removed
 * the config it had just written correctly, and spent the rest of its step
 * budget hunting a transport problem that never existed. A caller should not
 * have to weigh a ✓ against a ⚠ to learn whether the thing worked, so the
 * verdict is stated once, first, in words — and the detail lines below it are
 * indented context, never a competing signal.
 */
function buildVerdict(key: string, actionNeeded: boolean): string {
  return actionNeeded
    ? `⚠ VERDICT: "${key}" is configured and the server itself works, but this session needs attention — see below.`
    : `✓ VERDICT: "${key}" is correctly configured and working. No further action needed; do not re-add or remove it.`;
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
          const { actionNeeded, lines } = liveStateReport(key, r.toolNames);
          return [
            buildVerdict(key, actionNeeded),
            `   Probe: connected in ${r.durationMs}ms — ${r.toolCount} tool(s)${sample ? `: ${sample}${more}` : ''}.`,
            ...lines,
          ].join('\n');
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
        return `✗ VERDICT: "${key}" failed to connect after ${r.durationMs}ms${r.timedOut ? ' [timed out]' : ''}: ${r.error}${liveNote}`;
      },
    }),
    {
      // A read-only diagnostic probe: it spawns the *user's own configured*
      // server briefly and only lists tools (no tool is invoked).
      name: 'mcp_verify',
      kind: 'read',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
    },
  );
}
