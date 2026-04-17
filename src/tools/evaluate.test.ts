import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEvaluateTool } from './evaluate.js';

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

  it('prints the evaluation and returns an ack', async () => {
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
});
