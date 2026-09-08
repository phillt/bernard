import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The write-time contradiction check (#373), from the tool's side.
 *
 * `memory-contradiction.test.ts` covers the verdict; this covers what the tool
 * DOES with it — and above all that a write never stops happening.
 *
 * Its own file rather than a block in `memory.test.ts`: `vi.mock` is hoisted
 * file-wide, so mocking the contradiction and consolidation modules there would
 * apply to every other test in that file too.
 */
const verdict = vi.hoisted(() => ({ current: { kind: 'none' } as any }));
const checkContradiction = vi.hoisted(() => vi.fn(async () => verdict.current));

vi.mock('../memory-contradiction.js', () => ({
  NO_CONTRADICTION: { kind: 'none' },
  checkContradiction,
}));
vi.mock('../memory-consolidation.js', () => ({ consolidationInputs: () => [] }));
vi.mock('node:fs', () => ({
  statSync: vi.fn(() => ({ mtimeMs: 1 })),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { createMemoryTool } from './memory.js';
import { MemoryStore } from '../memory.js';

const config = { provider: 'anthropic' } as never;

async function write(
  tool: ReturnType<typeof createMemoryTool>,
  key = 'k',
  content = 'c',
  execOptions: unknown = {},
): Promise<string> {
  const r = await tool.execute({ action: 'write', key, content } as never, execOptions as never);
  return tool.serializeForModel ? tool.serializeForModel(r) : String((r as any).result);
}

beforeEach(() => {
  vi.clearAllMocks();
  verdict.current = { kind: 'none' };
  checkContradiction.mockImplementation(async () => verdict.current);
});

describe('memory write with a contradiction check', () => {
  it('writes as before when nothing is configured to check with', async () => {
    // No `config` means no check at all — a deliberate degradation, and what
    // keeps every existing caller unaffected.
    expect(await write(createMemoryTool(new MemoryStore()))).toBe('Memory "k" saved.');
    expect(checkContradiction).not.toHaveBeenCalled();
  });

  it('still writes when the check finds a contradiction', async () => {
    // The load-bearing property. `tools/memory.ts` argues against a refusing
    // memory tool; this check must not become one by the back door.
    verdict.current = { kind: 'supersede', key: 'old', reason: 'It says the opposite.' };
    const store = new MemoryStore();
    const spy = vi.spyOn(store, 'supersede').mockReturnValue({} as never);
    const out = await write(createMemoryTool(store, undefined, { config }));
    expect(out).toContain('Memory "k" saved.');
    expect(out).toContain('Retired "old"');
    expect(spy).toHaveBeenCalledWith('old', 'k');
  });

  it('reports what happened, not what was decided', async () => {
    verdict.current = { kind: 'supersede', key: 'old', reason: 'r' };
    const store = new MemoryStore();
    vi.spyOn(store, 'supersede').mockImplementation(() => {
      throw new Error('gone');
    });
    const out = await write(createMemoryTool(store, undefined, { config }));
    expect(out).toContain('Memory "k" saved.');
    expect(out).toContain('Both are kept');
  });

  it('keeps both when there is nobody to ask', async () => {
    // `headlessToolOptions` omits `askUser`, so cron and applet dispatch land
    // here — and keeping both is the right answer, not a degraded one.
    verdict.current = { kind: 'ask', key: 'old', reason: 'They disagree.' };
    const out = await write(createMemoryTool(new MemoryStore(), undefined, { config }));
    expect(out).toContain('Memory "k" saved.');
    expect(out).toContain('Both are kept');
  });

  it('asks when there is someone to ask, and acts on the answer', async () => {
    verdict.current = { kind: 'ask', key: 'old', reason: 'They disagree.' };
    const store = new MemoryStore();
    const spy = vi.spyOn(store, 'supersede').mockReturnValue({} as never);
    const askUser = vi.fn(async () => ({ answers: ['Replace "old" with this'] }));
    const out = await write(
      createMemoryTool(store, undefined, { config, askUser: askUser as never }),
    );
    expect(askUser).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('old', 'k');
    expect(out).toContain('as you chose');
  });

  it('retires the note just saved when the user discards it', async () => {
    // "Discard" cannot mean "do not write" — the note is on disk by then. It
    // retires, which one deleted front-matter line undoes.
    verdict.current = { kind: 'ask', key: 'old', reason: 'r' };
    const store = new MemoryStore();
    const spy = vi.spyOn(store, 'supersede').mockReturnValue({} as never);
    const askUser = vi.fn(async () => ({ answers: ['Discard what I just saved'] }));
    await write(createMemoryTool(store, undefined, { config, askUser: askUser as never }));
    expect(spy).toHaveBeenCalledWith('k', 'old');
  });

  it('treats a cancelled question as "keep both", not as a decision', async () => {
    verdict.current = { kind: 'ask', key: 'old', reason: 'r' };
    const store = new MemoryStore();
    const spy = vi.spyOn(store, 'supersede');
    const askUser = vi.fn(async () => ({ cancelled: true as const, answered: [] }));
    const out = await write(
      createMemoryTool(store, undefined, { config, askUser: askUser as never }),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain('Both notes are kept');
  });

  it('writes anyway when the check itself throws', async () => {
    checkContradiction.mockRejectedValueOnce(new Error('boom') as never);
    expect(await write(createMemoryTool(new MemoryStore(), undefined, { config }))).toBe(
      'Memory "k" saved.',
    );
  });
});

/**
 * The check honours the turn's abort signal.
 *
 * It makes an LLM call and can raise an `ask_user` overlay, so dropping the
 * signal left an Esc mid-write with the cheap-tier call still running and the
 * conflict menu still on screen. `execute`'s second parameter is where it lives
 * and it was simply not being destructured.
 */
describe('cancellation', () => {
  it('forwards the parent abort signal to the check', async () => {
    verdict.current = { kind: 'none' };
    const signal = new AbortController().signal;
    await write(createMemoryTool(new MemoryStore(), undefined, { config }), 'k', 'c', {
      abortSignal: signal,
    });
    expect(checkContradiction.mock.calls[0]?.[3]).toMatchObject({ abortSignal: signal });
  });

  it('omits it when the caller supplies none, rather than passing undefined through', async () => {
    verdict.current = { kind: 'none' };
    await write(createMemoryTool(new MemoryStore(), undefined, { config }));
    expect(checkContradiction.mock.calls[0]?.[3]).not.toHaveProperty('abortSignal');
  });
});
