import { describe, it, expect } from 'vitest';
import {
  ActionSemanticsSchema,
  ArchitectPlanSchema,
  ControlSchema,
  UxPlanSchema,
  actionsOf,
  controlsOf,
  parseStagePlan,
} from './design-model.js';

describe('parseStagePlan', () => {
  it('answers null rather than throwing on a shape it did not expect', () => {
    // `null` means "no checks available for this stage", never "this stage
    // failed". Planning is fail-open at every hop and the prose body is
    // rendered for the model either way, so a planner answering in an
    // unanticipated shape must degrade to exactly the behaviour that shipped
    // before this module existed.
    expect(parseStagePlan(ArchitectPlanSchema, 'just some prose')).toBeNull();
    expect(parseStagePlan(ArchitectPlanSchema, undefined)).toBeNull();
    expect(parseStagePlan(ArchitectPlanSchema, { nothing: 'useful' })).toBeNull();
  });

  it('keeps what it declared and drops what it did not', () => {
    // Zod strips unknown keys rather than rejecting. That is the additive
    // rule: a planner returning an extra field loses nothing, because the
    // model is shown the original body and only the CHECKS read this.
    const parsed = parseStagePlan(ArchitectPlanSchema, {
      singleJob: 'log a reading',
      needsStore: true,
      somethingNew: 'kept out of the model, not an error',
    });
    expect(parsed?.singleJob).toBe('log a reading');
    expect(parsed?.needsStore).toBe(true);
    expect(parsed).not.toHaveProperty('somethingNew');
  });

  it('rejects a rendering value outside the two the rule chooses between', () => {
    // The concrete thing nothing could check before: `WrapperResultSchema`
    // types the payload `z.any()`.
    expect(parseStagePlan(UxPlanSchema, { rendering: 'react' })).toBeNull();
    expect(parseStagePlan(UxPlanSchema, { rendering: 'runtime' })?.rendering).toBe('runtime');
  });
});

describe('ActionSemantics', () => {
  it('requires all five judgements, because each decides a downstream form', () => {
    const complete = {
      id: 'delete',
      intent: 'destroy',
      importance: 'secondary',
      frequency: 'low',
      risk: 'high',
      reversible: false,
    };
    expect(ActionSemanticsSchema.safeParse(complete).success).toBe(true);
    for (const missing of ['intent', 'importance', 'frequency', 'risk', 'reversible']) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[missing];
      expect(
        ActionSemanticsSchema.safeParse(partial).success,
        `${missing} should be required`,
      ).toBe(false);
    }
  });

  it('closes the vocabularies rather than taking free strings', () => {
    // An open string here is how `importance: "quite important"` reaches a
    // check that compares against 'primary'.
    expect(ActionSemanticsSchema.safeParse({ id: 'x', intent: 'yeet' }).success).toBe(false);
  });
});

describe('Control', () => {
  it('allows a null actionId for a control that drives local state', () => {
    expect(ControlSchema.safeParse({ actionId: null, component: 'button' }).success).toBe(true);
  });

  it('requires actionId to be present, so "forgot to say" is not "local state"', () => {
    // Nullable, not optional: the two mean different things and conflating
    // them would let an omission read as a deliberate decision.
    expect(ControlSchema.safeParse({ component: 'button' }).success).toBe(false);
  });

  it('closes the variant set to what the floor actually styles', () => {
    expect(
      ControlSchema.safeParse({ actionId: null, component: 'button', variant: 'ghost' }).success,
    ).toBe(false);
    for (const variant of ['primary', 'secondary', 'danger']) {
      expect(
        ControlSchema.safeParse({ actionId: null, component: 'button', variant }).success,
      ).toBe(true);
    }
  });
});

describe('controlsOf', () => {
  const ux = { controls: [{ actionId: 'a', label: 'From UX' }] };
  const interaction = { controls: [{ actionId: 'a', component: 'button', label: 'From IX' }] };

  it('prefers the interaction stage, which is the one that decided form', () => {
    expect(controlsOf({ ux, interaction })[0].label).toBe('From IX');
  });

  it('falls back to the UX planner when interaction did not run', () => {
    // Fail-open: what can be checked, is.
    const out = controlsOf({ ux });
    expect(out[0].label).toBe('From UX');
    // `component` is partial on the UX side, so the fallback fills a default
    // rather than handing a check an undefined it would have to guard.
    expect(out[0].component).toBe('button');
  });

  it('is empty rather than undefined when neither ran', () => {
    expect(controlsOf({})).toEqual([]);
  });
});

describe('actionsOf', () => {
  it('reads the architect and nobody else', () => {
    // The single most important property of the model: the action set has
    // exactly one author, which is what makes "the scope declares this" a
    // question with one answer.
    expect(
      actionsOf({
        architect: {
          singleJob: 'x',
          actions: [
            {
              id: 'save',
              intent: 'create',
              importance: 'primary',
              frequency: 'high',
              risk: 'low',
              reversible: true,
            },
          ],
        },
      }).map((a) => a.id),
    ).toEqual(['save']);
    expect(actionsOf({ ux: { controls: [{ actionId: 'sneaky' }] } })).toEqual([]);
  });
});
