import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import type { AgentContext } from '../framework/context.js';

/**
 * Loads the module with `dispatchToolWrapper` replaced, so these exercise the
 * orchestration decision rather than three agent runs. Same idiom as
 * `applet-styling.test.ts`.
 */
async function load(dispatch: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock('./tool-wrapper-run.js', () => ({ dispatchToolWrapper: dispatch }));
  return await import('./applet-planning.js');
}

const TARGET = {
  name: 'Blood Pressure Log',
  description: 'Record a reading and see the recent ones.',
  intent: { goal: 'keep track of my readings', input: 'two numbers from the cuff' },
};

const CTX = {} as AgentContext;

/** `dispatchToolWrapper` resolving `ok` with a per-specialist body. */
const okWith = (bodies: Record<string, unknown>) =>
  vi.fn(async ({ specialistId }: { specialistId: string }) => ({
    status: 'ok',
    result: bodies[specialistId] ?? `${specialistId} said something`,
  }));

describe('makeAppletPlanner', () => {
  it('runs the architect first and the other two against its scope', async () => {
    // The ordering IS the design: two planners given the same brief and no
    // shared scope plan differently-sized applets, and the contradiction only
    // surfaces for whoever has to write one page from both.
    const order: string[] = [];
    const dispatch = vi.fn(async ({ specialistId, input }) => {
      order.push(specialistId);
      if (specialistId === 'applet-architect') return { status: 'ok', result: 'SCOPE-MARKER' };
      // The pair must receive the architect's body VERBATIM. A paraphrase per
      // planner is the one edit that quietly reintroduces the divergence the
      // sequencing exists to prevent.
      expect(input).toContain('SCOPE-MARKER');
      return { status: 'ok', result: `${specialistId} plan` };
    });
    const { makeAppletPlanner } = await load(dispatch);

    const outcome = await makeAppletPlanner(CTX)(TARGET);

    expect(outcome.planned).toBe(true);
    expect(order[0]).toBe('applet-architect');
    expect(order.slice(1).sort()).toEqual(['applet-data-planner', 'applet-ux-planner']);
  });

  it('runs the interface and data planners in parallel, not one after the other', async () => {
    // Sequential would be a silent regression: same output, twice the wall
    // clock, on a path a person is waiting on. So it is asserted on overlap
    // rather than on ordering, which sequential also satisfies.
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = vi.fn(async ({ specialistId }: { specialistId: string }) => {
      if (specialistId === 'applet-architect') return { status: 'ok', result: 'scope' };
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { status: 'ok', result: 'plan' };
    });
    const { makeAppletPlanner } = await load(dispatch);

    await makeAppletPlanner(CTX)(TARGET);

    expect(maxInFlight).toBe(2);
  });

  it('assembles one spec with all three sections', async () => {
    const dispatch = okWith({
      'applet-architect': 'One reading in, a list out.',
      'applet-ux-planner': 'Two number fields and a Save button.',
      'applet-data-planner': 'reading:<ISO> holds {systolic, diastolic}.',
    });
    const { makeAppletPlanner } = await load(dispatch);

    const outcome = await makeAppletPlanner(CTX)(TARGET);

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    expect(outcome.spec).toContain('One reading in, a list out.');
    expect(outcome.spec).toContain('Two number fields and a Save button.');
    expect(outcome.spec).toContain('reading:<ISO> holds {systolic, diastolic}.');
  });

  it('stringifies a structured result rather than printing [object Object]', async () => {
    // These specialists declare `structuredOutput`, so `result` is an object on
    // the happy path. `String({})` is `[object Object]`, which reads as a
    // plausible section and carries nothing.
    const dispatch = okWith({ 'applet-architect': { singleJob: 'Record a reading.' } });
    const { makeAppletPlanner } = await load(dispatch);

    const outcome = await makeAppletPlanner(CTX)(TARGET);

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    expect(outcome.spec).toContain('Record a reading.');
    expect(outcome.spec).not.toContain('[object Object]');
  });

  it('does not run the pair when the architect fails', async () => {
    // With no scope the two would plan differently-sized applets, which is
    // worse than not planning — and it would spend two dispatches to get there.
    const dispatch = vi.fn(async () => ({ status: 'error', error: 'pool_exhausted' }));
    const { makeAppletPlanner } = await load(dispatch);

    const outcome = await makeAppletPlanner(CTX)(TARGET);

    expect(outcome.planned).toBe(false);
    if (outcome.planned) return;
    expect(outcome.reason).toContain('pool_exhausted');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('returns the spec with a section marked missing when one of the pair fails', async () => {
    // Fail-open, and partial is a real outcome: a scope plus one half is worth
    // more than nothing, provided the gap is NAMED rather than silently absent.
    const dispatch = vi.fn(async ({ specialistId }: { specialistId: string }) =>
      specialistId === 'applet-ux-planner'
        ? { status: 'error', error: 'step_limit' }
        : { status: 'ok', result: `${specialistId} plan` },
    );
    const { makeAppletPlanner } = await load(dispatch);

    const outcome = await makeAppletPlanner(CTX)(TARGET);

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    expect(outcome.spec).toContain('not planned');
    expect(outcome.spec).toContain('step_limit');
    expect(outcome.spec).toContain('applet-data-planner plan');
  });

  it('treats an empty body as a failure, not a section with nothing under it', async () => {
    // The dispatch returned, so nothing downstream would notice: the spec would
    // carry a heading and no content, which reads as "there was nothing to say".
    const dispatch = vi.fn(async ({ specialistId }: { specialistId: string }) =>
      specialistId === 'applet-ux-planner'
        ? { status: 'ok', result: '   ' }
        : { status: 'ok', result: 'body' },
    );
    const { makeAppletPlanner } = await load(dispatch);

    const outcome = await makeAppletPlanner(CTX)(TARGET);

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    expect(outcome.spec).toContain('returned no plan');
  });

  it('reports a cancelled turn as cancelled, never as a plan', async () => {
    const dispatch = vi.fn(async () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    });
    const { makeAppletPlanner } = await load(dispatch);

    const outcome = await makeAppletPlanner(CTX)(TARGET);

    expect(outcome).toEqual({ planned: false, reason: 'cancelled' });
  });

  it('forwards the abort signal per call, not per construction', async () => {
    // The callback is built once a turn; the signal belongs to the invocation.
    // Without this an Esc mid-`plan` leaves three sub-agent runs — seconds of
    // wall time and three paid completions — finishing into a discarded result.
    const dispatch = vi.fn(async () => ({ status: 'ok', result: 'x' }));
    const { makeAppletPlanner } = await load(dispatch);
    const signal = new AbortController().signal;

    await makeAppletPlanner(CTX)(TARGET, signal);

    for (const call of dispatch.mock.calls) expect(call[0].abortSignal).toBe(signal);
  });

  it('never lets a planning failure teach a frozen bundled record', async () => {
    // These are `kind: 'tool-wrapper'`, exactly the shape `dispatchToolWrapper`
    // enqueues a correction candidate for, and `permissionsFor` grants bundled
    // records `canAppendExamples: true` — so the queue really can reach them. A
    // planner that lost a pool slot is not a call-shape mistake.
    const dispatch = okWith({});
    const { makeAppletPlanner } = await load(dispatch);

    await makeAppletPlanner(CTX)(TARGET);

    expect(dispatch).toHaveBeenCalledTimes(3);
    for (const call of dispatch.mock.calls) expect(call[0].skipCorrectionEnqueue).toBe(true);
  });

  it('renders the intent in the record order, dropping fields nobody answered', async () => {
    // Iterating `INTENT_FIELDS` rather than the model-supplied object keeps two
    // planners reading the same brief in the same order. Blank fields are
    // dropped because "we did not ask" and "they had no answer" look identical
    // once written down.
    const dispatch = vi.fn(async () => ({ status: 'ok', result: 'x' }));
    const { makeAppletPlanner, buildArchitectBrief } = await load(dispatch);
    await makeAppletPlanner(CTX)({ ...TARGET, intent: { input: 'b', goal: 'a', who: '  ' } });

    const brief = buildArchitectBrief({ ...TARGET, intent: { input: 'b', goal: 'a', who: '  ' } });
    expect(brief.indexOf('a')).toBeLessThan(brief.indexOf('b'));
    expect(brief).not.toContain('Who is trying');
  });
});

/**
 * The recursion guard, asserted against the registry `createTools` really
 * returns — the same shape `applet-styling.test.ts` uses, and for the same
 * reason: the guard is a property of WHERE the tool is constructed, which is
 * exactly what a later tidy-up removes.
 *
 * Two things stop a planner re-entering the planning pass. `createTools` has no
 * `AgentContext` and so builds a planner-less `applet`; and the three planners
 * declare `targetTools: ['docs']`, so they never hold an `applet` tool at all.
 * This pins the first, because it is the one a refactor can undo.
 */
describe('the planning recursion guard', () => {
  useTempHome('bernard-applet-planning-guard');

  it('the applet tool createTools builds cannot plan', async () => {
    vi.resetModules();
    const dispatch = vi.fn(async () => ({ status: 'ok', result: 'plan' }));
    vi.doMock('./tool-wrapper-run.js', () => ({
      dispatchToolWrapper: dispatch,
      createToolWrapperRunTool: () => ({}),
    }));
    vi.doMock('../config.js', () => ({
      loadConfig: () => ({ appletPlanning: true, autoStyleApplets: false, autoOpenApplets: false }),
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
      { action: 'plan', name: 'Guard', description: 'x', intent: { goal: 'something' } },
      {} as never,
    );

    // Asserted on the OUTPUT rather than only on `dispatchToolWrapper`: any
    // planner wired into `createTools` — through this module or another route —
    // returns a spec here, so this catches the class rather than one function.
    expect(out).toContain('not available here');
    expect(out).not.toContain('Build plan for');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
