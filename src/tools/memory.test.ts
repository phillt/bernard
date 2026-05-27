import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryTool, createScratchTool } from './memory.js';
import { MemoryStore } from '../memory.js';

vi.mock('node:fs', () => ({
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
