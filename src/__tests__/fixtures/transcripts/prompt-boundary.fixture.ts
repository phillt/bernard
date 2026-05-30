import { defineFixture } from '../fixture-schema.js';

/**
 * Issue #172 — the SYSTEM prompt must never carry per-turn dynamic data
 * (memory, scratch, recalled RAG context, MCP server lists, etc.). Those
 * arrive as a `role:'user'` message built by `buildContextMessage`.
 *
 * If `buildSystemPrompt` ever starts injecting one of these substrings,
 * `system_prompt_excludes` fires immediately and names exactly what leaked.
 */
export const promptBoundaryFixture = defineFixture({
  name: 'prompt-boundary',
  category: 'prompt-boundary',
  invariants: [
    {
      type: 'system_prompt_excludes',
      substrings: [
        '## Persistent Memory',
        '## Scratch Notes',
        '## Recalled Context',
        '## Resolved References',
        'Currently connected MCP servers:',
        'Available specialist agents',
        'Saved routines the user can invoke',
      ],
    },
    {
      type: 'system_prompt_includes_when',
      condition: {},
      substring: '## MCP Servers',
    },
    {
      type: 'system_prompt_includes_when',
      condition: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      substring: 'claude-sonnet-4-5-20250929',
    },
  ],
});
