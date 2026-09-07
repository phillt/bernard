import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createReadOnlyMemoryTool,
  createReadOnlyScratchTool,
  readOnlyWrap,
} from './read-only-memory.js';
import type { MemoryStore } from '../../memory.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: 1 })),
  unlinkSync: vi.fn(),
}));

/**
 * The PAC read-only wrapper had no tests, and the gap it left was live.
 *
 * It hardcoded `action === 'write' || action === 'delete'` — a second copy of a
 * decision the tool itself already makes through `meta.isWriteAction`, and one
 * that fails **open**: `memory` gained a `supersede` action (#513) and this
 * wrapper would have admitted it, letting the Critic retire a user's memories
 * from the one phase whose entire contract is that it cannot write.
 *
 * These pin the property rather than the list, so the next mutating action is
 * covered on the day it is added rather than the day someone notices.
 */

let store: MemoryStore;
const calls: Array<[string, string?]> = [];

beforeEach(() => {
  calls.length = 0;
  store = {
    listMemory: () => ['a'],
    readMemory: (k: string) => {
      calls.push(['readMemory', k]);
      return 'body';
    },
    writeMemory: (k: string) => {
      calls.push(['writeMemory', k]);
    },
    deleteMemory: (k: string) => {
      calls.push(['deleteMemory', k]);
      return true;
    },
    supersede: (k: string, r: string) => {
      calls.push(['supersede', `${k}->${r}`]);
      return true;
    },
    listScratch: () => ['s'],
    readScratch: () => 'note',
    writeScratch: (k: string) => {
      calls.push(['writeScratch', k]);
    },
    deleteScratch: () => true,
  } as unknown as MemoryStore;
});

describe('the read-only memory tool', () => {
  it('allows list', async () => {
    const r = await createReadOnlyMemoryTool(store).execute(
      { action: 'list' } as never,
      {} as never,
    );
    expect(r.status).toBe('ok');
  });

  it('allows read', async () => {
    const r = await createReadOnlyMemoryTool(store).execute(
      { action: 'read', key: 'a' } as never,
      {} as never,
    );
    expect(r.status).toBe('ok');
    expect(calls).toContainEqual(['readMemory', 'a']);
  });

  it('rejects write without reaching the store', async () => {
    const r = await createReadOnlyMemoryTool(store).execute(
      { action: 'write', key: 'a', content: 'x' } as never,
      {} as never,
    );
    expect(r.status).toBe('error');
    expect(calls).toEqual([]);
  });

  it('rejects delete without reaching the store', async () => {
    const r = await createReadOnlyMemoryTool(store).execute(
      { action: 'delete', key: 'a' } as never,
      {} as never,
    );
    expect(r.status).toBe('error');
    expect(calls).toEqual([]);
  });

  it('rejects supersede without reaching the store', async () => {
    // The case the hardcoded list would have admitted. A Critic retiring a
    // user's curated memory is not a smaller act than deleting one — it is the
    // same act with the file left behind.
    const r = await createReadOnlyMemoryTool(store).execute(
      { action: 'supersede', key: 'a', replacement: 'b' } as never,
      {} as never,
    );
    expect(r.status).toBe('error');
    expect(calls).toEqual([]);
  });
});

describe('the read-only scratch tool', () => {
  it('allows read', async () => {
    const r = await createReadOnlyScratchTool(store).execute(
      { action: 'read', key: 's' } as never,
      {} as never,
    );
    expect(r.status).toBe('ok');
  });

  it('rejects write without reaching the store', async () => {
    const r = await createReadOnlyScratchTool(store).execute(
      { action: 'write', key: 's', content: 'x' } as never,
      {} as never,
    );
    expect(r.status).toBe('error');
    expect(calls).toEqual([]);
  });
});

describe('the wrapper refuses a tool it cannot classify', () => {
  it('rejects every action when the tool declares no isWriteAction', async () => {
    // Fail closed, deliberately: a read-only wrapper that cannot tell a read
    // from a write must not guess. Both real callers declare the predicate, so
    // this is a guard rather than a live path — which is exactly why it needs a
    // test, since nothing else would ever exercise it.
    const wrapped = readOnlyWrap({
      meta: { name: 'bare', kind: 'write', deterministic: false },
      description: 'd',
      parameters: {} as never,
      execute: async () => {
        calls.push(['bare']);
        return { status: 'ok', result: 'x' };
      },
      serializeForModel: () => 'x',
    } as never);

    const r = await wrapped.execute({ action: 'read' } as never, {} as never);
    expect(r.status).toBe('error');
    expect(calls).toEqual([]);
  });
});
