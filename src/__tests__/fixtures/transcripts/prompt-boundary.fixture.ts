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
      // Positive control: the prompt DOES surface the active model context, so
      // the excludes above aren't passing vacuously. Since #264 that context is
      // the orchestrator lineup ladder ("Active lineup: …"), not a flat
      // "model: <id>" line, so we assert the stable marker rather than a
      // concrete (catalog-dependent) model id.
      type: 'system_prompt_includes_when',
      condition: { provider: 'anthropic' },
      substring: 'Active lineup:',
    },
  ],
});
