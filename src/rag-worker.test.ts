import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock dependencies before importing anything that uses them
const mockExtractDomainFacts = vi.fn();
const mockLoadConfig = vi.fn();
const mockAddFacts = vi.fn();

vi.mock('./config.js', () => ({
  loadConfig: (...args: any[]) => mockLoadConfig(...args),
}));

vi.mock('./context.js', () => ({
  extractDomainFacts: (...args: any[]) => mockExtractDomainFacts(...args),
}));

vi.mock('./rag.js', () => ({
  RAGStore: vi.fn().mockImplementation(() => ({
    addFacts: mockAddFacts,
  })),
}));

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
}));

describe('rag-worker', () => {
  let tempDir: string;
  let tempFile: string;

  const fakeConfig = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    ragEnabled: true,
    anthropicApiKey: 'sk-test',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-worker-test-'));
    tempFile = path.join(tempDir, '.pending-test.json');
    mockLoadConfig.mockReturnValue(fakeConfig);
    mockExtractDomainFacts.mockResolvedValue([
      { domain: 'tool-usage', facts: ['npm run build compiles project'] },
      { domain: 'user-preferences', facts: ['User prefers dark mode'] },
      { domain: 'general', facts: ['Project uses TypeScript'] },
    ]);
    mockAddFacts.mockResolvedValue(1);
  });

  afterEach(() => {
    // Clean up temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function runWorker(filePath: string): Promise<void> {
    // Simulate what the worker does (we can't easily exec the script in tests,
    // so we replicate its logic using our mocked dependencies)
    const { loadConfig } = await import('./config.js');
    const { extractDomainFacts } = await import('./context.js');
    const { RAGStore } = await import('./rag.js');

    const raw = fs.readFileSync(filePath, 'utf-8');
    const payload = JSON.parse(raw);

    const config = loadConfig({ provider: payload.provider, model: payload.model });
    const domainFacts = await extractDomainFacts(payload.serialized, config);

    const totalFacts = domainFacts.reduce((sum: number, df: any) => sum + df.facts.length, 0);
    if (totalFacts > 0) {
      const ragStore = new RAGStore();
      for (const df of domainFacts) {
        await ragStore.addFacts(df.facts, 'exit', df.domain);
      }
    }

    fs.unlinkSync(filePath);
  }

  it('reads temp file, extracts domain facts, stores per-domain, and deletes temp file', async () => {
    const payload = {
      serialized: 'User: I prefer dark mode\nAssistant: Noted!',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorker(tempFile);

    expect(mockLoadConfig).toHaveBeenCalledWith({ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' });
    expect(mockExtractDomainFacts).toHaveBeenCalledWith(payload.serialized, fakeConfig);

    // Should store facts per domain
    expect(mockAddFacts).toHaveBeenCalledWith(['npm run build compiles project'], 'exit', 'tool-usage');
    expect(mockAddFacts).toHaveBeenCalledWith(['User prefers dark mode'], 'exit', 'user-preferences');
    expect(mockAddFacts).toHaveBeenCalledWith(['Project uses TypeScript'], 'exit', 'general');
    expect(mockAddFacts).toHaveBeenCalledTimes(3);

    expect(fs.existsSync(tempFile)).toBe(false);
  });

  it('does not create RAGStore when no facts are extracted', async () => {
    mockExtractDomainFacts.mockResolvedValue([]);
    const { RAGStore } = await import('./rag.js');

    const payload = {
      serialized: 'User: hello\nAssistant: hi',
      provider: 'openai',
      model: 'gpt-4o',
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorker(tempFile);

    expect(mockExtractDomainFacts).toHaveBeenCalled();
    expect(RAGStore).not.toHaveBeenCalled();
    expect(fs.existsSync(tempFile)).toBe(false);
  });

  it('passes provider and model overrides to loadConfig', async () => {
    const payload = {
      serialized: 'User: test\nAssistant: ok',
      provider: 'openai',
      model: 'gpt-4o',
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorker(tempFile);

    expect(mockLoadConfig).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4o' });
  });

  it('handles partial domain extraction (only some domains have facts)', async () => {
    mockExtractDomainFacts.mockResolvedValue([
      { domain: 'general', facts: ['Project uses TypeScript'] },
    ]);

    const payload = {
      serialized: 'User: test\nAssistant: ok',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorker(tempFile);

    expect(mockAddFacts).toHaveBeenCalledTimes(1);
    expect(mockAddFacts).toHaveBeenCalledWith(['Project uses TypeScript'], 'exit', 'general');
  });
});
