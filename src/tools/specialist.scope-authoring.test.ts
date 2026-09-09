import { describe, it, expect } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';

/**
 * A user or an agent can set a fence (#511 follow-up).
 *
 * `memoryScope` / `knowledgeScope` / `corpusScope` were enforced everywhere and
 * settable nowhere — hand-edited JSON only — which is the gap most likely to be
 * mistaken for "scoping does not work". #511 recorded the blocker as the
 * missing clearing sentinel: `undefined` means "don't change" and `[]` already
 * means deny-all, so a third value was needed. `''` is it, the way `role`,
 * `strategy` and `toolSurface` already clear, and it cannot be confused with a
 * declaration because it is not an array.
 *
 * A real `BERNARD_HOME` rather than the main suite's `node:fs` mock, for
 * `specialist.bind-coverage.test.ts`'s reason: the round trip through disk is
 * the thing under test, and a mock would let a create that stored nothing pass.
 */
useTempHome('spec-scope');

async function load() {
  const { vi } = await import('vitest');
  vi.resetModules();
  const { createSpecialistTool } = await import('./specialist.js');
  const { SpecialistStore } = await import('../specialists.js');
  const { SCOPE_AXES } = await import('../framework/agents/dispatch-profile.js');
  const store = new SpecialistStore({ seed: false });
  return { tool: createSpecialistTool(store), store, SCOPE_AXES };
}

const BASE = {
  action: 'create' as const,
  id: 'coder',
  name: 'Coder',
  description: 'writes code',
  systemPrompt: 'You write code.',
};

const run = async (tool: { execute: (a: unknown, o: unknown) => unknown }, args: object) =>
  (await tool.execute(args, {} as never)) as string;

describe('creating a fenced specialist', () => {
  it('stores every axis it was given', async () => {
    const { tool, store } = await load();
    await run(tool, {
      ...BASE,
      memoryScope: ['proj-*'],
      knowledgeScope: ['general'],
      corpusScope: ['handbook'],
    });
    expect(store.get('coder')).toMatchObject({
      memoryScope: ['proj-*'],
      knowledgeScope: ['general'],
      corpusScope: ['handbook'],
    });
  });

  it('honours [] as deny-all rather than dropping it', async () => {
    // The distinction the sentinel exists to preserve: `[]` is a real posture —
    // "verify against the task and nothing else" — and storing it as "absent"
    // would silently hand the specialist the whole store.
    const { tool, store } = await load();
    await run(tool, { ...BASE, memoryScope: [] });
    expect(store.get('coder')?.memoryScope).toEqual([]);
  });

  it('stores nothing for the clear sentinel, since there is nothing to clear', async () => {
    const { tool, store } = await load();
    await run(tool, { ...BASE, memoryScope: '' });
    expect(store.get('coder')).not.toHaveProperty('memoryScope');
  });

  it('leaves a record that declares nothing unfenced', async () => {
    const { tool, store, SCOPE_AXES } = await load();
    await run(tool, BASE);
    const record = store.get('coder')!;
    for (const axis of SCOPE_AXES) expect(record).not.toHaveProperty(axis.field);
  });
});

describe('updating a fence', () => {
  async function withCoder() {
    const loaded = await load();
    await run(loaded.tool, { ...BASE, memoryScope: ['proj-*'], knowledgeScope: ['general'] });
    return loaded;
  }

  it('replaces one axis without touching the others', async () => {
    const { tool, store } = await withCoder();
    await run(tool, { action: 'update', id: 'coder', memoryScope: ['notes-*'] });
    expect(store.get('coder')).toMatchObject({
      memoryScope: ['notes-*'],
      knowledgeScope: ['general'],
    });
  });

  it('removes a fence on ""', async () => {
    const { tool, store } = await withCoder();
    await run(tool, { action: 'update', id: 'coder', memoryScope: '' });
    const record = store.get('coder')!;
    expect(record).not.toHaveProperty('memoryScope');
    // …and only that one, or the clear is a reset.
    expect(record.knowledgeScope).toEqual(['general']);
  });

  it('narrows to deny-all on []', async () => {
    // Guards the guard above: `[]` and `''` must not both mean "remove", which
    // is the collision #511 said made an authoring surface impossible.
    const { tool, store } = await withCoder();
    await run(tool, { action: 'update', id: 'coder', memoryScope: [] });
    expect(store.get('coder')?.memoryScope).toEqual([]);
  });

  it('counts as a field, so a scope-only update is not rejected as empty', async () => {
    const { tool } = await withCoder();
    const out = await run(tool, { action: 'update', id: 'coder', corpusScope: ['handbook'] });
    expect(out).not.toMatch(/^Error/);
  });
});

