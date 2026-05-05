import { describe, it, expect, beforeEach } from 'vitest';
import { PlanStore } from './plan-store.js';

const s = (description: string, verification = `verify: ${description}`) => ({
  description,
  verification,
});

describe('PlanStore', () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  it('create replaces any existing plan and assigns sequential ids', () => {
    store.create([s('first'), s('second')]);
    const replaced = store.create([s('a'), s('b'), s('c')]);
    expect(replaced).toHaveLength(3);
    expect(replaced.map((step) => step.id)).toEqual([1, 2, 3]);
    expect(replaced.every((step) => step.status === 'pending')).toBe(true);
    expect(replaced.every((step) => step.verification.length > 0)).toBe(true);
  });

  it('add appends a pending step with the next id', () => {
    store.create([s('first'), s('second')]);
    const added = store.add(s('third'));
    expect(added.id).toBe(3);
    expect(added.status).toBe('pending');
    expect(added.verification).toBe('verify: third');
    expect(store.view()).toHaveLength(3);
  });

  it('update transitions status and stores note + signoff', () => {
    store.create([s('a'), s('b')]);
    const updated = store.update(1, 'done', { signoff: 'observed exit 0' });
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('done');
    expect(updated?.signoff).toBe('observed exit 0');
  });

  it('update on unknown id returns null', () => {
    store.create([s('a')]);
    expect(store.update(99, 'done')).toBeNull();
  });

  it('isComplete returns true only when all steps are terminal', () => {
    store.create([s('a'), s('b'), s('c')]);
    expect(store.isComplete()).toBe(false);

    store.update(1, 'done', { signoff: 'ok' });
    store.update(2, 'cancelled', { note: 'not needed' });
    expect(store.isComplete()).toBe(false);

    store.update(3, 'error', { note: 'no permission' });
    expect(store.isComplete()).toBe(true);
  });

  it('in_progress counts as unresolved', () => {
    store.create([s('a'), s('b')]);
    store.update(1, 'in_progress');
    store.update(2, 'done', { signoff: 'ok' });
    expect(store.isComplete()).toBe(false);
    expect(store.unresolvedCount()).toBe(1);
  });

  it('unresolvedCount reflects pending/in_progress steps', () => {
    store.create([s('a'), s('b'), s('c'), s('d')]);
    expect(store.unresolvedCount()).toBe(4);
    store.update(1, 'done', { signoff: 'ok' });
    store.update(2, 'in_progress');
    expect(store.unresolvedCount()).toBe(3);
  });

  it('clear resets steps and next-id', () => {
    store.create([s('a'), s('b')]);
    store.clear();
    expect(store.view()).toEqual([]);
    const added = store.add(s('fresh'));
    expect(added.id).toBe(1);
  });

  it('view returns a defensive copy', () => {
    store.create([s('a')]);
    const snapshot = store.view();
    snapshot[0].description = 'mutated';
    expect(store.view()[0].description).toBe('a');
  });

  it('isComplete returns true for an empty plan', () => {
    expect(store.isComplete()).toBe(true);
    expect(store.unresolvedCount()).toBe(0);
  });

  it('cancelAllUnresolved cancels non-terminal steps and leaves terminal ones alone', () => {
    store.create([s('a'), s('b'), s('c'), s('d'), s('e')]);
    store.update(1, 'done', { signoff: 'finished' });
    store.update(2, 'error', { note: 'blocked' });
    store.update(3, 'in_progress');
    store.update(5, 'cancelled', { note: 'user pivoted' });

    const cancelled = store.cancelAllUnresolved('retries exhausted');
    expect(cancelled).toBe(2);

    const steps = store.view();
    expect(steps[0]).toMatchObject({ status: 'done', signoff: 'finished' });
    expect(steps[1]).toMatchObject({ status: 'error', note: 'blocked' });
    expect(steps[2]).toMatchObject({ status: 'cancelled', note: 'retries exhausted' });
    expect(steps[3]).toMatchObject({ status: 'cancelled', note: 'retries exhausted' });
    expect(steps[4]).toMatchObject({ status: 'cancelled', note: 'user pivoted' });
    expect(store.isComplete()).toBe(true);
  });

  it('render includes verification, signoff, and note when present', () => {
    store.create([s('first', 'check exit code'), s('second', 'read file')]);
    store.update(1, 'done', { signoff: 'exit 0 observed' });
    store.update(2, 'error', { note: 'file missing' });
    const rendered = store.render();
    expect(rendered).toContain('1. [done] first');
    expect(rendered).toContain('verify: check exit code');
    expect(rendered).toContain('signoff: exit 0 observed');
    expect(rendered).toContain('2. [error] second');
    expect(rendered).toContain('note: file missing');
  });
});
