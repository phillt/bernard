import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

const fs = await import('node:fs');

import { buildMemoryContext } from './memory-context.js';
import { MemoryStore } from './memory.js';
import type { RAGSearchResult } from './rag.js';

describe('buildMemoryContext', () => {
  let store: MemoryStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    store = new MemoryStore();
  });

  it('returns empty string when store is empty and no RAG results', () => {
    const result = buildMemoryContext({ memoryStore: store });
    expect(result).toBe('');
  });

  it('renders RAG results grouped by domain under Recalled Context', () => {
    const ragResults: RAGSearchResult[] = [
      { fact: 'User prefers dark mode', similarity: 0.85, domain: 'user-preferences' },
      { fact: 'npm run build compiles project', similarity: 0.9, domain: 'tool-usage' },
      { fact: 'Project uses TypeScript', similarity: 0.72, domain: 'general' },
    ];
    const result = buildMemoryContext({ memoryStore: store, ragResults });
    expect(result).toContain('## Recalled Context');
    expect(result).toContain('hints');
    expect(result).toContain('### User Preferences');
    expect(result).toContain('- User prefers dark mode');
    expect(result).toContain('### Tool Usage Patterns');
    expect(result).toContain('- npm run build compiles project');
    expect(result).toContain('### General Knowledge');
    expect(result).toContain('- Project uses TypeScript');
  });

  it('omits Recalled Context when ragResults is empty', () => {
    const result = buildMemoryContext({ memoryStore: store, ragResults: [] });
    expect(result).not.toContain('## Recalled Context');
  });

  it('omits Recalled Context when ragResults is undefined', () => {
    const result = buildMemoryContext({ memoryStore: store });
    expect(result).not.toContain('## Recalled Context');
  });

  it('renders persistent memory under Persistent Memory heading', () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['prefs.md'] as any);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('dark mode enabled');
    store = new MemoryStore();
    const result = buildMemoryContext({ memoryStore: store });
    expect(result).toContain('## Persistent Memory');
    expect(result).toContain('### prefs');
    expect(result).toContain('dark mode enabled');
  });

  it('includes scratch notes by default', () => {
    store.writeScratch('todo', 'step 1 done');
    const result = buildMemoryContext({ memoryStore: store });
    expect(result).toContain('## Scratch Notes (session only)');
    expect(result).toContain('### todo');
    expect(result).toContain('step 1 done');
  });

  it('excludes scratch notes when includeScratch is false', () => {
    store.writeScratch('todo', 'step 1 done');
    const result = buildMemoryContext({ memoryStore: store, includeScratch: false });
    expect(result).not.toContain('## Scratch Notes');
    expect(result).not.toContain('todo');
  });

  it('combines all sections when everything is populated', () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['project.md'] as any);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('uses vitest');
    store = new MemoryStore();
    store.writeScratch('plan', 'step 2');

    const ragResults: RAGSearchResult[] = [
      { fact: 'user likes tabs', similarity: 0.8, domain: 'user-preferences' },
    ];

    const result = buildMemoryContext({ memoryStore: store, ragResults });
    expect(result).toContain('## Recalled Context');
    expect(result).toContain('## Persistent Memory');
    expect(result).toContain('## Scratch Notes (session only)');
  });
});
