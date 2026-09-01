import { describe, it, expect } from 'vitest';
import { runDispatchOrFail } from './dispatch-failure.js';

describe('runDispatchOrFail (#351)', () => {
  it('returns the body result untouched on success', async () => {
    const out = await runDispatchOrFail(
      async () => ({ status: 'ok' }),
      () => ({ status: 'shaped' }),
    );
    expect(out).toEqual({ status: 'ok' });
  });

  it('hands a work failure to the shaper instead of throwing', async () => {
    // The behaviour worth keeping from the five hand-rolled catches: a failed
    // sub-dispatch is a legitimate tool RESULT the model reads and works around.
    const out = await runDispatchOrFail(
      async () => {
        throw new Error('API rate limit');
      },
      (message) => `Error: Sub-agent failed: ${message}`,
    );
    expect(out).toBe('Error: Sub-agent failed: API rate limit');
  });

  it('re-throws a cancellation rather than shaping it into a result', async () => {
    // The whole reason this is a combinator: a returned value is a *successful*
    // tool result, which the parent reads as data and loops on (#327). Three of
    // the five sites carried this statement; two did not.
    const shaper = () => 'never';
    await expect(
      runDispatchOrFail(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }, shaper),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('re-throws an abort the runner fired itself, walking `cause`', async () => {
    // `isDispatchCancellation` matches on name — a provider "network timeout"
    // is a work failure the model should see, our own abort is not — and walks
    // `cause` because the AI SDK re-wraps a throw out of `tool.execute`.
    const own = new Error('Provider stream timed out — no data received');
    own.name = 'DispatchAbortError';
    const wrapped = new Error('Error executing tool delegate_google', { cause: own });
    wrapped.name = 'AI_ToolExecutionError';
    await expect(
      runDispatchOrFail(
        async () => {
          throw wrapped;
        },
        () => 'never',
      ),
    ).rejects.toThrow(/Error executing tool/);
  });

  it('stringifies a non-Error throw rather than interpolating [object Object]', async () => {
    const out = await runDispatchOrFail(
      async () => {
        throw 'plain string rejection';
      },
      (message) => `shaped: ${message}`,
    );
    expect(out).toBe('shaped: plain string rejection');
  });

  it('passes the raw error alongside the message so a shaper can inspect it', async () => {
    const boom = Object.assign(new Error('nope'), { httpStatus: 429 });
    const out = await runDispatchOrFail(
      async () => {
        throw boom;
      },
      (_message, err) => err,
    );
    expect(out).toBe(boom);
  });
});
