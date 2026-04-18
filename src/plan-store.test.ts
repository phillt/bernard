import { describe, it, expect, beforeEach } from 'vitest';
import { PlanStore } from './plan-store.js';

describe('PlanStore', () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  it('create replaces any existing plan and assigns sequential ids', () => {
    store.create(['first', 'second']);
    const replaced = store.create(['a', 'b', 'c']);
    expect(replaced).toHaveLength(3);
    expect(replaced.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(replaced.every((s) => s.status === 'pending')).toBe(true);
  });

  it('add appends a pending step with the next id', () => {
    store.create(['first', 'second']);
    const added = store.add('third');
    expect(added.id).toBe(3);
    expect(added.status).toBe('pending');
    expect(store.view()).toHaveLength(3);
  });

  it('update transitions status and stores note', () => {
    store.create(['a', 'b']);
    const updated = store.update(1, 'done', 'finished');
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('done');
    expect(updated?.note).toBe('finished');
  });

  it('update on unknown id returns null', () => {
    store.create(['a']);
    expect(store.update(99, 'done')).toBeNull();
  });

  it('isComplete returns true only when all steps are terminal', () => {
    store.create(['a', 'b', 'c']);
    expect(store.isComplete()).toBe(false);

    store.update(1, 'done');
    store.update(2, 'cancelled', 'not needed');
    expect(store.isComplete()).toBe(false);

    store.update(3, 'error', 'no permission');
    expect(store.isComplete()).toBe(true);
  });

  it('in_progress counts as unresolved', () => {
    store.create(['a', 'b']);
    store.update(1, 'in_progress');
    store.update(2, 'done');
    expect(store.isComplete()).toBe(false);
    expect(store.unresolvedCount()).toBe(1);
  });

  it('unresolvedCount reflects pending/in_progress steps', () => {
    store.create(['a', 'b', 'c', 'd']);
    expect(store.unresolvedCount()).toBe(4);
    store.update(1, 'done');
    store.update(2, 'in_progress');
    expect(store.unresolvedCount()).toBe(3);
  });

  it('clear resets steps and next-id', () => {
    store.create(['a', 'b']);
    store.clear();
    expect(store.view()).toEqual([]);
    const added = store.add('fresh');
    expect(added.id).toBe(1);
  });

  it('view returns a defensive copy', () => {
    store.create(['a']);
    const snapshot = store.view();
    snapshot[0].description = 'mutated';
    expect(store.view()[0].description).toBe('a');
  });

  it('isComplete returns true for an empty plan', () => {
    expect(store.isComplete()).toBe(true);
    expect(store.unresolvedCount()).toBe(0);
  });

  it('cancelAllUnresolved cancels non-terminal steps and leaves terminal ones alone', () => {
    store.create(['a', 'b', 'c', 'd', 'e']);
    store.update(1, 'done', 'finished');
    store.update(2, 'error', 'blocked');
    store.update(3, 'in_progress');
    // 4 stays pending; 5 already cancelled with its own note
    store.update(5, 'cancelled', 'user pivoted');

    const cancelled = store.cancelAllUnresolved('retries exhausted');
    expect(cancelled).toBe(2);

    const steps = store.view();
    expect(steps[0]).toMatchObject({ status: 'done', note: 'finished' });
    expect(steps[1]).toMatchObject({ status: 'error', note: 'blocked' });
    expect(steps[2]).toMatchObject({ status: 'cancelled', note: 'retries exhausted' });
    expect(steps[3]).toMatchObject({ status: 'cancelled', note: 'retries exhausted' });
    expect(steps[4]).toMatchObject({ status: 'cancelled', note: 'user pivoted' });
    expect(store.isComplete()).toBe(true);
  });

  it('render produces a readable status list', () => {
    store.create(['first', 'second']);
    store.update(1, 'done');
    store.update(2, 'error', 'blocked');
    const rendered = store.render();
    expect(rendered).toContain('1. [done] first');
    expect(rendered).toContain('2. [error] second — blocked');
  });
});
