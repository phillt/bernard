import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';

/**
 * The contradiction check against a REAL directory (#373).
 *
 * `memory.contradiction.test.ts` mocks `node:fs` wholesale and spies on
 * `store.supersede`, which is right for "what does the tool do with a verdict"
 * and is exactly what hid the defect these pin: the check ran BEFORE the write,
 * and `MemoryStore.supersede` refuses a replacement that does not exist. So
 * every acting verdict fell through to "both are kept" — the check spent a full
 * model round trip and could only ever produce a sentence, indistinguishable
 * from the model having declined.
 *
 * A mocked `supersede` cannot see that. Only a real store can.
 */
useTempHome('bernard-contradiction-disk');

const verdict = vi.hoisted(() => ({ current: { kind: 'none' } as any }));
vi.mock('../memory-contradiction.js', () => ({
  NO_CONTRADICTION: { kind: 'none' },
  checkContradiction: vi.fn(async () => verdict.current),
}));

const config = { provider: 'anthropic' } as never;

let createMemoryTool: typeof import('./memory.js').createMemoryTool;
let MemoryStore: typeof import('../memory.js').MemoryStore;

beforeEach(async () => {
  vi.resetModules();
  verdict.current = { kind: 'none' };
  createMemoryTool = (await import('./memory.js')).createMemoryTool;
  MemoryStore = (await import('../memory.js')).MemoryStore;
});

async function write(store: InstanceType<typeof MemoryStore>, key: string, content: string) {
  const tool = createMemoryTool(store, undefined, { config });
  const r = await tool.execute({ action: 'write', key, content } as never, {} as never);
  return String((r as { result: string }).result);
}

describe('acting on a verdict against a real store', () => {
  it('actually retires the contradicted note', async () => {
    const store = new MemoryStore();
    store.writeMemory('old', 'the sky is green');
    verdict.current = { kind: 'supersede', key: 'old', reason: 'It says the opposite.' };

    const out = await write(store, 'new', 'the sky is blue');

    expect(out).toContain('Retired "old"');
    // The claim in the sentence and the state on disk must agree — the whole
    // failure mode was a sentence that said one thing while the file said
    // another (or, before the fix, a sentence that admitted defeat).
    expect(store.listMemory().sort()).toEqual(['new']);
    expect(store.readRecord('old')?.supersededBy).toBe('new');
    expect(store.readMemory('new')).toContain('the sky is blue');
  });

  it('names the disagreement without retiring anything when the target is gone', async () => {
    const store = new MemoryStore();
    verdict.current = { kind: 'supersede', key: 'never-existed', reason: 'r' };
    const out = await write(store, 'new', 'x');
    expect(out).toContain('Both are kept.');
    expect(store.listMemory()).toEqual(['new']);
  });

  // The other half of the ordering constraint: a write that fails its own
  // collision guard must cost no model call at all.
  it('does not check when the write itself was refused', async () => {
    const store = new MemoryStore();
    store.writeMemory('ab', 'first');
    const { checkContradiction } = await import('../memory-contradiction.js');
    vi.mocked(checkContradiction).mockClear();
    const tool = createMemoryTool(store, undefined, { config });
    const r = await tool.execute(
      // Two raw keys that sanitize onto one file — the collision guard's case.
      { action: 'write', key: 'a b', content: 'second' } as never,
      {} as never,
    );
    expect(JSON.stringify(r)).toMatch(/\\"ab\\"/);
    expect(checkContradiction).not.toHaveBeenCalled();
  });
});
