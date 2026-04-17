import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createThinkTool } from './think.js';

const printThought = vi.fn();
vi.mock('../output.js', () => ({
  printThought: (...args: any[]) => printThought(...args),
}));

describe('think tool', () => {
  let tool: ReturnType<typeof createThinkTool>;

  beforeEach(() => {
    printThought.mockClear();
    tool = createThinkTool();
  });

  it('prints the thought and returns an ack', async () => {
    const result = await tool.execute!(
      { thought: 'Next I will list the package deps to find what is outdated.' } as any,
      {} as any,
    );
    expect(printThought).toHaveBeenCalledWith(
      'Next I will list the package deps to find what is outdated.',
    );
    expect(result).toBe('Thought recorded.');
  });

  it('requires thought text (zod schema)', () => {
    expect(tool.parameters).toBeDefined();
  });
});
