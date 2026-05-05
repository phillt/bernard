import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPlanTool } from './plan.js';
import { PlanStore } from '../plan-store.js';
import { printPlan } from '../output.js';

vi.mock('../output.js', () => ({
  printPlan: vi.fn(),
}));

const s = (description: string, verification = `verify: ${description}`) => ({
  description,
  verification,
});

describe('plan tool', () => {
  let store: PlanStore;
  let tool: ReturnType<typeof createPlanTool>;

  beforeEach(() => {
    vi.mocked(printPlan).mockClear();
    store = new PlanStore();
    tool = createPlanTool(store);
  });

  const run = async (args: Record<string, unknown>) =>
    (await tool.execute!(args as any, {} as any)) as string;

  it('create returns success when steps are provided', async () => {
    const result = await run({ action: 'create', steps: [s('a'), s('b')] });
    expect(result).toContain('Plan created with 2 steps');
    expect(store.view()).toHaveLength(2);
    expect(store.view()[0].verification).toBe('verify: a');
  });

  it('create errors when steps is missing', async () => {
    const result = await run({ action: 'create' });
    expect(result).toMatch(/Error.*steps is required/);
  });

  it('update to done requires a signoff', async () => {
    await run({ action: 'create', steps: [s('a')] });
    const result = await run({ action: 'update', id: 1, status: 'done' });
    expect(result).toMatch(/Error: signoff is required when marking a step done/);
    expect(store.view()[0].status).toBe('pending');
  });

  it('update to done with only a note still errors (signoff is what matters)', async () => {
    await run({ action: 'create', steps: [s('a')] });
    const result = await run({ action: 'update', id: 1, status: 'done', note: 'finished it' });
    expect(result).toMatch(/Error: signoff is required when marking a step done/);
    expect(store.view()[0].status).toBe('pending');
  });

  it('update to cancelled requires a note', async () => {
    await run({ action: 'create', steps: [s('a')] });
    const result = await run({ action: 'update', id: 1, status: 'cancelled' });
    expect(result).toMatch(/Error: note is required when marking a step cancelled/);
  });

  it('update to error requires a note', async () => {
    await run({ action: 'create', steps: [s('a')] });
    const result = await run({ action: 'update', id: 1, status: 'error' });
    expect(result).toMatch(/Error: note is required when marking a step error/);
  });

  it('update to done with a signoff succeeds and stores it', async () => {
    await run({ action: 'create', steps: [s('a')] });
    const result = await run({
      action: 'update',
      id: 1,
      status: 'done',
      signoff: 'ran cmd; got exit 0; output included expected substring',
    });
    expect(result).toBe('Step 1 -> done.');
    expect(store.view()[0].status).toBe('done');
    expect(store.view()[0].signoff).toContain('exit 0');
  });

  it('update to in_progress does not require a note or signoff', async () => {
    await run({ action: 'create', steps: [s('a')] });
    const result = await run({ action: 'update', id: 1, status: 'in_progress' });
    expect(result).toBe('Step 1 -> in_progress.');
  });

  it('update on unknown id returns error', async () => {
    await run({ action: 'create', steps: [s('a')] });
    const result = await run({
      action: 'update',
      id: 99,
      status: 'done',
      signoff: 'verified',
    });
    expect(result).toMatch(/no step found with id 99/);
  });

  it('add appends a pending step with verification', async () => {
    await run({ action: 'create', steps: [s('a')] });
    const result = await run({ action: 'add', step: s('b', 'read output.txt') });
    expect(result).toBe('Step 2 added.');
    expect(store.view()).toHaveLength(2);
    expect(store.view()[1].verification).toBe('read output.txt');
  });

  it('add errors when step is missing', async () => {
    const result = await run({ action: 'add' });
    expect(result).toMatch(/Error: step is required/);
  });

  it('view on empty plan returns informative message', async () => {
    const result = await run({ action: 'view' });
    expect(result).toMatch(/No plan in progress/);
  });

  it('view on populated plan reports counts', async () => {
    await run({ action: 'create', steps: [s('a'), s('b')] });
    await run({ action: 'update', id: 1, status: 'done', signoff: 'ok' });
    const result = await run({ action: 'view' });
    expect(result).toContain('2 steps');
    expect(result).toContain('1 unresolved');
  });

  it('rejects create with empty verification at the schema layer', () => {
    const parsed = tool.parameters.safeParse({
      action: 'create',
      steps: [{ description: 'do a thing', verification: '' }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => /verification must not be empty/.test(i.message)),
      ).toBe(true);
    }
  });

  it('rejects add with empty verification at the schema layer', () => {
    const parsed = tool.parameters.safeParse({
      action: 'add',
      step: { description: 'do a thing', verification: '' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects create with empty description at the schema layer', () => {
    const parsed = tool.parameters.safeParse({
      action: 'create',
      steps: [{ description: '', verification: 'check it' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('skips re-printing when repeated view actions yield identical render', async () => {
    await run({ action: 'create', steps: [s('a'), s('b')] });
    expect(printPlan).toHaveBeenCalledTimes(1);
    await run({ action: 'view' });
    await run({ action: 'view' });
    await run({ action: 'view' });
    expect(printPlan).toHaveBeenCalledTimes(1);
  });

  it('re-prints once state changes after suppressed views', async () => {
    await run({ action: 'create', steps: [s('a')] });
    await run({ action: 'view' });
    expect(printPlan).toHaveBeenCalledTimes(1);
    await run({ action: 'update', id: 1, status: 'in_progress' });
    expect(printPlan).toHaveBeenCalledTimes(2);
  });
});
