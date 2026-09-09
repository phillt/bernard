import { describe, it, expect } from 'vitest';
import { definitions, registerBuiltinDefinitions } from '../index.js';
import { mcpDelegateDefinition } from '../mcp-delegate.js';
import {
  resolveDispatchProfile,
  declaredToolSurface,
  MAX_STEP_RATIO,
  SCOPE_AXES,
  applyStandaloneScopes,
  declaredScope,
  pickScopes,
} from '../dispatch-profile.js';
import { resolveToolSurface } from '../tool-surface.js';
import { specialistDefinition } from '../specialist.js';
import { toolWrapperDefinition } from '../tool-wrapper.js';
import type { Specialist } from '../../../specialists.js';
import type { AgentContext } from '../../context.js';
import type { AgentDefinition } from '../types.js';

/**
 * The record addresses its own dispatch (#508), pinned the way
 * `retrieval.test.ts` and `tool-surface.test.ts` pin the two resolutions this
 * one joins.
 *
 * Three properties, and the last two are the ones that rot:
 *
 *  - which definitions can be addressed at all (`recordId`),
 *  - that a bad value FALLS BACK rather than throwing or being honoured, since
 *    it comes off a user-editable JSON file and this runs before every
 *    dispatch in the process,
 *  - that the definitions actually CONSUME the profile. A definition may ignore
 *    its extra parameter and still typecheck, so the guard has to be
 *    behavioural.
 */

function ctxWith(record?: Partial<Specialist>): AgentContext {
  const full = record
    ? ({
        id: 'spec',
        name: 'S',
        description: '',
        systemPrompt: '',
        guidelines: [],
        ...record,
      } as Specialist)
    : undefined;
  return {
    config: { maxSteps: 20, coordinatorMode: 'off' },
    stores: { specialists: { get: (id: string) => (id === 'spec' ? full : undefined) } },
    mcp: { tools: {}, serverNames: [], serverTools: new Map() },
  } as unknown as AgentContext;
}

/** Every registered definition, plus the one dispatched directly. */
function allDefinitions(): Array<{ name: string; def: AgentDefinition<any, any> }> {
  registerBuiltinDefinitions();
  return [
    ...definitions.ids().map((id) => ({ name: id, def: definitions.get(id) })),
    { name: 'mcp-delegate', def: mcpDelegateDefinition },
  ] as Array<{ name: string; def: AgentDefinition<any, any> }>;
}

/**
 * Which definitions run a record. Only the two that dispatch a `Specialist` do,
 * and `recordId`'s absence is what makes every other definition — `main`
 * included — provably unaffected by this feature.
 */
const HAS_RECORD = ['specialist', 'tool-wrapper'];

describe('which definitions can be addressed by a record', () => {
  it('every registered definition has a pinned expectation', () => {
    // Guards the guard: a new definition must decide rather than inherit.
    const names = allDefinitions().map((d) => d.name);
    for (const name of names) {
      expect(HAS_RECORD.includes(name), `${name} must be listed or deliberately absent`).toBe(
        Boolean(allDefinitions().find((d) => d.name === name)!.def.recordId),
      );
    }
  });

  it('main declares none, so a persistent history cannot be re-shaped by a record', () => {
    registerBuiltinDefinitions();
    expect(definitions.get('main').recordId).toBeUndefined();
  });
});

describe('resolveDispatchProfile', () => {
  const def = { id: 'specialist', recordId: (i: { specialistId: string }) => i.specialistId };
  const input = { specialistId: 'spec' };

  it('is empty when the definition names no record', () => {
    expect(resolveDispatchProfile(ctxWith({}), { id: 'x' }, input)).toEqual({});
  });

  it('is empty when the record does not exist', () => {
    expect(resolveDispatchProfile(ctxWith(), def, input)).toEqual({});
  });

  it('is empty when the record declares nothing — today’s behaviour, byte for byte', () => {
    expect(resolveDispatchProfile(ctxWith({}), def, input)).toEqual({});
  });

  it('reads the three fields a record may declare', () => {
    expect(
      resolveDispatchProfile(
        ctxWith({ stepRatio: 0.2, strategy: 'react', toolSurface: 'full' }),
        def,
        input,
      ),
    ).toEqual({ stepRatio: 0.2, strategy: 'react', toolSurface: 'full' });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a step count mistaken for a ratio', 50],
    ['just over the cap', MAX_STEP_RATIO + 0.01],
    ['a string', '0.5' as unknown as number],
  ])('falls back on an invalid stepRatio (%s)', (_label, stepRatio) => {
    // Validated, not trusted: the value comes off a user-editable JSON file,
    // and this runs before every dispatch, so a throw here is a broken record
    // taking down every turn that touches it.
    expect(resolveDispatchProfile(ctxWith({ stepRatio }), def, input).stepRatio).toBeUndefined();
  });

  it('falls back on an unknown strategy or surface rather than passing it through', () => {
    const profile = resolveDispatchProfile(
      ctxWith({
        strategy: 'coordinator' as never,
        toolSurface: 'everything' as never,
      }),
      def,
      input,
    );
    expect(profile).toEqual({});
  });

  it('keeps the valid fields when a sibling is invalid', () => {
    // Per-field, not all-or-nothing: one typo must not silently discard a
    // declaration the user got right.
    expect(
      resolveDispatchProfile(ctxWith({ stepRatio: 99, strategy: 'react' }), def, input),
    ).toEqual({ strategy: 'react' });
  });

  it('survives a store that throws', () => {
    const ctx = {
      config: {},
      stores: {
        specialists: {
          get: () => {
            throw new Error('corrupt');
          },
        },
      },
    } as unknown as AgentContext;
    expect(resolveDispatchProfile(ctx, def, input)).toEqual({});
  });
});

