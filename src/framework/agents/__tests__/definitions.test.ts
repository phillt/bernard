import { describe, it, expect } from 'vitest';
import { definitions, registerBuiltinDefinitions } from '../index.js';

/**
 * Drift detector for the six kind-level agent definitions registered at
 * startup. Snapshots the stable fields (id, historyMode, repairLabel) so an
 * unintended addition / removal / renaming surfaces immediately. Per-instance
 * variation flows through TInput and is not snapshotted here.
 *
 * Correction is intentionally NOT a registered kind — it runs through
 * `tool_wrapper_run` against the bundled `correction-agent` specialist.
 */
describe('built-in agent definitions', () => {
  it('registers the expected six kinds with stable ids and history modes', () => {
    registerBuiltinDefinitions();
    const summary = definitions
      .ids()
      .sort()
      .map((id) => {
        const d = definitions.get(id);
        return {
          id: d.id,
          historyMode: d.historyMode,
          repairLabel: d.repairLabel,
        };
      });
    expect(summary).toEqual([
      { id: 'cron', historyMode: 'ephemeral', repairLabel: 'cron' },
      { id: 'main', historyMode: 'persistent', repairLabel: 'main' },
      { id: 'specialist', historyMode: 'ephemeral', repairLabel: 'specialist' },
      { id: 'sub', historyMode: 'ephemeral', repairLabel: 'subagent' },
      { id: 'task', historyMode: 'ephemeral', repairLabel: undefined },
      { id: 'tool-wrapper', historyMode: 'ephemeral', repairLabel: 'tool-wrapper' },
    ]);
  });

  it('registerBuiltinDefinitions is idempotent', () => {
    registerBuiltinDefinitions();
    const before = definitions.ids().sort();
    registerBuiltinDefinitions();
    const after = definitions.ids().sort();
    expect(after).toEqual(before);
  });
});
