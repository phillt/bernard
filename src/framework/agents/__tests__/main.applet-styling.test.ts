import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../../../__tests__/temp-home.js';
import type { AgentContext } from '../../context.js';

/**
 * The main agent is the ONLY place the applet design pass is wired in, which
 * makes deleting that one line invisible: every other test still passes, the
 * recursion-guard test passes *harder*, and applets quietly go back to
 * shipping the scaffold. So the guard has a positive counterpart — main's
 * `applet` must be able to style, asserted the same behavioural way, through
 * the real definition rather than by reading the source.
 */
async function mainApplet(dispatch: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock('../../../tools/tool-wrapper-run.js', () => ({
    dispatchToolWrapper: dispatch,
    createToolWrapperRunTool: () => ({}),
  }));
  vi.doMock('../../../config.js', () => ({
    loadConfig: () => ({ autoStyleApplets: true, autoOpenApplets: false }),
  }));

  const { mainAgentDefinition } = await import('../main.js');
  const { resolveToolSurface } = await import('../tool-surface.js');

  const noopStore = new Proxy({}, { get: () => () => [] });
  const ctx = {
    config: { coordinatorMode: 'off', maxSteps: 25, promptCache: false, customProviders: {} },
    toolOptions: {},
    mcp: { tools: {}, serverNames: [], serverTools: new Map() },
    stores: {
      memory: { clearScratch: () => {}, list: () => [] },
      routines: noopStore,
      specialists: noopStore,
      candidates: noopStore,
      toolProfiles: { list: () => [] },
    },
    verification: { record: () => {} },
  } as unknown as AgentContext;

  const input = { planStore: {}, systemPrompt: '' } as never;
  const tools = await mainAgentDefinition.tools(
    ctx,
    input,
    resolveToolSurface(ctx, mainAgentDefinition),
  );
  return tools.applet as { execute: (a: unknown, b: unknown) => Promise<string> };
}

const CREATE = {
  action: 'create',
  id: 'main-wired',
  name: 'Wired',
  description: 'Checks that main wires the design pass.',
  page: [
    '<title>Wired</title>',
    '<link rel="stylesheet" href="/__bernard/tokens.css" />',
    '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
    '<script src="/__bernard/applet.js"></script>',
    '<main><button id="go">Go</button></main>',
    "<script>document.getElementById('go').addEventListener('click', () => bernard.invoke('ping'));</script>",
  ].join('\n'),
  actions: {
    ping: { dispatch: { kind: 'agent', specialistId: 'web-wrapper', instructions: 'Ping.' } },
  },
};

describe('the main agent wires the applet design pass', () => {
  useTempHome('bernard-main-applet-styling');

  it('creating an applet through main dispatches the styler', async () => {
    const dispatch = vi.fn(async () => ({ status: 'ok', result: 'Rewrote the layout.' }));
    const applet = await mainApplet(dispatch);

    const out = await applet.execute(CREATE, {} as never);

    // The create must succeed, or "styled" would be absent for the wrong
    // reason — the vacuous-pass shape this file exists to avoid.
    expect(out).toContain('created');
    expect(out).toContain('Styled it: Rewrote the layout.');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0] as [Record<string, unknown>])[0].specialistId).toBe(
      'applet-styler',
    );
  });
});