describe('an invalid entry', () => {
  it('is refused by name, with the rule, and nothing is saved', async () => {
    // Refused here where the resolver drops silently, the division
    // `targetToolsScopeError` already makes: `declaredScope` runs before every
    // dispatch and must never throw, so it falls back per entry — which is
    // right for a resolver and useless as feedback. A fence is the field where
    // a silent drop is worst, since an entry that never matches is
    // indistinguishable from a store with nothing to say.
    const { tool, store } = await load();
    const out = await run(tool, { ...BASE, memoryScope: ['ok-*', '../etc'] });
    expect(out).toMatch(/^Error/);
    expect(out).toContain('memoryScope');
    expect(out).toContain('../etc');
    expect(out).toContain('prefix ending in');
    expect(store.get('coder')).toBeUndefined();
  });

  it('refuses a domain that does not exist', async () => {
    const { tool, store } = await load();
    const out = await run(tool, { ...BASE, knowledgeScope: ['not-a-domain'] });
    expect(out).toMatch(/^Error/);
    expect(store.get('coder')).toBeUndefined();
  });

  it('keeps a library id for a library nobody has created yet', async () => {
    // Shape, never existence — the property that makes `corpusScope` a separate
    // axis from `knowledgeScope`. It already fails closed by matching nothing.
    const { tool, store } = await load();
    await run(tool, { ...BASE, corpusScope: ['not-created-yet'] });
    expect(store.get('coder')?.corpusScope).toEqual(['not-created-yet']);
  });

  it('leaves an existing record untouched when an update is refused', async () => {
    const { tool, store } = await load();
    await run(tool, { ...BASE, memoryScope: ['proj-*'] });
    const out = await run(tool, { action: 'update', id: 'coder', memoryScope: ['../etc'] });
    expect(out).toMatch(/^Error/);
    expect(store.get('coder')?.memoryScope).toEqual(['proj-*']);
  });
});

describe('reading one back', () => {
  it('prints every declared axis, and none it did not declare', async () => {
    // What the `/specialists` edit hand-off and any agent about to change a
    // record actually calls. A fence it cannot see is one it will drop.
    const { tool } = await load();
    await run(tool, { ...BASE, memoryScope: ['proj-*'], corpusScope: [] });
    const out = await run(tool, { action: 'read', id: 'coder' });
    expect(out).toContain('memoryScope: proj-*');
    expect(out).toContain('corpusScope:');
    expect(out).not.toContain('knowledgeScope');
  });
});

describe('the schema tracks the table', () => {
  it('offers every axis in SCOPE_AXES', async () => {
    // The record-to-surface direction, which is the one the mistake is made in:
    // a fourth fence added to `SCOPE_AXES` is enforced everywhere by the table
    // and settable nowhere until someone adds it here. The zod keys are written
    // by hand because generating them widens the parameter type and unpicks the
    // destructuring, so this is what keeps the hand-written list honest.
    const { tool, SCOPE_AXES } = await load();
    const shape = (tool.parameters as unknown as { shape: Record<string, unknown> }).shape;
    for (const axis of SCOPE_AXES) expect(Object.keys(shape)).toContain(axis.field);
  });

  it('gives every axis a hint the refusal can quote', async () => {
    const { SCOPE_AXES } = await load();
    for (const axis of SCOPE_AXES) expect(axis.hint.length).toBeGreaterThan(10);
  });
});
