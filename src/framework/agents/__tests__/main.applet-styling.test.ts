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
  // `makeCtx` + `toolsOf` rather than a fourth hand-built context: that
  // fixture's own docstring says a per-file copy is how one drifts without any
  // test noticing, and its config comes from the repo's one cast-free
  // `BernardConfig` builder, so a new config field surfaces as a compile error
  // here instead of silently defaulting.
  const { makeCtx, toolsOf } = await import('./_mcp-delegation-fixture.js');

  // `overrides` is a shallow spread, so `stores` would be REPLACED wholesale —
  // dropping routines/specialists/candidates and silently changing what
  // `createTools` builds. Merge onto the fixture's own instead.
  const base = makeCtx(false);
  const ctx = {
    ...base,
    stores: {
      ...base.stores,
      // `main.ts` reads `memory.list` for the tool-profiles prompt; the
      // fixture's default memory store stops at `clearScratch`.
      memory: { clearScratch: () => {}, list: () => [] },
    },
  } as unknown as AgentContext;

  const input = { planStore: {}, systemPrompt: '' } as never;
  const tools = await toolsOf(mainAgentDefinition, ctx, input);
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

/**
 * The overlay `main` hands DOWN to a persona dispatch must not carry `applet`.
 *
 * This is the recursion guard, and it needs its own test because the sibling
 * one above uses a stand-in overlay built by the test — it can prove the filter
 * drops `applet`, and cannot see whether main put one in. Mutation-checked:
 * moving `applet` into `dispatchOverlay` in `main.ts` passes every other test
 * in the tree, including the two in this file, and fails only this one.
 */
describe("main's handed-down dispatch overlay", () => {
  useTempHome('bernard-main-dispatch-overlay');

  it('carries the four dispatch tools and never `applet`', async () => {
    vi.resetModules();
    // Capture the thunk `main.ts` passes to `createSpecialistRunTool` — that
    // object is exactly what a dispatched persona is offered.
    let handedDown: (() => Record<string, unknown>) | undefined;
    vi.doMock('../../../tools/specialist-run.js', () => ({
      createSpecialistRunTool: (_ctx: unknown, thunk?: () => Record<string, unknown>) => {
        handedDown = thunk;
        return {};
      },
    }));
    vi.doMock('../../../config.js', () => ({
      loadConfig: () => ({ autoStyleApplets: false, autoOpenApplets: false }),
    }));

    const { mainAgentDefinition } = await import('../main.js');
    const { makeCtx, toolsOf } = await import('./_mcp-delegation-fixture.js');
    const base = makeCtx(false);
    const ctx = {
      ...base,
      stores: { ...base.stores, memory: { clearScratch: () => {}, list: () => [] } },
    } as unknown as AgentContext;

    const tools = await toolsOf(mainAgentDefinition, ctx, {
      planStore: {},
      systemPrompt: '',
    } as never);

    // The positive half: main itself still has a styling-capable `applet`.
    expect(tools).toHaveProperty('applet');

    expect(handedDown, 'main did not hand an overlay down at all').toBeDefined();
    const overlay = Object.keys(handedDown!()).sort();
    expect(overlay).toEqual(['agent', 'specialist_run', 'task', 'tool_wrapper_run']);
    expect(overlay).not.toContain('applet');
  });
});
