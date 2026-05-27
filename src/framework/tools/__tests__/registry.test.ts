import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../registry.js';
import { ok, type BernardTool } from '../types.js';

function makeTool(
  name: string,
  kind: 'read' | 'write' | 'dangerous' | 'inert',
): BernardTool<unknown, unknown> {
  return {
    meta: { name, kind },
    description: name,
    parameters: z.object({}),
    execute: async () => ok({ name }),
    serializeForModel: (r) => (r.status === 'ok' ? r.result : `Error: ${r.error.message}`),
  };
}

describe('ToolRegistry', () => {
  it('starts empty by default', () => {
    const r = new ToolRegistry();
    expect(r.all()).toEqual([]);
  });

  it('seeds from a constructor iterable, keyed by meta.name', () => {
    const r = new ToolRegistry([makeTool('a', 'read'), makeTool('b', 'write')]);
    expect(r.has('a')).toBe(true);
    expect(r.has('b')).toBe(true);
    expect(r.get('a')?.meta.kind).toBe('read');
  });

  it('add() replaces an entry with the same name', () => {
    const r = new ToolRegistry([makeTool('x', 'read')]);
    r.add(makeTool('x', 'write'));
    expect(r.all()).toHaveLength(1);
    expect(r.get('x')?.meta.kind).toBe('write');
  });

  it('byMetadata({kind:"read"}) returns only read tools', () => {
    const r = new ToolRegistry([
      makeTool('search', 'read'),
      makeTool('list', 'read'),
      makeTool('write-file', 'write'),
      makeTool('shell', 'dangerous'),
    ]);
    const reads = r.byMetadata({ kind: 'read' });
    expect(reads.map((t) => t.meta.name).sort()).toEqual(['list', 'search']);
  });

  it('byMetadata({}) returns every tool', () => {
    const r = new ToolRegistry([makeTool('a', 'read'), makeTool('b', 'write')]);
    expect(
      r
        .byMetadata({})
        .map((t) => t.meta.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('byMetadata ignores undefined filter values', () => {
    const r = new ToolRegistry([makeTool('a', 'read'), makeTool('b', 'write')]);
    expect(r.byMetadata({ kind: undefined }).length).toBe(2);
  });

  it('byMetadata supports multi-key filters', () => {
    const a: BernardTool<unknown, unknown> = {
      ...makeTool('a', 'read'),
      meta: { name: 'a', kind: 'read', category: 'fs' },
    };
    const b: BernardTool<unknown, unknown> = {
      ...makeTool('b', 'read'),
      meta: { name: 'b', kind: 'read', category: 'net' },
    };
    const r = new ToolRegistry([a, b]);
    const fsReads = r.byMetadata({ kind: 'read', category: 'fs' });
    expect(fsReads.map((t) => t.meta.name)).toEqual(['a']);
  });

  it('toAISDKRecord() produces a Record keyed by meta.name with callable execute', async () => {
    const r = new ToolRegistry([makeTool('a', 'read')]);
    const aisdk = r.toAISDKRecord();
    expect(Object.keys(aisdk)).toEqual(['a']);
    const result = await (aisdk.a as { execute: (a: unknown, o: unknown) => unknown }).execute(
      {},
      {},
    );
    expect(result).toEqual({ name: 'a' });
  });
});
