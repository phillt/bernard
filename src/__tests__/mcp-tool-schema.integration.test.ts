/**
 * An MCP server's JSON Schema reaches the provider unchanged (#sdk-boundary).
 *
 * `MCPManager.convertTool` exists to bridge one version skew: `@ai-sdk/mcp@1.x`
 * returns `{type:'dynamic', inputSchema}` and `ai@4.x` wants
 * `{parameters: jsonSchema(...)}`. It is a shim, and the follow-up SDK bump
 * deletes it — at which point the only question that matters is whether the
 * schema a server declared still arrives at the model intact.
 *
 * Nothing in the type system can answer that. `src/mcp.ts` is `any` end to end
 * through this path (`convertTool(_name: string, tool: any): any`), so deleting
 * the shim produces no type error whether the deletion is right or wrong. A
 * runtime assertion over the real objects is the only thing that can license
 * it, which is why this test:
 *
 *   - speaks the MCP wire protocol to a REAL child process rather than mocking
 *     `@ai-sdk/mcp` (every other MCP test in this repo mocks the client, so all
 *     of them would pass with `convertTool` returning garbage);
 *   - does NOT `vi.mock('ai')`, because `generateText`'s own tool preparation
 *     is half of the path under test;
 *   - asserts DEEP EQUALITY against the server's declaration rather than
 *     spot-checking fields — a shim that dropped `required`, flattened the
 *     nested object or lost the enum would pass every spot check that happened
 *     not to name the thing it lost.
 *
 * No API key and no network: the model is `MockLanguageModelV1`, and the
 * "server" is `node src/__tests__/fixtures/mcp-schema-server.mjs`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { MCPManager } from '../mcp.js';
import { MCP_CONFIG_PATH } from '../paths.js';
import { TOOL_NAME, TOOL_SCHEMA } from './fixtures/mcp-schema-server.mjs';

const SERVER_PATH = fileURLToPath(new URL('./fixtures/mcp-schema-server.mjs', import.meta.url));
const SERVER_KEY = 'schema-fixture';

/** Writes an `mcp.json` in this test file's isolated BERNARD_HOME. */
function writeMcpConfig(): void {
  fs.mkdirSync(path.dirname(MCP_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    MCP_CONFIG_PATH,
    JSON.stringify({
      mcpServers: { [SERVER_KEY]: { command: process.execPath, args: [SERVER_PATH] } },
    }),
    'utf-8',
  );
}

/** The `tools` argument the SDK hands the provider, captured off `doGenerate`. */
interface CapturedFunctionTool {
  type: string;
  name: string;
  description?: string;
  parameters: unknown;
}

let manager: MCPManager | undefined;

afterEach(async () => {
  await manager?.close();
  manager = undefined;
});

describe('MCP tool schema interop', () => {
  it('delivers the server-declared JSON Schema to the provider unchanged', async () => {
    writeMcpConfig();
    manager = new MCPManager();
    await manager.connect();

    const tools = manager.getTools();
    const registryKey = Object.keys(tools).find((k) => k.endsWith(TOOL_NAME));
    // Guard the guard: without a connected server every assertion below would
    // be vacuous, and a spawn failure is silent (`connect` catches per server).
    expect(
      registryKey,
      `server did not connect; tools: ${Object.keys(tools).join(', ')}`,
    ).toBeDefined();

    let captured: CapturedFunctionTool[] | undefined;
    const model = new MockLanguageModelV1({
      provider: 'schema-probe',
      modelId: 'schema-probe-v1',
      doGenerate: async (options: { mode: unknown }) => {
        captured = (options.mode as { tools?: CapturedFunctionTool[] }).tools;
        return {
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1 },
          text: 'ok',
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });

    await generateText({
      model,
      tools: tools as Parameters<typeof generateText>[0]['tools'],
      messages: [{ role: 'user', content: 'schema probe' }],
    });

    const advertised = captured?.find((t) => t.name === registryKey);
    expect(
      advertised,
      `tool absent from doGenerate; saw: ${JSON.stringify(captured)}`,
    ).toBeDefined();
    // The whole point: byte-for-byte what the server declared, after
    // `@ai-sdk/mcp`'s wrapping, Bernard's `convertTool` re-wrapping, and the AI
    // SDK's own `asSchema` resolution.
    expect(advertised?.parameters).toEqual(TOOL_SCHEMA);
    expect(advertised?.type).toBe('function');
  }, 30_000);
});
