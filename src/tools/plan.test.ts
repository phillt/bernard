import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPlanTool } from './plan.js';
import { PlanStore } from '../plan-store.js';

vi.mock('../output.js', () => ({
  printPlan: vi.fn(),
}));

describe('plan tool', () => {
  let store: PlanStore;
  let tool: ReturnType<typeof createPlanTool>;

  beforeEach(() => {
    store = new PlanStore();
    tool = createPlanTool(store);
  });

  const run = async (args: Record<string, unknown>) =>
    (await tool.execute!(args as any, {} as any)) as string;

  it('create returns success when steps are provided', async () => {
    const result = await run({ action: 'create', steps: ['a', 'b'] });
    expect(result).toContain('Plan created with 2 steps');
    expect(store.view()).toHaveLength(2);
  });

  it('create errors when steps is missing', async () => {
    const result = await run({ action: 'create' });
    expect(result).toMatch(/Error.*steps is required/);
  });

  it('update to done requires a note', async () => {
    await run({ action: 'create', steps: ['a'] });
    const result = await run({ action: 'update', id: 1, status: 'done' });
    expect(result).toMatch(/Error: note is required when marking a step done/);
    expect(store.view()[0].status).toBe('pending');
  });

  it('update to cancelled requires a note', async () => {
    await run({ action: 'create', steps: ['a'] });
    const result = await run({ action: 'update', id: 1, status: 'cancelled' });
    expect(result).toMatch(/Error: note is required when marking a step cancelled/);
  });

  it('update to error requires a note', async () => {
    await run({ action: 'create', steps: ['a'] });
    const result = await run({ action: 'update', id: 1, status: 'error' });
    expect(result).toMatch(/Error: note is required when marking a step error/);
  });

  it('update to done with a note succeeds', async () => {
    await run({ action: 'create', steps: ['a'] });
    const result = await run({
      action: 'update',
      id: 1,
      status: 'done',
      note: 'read package.json — found 14 dependencies',
    });
    expect(result).toBe('Step 1 -> done.');
    expect(store.view()[0].status).toBe('done');
    expect(store.view()[0].note).toContain('package.json');
  });

  it('update to in_progress does not require a note', async () => {
    await run({ action: 'create', steps: ['a'] });
    const result = await run({ action: 'update', id: 1, status: 'in_progress' });
    expect(result).toBe('Step 1 -> in_progress.');
  });

  it('update on unknown id returns error', async () => {
    await run({ action: 'create', steps: ['a'] });
    const result = await run({ action: 'update', id: 99, status: 'done', note: 'x' });
    expect(result).toMatch(/no step found with id 99/);
  });

  it('add appends a pending step', async () => {
    await run({ action: 'create', steps: ['a'] });
    const result = await run({ action: 'add', step: 'b' });
    expect(result).toBe('Step 2 added.');
    expect(store.view()).toHaveLength(2);
  });

  it('view on empty plan returns informative message', async () => {
    const result = await run({ action: 'view' });
    expect(result).toMatch(/No plan in progress/);
  });

  it('view on populated plan reports counts', async () => {
    await run({ action: 'create', steps: ['a', 'b'] });
    await run({ action: 'update', id: 1, status: 'done', note: 'ok' });
    const result = await run({ action: 'view' });
    expect(result).toContain('2 steps');
    expect(result).toContain('1 unresolved');
  });
});
