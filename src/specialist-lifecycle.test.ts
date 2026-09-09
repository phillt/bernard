import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from './__tests__/temp-home.js';

/**
 * Deleting a specialist sweeps what is keyed on it.
 *
 * Mirrors `apps/lifecycle.test.ts`: a real filesystem under a temp HOME, every
 * store populated by hand, one call, then one assertion per row asserting
 * EMPTINESS. There was no test anywhere asserting a specialist deletion leaves
 * another store clean, which is how the orphan class below stayed invisible.
 */
useTempHome('bernard-specialist-delete');

async function load() {
  vi.resetModules();
  return {
    ...(await import('./specialist-lifecycle.js')),
    MemoryStore: (await import('./memory.js')).MemoryStore,
    SpecialistStore: (await import('./specialists.js')).SpecialistStore,
  };
}

const RECORD = {
  name: 'Coder',
  description: 'Writes code',
  systemPrompt: 'You write code.',
  guidelines: [],
  targetTools: ['shell'],
};

describe('deleteSpecialist', () => {
  it('sweeps the memories the specialist owned', async () => {
    const m = await load();
    const specialists = new m.SpecialistStore({ seed: false });
    specialists.createFull({ id: 'coder', ...RECORD } as never);
    const coder = new m.MemoryStore().asOwner('coder');
    coder.writeMemory('style-rules', 'Two-space indent.');
    coder.writeMemory('build-notes', 'Run npm ci first.');

    const result = m.deleteSpecialist('coder', specialists);

    expect(result).toEqual({ deleted: true, memories: 2 });
    expect(specialists.get('coder')).toBeUndefined();
    // Asserted from an OWNED view, not from main's: main could not see these
    // even when they existed, so a main-side check would pass either way.
    const after = new m.MemoryStore().asOwner('coder');
    expect(after.readMemory('style-rules')).toBeNull();
    expect(after.readMemory('build-notes')).toBeNull();
  });

  it("leaves the user's own memories alone", async () => {
    // The blast-radius test. `deleteByOwner` matches the owner exactly, so an
    // unowned record is untouchable through it.
    const m = await load();
    const specialists = new m.SpecialistStore({ seed: false });
    specialists.createFull({ id: 'coder', ...RECORD } as never);
    new m.MemoryStore().writeMemory('deploy-process', 'Tag, then push.');
    new m.MemoryStore().asOwner('coder').writeMemory('style-rules', 'x');

    expect(m.deleteSpecialist('coder', specialists).memories).toBe(1);
    expect(new m.MemoryStore().readMemory('deploy-process')).toBe('Tag, then push.');
  });

  it('leaves another specialist alone', async () => {
    const m = await load();
    const specialists = new m.SpecialistStore({ seed: false });
    specialists.createFull({ id: 'coder', ...RECORD } as never);
    specialists.createFull({ id: 'designer', ...RECORD } as never);
    new m.MemoryStore().asOwner('coder').writeMemory('coder-note', 'a');
    new m.MemoryStore().asOwner('designer').writeMemory('designer-note', 'b');

    m.deleteSpecialist('coder', specialists);

    expect(specialists.get('designer')).toBeDefined();
    expect(new m.MemoryStore().asOwner('designer').readMemory('designer-note')).toBe('b');
  });

  it('does not hand a re-created id the previous specialist’s memories', async () => {
    // The case that decided the scope. `createFull` refuses only on `exists`,
    // so without the sweep a delete-then-recreate inherits the old private
    // notes — same id, same `owner` string, same files.
    const m = await load();
    const specialists = new m.SpecialistStore({ seed: false });
    specialists.createFull({ id: 'coder', ...RECORD } as never);
    new m.MemoryStore().asOwner('coder').writeMemory('secret-note', 'old agent');

    m.deleteSpecialist('coder', specialists);
    specialists.createFull({ id: 'coder', ...RECORD } as never);

    expect(new m.MemoryStore().asOwner('coder').readMemory('secret-note')).toBeNull();
  });

  it('reports a missing specialist rather than throwing', async () => {
    const m = await load();
    const specialists = new m.SpecialistStore({ seed: false });
    expect(m.deleteSpecialist('nope', specialists)).toEqual({ deleted: false, memories: 0 });
  });

  it('refuses a bundled specialist without touching its memories', async () => {
    // The record delete runs FIRST precisely so a refusal happens before any
    // sweep: destroying data for a record that then stays on disk is the worst
    // available outcome.
    const m = await load();
    const specialists = new m.SpecialistStore({ seed: false });
    new m.MemoryStore().asOwner('shell-wrapper').writeMemory('kept', 'still here');

    expect(() => m.deleteSpecialist('shell-wrapper', specialists)).toThrow();
    expect(new m.MemoryStore().asOwner('shell-wrapper').readMemory('kept')).toBe('still here');
  });
});

describe('deleteSpecialist sweeps the specialist’s own RAG store', () => {
  it('removes the directory', async () => {
    // A store per specialist is a DIRECTORY, which is the payoff over a
    // namespace column: `RAGStore` can only delete by id and has no owner axis,
    // so a namespaced sweep would mean loading the whole store, filtering, and
    // re-serializing it.
    const m = await load();
    const fs = await import('node:fs');
    const { specialistRagDir } = await import('./paths.js');
    const specialists = new m.SpecialistStore({ seed: false });
    specialists.createFull({ id: 'coder', ...RECORD } as never);
    const dir = specialistRagDir('coder');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/memories.json`, '{"memories":[]}');

    // Asserted on the FILESYSTEM rather than on a returned flag: the flag was
    // read by nothing outside this file, and the directory being gone is the
    // property that matters.
    m.deleteSpecialist('coder', specialists);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('leaves a specialist that never wrote a fact alone', async () => {
    // Guards the guard: an unconditional `rmSync` on a directory that does not
    // exist must not throw and take the record delete's report with it.
    const m = await load();
    const specialists = new m.SpecialistStore({ seed: false });
    specialists.createFull({ id: 'quiet', ...RECORD } as never);
    expect(m.deleteSpecialist('quiet', specialists)).toEqual({ deleted: true, memories: 0 });
  });
});
