import { defineFixture } from '../fixture-schema.js';

/**
 * Issue #171 — write-effecting tools must never cache; deterministic +
 * side-effect-free tools round-trip cleanly; LLM cache keys partition on
 * `modelId` (so a model-mode #170 retier never poisons cache from a
 * different tier).
 */
export const cachingFixture = defineFixture({
  name: 'caching',
  category: 'caching',
  invariants: [
    {
      type: 'tool_cache_excluded_when_write',
      meta: {
        name: 'fake_shell',
        kind: 'write',
        sideEffect: 'local',
        deterministic: false,
      },
    },
    {
      type: 'tool_cache_deterministic',
      meta: {
        name: 'fake_datetime',
        kind: 'inert',
        sideEffect: 'none',
        deterministic: true,
      },
      args: { format: 'iso' },
    },
    {
      type: 'llm_cache_key_partitions',
      keyA: {
        siteName: 'rewriter',
        modelId: 'anthropic:claude-haiku-4-5-20251001',
        system: 'sys',
        userContent: 'u',
      },
      keyB: {
        siteName: 'rewriter',
        modelId: 'anthropic:claude-sonnet-4-5-20250929',
        system: 'sys',
        userContent: 'u',
      },
    },
  ],
});
