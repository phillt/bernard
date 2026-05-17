import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAskUserTool } from './ask-user.js';
import type { AskUserBatchResult, AskUserQuestion } from './types.js';

type AskUserCallback = (
  questions: AskUserQuestion[],
  signal?: AbortSignal,
) => Promise<AskUserBatchResult>;

describe('ask_user tool', () => {
  let askUser: ReturnType<typeof vi.fn<Parameters<AskUserCallback>, ReturnType<AskUserCallback>>>;

  beforeEach(() => {
    askUser = vi.fn();
  });

  it('returns answers JSON when a single-question batch resolves', async () => {
    askUser.mockResolvedValue({ answers: ['open'] });
    const tool = createAskUserTool(askUser);
    const out = await tool.execute!(
      { questions: [{ question: 'open or closed?', choices: ['open', 'closed'] }] } as any,
      {} as any,
    );
    expect(JSON.parse(out)).toEqual({ answers: ['open'] });
    expect(askUser).toHaveBeenCalledWith(
      [
        {
          question: 'open or closed?',
          choices: ['open', 'closed'],
          allowOther: true,
          otherLabel: undefined,
        },
      ],
      undefined,
    );
  });

  it('returns all answers JSON when a multi-question batch resolves', async () => {
    askUser.mockResolvedValue({ answers: ['red', 'large'] });
    const tool = createAskUserTool(askUser);
    const out = await tool.execute!(
      {
        questions: [
          { question: 'color?', choices: ['red', 'blue'] },
          { question: 'size?', choices: ['small', 'large'] },
        ],
      } as any,
      {} as any,
    );
    expect(JSON.parse(out)).toEqual({ answers: ['red', 'large'] });
    expect(askUser.mock.calls[0][0]).toHaveLength(2);
  });

  it('passes allow_other=false through to the callback', async () => {
    askUser.mockResolvedValue({ answers: ['closed'] });
    const tool = createAskUserTool(askUser);
    await tool.execute!(
      {
        questions: [
          { question: 'open or closed?', choices: ['open', 'closed'], allow_other: false },
        ],
      } as any,
      {} as any,
    );
    expect(askUser.mock.calls[0][0][0].allowOther).toBe(false);
  });

  it('defaults allowOther to true when choices is absent (free-form)', async () => {
    askUser.mockResolvedValue({ answers: ['feline'] });
    const tool = createAskUserTool(askUser);
    await tool.execute!({ questions: [{ question: 'name?' }] } as any, {} as any);
    const q = askUser.mock.calls[0][0][0];
    expect(q.choices).toBeUndefined();
    expect(q.allowOther).toBe(true);
  });

  it('forwards other_label to the callback as otherLabel', async () => {
    askUser.mockResolvedValue({ answers: ['default'] });
    const tool = createAskUserTool(askUser);
    await tool.execute!(
      {
        questions: [
          {
            question: 'pick a config',
            choices: ['default', 'minimal'],
            other_label: 'Other (I will specify config)',
          },
        ],
      } as any,
      {} as any,
    );
    expect(askUser.mock.calls[0][0][0].otherLabel).toBe('Other (I will specify config)');
  });

  it('returns {cancelled, answered: []} when the user cancels the first question', async () => {
    askUser.mockResolvedValue({ cancelled: true, answered: [] });
    const tool = createAskUserTool(askUser);
    const out = await tool.execute!({ questions: [{ question: 'name?' }] } as any, {} as any);
    expect(JSON.parse(out)).toEqual({ cancelled: true, answered: [] });
  });

  it('returns partial answers when the user cancels mid-batch', async () => {
    askUser.mockResolvedValue({ cancelled: true, answered: ['red'] });
    const tool = createAskUserTool(askUser);
    const out = await tool.execute!(
      {
        questions: [
          { question: 'color?', choices: ['red', 'blue'] },
          { question: 'size?', choices: ['small', 'large'] },
        ],
      } as any,
      {} as any,
    );
    expect(JSON.parse(out)).toEqual({ cancelled: true, answered: ['red'] });
  });

  it('returns {unavailable: true} when no callback is provided', async () => {
    const tool = createAskUserTool(undefined);
    const out = await tool.execute!({ questions: [{ question: 'name?' }] } as any, {} as any);
    expect(JSON.parse(out)).toEqual({ unavailable: true, reason: 'no interactive user' });
  });

  it('forwards the abort signal from execOptions into the callback', async () => {
    askUser.mockResolvedValue({ answers: ['x'] });
    const tool = createAskUserTool(askUser);
    const controller = new AbortController();
    await tool.execute!(
      { questions: [{ question: 'q?', choices: ['a', 'b'] }] } as any,
      { abortSignal: controller.signal } as any,
    );
    expect(askUser.mock.calls[0][1]).toBe(controller.signal);
  });

  it('rejects an empty questions array via Zod', () => {
    const tool = createAskUserTool(askUser);
    const result = (tool.parameters as any).safeParse({ questions: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a single-choice menu inside a question via Zod', () => {
    const tool = createAskUserTool(askUser);
    const result = (tool.parameters as any).safeParse({
      questions: [{ question: 'pick one', choices: ['only'] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a questions array longer than 10 via Zod', () => {
    const tool = createAskUserTool(askUser);
    const result = (tool.parameters as any).safeParse({
      questions: Array.from({ length: 11 }, (_, i) => ({ question: `q${i}` })),
    });
    expect(result.success).toBe(false);
  });
});
