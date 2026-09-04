import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import type { AgentContext } from '../framework/context.js';

/**
 * Loads the module under test with `dispatchToolWrapper` replaced, so these
 * tests exercise the routing decision rather than an agent run.
 */
async function load(dispatch: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock('./tool-wrapper-run.js', () => ({ dispatchToolWrapper: dispatch }));
  return await import('./applet-styling.js');
}

const TARGET = {
  id: 'mood-log',
  name: 'Mood Log',
  description: 'Record a mood and a note.',
  actions: ['record', 'summary'],
};

const CTX = {} as AgentContext;

describe('makeAppletStyler', () => {
  it('dispatches the bundled styler and reports success', async () => {
    const dispatch = vi.fn(async () => ({ status: 'ok', result: 'Rewrote the page.' }));
    const { makeAppletStyler, STYLER_SPECIALIST_ID } = await load(dispatch);

    const outcome = await makeAppletStyler(CTX)(TARGET);

    expect(outcome).toEqual({ styled: true, summary: 'Rewrote the page.' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [args, ctx] = dispatch.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(args.specialistId).toBe(STYLER_SPECIALIST_ID);
    expect(ctx).toBe(CTX);
  });

  it('forwards the fields the dispatch needs', async () => {
    const dispatch = vi.fn(async () => ({ status: 'ok', result: '' }));
    const { makeAppletStyler } = await load(dispatch);

    await makeAppletStyler(CTX)(TARGET);
    const args = (dispatch.mock.calls[0] as [Record<string, unknown>])[0];

    // `applet-styler` is a bundled `tool-wrapper` whose `targetTools[0]` is
    // `applet` — exactly the shape `dispatchToolWrapper` enqueues for — and
    // bundled records accept appended examples. A pass that failed because the
    // pool was full must not teach a shipped specialist. The omission is
    // invisible at runtime, which is why it is asserted rather than trusted.
    expect(args.skipCorrectionEnqueue).toBe(true);
    // Names the applet, so the extra seconds on screen are explained.
    expect(args.runLabel).toBe('[style] Mood Log');
  });

  it('reports the error CODE, which is what a reader acts on', async () => {
    const dispatch = vi.fn(async () => ({
      status: 'error',
      result: 'Agent pool is full.',
      error: 'pool_exhausted',
    }));
    const { makeAppletStyler } = await load(dispatch);

    expect(await makeAppletStyler(CTX)(TARGET)).toEqual({
      styled: false,
      reason: 'pool_exhausted',
    });
  });

  it('falls back to the message when the dispatch reports no code', async () => {
    const dispatch = vi.fn(async () => ({ status: 'error', result: 'something went wrong' }));
    const { makeAppletStyler } = await load(dispatch);

    expect(await makeAppletStyler(CTX)(TARGET)).toEqual({
      styled: false,
      reason: 'something went wrong',
    });
  });

  it('never throws — a thrown dispatch becomes an outcome', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('boom');
    });
    const { makeAppletStyler } = await load(dispatch);

    expect(await makeAppletStyler(CTX)(TARGET)).toEqual({ styled: false, reason: 'boom' });
  });

  it('reports a cancelled turn as cancelled, not as a styling failure', async () => {
    // The applet is already written when this runs, so an Esc must not take
    // the create down with it.
    const dispatch = vi.fn(async () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    });
    const { makeAppletStyler } = await load(dispatch);

    expect(await makeAppletStyler(CTX)(TARGET)).toEqual({ styled: false, reason: 'cancelled' });
  });

  it("forwards the call's abort signal, so an Esc reaches the dispatch", async () => {
    // Per call, not per construction: the tool is built once a turn. Without
    // this the styler's whole sub-agent run — seconds and a paid completion —
    // outlives a cancelled turn with its output discarded.
    const dispatch = vi.fn(async () => ({ status: 'ok', result: '' }));
    const { makeAppletStyler } = await load(dispatch);
    const controller = new AbortController();
    const styler = makeAppletStyler(CTX);

    await styler(TARGET);
    await styler(TARGET, controller.signal);

    const first = (dispatch.mock.calls[0] as [Record<string, unknown>])[0];
    const second = (dispatch.mock.calls[1] as [Record<string, unknown>])[0];
    expect('abortSignal' in first).toBe(false);
    expect(second.abortSignal).toBe(controller.signal);
  });
});

