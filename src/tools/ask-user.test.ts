import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAskUserTool } from './ask-user.js';
import type { AskUserResult } from './types.js';

describe('ask_user tool', () => {
  let askUser: ReturnType<typeof vi.fn<any[], Promise<AskUserResult>>>;

  beforeEach(() => {
    askUser = vi.fn();
  });

  it('returns the answer JSON when the callback resolves with one', async () => {
    askUser.mockResolvedValue({ answer: 'open' });
    const tool = createAskUserTool(askUser);
    const out = await tool.execute!(
      { question: 'open or closed?', choices: ['open', 'closed'] } as any,
      {} as any,
    );
    expect(JSON.parse(out)).toEqual({ answer: 'open' });
    expect(askUser).toHaveBeenCalledWith(
      'open or closed?',
      ['open', 'closed'],
      true,
      undefined,
      undefined,
    );
  });

  it('passes allow_other=false through to the callback', async () => {
    askUser.mockResolvedValue({ answer: 'closed' });
    const tool = createAskUserTool(askUser);
    await tool.execute!(
      { question: 'open or closed?', choices: ['open', 'closed'], allow_other: false } as any,
      {} as any,
    );
    expect(askUser).toHaveBeenCalledWith(
      'open or closed?',
      ['open', 'closed'],
      false,
      undefined,
      undefined,
    );
  });

  it('defaults allowOther to true when choices is absent (free-form)', async () => {
    askUser.mockResolvedValue({ answer: 'feline' });
    const tool = createAskUserTool(askUser);
    await tool.execute!({ question: 'name?' } as any, {} as any);
    expect(askUser).toHaveBeenCalledWith('name?', undefined, true, undefined, undefined);
  });

  it('forwards other_label to the callback', async () => {
    askUser.mockResolvedValue({ answer: 'foo' });
    const tool = createAskUserTool(askUser);
    await tool.execute!(
      {
        question: 'pick a config',
        choices: ['default', 'minimal'],
        other_label: 'Other (I will specify config)',
      } as any,
      {} as any,
    );
    expect(askUser).toHaveBeenCalledWith(
      'pick a config',
      ['default', 'minimal'],
      true,
      'Other (I will specify config)',
      undefined,
    );
  });

  it('returns {cancelled: true} when the callback cancels', async () => {
    askUser.mockResolvedValue({ cancelled: true });
    const tool = createAskUserTool(askUser);
    const out = await tool.execute!({ question: 'name?' } as any, {} as any);
    expect(JSON.parse(out)).toEqual({ cancelled: true });
  });

  it('returns {unavailable: true} when no callback is provided', async () => {
    const tool = createAskUserTool(undefined);
    const out = await tool.execute!({ question: 'name?' } as any, {} as any);
    expect(JSON.parse(out)).toEqual({ unavailable: true, reason: 'no interactive user' });
  });

  it('rejects a single-choice menu with a validation error', async () => {
    const tool = createAskUserTool(askUser);
    const out = await tool.execute!(
      { question: 'pick one', choices: ['only'] } as any,
      {} as any,
    );
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/at least 2 choices/);
    expect(askUser).not.toHaveBeenCalled();
  });

  it('forwards the abort signal from execOptions into the callback', async () => {
    askUser.mockResolvedValue({ answer: 'x' });
    const tool = createAskUserTool(askUser);
    const controller = new AbortController();
    await tool.execute!(
      { question: 'q?', choices: ['a', 'b'] } as any,
      { abortSignal: controller.signal } as any,
    );
    expect(askUser).toHaveBeenCalledWith('q?', ['a', 'b'], true, undefined, controller.signal);
  });
});
