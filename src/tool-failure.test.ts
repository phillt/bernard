import { describe, it, expect } from 'vitest';
import { toolFailureFor } from './tool-failure.js';
import { failureMarker } from './error-taxonomy.js';

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

  it('finds a marker inside the detected snippet', () => {
    // The marker's authority over the patterns is pinned in
    // `error-taxonomy.test.ts`; what is this layer's own is that
    // `detectToolError` surfaces the snippet the marker lives in.
    const f = toolFailureFor('shell', {
      output: `Error (${failureMarker('rate_limit')} slow down): x`,
      is_error: true,
    });
    expect(f!.category).toBe('rate_limit');
  });

  it('works for MCP-shaped failures too, not just the shimmed tools', () => {
    const f = toolFailureFor('browser_click', {
      content: [{ type: 'text', text: 'WebSocket is not open' }],
      isError: true,
    });
    expect(f).toBeDefined();
  });
});
