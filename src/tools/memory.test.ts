import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryTool, createScratchTool } from './memory.js';
import { MemoryKeyCollisionError, MemorySupersedeError } from '../memory.js';
import { MemoryStore } from '../memory.js';

vi.mock('node:fs', () => ({
  // `statSync` backs `MemoryStore`'s stat-validated read cache (#513): a
  // separate bernard process writing memory while this one is open must be
  // seen, so the cache is validated rather than write-invalidated.
  statSync: vi.fn(() => ({ mtimeMs: 1 })),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const fs = await import('node:fs');

/** Invokes the tool and returns the model-facing serialized value. */
async function runSerialized(
  tool: ReturnType<typeof createMemoryTool>,
  args: Parameters<typeof tool.execute>[0],
): Promise<unknown> {
  const envelope = await tool.execute(args, {});
  return tool.serializeForModel(envelope);
}

describe('createMemoryTool', () => {
  let store: MemoryStore;
  let memoryTool: ReturnType<typeof createMemoryTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default implementations
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    store = new MemoryStore();
    memoryTool = createMemoryTool(store);
  });

  it('list returns empty message when no memories', async () => {
    const result = await runSerialized(memoryTool, { action: 'list' });
    expect(result).toContain('No persistent memories');
  });

  it('list returns stored keys', async () => {
    store.writeMemory('prefs', 'dark mode');
    vi.mocked(fs.readdirSync).mockReturnValue(['prefs.md'] as any);
    // `readFileSync` has to answer too: `listMemory()` loads each entry to read
    // `supersededBy`, so a file that `readdir` reports and `read` cannot open is
    // correctly excluded as vanished. The suite's default mock throws ENOENT for
    // everything, which described a file that does not exist.
    vi.mocked(fs.readFileSync).mockReturnValue('dark mode' as any);
    const result = await runSerialized(memoryTool, { action: 'list' });
    expect(result).toContain('prefs');
  });

  it('read requires key', async () => {
    const result = await runSerialized(memoryTool, { action: 'read' });
    expect(result).toBe('Error: key is required for read action.');
  });

  it('read returns content when found', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('memory content');
    const result = await runSerialized(memoryTool, { action: 'read', key: 'prefs' });
    expect(result).toBe('memory content');
  });

  it('read returns not-found message when missing', async () => {
    const result = await runSerialized(memoryTool, { action: 'read', key: 'nope' });
    expect(result).toContain('No memory found');
  });

  it('write requires key', async () => {
    const result = await runSerialized(memoryTool, { action: 'write', content: 'data' });
    expect(result).toBe('Error: key is required for write action.');
  });

  it('write requires content', async () => {
    const result = await runSerialized(memoryTool, { action: 'write', key: 'k' });
    expect(result).toBe('Error: content is required for write action.');
  });

  it('write saves and confirms', async () => {
    const result = await runSerialized(memoryTool, {
      action: 'write',
      key: 'prefs',
      content: 'dark mode',
    });
    expect(result).toContain('saved');
  });

  it('delete requires key', async () => {
    const result = await runSerialized(memoryTool, { action: 'delete' });
    expect(result).toBe('Error: key is required for delete action.');
  });

  it('delete returns not-found when missing', async () => {
    const result = await runSerialized(memoryTool, { action: 'delete', key: 'nope' });
    expect(result).toContain('No memory found');
  });

  it('delete removes and confirms', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = await runSerialized(memoryTool, { action: 'delete', key: 'prefs' });
    expect(result).toContain('deleted');
  });

  it('returns error envelope on validation failure', async () => {
    const envelope = await memoryTool.execute({ action: 'read' }, {});
    expect(envelope.status).toBe('error');
    if (envelope.status === 'error') {
      expect(envelope.error.type).toBe('invalid_args');
      expect(envelope.error.message).toBe('key is required for read action.');
    }
  });
});

describe('createScratchTool', () => {
  let store: MemoryStore;
  let scratchTool: ReturnType<typeof createScratchTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new MemoryStore();
    scratchTool = createScratchTool(store);
  });

  it('list returns empty message when no notes', async () => {
    const result = await runSerialized(scratchTool, { action: 'list' });
    expect(result).toContain('No scratch notes');
  });

  it('list returns stored keys', async () => {
    store.writeScratch('todo', 'step 1');
    const result = await runSerialized(scratchTool, { action: 'list' });
    expect(result).toContain('todo');
  });

  it('read requires key', async () => {
    const result = await runSerialized(scratchTool, { action: 'read' });
    expect(result).toBe('Error: key is required for read action.');
  });

  it('read returns content when found', async () => {
    store.writeScratch('todo', 'step 1');
    const result = await runSerialized(scratchTool, { action: 'read', key: 'todo' });
    expect(result).toBe('step 1');
  });

  it('read returns not-found message when missing', async () => {
    const result = await runSerialized(scratchTool, { action: 'read', key: 'nope' });
    expect(result).toContain('No scratch note found');
  });

  it('write requires key', async () => {
    const result = await runSerialized(scratchTool, { action: 'write', content: 'data' });
    expect(result).toBe('Error: key is required for write action.');
  });

  it('write requires content', async () => {
    const result = await runSerialized(scratchTool, { action: 'write', key: 'k' });
    expect(result).toBe('Error: content is required for write action.');
  });

  it('write saves and confirms', async () => {
    const result = await runSerialized(scratchTool, {
      action: 'write',
      key: 'todo',
      content: 'step 1',
    });
    expect(result).toContain('saved');
  });

  it('delete requires key', async () => {
    const result = await runSerialized(scratchTool, { action: 'delete' });
    expect(result).toBe('Error: key is required for delete action.');
  });

  it('delete returns not-found when missing', async () => {
    const result = await runSerialized(scratchTool, { action: 'delete', key: 'nope' });
    expect(result).toContain('No scratch note found');
  });

  it('delete removes and confirms', async () => {
    store.writeScratch('todo', 'step 1');
    const result = await runSerialized(scratchTool, { action: 'delete', key: 'todo' });
    expect(result).toContain('deleted');
  });
});

