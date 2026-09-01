import { tool } from 'ai';
import { z } from 'zod';
import { getMCPServer, verifyMCPServer, getActiveMCPManager } from '../mcp.js';
import { attachMeta } from '../framework/tools/adapter.js';
import { nameList } from '../text.js';

/**
 * Reconciles a successful fresh probe against the tools actually wired into the
 * running session, so "healthy" reflects what the agent can really call — not
 * just what an isolated spawn reports. `actionNeeded` decides the verdict line
 * and is deliberately **false** for a server that simply hasn't been loaded
 * yet; see `LiveRegistration.knownAtStartup` in `mcp.ts`.
 */
function liveStateReport(
  key: string,
  probeToolNames: string[],
): { actionNeeded: boolean; lines: string[] } {
  const mgr = getActiveMCPManager();
  if (!mgr) return { actionNeeded: false, lines: [] };
  const reg = mgr.getLiveRegistration(key, probeToolNames);
  const lines: string[] = [];

  if (!reg.connected) {
    if (!reg.knownAtStartup) {
      // Added since this session launched. Nothing is wrong: the tool set was
      // built before the server existed. Phrased as a next step rather than a
      // warning — see `LiveRegistration.knownAtStartup` for why that matters.
      lines.push(
        `   Not loaded in this session yet — it was added after startup, which is expected. Restart Bernard to use its tools.`,
      );
    } else {
      lines.push(
        `   NOT loaded in this session: it was configured at startup but failed to connect${
          reg.error ? ` (${reg.error})` : ''
        }, so its tools are not callable here.`,
      );
    }
  } else if (reg.missing.length > 0) {
    lines.push(
      `   Live: only ${reg.live.length} of ${probeToolNames.length} probed tool(s) route to "${key}" in this session.`,
    );
  } else {
    lines.push(`   Live: all ${reg.live.length} tool(s) are active in this session.`);
  }

  if (reg.connected && reg.missing.length > 0) {
    lines.push(
      `   ${reg.missing.length} not in this session's tool set (restart to refresh): ${nameList(reg.missing, 8)}.`,
    );
  }

  // One place that says what "needs attention" means. A pending restart does
  // not: the caller has nothing to decide. A startup failure does.
  //
  // Name collisions used to count here too. Since #413 each server registers
  // its tools under a key carrying that server's own hash, so one server's
  // tool can no longer be routed to another and there is nothing left to
  // report — the case is unrepresentable rather than merely rare.
  const actionNeeded = reg.connected ? reg.missing.length > 0 : reg.knownAtStartup;
  return { actionNeeded, lines };
}

/**
 * The first line of every `mcp_verify` result: one unambiguous verdict.
 *
 * The output used to open with `✓ … connected` and then append a `⚠` block, so
 * a healthy just-added server produced a result that read as success and
 * warning at once. An agent scanning it concluded the add had failed, removed
 * the config it had just written correctly, and spent the rest of its step
 * budget hunting a transport problem that never existed. A caller should not
 * have to weigh a ✓ against a ⚠ to learn whether the thing worked.
 *
 * All three states mint here so the rule holds on every exit — the failure
 * branch previously opened `✗ …` and then appended its own `✓ Note: … IS
 * currently loaded`, which is the same two-symbol conflict in the branch where
 * the good news is furthest from the leading glyph.
 */
type VerifyVerdict = 'ok' | 'attention' | 'failed';

function buildVerdict(key: string, verdict: VerifyVerdict, detail = ''): string {
  switch (verdict) {
    case 'ok':
      return `✓ VERDICT: "${key}" is correctly configured and working. No further action needed; do not re-add or remove it.`;
    case 'attention':
      return `⚠ VERDICT: "${key}" is configured and the server itself works, but this session needs attention — see below.`;
    case 'failed':
      return `✗ VERDICT: "${key}" failed to connect${detail}.`;
  }
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
        "Test-connect a configured MCP server WITHOUT restarting Bernard. Spawns/connects it with a timeout, lists its tools, and reconciles the probe against THIS running session (loaded or not; tools callable or missing). Always run this after adding or editing an MCP server. READ THE FIRST LINE: every result opens with a single 'VERDICT:' line and that line alone decides the outcome — '\u2713 VERDICT' means the server is correctly configured and you must NOT re-add or remove it, '\u26a0 VERDICT' means it works but something needs a decision (such as a startup failure), '\u2717 VERDICT' means it genuinely could not connect. The indented lines below are supporting detail, never a second verdict. A server you just added is normally not loaded in the current session yet; that is expected and is NOT a failure \u2014 it only needs a Bernard restart.",
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
            buildVerdict(key, actionNeeded ? 'attention' : 'ok'),
            `   Probe: connected in ${r.durationMs}ms — ${r.toolCount} tool(s)${sample ? `: ${sample}${more}` : ''}.`,
            ...lines,
          ].join('\n');
        }
        // The probe failed, but the server may still be loaded live — a cold
        // `npx` start can time out on a fresh spawn while the session (warmed
        // at launch) has it. That makes the verdict `attention`, not `failed`:
        // the tools are callable right now, so reporting a failure would send
        // the caller to fix something that is working.
        const status = getActiveMCPManager()
          ?.getServerStatuses()
          .find((s) => s.name === key);
        const loadedLive = status?.connected === true && status.toolCount > 0;
        const probeDetail = ` after ${r.durationMs}ms${r.timedOut ? ' [timed out]' : ''}: ${r.error}`;
        if (loadedLive) {
          return [
            buildVerdict(key, 'attention'),
            `   Probe failed${probeDetail}.`,
            `   But "${key}" IS currently loaded in this session (${status.toolCount} tool(s)) — the fresh cold-start is just slower than the probe timeout. Its tools are callable now.`,
          ].join('\n');
        }
        return buildVerdict(key, 'failed', probeDetail);
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
