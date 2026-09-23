import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import { buildReviewBrief } from './applet-review.js';

/**
 * The review pass had no code wiring at all until now.
 *
 * `create` called the styler through `applet-styling.ts` and nothing called
 * the reviewer, so an applet was checked only when the main agent happened to
 * choose to. That is why "everybody approved it" was weaker than it sounded:
 * sometimes nobody did.
 */
describe('buildReviewBrief', () => {
  it('names the applet and every action to exercise', () => {
    const brief = buildReviewBrief({ id: 'notes', name: 'Notes', actions: ['save', 'clear'] });
    expect(brief).toContain('notes');
    expect(brief).toContain('save, clear');
  });

  it('says plainly when there is nothing to invoke', () => {
    // An applet with no actions is a real shape — a page over its own store.
    // Telling the reviewer to exercise nothing is how it reports `skipped`
    // for actions that do not exist.
    const brief = buildReviewBrief({ id: 'x', name: 'X', actions: [] });
    expect(brief).toContain('no actions');
    expect(brief).not.toContain('Actions to exercise');
  });
});

describe('a created applet is reviewed', () => {
  useTempHome('bernard-applet-review');

  const PAGE = [
    '<link rel="stylesheet" href="/__bernard/tokens.css" />',
    '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
    '<script src="/__bernard/applet.js"></script>',
    '<main><button id="go">Go</button></main>',
    "<script>document.getElementById('go').addEventListener('click', () => bernard.invoke('summarise'));</script>",
  ].join('\n');

  const CREATE = {
    action: 'create' as const,
    id: 'notes',
    name: 'Notes',
    description: 'Keeps short notes.',
    page: PAGE,
    actions: {
      summarise: {
        dispatch: {
          kind: 'agent' as const,
          specialistId: 'web-wrapper',
          instructions: 'Summarise.',
        },
      },
    },
  };

  async function load(review?: unknown, flags: Record<string, boolean> = {}) {
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({
        autoReviewApplets: true,
        autoStyleApplets: false,
        autoOpenApplets: false,
        ...flags,
      }),
    }));
    const { createAppletTool } = await import('./applet.js');
    const { AppRegistry } = await import('../apps/registry.js');
    return createAppletTool(
      new AppRegistry({ seed: false }),
      review ? { review: review as never } : {},
    );
  }

  it('runs the review and reports what it found', async () => {
    const review = vi.fn(async () => ({ reviewed: true, summary: '1/1 action(s) ran' }));
    const tool = await load(review);
    const out = String(await tool.execute(CREATE, {} as never));

    expect(review).toHaveBeenCalledTimes(1);
    // The target carries what the reviewer needs to exercise it.
    expect(review.mock.calls[0][0]).toMatchObject({ id: 'notes', actions: ['summarise'] });
    expect(out).toContain('Reviewed');
  });

  it('names the reason when the review does not run', async () => {
    // Swallowing it is the state this wiring exists to end: an applet
    // reported as built and silently never checked.
    const review = vi.fn(async () => ({ reviewed: false, reason: 'pool_exhausted' }));
    const tool = await load(review);
    const out = String(await tool.execute(CREATE, {} as never));
    expect(out).toContain('Not reviewed (pool_exhausted)');
    // And says what to do instead, since the applet is already on disk.
    expect(out).toContain('bernard app check notes');
  });

  it('still creates the applet when the review throws', async () => {
    // Its own try, for the reason `styleNote` has one: the applet is on disk
    // and already open by this point, so a throw reaching `execute`'s catch
    // would report a create that SUCCEEDED as `Error:` — telling the model to
    // retry one that would then fail as "already exists".
    const review = vi.fn(async () => {
      throw new Error('boom');
    });
    const tool = await load(review);
    const out = String(await tool.execute(CREATE, {} as never));
    expect(out).toContain('created');
    expect(out).not.toMatch(/^Error:/);
    expect(out).toContain('boom');
  });

  it('does not review when the setting is off', async () => {
    const review = vi.fn(async () => ({ reviewed: true, summary: 'x' }));
    const tool = await load(review, { autoReviewApplets: false });
    await tool.execute(CREATE, {} as never);
    expect(review).not.toHaveBeenCalled();
  });
});

/**
 * The recursion guard, asserted against the registry `createTools` really
 * returns — the shape `applet-planning.test.ts` and `applet-styling.test.ts`
 * both use, and for their reason: the guard is a property of WHERE the tool
 * is constructed, which is exactly what a later tidy-up removes.
 */
