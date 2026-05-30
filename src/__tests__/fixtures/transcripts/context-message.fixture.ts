import { defineFixture } from '../fixture-schema.js';

/**
 * Issue #172 — the per-turn context message must be a `role:'user'` payload
 * containing all dynamic data wrapped in `<system_provided_context>`. The
 * header escapes the wrapper tag as `&lt;system_provided_context&gt;` so a
 * naive substring scan against the literal open-tag finds exactly one
 * occurrence (the real wrapper), not two.
 */
export const contextMessageFixture = defineFixture({
  name: 'context-message',
  category: 'context-message',
  invariants: [
    {
      type: 'context_message_role_is_user',
      inputs: { mcpServerNames: ['sentinel-mcp'] },
    },
    {
      type: 'context_message_includes',
      inputs: { mcpServerNames: ['sentinel-mcp'] },
      substring: 'sentinel-mcp',
    },
    {
      type: 'context_message_includes',
      inputs: { mcpServerNames: ['sentinel-mcp'] },
      substring: '<connected_mcp_servers>',
    },
    {
      type: 'context_message_includes',
      inputs: { mcpServerNames: ['sentinel-mcp'] },
      substring: '&lt;system_provided_context&gt;',
    },
    {
      type: 'context_message_excludes',
      inputs: { mcpServerNames: ['<inject>nope</inject>'] },
      substring: '<inject>',
    },
  ],
});