describe('the definitions consume the profile', () => {
  const config = { maxSteps: 20 } as never;

  it('specialist scales its step budget by a declared ratio', () => {
    expect(specialistDefinition.stepBudget(config, {} as never, {})).toBe(10);
    expect(specialistDefinition.stepBudget(config, {} as never, { stepRatio: 0.2 })).toBe(4);
  });

  it('tool-wrapper scales too, and keeps its own floor of 2', () => {
    expect(toolWrapperDefinition.stepBudget(config, {} as never, {})).toBe(10);
    expect(toolWrapperDefinition.stepBudget(config, {} as never, { stepRatio: 0.5 })).toBe(10);
    // The floor is a property of the SHAPE — below it a wrapper cannot call a
    // tool and then report — so a record cannot declare its way past it.
    expect(toolWrapperDefinition.stepBudget(config, {} as never, { stepRatio: 0.01 })).toBe(2);
  });

  it('tool-wrapper opts into ReAct only when the record asks', () => {
    // It returned `new NormalStrategy()` unconditionally, so the ReAct path was
    // unreachable from a record even though `buildStrategy` has taken a per-run
    // `strategyId` since #167.
    const ctx = ctxWith({});
    const plain = toolWrapperDefinition.strategy(ctx, {} as never, {});
    const react = toolWrapperDefinition.strategy(ctx, {} as never, { strategy: 'react' });
    expect(plain.constructor.name).toBe('NormalStrategy');
    expect(react.constructor.name).toBe('ReActStrategy');
  });

  it('a wrapper record actually reaches the registry, not just the resolver', () => {
    // The precedence is justified by `tool-wrapper`'s hardcoded `'full'`, so it
    // has to be live for exactly that kind — and it nearly was not.
    // `dispatchToolWrapper` assembles `childTools` BEFORE `runDefinition` runs
    // and `toolWrapperDefinition.tools()` returns them verbatim, so the resolved
    // profile never reaches the registry. Both readers go through
    // `declaredToolSurface`, and this pins that they agree.
    expect(declaredToolSurface({ toolSurface: 'worker' })).toBe('worker');
    expect(declaredToolSurface({ toolSurface: 'everythin' })).toBeUndefined();
    expect(declaredToolSurface({})).toBeUndefined();
    const ctx = ctxWith({ toolSurface: 'worker' });
    expect(
      resolveToolSurface(
        ctx,
        toolWrapperDefinition,
        resolveDispatchProfile(ctx, toolWrapperDefinition, { specialistId: 'spec' } as never),
      ).surface,
    ).toBe(declaredToolSurface({ toolSurface: 'worker' }));
  });

  it('a record narrows or widens the tool surface, beating the definition', () => {
    const ctx = ctxWith({});
    // `tool-wrapper` declares `'full'`, chosen for three bundled wrappers and
    // inherited by every wrapper written since — so a record must be able to
    // say "not me".
    expect(resolveToolSurface(ctx, toolWrapperDefinition, {}).surface).toBe('full');
    expect(resolveToolSurface(ctx, toolWrapperDefinition, { toolSurface: 'worker' }).surface).toBe(
      'worker',
    );
    // And the other direction, off the ephemeral derivation.
    expect(resolveToolSurface(ctx, specialistDefinition, {}).surface).toBe('worker');
    expect(resolveToolSurface(ctx, specialistDefinition, { toolSurface: 'full' }).surface).toBe(
      'full',
    );
  });
});

describe('specialist spend is attributed to a specialist site (#299/#508)', () => {
  it('EVERY definition declares a site, which is what the fix actually is', () => {
    // The bug was `def.site ?? 'main'`: an optional field whose omission
    // silently billed a whole definition's spend to the main layer. Adding two
    // declarations fixes two definitions; making the field required is what
    // stops the tenth one repeating it. `tsc` excludes tests, so this asserts
    // it on the real registry rather than relying on the type alone.
    registerBuiltinDefinitions();
    for (const id of definitions.ids()) {
      expect(definitions.get(id).site, id).toBeDefined();
    }
    expect(mcpDelegateDefinition.site).toBeDefined();
  });

  it('specialist and tool-wrapper both declare a site', () => {
    // Without one, `resolveModel` returns no `site` key and `run.ts`'s
    // `def.site ?? 'main'` default stands — so every specialist's spend folded
    // into the `main` layer of `bernard usage`, and the one number that could
    // tell you a persona was expensive said the main agent was.
    expect(specialistDefinition.site).toBe('specialist');
    expect(toolWrapperDefinition.site).toBe('tool-wrapper');
  });
});

