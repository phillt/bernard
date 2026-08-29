import { describe, it, expect } from 'vitest';
import { toolFailureFor } from '../output-sink.js';
import { failureMarker } from '../../../error-taxonomy.js';

/**
 * `toolFailureFor` is the single builder both sink emitters use, so the
 * streaming path (`framework/agents/run.ts`) and the bulk one
 * (`framework/hooks/output.ts`) cannot disagree about what a failure means.
 */
describe('toolFailureFor', () => {
  it('returns nothing for a successful result', () => {
    expect(toolFailureFor('shell', { output: 'ok', is_error: false })).toBeUndefined();
  });

  it('classifies an in-band shell failure and carries the USER playbook', () => {
    const f = toolFailureFor('shell', { output: 'bash: nope: command not found', is_error: true });
    expect(f).toBeDefined();
    expect(f!.category).toBe('not_found');
    // The user-facing line, not `playbook.model` — the whole point of #353.
    expect(f!.hint).not.toMatch(/Re-issue|Do not retry/);
    expect(f!.hint.length).toBeGreaterThan(0);
  });

  it('honours an embedded marker over the prose', () => {
    // A shim-routed result already carries the classifier's verdict; re-running
    // the patterns on the playbook text would mis-read it.
    const f = toolFailureFor('shell', {
      output: `Error (${failureMarker('auth')} Authentication failed. Do not retry.): x`,
      is_error: true,
    });
    expect(f!.category).toBe('auth');
    expect(f!.severity).toBe('critical');
  });

  it('works for MCP-shaped failures too, not just the shimmed tools', () => {
    const f = toolFailureFor('browser_click', {
      content: [{ type: 'text', text: 'WebSocket is not open' }],
      isError: true,
    });
    expect(f).toBeDefined();
  });
});