describe('the review recursion guard', () => {
  useTempHome('bernard-applet-review-guard');

  it('the applet tool createTools builds cannot review', async () => {
    vi.resetModules();
    const dispatch = vi.fn(async () => ({ status: 'ok', result: 'reviewed' }));
    vi.doMock('./tool-wrapper-run.js', () => ({
      dispatchToolWrapper: dispatch,
      createToolWrapperRunTool: () => ({}),
    }));
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({
        autoReviewApplets: true,
        autoStyleApplets: false,
        autoOpenApplets: false,
        appletPlanning: false,
      }),
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

    const page = [
      '<link rel="stylesheet" href="/__bernard/tokens.css" />',
      '<link rel="manifest" href="/__bernard/manifest.webmanifest" />',
      '<script src="/__bernard/applet.js"></script>',
      '<main><button id="go">Go</button></main>',
      "<script>document.getElementById('go').addEventListener('click', () => bernard.invoke('go'));</script>",
    ].join('\n');
    const out = String(
      await tools.applet.execute(
        {
          action: 'create',
          id: 'guard',
          name: 'Guard',
          description: 'x',
          page,
          actions: {
            go: {
              dispatch: {
                kind: 'agent',
                specialistId: 'web-wrapper',
                instructions: 'Go.',
              },
            },
          },
        },
        {} as never,
      ),
    );

    // Asserted on the OUTPUT, not only on `dispatchToolWrapper`: any reviewer
    // wired into `createTools` — through this module or another route — leaves
    // a verdict here, so this catches the class rather than one function.
    expect(out).toContain('created');
    expect(out).not.toContain('Reviewed');
    expect(out).not.toContain('Not reviewed');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

/**
 * A review that FOUND problems is a review that ran.
 *
 * Measured on the first real pipeline run: the reviewer invoked all ten
 * actions, found six failing for want of tool grants, completed all five
 * named passes — and every word of it was discarded, because the dispatch
 * came back `status: 'error'` and that was read as the REVIEW failing rather
 * than the APPLET being broken. `create` duly said "Not reviewed … run
 * `bernard app check` yourself" about a review that had just run it.
 */
describe('a failing applet is not a failed review', () => {
  const load = async (wrapped: unknown) => {
    vi.resetModules();
    vi.doMock('./tool-wrapper-run.js', () => ({ dispatchToolWrapper: vi.fn(async () => wrapped) }));
    const { makeAppletReviewer } = await import('./applet-review.js');
    return makeAppletReviewer({} as never)({ id: 'x', name: 'X', actions: ['a'] });
  };

  const VERDICT = {
    checked: [
      { action: 'a', verdict: 'fail', detail: 'missing file tools' },
      { action: 'b', verdict: 'pass', detail: '' },
    ],
    findings: [{ pass: 'usability', severity: 'low', detail: 'fine' }],
  };

  it('reports a verdict that found failures as reviewed', async () => {
    const out = await load({ status: 'error', result: VERDICT });
    expect(out.reviewed).toBe(true);
    if (!out.reviewed) return;
    expect(out.summary).toContain('1/2 action(s) ran');
  });

  it('still reports a genuinely failed dispatch as not reviewed', async () => {
    // The discriminator is the SHAPE, not the status: a pool exhaustion, a
    // step limit or a parse failure produces no verdict, so none of them can
    // be laundered into a review that happened.
    const out = await load({ status: 'error', result: 'pool full', error: 'pool_exhausted' });
    expect(out.reviewed).toBe(false);
    if (out.reviewed) return;
    expect(out.reason).toContain('pool_exhausted');
  });

  it('does not accept an object that is not a verdict', async () => {
    // The discriminator has to be the FIELDS, not "is it an object" — a
    // wrapper parse failure returns an object too, and treating that as a
    // completed review would report a dispatch that produced nothing as one
    // that checked the applet. Measured: a `result: {}` slipped through an
    // earlier cut of this test, because the failure fixture was a string.
    const out = await load({
      status: 'error',
      result: { note: 'nothing usable' },
      error: 'parse_failed',
    });
    expect(out.reviewed).toBe(false);
    if (out.reviewed) return;
    expect(out.reason).toContain('parse_failed');
  });

  it('reports a clean run as reviewed', async () => {
    const out = await load({
      status: 'ok',
      result: { checked: [{ action: 'a', verdict: 'pass' }] },
    });
    expect(out.reviewed).toBe(true);
  });
});