describe('memory tool: the #513 additions', () => {
  let store: MemoryStore;
  let tool: ReturnType<typeof createMemoryTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1 } as any);
    store = new MemoryStore();
    tool = createMemoryTool(store);
  });

  it('returns the body to the model, never the front matter', async () => {
    // `read` hands its value to the model byte-for-byte AND uses it as the
    // provenance `contentPreview`, so a leaking fence would show up in the
    // transcript and in the Sources overlay. It reads through `readMemory`,
    // which returns the body; this pins that it stays that way.
    vi.mocked(fs.readFileSync).mockReturnValue(
      '---\nkey: note\nwrittenAt: 2026-09-07T12:00:00.000Z\n---\nthe body\n' as any,
    );
    const out = await runSerialized(tool, { action: 'read', key: 'note' });
    expect(out).toBe('the body\n');
    expect(out).not.toContain('writtenAt');
  });

  it('supersede retires a memory in favour of another', async () => {
    const spy = vi.spyOn(store, 'supersede').mockReturnValue(true);
    const out = await runSerialized(tool, {
      action: 'supersede',
      key: 'issue',
      replacement: 'issue-3538',
    });
    expect(spy).toHaveBeenCalledWith('issue', 'issue-3538');
    // The message says the file survives, because that is the whole difference
    // between this and `delete` and the reason a wrong call is cheap.
    expect(out).toContain('still on disk');
  });

  it('supersede requires a replacement', async () => {
    const out = await runSerialized(tool, { action: 'supersede', key: 'issue' });
    expect(out).toMatch(/^Error: /);
    expect(out).toContain('replacement is required');
  });

  it('supersede reports a store refusal as a tool error rather than throwing', async () => {
    // The store's own typed error, not a bare `Error`. That type is what lets
    // the tool map it in ONE guard: the catch-all this replaced also swallowed
    // `MemoryScopeError` and reported a fence refusal as a call-shape mistake.
    vi.spyOn(store, 'supersede').mockImplementation(() => {
      throw new MemorySupersedeError('no memory with that key exists');
    });
    const out = await runSerialized(tool, {
      action: 'supersede',
      key: 'issue',
      replacement: 'ghost',
    });
    expect(out).toMatch(/^Error: /);
    expect(out).toContain('no memory with that key');
  });

  it('a key collision comes back as a tool error naming the conflict', async () => {
    // Correctable by picking a different key, so it must reach the model as an
    // `invalid_args` result rather than as a throw out of `execute` — which
    // `error-taxonomy` would classify as a call-shape mistake it can fix.
    vi.spyOn(store, 'writeMemory').mockImplementation(() => {
      throw new MemoryKeyCollisionError('foo/bar', 'foo bar');
    });
    const out = await runSerialized(tool, { action: 'write', key: 'foo/bar', content: 'x' });
    expect(out).toMatch(/^Error: /);
    expect(out).toContain('foo bar');
  });

  it('classifies every mutating action as a write, for both permission gates', () => {
    // The fail-open #513 found in `readOnlyWrap`: a new mutating action that no
    // gate classifies is one an unattended dispatch may make with nobody to
    // ask. `retire` and a DECIDED `proposals` call both change state.
    const isWrite = tool.meta.isWriteAction!;
    expect(isWrite({ action: 'retire' } as never)).toBe(true);
    expect(isWrite({ action: 'proposals', decision: 'accepted' } as never)).toBe(true);
    expect(isWrite({ action: 'proposals', decision: 'declined' } as never)).toBe(true);
    // A bare listing is not.
    expect(isWrite({ action: 'proposals' } as never)).toBe(false);
  });

  it('retire reports the file surviving, which is the difference from delete', async () => {
    const spy = vi.spyOn(store, 'retire').mockReturnValue(true);
    const out = await runSerialized(tool, { action: 'retire', key: 'one-off' });
    expect(spy).toHaveBeenCalledWith('one-off');
    expect(out).toContain('still on disk');
  });

  it('retire requires a key', async () => {
    const out = await runSerialized(tool, { action: 'retire' });
    expect(out).toMatch(/^Error: /);
  });

  it('proposals requires a decision once an id is given', async () => {
    const out = await runSerialized(tool, { action: 'proposals', proposalId: 'x' });
    expect(out).toMatch(/^Error: /);
    expect(out).toContain('decision is required');
  });

  it('classifies supersede as a write for both permission gates', () => {
    // Without this the read-only block gate (#179) would let an unattended
    // dispatch retire a user's memories with nobody to ask.
    expect(tool.meta.isWriteAction?.({ action: 'supersede' } as never)).toBe(true);
    expect(tool.meta.isWriteAction?.({ action: 'read' } as never)).toBe(false);
  });
});
