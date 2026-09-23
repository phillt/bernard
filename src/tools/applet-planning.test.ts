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
  it('runs scope first, then the pair, then interaction against both', async () => {
    // The ordering IS the design, and it runs large decisions before small
    // ones. Two planners given the same brief and no shared scope plan
    // differently-sized applets; and an interaction stage deciding "this
    // needs a trash icon" before anything established that a destructive
    // delete belongs here is the same mistake one level down.
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
    expect(order.slice(1, 3).sort()).toEqual(['applet-data-planner', 'applet-ux-planner']);
    // Interaction is strictly after the pair — it reads what they decided, so
    // it cannot join the parallel arm even though that would be faster.
    expect(order[3]).toBe('applet-interaction-designer');
    // Wording did not run: this design has no controls and no destructive
    // action, which is `needsMicrocopy` declining rather than a failure.
    expect(order).toHaveLength(4);
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

    await makeAppletPlanner(CTX)(TARGET, { signal });

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

    // Every stage, including the two added later — the property is about the
    // dispatch shape, so a new stage that forgot the flag is what this catches.
    expect(dispatch).toHaveBeenCalledTimes(4);
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

/**
 * The pipeline says who it is, or every stage refuses it (#610 follow-up).
 *
 * The five stage records are marked `pipeline`, so `invocationRefusal` turns
 * away anything that does not claim the same name — that is the lock-down
 * which stops the main agent hand-dispatching them, which is how the
 * interaction and microcopy stages came to have zero dispatches ever.
 *
 * The cost of that is one line in `runPlanner`, and dropping it breaks the
 * whole pipeline rather than one stage. Nothing else would catch it: every
 * test in this file mocks the dispatch, so the real gate is never reached.
 */
describe('the pipeline identifies itself', () => {
  it('claims its own pipeline on every stage dispatch', async () => {
    const dispatch = okWith({});
    const { makeAppletPlanner, APPLET_DESIGN_PIPELINE } = await load(dispatch);
    await makeAppletPlanner(CTX)(TARGET);

    expect(dispatch.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of dispatch.mock.calls) {
      expect(args.via, `${args.specialistId} dispatched with no via`).toEqual({
        kind: 'pipeline',
        pipeline: APPLET_DESIGN_PIPELINE,
      });
    }
  });

  it('does not claim it on behalf of anything else', async () => {
    // The mark carries a NAME so a second pipeline cannot drive these
    // stages. A stage dispatched under the wrong name is refused, so this
    // pins the exact string rather than "some pipeline".
    const dispatch = okWith({});
    const { makeAppletPlanner } = await load(dispatch);
    await makeAppletPlanner(CTX)(TARGET);
    expect(dispatch.mock.calls[0][0].via.pipeline).toBe('applet-design');
  });
});

/**
 * A stage that answers in an unreadable shape must not go quiet.
 *
 * `parseStagePlan(...) ?? undefined` dropped the typed stage and said nothing,
 * which is the quietest bug in the pipeline: the prose still lands in the
 * spec, so the plan reads as complete, while `checkDesign` skips every rule
 * whose stage is absent — so ONE bad payload takes the cross-stage checks down
 * for the whole design.
 *
 * Measured before the fix, on an architect payload missing by one enum value:
 * a design carrying a destructive control with no confirmation AND a control
 * naming an action nothing declared produced **zero** issues.
 */
describe('a stage that does not parse', () => {
  /** A near-miss: `intent` must be one of five verbs, and `remove` is not one. */
  const NEAR_MISS = {
    singleJob: 'track readings',
    actions: [
      {
        id: 'delete',
        intent: 'remove',
        importance: 'secondary',
        frequency: 'low',
        risk: 'high',
        reversible: false,
      },
    ],
  };

  it('says so in the spec rather than dropping it silently', async () => {
    const { makeAppletPlanner } = await load(okWith({ 'applet-architect': NEAR_MISS }));
    const out = await makeAppletPlanner(CTX)(TARGET);

    expect(out.planned).toBe(true);
    if (!out.planned) return;
    expect(out.spec).toContain('could not be read');
    expect(out.spec).toContain('scope');
    // The prose is still there and still useful — this is the loss of the
    // CHECKS, not a stage failure, and the two need different words.
    expect(out.spec).toContain('## Scope');
  });

  it('leaves the typed stage out, which is what makes the notice necessary', async () => {
    const { makeAppletPlanner } = await load(okWith({ 'applet-architect': NEAR_MISS }));
    const out = await makeAppletPlanner(CTX)(TARGET);
    if (!out.planned) return;
    expect(out.design.architect).toBeUndefined();
  });

  it('says nothing when every stage parses', async () => {
    // The guard that stops this becoming a caveat on every plan — and it
    // needs EVERY stage supplied, because `okWith`'s fallback is a string,
    // which is itself a contract violation for a `structuredOutput: true`
    // record and is correctly flagged.
    const { makeAppletPlanner } = await load(
      okWith({
        'applet-architect': { singleJob: 'track readings' },
        'applet-ux-planner': { goal: 'log a reading' },
        'applet-data-planner': { storeKeys: [{ key: 'reading' }] },
        'applet-interaction-designer': { controls: [] },
      }),
    );
    const out = await makeAppletPlanner(CTX)(TARGET);
    if (!out.planned) return;
    expect(out.spec).not.toContain('could not be read');
  });

  it('names each unreadable stage, not just the first', async () => {
    const { makeAppletPlanner } = await load(
      okWith({
        'applet-architect': NEAR_MISS,
        'applet-ux-planner': { rendering: 'react' }, // not one of the two values
      }),
    );
    const out = await makeAppletPlanner(CTX)(TARGET);
    if (!out.planned) return;
    expect(out.spec).toContain('scope and interface');
    expect(out.spec).toContain('stages');
  });
});

/**
 * Re-planning one stage, which is what makes the pipeline nudgeable.
 *
 * The alternative shape — a fixed sequence you can only run whole — cannot
 * express "too many buttons, try the controls again", so the only way to act
 * on a spec was to throw it away and plan from scratch.
 */
describe('re-running one stage', () => {
  const PRIOR = {
    design: { architect: { singleJob: 'log a reading' } },
    bodies: {
      scope: 'SCOPE-FROM-BEFORE',
      interface: 'INTERFACE-FROM-BEFORE',
      'data and actions': 'DATA-FROM-BEFORE',
      controls: 'CONTROLS-FROM-BEFORE',
    },
  };

  it('dispatches only the named stage', async () => {
    const dispatch = okWith({});
    const { makeAppletPlanner } = await load(dispatch);

    await makeAppletPlanner(CTX)(TARGET, { only: ['controls'], prior: PRIOR });

    expect(dispatch.mock.calls.map((c) => c[0].specialistId)).toEqual([
      'applet-interaction-designer',
    ]);
  });

  /**
   * The reason the bodies are stashed at all.
   *
   * A downstream brief splices the prior stage VERBATIM so a scope cannot be
   * paraphrased away between hops. Seeding a re-run from the typed design
   * instead would hand this stage a SUMMARY — shorter, different, and exactly
   * the paraphrase the verbatim splice exists to prevent.
   */
  it('splices the reused bodies into the re-run brief verbatim', async () => {
    const dispatch = okWith({});
    const { makeAppletPlanner } = await load(dispatch);

    await makeAppletPlanner(CTX)(TARGET, { only: ['controls'], prior: PRIOR });

    const brief = dispatch.mock.calls[0][0].input;
    expect(brief).toContain('SCOPE-FROM-BEFORE');
    expect(brief).toContain('INTERFACE-FROM-BEFORE');
  });

  it('keeps the untouched sections in the assembled spec', async () => {
    const { makeAppletPlanner } = await load(okWith({}));
    const out = await makeAppletPlanner(CTX)(TARGET, { only: ['controls'], prior: PRIOR });

    expect(out.planned).toBe(true);
    if (!out.planned) return;
    expect(out.spec).toContain('SCOPE-FROM-BEFORE');
    expect(out.spec).toContain('DATA-FROM-BEFORE');
    expect(out.reused).toContain('scope');
    expect(out.reused).toContain('data and actions');
    expect(out.reused).not.toContain('controls');
  });

  it('runs a stage it was told to skip when there is nothing to reuse', async () => {
    // Otherwise re-planning the controls of a plan that never had a scope
    // produces a design with a hole in the middle and no way to say so.
    const dispatch = okWith({});
    const { makeAppletPlanner } = await load(dispatch);

    await makeAppletPlanner(CTX)(TARGET, {
      only: ['controls'],
      prior: { design: {}, bodies: { controls: 'x' } },
    });

    expect(dispatch.mock.calls.map((c) => c[0].specialistId)).toContain('applet-architect');
  });

  it('carries the bodies out so the NEXT re-run can splice them', async () => {
    const { makeAppletPlanner } = await load(okWith({ 'applet-architect': 'FRESH-SCOPE' }));
    const out = await makeAppletPlanner(CTX)(TARGET);

    expect(out.planned).toBe(true);
    if (!out.planned) return;
    expect(out.bodies.scope).toContain('FRESH-SCOPE');
  });
});

describe('a nudge', () => {
  it('reaches the stage as its own trailing section', async () => {
    const dispatch = okWith({});
    const { makeAppletPlanner } = await load(dispatch);

    await makeAppletPlanner(CTX)(TARGET, { nudge: 'keep it to one screen', only: ['scope'] });

    const brief = dispatch.mock.calls[0][0].input;
    expect(brief).toContain('## What to change this time');
    expect(brief).toContain('keep it to one screen');
  });

  it('goes to the named stage and nowhere else', async () => {
    const dispatch = okWith({});
    const { makeAppletPlanner } = await load(dispatch);

    await makeAppletPlanner(CTX)(TARGET, { nudge: 'fewer primary buttons', only: ['controls'] });

    for (const [args] of dispatch.mock.calls) {
      const named = args.specialistId === 'applet-interaction-designer';
      expect(args.input.includes('fewer primary buttons')).toBe(named);
    }
  });

  it('never edits the scope that is passed down', async () => {
    // The scope travels verbatim, and a nudge spliced into it would make that
    // false — which is the one property the sequencing rests on.
    const dispatch = okWith({ 'applet-architect': 'SCOPE-MARKER' });
    const { makeAppletPlanner } = await load(dispatch);

    await makeAppletPlanner(CTX)(TARGET, { nudge: 'denser', only: ['interface'] });

    const ux = dispatch.mock.calls.find((c) => c[0].specialistId === 'applet-ux-planner')![0];
    expect(ux.input).toContain('SCOPE-MARKER');
    expect(ux.input.indexOf('denser')).toBeGreaterThan(ux.input.indexOf('SCOPE-MARKER'));
  });

  it('adds nothing when absent', async () => {
    const dispatch = okWith({});
    const { makeAppletPlanner } = await load(dispatch);
    await makeAppletPlanner(CTX)(TARGET);
    for (const [args] of dispatch.mock.calls) {
      expect(args.input).not.toContain('What to change this time');
    }
  });
});
