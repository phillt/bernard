#!/usr/bin/env node
/**
 * A minimal, dependency-free MCP server over stdio, for
 * `src/__tests__/mcp-tool-schema.integration.test.ts`.
 *
 * It exists because `@modelcontextprotocol/sdk` is NOT a dependency of this
 * repo (`@ai-sdk/mcp` ships a client and transports, no server), and adding one
 * to assert an interop property would make the assertion depend on a second
 * vendor's idea of the protocol. The protocol surface a tool listing needs is
 * three JSON-RPC methods, so it is cheaper and more honest to speak them
 * directly: whatever this writes on the wire is what a real server writes.
 *
 * `TOOL_SCHEMA` is deliberately non-trivial — a nested object, an enum, two
 * `required[]` arrays and `additionalProperties: false` — because the property
 * under test is that Bernard's `convertTool` shim is a pure passthrough, and a
 * flat `{type:'object'}` would survive almost any transformation.
 *
 * Note `@ai-sdk/mcp` re-emits `{...inputSchema, properties, additionalProperties:
 * false}`, so a server declaring `additionalProperties: true` would NOT round
 * trip. That is the client's transform, not Bernard's, and declaring `false`
 * here keeps this test measuring the one thing it is named for.
 */

const PROTOCOL_VERSION = '2025-06-18';

export const TOOL_NAME = 'search_archive';

export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to look for.' },
    mode: { type: 'string', enum: ['fast', 'thorough'] },
    filters: {
      type: 'object',
      properties: {
        since: { type: 'string', format: 'date' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['since'],
      additionalProperties: false,
    },
  },
  required: ['query', 'mode'],
  additionalProperties: false,
};

const TOOL_DESCRIPTION = 'Search the archive.';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handle(request) {
  // A notification carries no `id` and must never be answered.
  if (request.id === undefined) return;

  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'bernard-schema-fixture', version: '1.0.0' },
      },
    });
    return;
  }

  if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA }],
      },
    });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: request.id,
    error: { code: -32601, message: `Method not found: ${request.method}` },
  });
}

// Only run the server when executed as a script. The test imports this module
// for `TOOL_NAME` / `TOOL_SCHEMA`, and an import must not start reading stdin.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        // A malformed line is the harness's problem, not this server's.
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
