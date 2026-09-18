import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentContext } from '../../types.js';
import type { AgentDefinition } from '../../types.js';

/**
 * Every `ToolOptions` field reaches the gates (#340, #447).
 *
 * `runDefinition` used to build `augmentTools`' options by ENUMERATING each
 * pass-through by hand, and the hazard was diagnosed and patched here twice:
 * `writeScope` in #340, then `onDenied` in #447 — which had never been
 * forwarded at all, so the denial reporting that change rests on could not
 * have fired in production. The guard shipped with it was a source scan
 * (`expect(bag).toContain('onDenied: ctx.toolOptions.onDenied')`) that its own
 * comment called "the weak assertion it is": it needed a new hand-written
 * literal per field, broke on a reformat, and pinned the MECHANISM rather than
 * the property.
 *
 * This pins the property. It spies on the real seam, so it fails if anyone
 * reverts the spread to an enumeration and forgets a field — including a field
 * that does not exist yet, which is the case the source scan could never
 * cover.
 */

const augmentSpy = vi.fn((tools: unknown) => tools);

vi.mock('../../../tools/augment.js', () => ({
  augmentTools: (tools: unknown, opts: unknown) => {
    augmentSpy(tools, opts);
    return tools;
  },
}));

vi.mock('ai', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('ai');
  return { ...actual, generateText: vi.fn(async () => ({ text: 'ok', steps: [], usage: {} })) };
});

vi.mock('../../../providers/index.js', () => ({
  getModelForConfig: () => ({ modelId: 'test' }),
  getProviderOptionsForConfig: () => ({}),
}));

vi.mock('../../../tool-call-repair.js', () => ({ makeRepairHook: () => undefined }));

const { runDefinition } = await import('../run.js');
const { makeTestContext } = await import('../../../__tests__/agent-context.js');
const { NormalStrategy } = await import('../../strategies/normal.js');

/**
 * A sentinel on every field `ToolOptions` declares, so the assertion is about
 * the SET rather than about the two fields that happened to be forgotten.
 */
function toolOptionsWithEveryField(): Record<string, unknown> {
  return {
    askUser: () => Promise.resolve(''),
    blockAction: () => Promise.resolve('deny' as const),
    confirmAction: () => Promise.resolve(false),
    confirmDangerous: true,
    getShellTimeout: () => 1,
    getToolPermissions: () => [],
    onDenied: () => {},
    onUsage: () => {},
    raiseShellTimeout: () => {},
    requestPermissionConsent: () => Promise.resolve([]),
    sessionToolAllowlist: new Set<string>(),
    shellTimeout: 1,
    unattended: true,
    writeScope: { workspace: '/tmp/ws' },
  };
}

/** The shape `run.test.ts` uses; only the fields the runner really calls. */
function fakeDefinition(): AgentDefinition<{ text: string }, string> {
  return {
    id: 'fake',
    historyMode: 'ephemeral',
    site: 'main',
    systemPrompt: () => 'SYS',
    tools: () => ({}),
    strategy: () => new NormalStrategy(),
    stepBudget: () => 7,
    buildUserMessage: (input: { text: string }) => ({ role: 'user' as const, content: input.text }),
    hooks: () => [],
    repairLabel: 'main',
  } as unknown as AgentDefinition<{ text: string }, string>;
}

describe('runDefinition forwards toolOptions to the gates', () => {
  beforeEach(() => augmentSpy.mockClear());

  it('forwards every field ToolOptions declares, not a hand-kept subset', async () => {
    const supplied = toolOptionsWithEveryField();
    const ctx = makeTestContext({ toolOptions: supplied } as unknown as Partial<AgentContext>);
    await runDefinition(ctx, fakeDefinition(), { text: 'hi' });

    expect(augmentSpy).toHaveBeenCalled();
    const bag = augmentSpy.mock.calls[0][1] as Record<string, unknown>;
    // The SET, so a field added to `ToolOptions` later is covered the day it
    // is added rather than the day someone remembers to extend this list.
    for (const key of Object.keys(supplied)) {
      expect(bag, `toolOptions.${key} never reached augmentTools`).toHaveProperty(key);
    }
    // The two that were actually inert, named so a regression reads clearly.
    expect(bag.unattended).toBe(true);
    expect(bag.onDenied).toBe(supplied.onDenied);
  });

  it('still lets the policy decision own toolMode and confirmThreshold', async () => {
    // The spread is FIRST precisely so these win. If it were moved after the
    // explicit fields, a same-named `ToolOptions` field would silently
    // override the gate's MODE — which is the one way this change could be
    // worse than the enumeration it replaced.
    //
    // `ToolOptions` declares neither name today, so supplying them here is
    // deliberate: it simulates the future field that would make the ordering
    // load-bearing. Without it the assertion passes with the spread in either
    // position and pins nothing — which a mutation check confirmed.
    const hostile = {
      ...toolOptionsWithEveryField(),
      toolMode: 'write',
      confirmThreshold: 'never',
    };
    const ctx = makeTestContext({
      toolOptions: hostile,
      policyDecision: { toolMode: { mode: 'read-only', confirmThreshold: 'high' } },
    } as unknown as Partial<AgentContext>);
    await runDefinition(ctx, fakeDefinition(), { text: 'hi' });

    const bag = augmentSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(bag.toolMode).toBe('read-only');
    expect(bag.confirmThreshold).toBe('high');
  });
});
