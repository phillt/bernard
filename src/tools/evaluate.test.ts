import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEvaluateTool } from './evaluate.js';
import { VerificationStore } from '../agent-status.js';

const printEvaluation = vi.fn();
vi.mock('../output.js', () => ({
  printEvaluation: (...args: any[]) => printEvaluation(...args),
}));

describe('evaluate tool', () => {
  let tool: ReturnType<typeof createEvaluateTool>;

  beforeEach(() => {
    printEvaluation.mockClear();
    tool = createEvaluateTool();
  });

  it('prints the evaluation and returns the legacy ack when no checks provided', async () => {
    const result = await tool.execute!(
      { evaluation: 'Actually, that response looked empty — let me retry.' } as any,
      {} as any,
    );
    expect(printEvaluation).toHaveBeenCalledWith(
      'Actually, that response looked empty — let me retry.',
    );
    expect(result).toBe('Evaluation recorded.');
  });

  it('requires evaluation text (zod schema)', () => {
    expect(tool.parameters).toBeDefined();
  });

  it('with structured checks: returns verdict-tagged ack and writes to VerificationStore', async () => {
    const store = new VerificationStore();
    const t = createEvaluateTool(store);
    const result = await t.execute!(
      {
        evaluation: 'Wrote the file; confirmed via re-read.',
        checks: [
          { id: 'post_write_confirmed', label: 'post-write read', status: 'pass' },
          { id: 'schema_matched', label: 'schema', status: 'pass' },
        ],
      } as any,
      {} as any,
    );
    expect(result).toBe('Evaluation recorded: PASS (2 checks).');
    const v = store.getLast();
    expect(v?.verdict).toBe('pass');
    expect(v?.source).toBe('evaluate');
    expect(v?.checks).toHaveLength(2);
  });

  it('with a failing check: returns FAIL verdict and writes fail to store', async () => {
    const store = new VerificationStore();
    const t = createEvaluateTool(store);
    const result = await t.execute!(
      {
        evaluation: 'Tried to write but the file is missing post-write.',
        checks: [
          {
            id: 'post_write_confirmed',
            label: 'post-write read',
            status: 'fail',
            evidence: 'file not found',
          },
        ],
      } as any,
      {} as any,
    );
    expect(result).toBe('Evaluation recorded: FAIL (1 check).');
    expect(store.getLast()?.verdict).toBe('fail');
  });

  it('without a VerificationStore: still tags the ack but does not throw', async () => {
    const result = await tool.execute!(
      {
        evaluation: 'ok',
        checks: [{ id: 'x', label: 'x', status: 'warn' }],
      } as any,
      {} as any,
    );
    expect(result).toBe('Evaluation recorded: WARN (1 check).');
  });
});