describe('SCOPE_AXES (#552)', () => {
  /**
   * The table is what turns "eleven touch points, nine of them uniform" into
   * one entry — so the properties worth pinning are the ones the TYPE cannot
   * state and the ones a future reader would otherwise re-derive.
   *
   * The two compile-time properties are deliberately NOT asserted here.
   * `tsconfig.json` excludes every test file from the program, so a
   * `@ts-expect-error` in one is compiled by nothing — it looks like a guard
   * and is decoration, the mistake `user-message.ts` records paying for. The
   * `satisfies Record<ScopeField, ScopeAxis>` in the module itself is the real
   * check: deleting an entry and adding a stray one both fail `npm run build`.
   */
  it('is honoured by declaredScope for every axis it declares', () => {
    // What the type cannot state. `ScopeField` is `keyof typeof AXES`, so a
    // missing axis is unrepresentable rather than merely rejected — but nothing
    // in the type stops `declaredScope` from skipping one. Built from the table
    // rather than from three literal names, so it is not a re-listing of what
    // the table already says.
    const declared = Object.fromEntries(SCOPE_AXES.map((a) => [a.field, []]));
    expect(Object.keys(declaredScope(declared)).sort()).toEqual(
      SCOPE_AXES.map((a) => a.field).sort(),
    );
  });

  it('gives each axis a distinct field and a distinct label', () => {
    // Two vocabularies, both user-visible: `specialist inspect` prints the
    // field name, the dispatch-context viewer prints the label. A duplicate in
    // either collapses two fences into one line.
    expect(new Set(SCOPE_AXES.map((a) => a.field)).size).toBe(SCOPE_AXES.length);
    expect(new Set(SCOPE_AXES.map((a) => a.label)).size).toBe(SCOPE_AXES.length);
  });

  it('builds its validator per call, because one axis closes over live state', () => {
    // `knowledgeScope`'s predicate snapshots the domain registry. A predicate
    // built at module load would freeze that snapshot for the process; the
    // thunk is what keeps it a per-validation read.
    const axis = SCOPE_AXES.find((a) => a.field === 'knowledgeScope')!;
    expect(axis.validate()).not.toBe(axis.validate());
  });

  it('marks exactly one axis as having a ctx-free application point', () => {
    // `headless.ts` applies the RAG fence a second time, before
    // `assembleContext`, to overlap the MCP connect. That asymmetry is real —
    // memory has one point, knowledge two, corpus one — and it lives in the
    // table so nobody has to know it.
    expect(SCOPE_AXES.filter((a) => a.standalone).map((a) => a.field)).toEqual(['knowledgeScope']);
  });

  it('applies only the axes marked for the store it was handed', () => {
    const calls: (readonly string[] | null | undefined)[] = [];
    const store = {
      scoped(scope: readonly string[] | null | undefined) {
        calls.push(scope);
        return store;
      },
    };
    applyStandaloneScopes(store, 'rag', { memoryScope: ['k'], knowledgeScope: ['general'] });
    // Once, with the RAG fence — never with the memory one, which would fence
    // the wrong store with the wrong vocabulary and silently match nothing.
    // The store kind is a PARAMETER for exactly this reason: the marked set has
    // one member today, and what matters is what happens when it does not.
    expect(calls).toEqual([['general']]);
  });

  it('drops every axis when no axis is marked for that store', () => {
    // Guards the guard: the assertion above passes if the filter is dropped and
    // `knowledgeScope` merely happens to be the last axis applied.
    const calls: unknown[] = [];
    const store = {
      scoped(scope: readonly string[] | null | undefined) {
        calls.push(scope);
        return store;
      },
    };
    applyStandaloneScopes(store, 'memory' as never, { knowledgeScope: ['general'] });
    expect(calls).toEqual([]);
  });

  it('pickScopes keeps a deny-all fence and drops only an absent one', () => {
    // `[]` is a real posture and must reach the record: dropping it would make
    // "fenced to nothing" and "not fenced" render identically on the one
    // surface that exists to tell a fence apart from a bad retrieval. This is
    // also what the conditional spreads it replaces did, since `[]` is truthy.
    expect(pickScopes({ memoryScope: ['k*'], knowledgeScope: [] })).toEqual({
      memoryScope: ['k*'],
      knowledgeScope: [],
    });
    expect(pickScopes({})).toEqual({});
  });
});
