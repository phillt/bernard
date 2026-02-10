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

describe('createMemoryTool', () => {
  let store: MemoryStore;
  let memoryTool: ReturnType<typeof createMemoryTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default implementations
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    store = new MemoryStore();
    memoryTool = createMemoryTool(store);
  });

  it('list returns empty message when no memories', async () => {
    const result = await memoryTool.execute({ action: 'list' }, {} as any);
    expect(result).toContain('No persistent memories');
  });

  it('list returns stored keys', async () => {
    store.writeMemory('prefs', 'dark mode');
    vi.mocked(fs.readdirSync).mockReturnValue(['prefs.md'] as any);
    const result = await memoryTool.execute({ action: 'list' }, {} as any);
    expect(result).toContain('prefs');
  });

  it('read requires key', async () => {
    const result = await memoryTool.execute({ action: 'read' }, {} as any);
    expect(result).toContain('key is required');
  });

  it('read returns content when found', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('memory content');
    const result = await memoryTool.execute({ action: 'read', key: 'prefs' }, {} as any);
    expect(result).toBe('memory content');
  });

  it('read returns not-found message when missing', async () => {
    const result = await memoryTool.execute({ action: 'read', key: 'nope' }, {} as any);
    expect(result).toContain('No memory found');
  });

  it('write requires key', async () => {
    const result = await memoryTool.execute({ action: 'write', content: 'data' }, {} as any);
    expect(result).toContain('key is required');
  });

  it('write requires content', async () => {
    const result = await memoryTool.execute({ action: 'write', key: 'k' }, {} as any);
    expect(result).toContain('content is required');
  });

  it('write saves and confirms', async () => {
    const result = await memoryTool.execute(
      { action: 'write', key: 'prefs', content: 'dark mode' },
      {} as any,
    );
    expect(result).toContain('saved');
  });

  it('delete requires key', async () => {
    const result = await memoryTool.execute({ action: 'delete' }, {} as any);
    expect(result).toContain('key is required');
  });

  it('delete returns not-found when missing', async () => {
    const result = await memoryTool.execute({ action: 'delete', key: 'nope' }, {} as any);
    expect(result).toContain('No memory found');
  });

  it('delete removes and confirms', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = await memoryTool.execute({ action: 'delete', key: 'prefs' }, {} as any);
    expect(result).toContain('deleted');
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
    const result = await scratchTool.execute({ action: 'list' }, {} as any);
    expect(result).toContain('No scratch notes');
  });

  it('list returns stored keys', async () => {
    store.writeScratch('todo', 'step 1');
    const result = await scratchTool.execute({ action: 'list' }, {} as any);
    expect(result).toContain('todo');
  });

  it('read requires key', async () => {
    const result = await scratchTool.execute({ action: 'read' }, {} as any);
    expect(result).toContain('key is required');
  });

  it('read returns content when found', async () => {
    store.writeScratch('todo', 'step 1');
    const result = await scratchTool.execute({ action: 'read', key: 'todo' }, {} as any);
    expect(result).toBe('step 1');
  });

  it('read returns not-found message when missing', async () => {
    const result = await scratchTool.execute({ action: 'read', key: 'nope' }, {} as any);
    expect(result).toContain('No scratch note found');
  });

  it('write requires key', async () => {
    const result = await scratchTool.execute({ action: 'write', content: 'data' }, {} as any);
    expect(result).toContain('key is required');
  });

  it('write requires content', async () => {
    const result = await scratchTool.execute({ action: 'write', key: 'k' }, {} as any);
    expect(result).toContain('content is required');
  });

  it('write saves and confirms', async () => {
    const result = await scratchTool.execute(
      { action: 'write', key: 'todo', content: 'step 1' },
      {} as any,
    );
    expect(result).toContain('saved');
  });

  it('delete requires key', async () => {
    const result = await scratchTool.execute({ action: 'delete' }, {} as any);
    expect(result).toContain('key is required');
  });

  it('delete returns not-found when missing', async () => {
    const result = await scratchTool.execute({ action: 'delete', key: 'nope' }, {} as any);
    expect(result).toContain('No scratch note found');
  });

  it('delete removes and confirms', async () => {
    store.writeScratch('todo', 'step 1');
    const result = await scratchTool.execute({ action: 'delete', key: 'todo' }, {} as any);
    expect(result).toContain('deleted');
  });
});