describe('buildStyleBrief', () => {
  it('names the update call the styler already knows', async () => {
    const { buildStyleBrief } = await load(vi.fn());
    const brief = buildStyleBrief(TARGET);

    // Its own `goodExample` calls `applet update {id, page}`; the brief agrees
    // with the record rather than competing with it.
    expect(brief).toContain('"action":"update"');
    expect(brief).toContain('"id":"mood-log"');
  });

  it('lists every declared action, since each needs a control', async () => {
    const { buildStyleBrief } = await load(vi.fn());
    const brief = buildStyleBrief(TARGET);

    expect(brief).toContain('`record`');
    expect(brief).toContain('`summary`');
  });

  it('says so plainly when there are no actions', async () => {
    const { buildStyleBrief } = await load(vi.fn());

    expect(buildStyleBrief({ ...TARGET, actions: [] })).toContain('none');
  });
});

/**
 * The recursion guard, asserted against the registry `createTools` really
 * returns.
 *
 * `applet-styler` writes by calling `applet update`, and it does receive an
 * `applet` tool — `dispatchToolWrapper` builds its registry at `surface:
 * 'full'` and `buildChildTools` keeps `applet` because `targetTools` names it.
 * Nothing stops that call re-entering the design pass except the fact that
 * `createTools` has no `AgentContext` and therefore builds a styler-less
 * `applet`; only `main.ts`'s override can dispatch.
 *
 * That makes the guard a property of WHERE the tool is constructed, which is
 * exactly the kind of thing a later refactor tidies away. Moving the override
 * into `createTools` must fail here rather than hang a session, so the
 * assertion drives the real factory rather than restating the argument.
 */
describe('the recursion guard', () => {
  useTempHome('bernard-applet-styling-guard');

  it('the applet tool createTools builds cannot style', async () => {
    vi.resetModules();
    const dispatch = vi.fn(async () => ({ status: 'ok', result: '' }));
    vi.doMock('./tool-wrapper-run.js', () => ({
      dispatchToolWrapper: dispatch,
      createToolWrapperRunTool: () => ({}),
    }));
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ autoStyleApplets: true, autoOpenApplets: false }),
    }));
    vi.doMock('../memory.js', () => ({
      MemoryStore: class {
        list() {
          return [];
        }
        read() {
          return null;
        }
      },
    }));

    const { createTools } = await import('./index.js');
    const { MemoryStore } = await import('../memory.js');
    const tools = await createTools(
      { shellTimeout: 10_000, confirmDangerous: async () => false },
      new MemoryStore() as never,
    );

    // A scan over an absent tool passes vacuously — the failure #452 shipped.
    expect(tools.applet).toBeDefined();

    const out = await tools.applet.execute(
      {
        action: 'create',
        id: 'guard-check',
        name: 'Guard',
        description: 'Checks that a nested create cannot style.',
        actions: {
          ping: {
            dispatch: { kind: 'agent', specialistId: 'web-wrapper', instructions: 'Ping.' },
          },
        },
        page: [
          '<title>Guard</title>',
          '<link rel="stylesheet" href="/__bernard/tokens.css" />',
          '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
          '<script src="/__bernard/applet.js"></script>',
          '<main><button id="go">Go</button></main>',
          "<script>document.getElementById('go').addEventListener('click', () => bernard.invoke('ping'));</script>",
        ].join('\n'),
      },
      {} as never,
    );

    // The create has to SUCCEED for the assertion below to mean anything: a
    // refused create never reaches the styling step, so "never dispatched"
    // would be true for the wrong reason.
    expect(out).toContain('created');
    // Asserted on the OUTPUT, not only on `dispatchToolWrapper`: any styler
    // wired into `createTools` — through this module or any other route —
    // folds a note into the create result, so this catches the class rather
    // than one function. (Mutation-checked: passing a styler into
    // `createTools` fails this line; asserting the dispatch alone did not.)
    expect(out).not.toContain('Styled');
    expect(out).not.toContain('default page');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
