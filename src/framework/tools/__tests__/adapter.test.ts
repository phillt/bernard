import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { toolToAISDK, legacyTool, readToolMeta } from '../adapter.js';
import { ok, err, type BernardTool } from '../types.js';

function makeMigrated(): BernardTool<{ x: number }, { doubled: number }> {
  return {
    meta: { name: 'demo', kind: 'read' },
    description: 'demo',
    parameters: z.object({ x: z.number() }),
    execute: async ({ x }) => {
      if (x < 0) {
        return err({ type: 'invalid_args', message: 'x must be non-negative' });
      }
      return ok({ doubled: x * 2 });
    },
    serializeForModel: (r) =>
      r.status === 'ok' ? r.result : `Error: ${r.error.message}`,
  };
}

describe('toolToAISDK', () => {
  it('passes the envelope result through serializeForModel on success', async () => {
    const aisdk = toolToAISDK(makeMigrated());
    const result = await (aisdk as { execute: (a: unknown, o: unknown) => unknown }).execute(
      { x: 21 },
      {},
    );
    expect(result).toEqual({ doubled: 42 });
  });

  it('passes the envelope result through serializeForModel on error', async () => {
    const aisdk = toolToAISDK(makeMigrated());
    const result = await (aisdk as { execute: (a: unknown, o: unknown) => unknown }).execute(
      { x: -1 },
      {},
    );
    expect(result).toBe('Error: x must be non-negative');
  });

  it('attaches __bernardMeta non-enumerably', () => {
    const aisdk = toolToAISDK(makeMigrated());
    expect(readToolMeta(aisdk)).toEqual({ name: 'demo', kind: 'read' });
    expect(Object.keys(aisdk)).not.toContain('__bernardMeta');
  });
});

describe('legacyTool', () => {
  it('wraps a successful AI-SDK return in a status:"ok" envelope', async () => {
    const legacy = tool({
      description: 'echo',
      parameters: z.object({ msg: z.string() }),
      execute: async ({ msg }) => `you said: ${msg}`,
    });
    const wrapped = legacyTool(legacy, { name: 'echo', kind: 'inert' });
    const result = await wrapped.execute({ msg: 'hi' }, {});
    expect(result).toEqual({ status: 'ok', result: 'you said: hi' });
  });

  it('converts a thrown error into a status:"error" envelope', async () => {
    const legacy = tool({
      description: 'fail',
      parameters: z.object({}),
      execute: async () => {
        throw new Error('boom');
      },
    });
    const wrapped = legacyTool(legacy, { name: 'fail', kind: 'inert' });
    const result = await wrapped.execute({}, {});
    expect(result).toEqual({
      status: 'error',
      error: { type: 'exec_failed', message: 'boom' },
    });
  });

  it('passes an already-envelope return through untouched', async () => {
    const legacy = tool({
      description: 'returns envelope',
      parameters: z.object({}),
      execute: async () => ({ status: 'ok' as const, result: 'pre-wrapped' }),
    });
    const wrapped = legacyTool(legacy, { name: 'env', kind: 'inert' });
    const result = await wrapped.execute({}, {});
    expect(result).toEqual({ status: 'ok', result: 'pre-wrapped' });
  });

  it('serializeForModel preserves the legacy plain-value shape on success', async () => {
    const legacy = tool({
      description: 'val',
      parameters: z.object({}),
      execute: async () => ({ output: 'hi', is_error: false }),
    });
    const wrapped = legacyTool(legacy, { name: 'val', kind: 'inert' });
    const envelope = await wrapped.execute({}, {});
    expect(wrapped.serializeForModel(envelope)).toEqual({ output: 'hi', is_error: false });
  });
});
