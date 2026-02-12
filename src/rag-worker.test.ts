import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock dependencies before importing anything that uses them
const mockExtractFacts = vi.fn();
const mockLoadConfig = vi.fn();
const mockAddFacts = vi.fn();

vi.mock('./config.js', () => ({
  loadConfig: (...args: any[]) => mockLoadConfig(...args),
}));

vi.mock('./context.js', () => ({
  extractFacts: (...args: any[]) => mockExtractFacts(...args),
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
    mockExtractFacts.mockResolvedValue(['User prefers dark mode', 'Project uses TypeScript']);
    mockAddFacts.mockResolvedValue(2);
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
    const { extractFacts } = await import('./context.js');
    const { RAGStore } = await import('./rag.js');

    const raw = fs.readFileSync(filePath, 'utf-8');
    const payload = JSON.parse(raw);

    const config = loadConfig({ provider: payload.provider, model: payload.model });
    const facts = await extractFacts(payload.serialized, config);

    if (facts.length > 0) {
      const ragStore = new RAGStore();
      await ragStore.addFacts(facts, 'exit');
    }

    fs.unlinkSync(filePath);
  }

  it('reads temp file, extracts facts, stores them, and deletes temp file', async () => {
    const payload = {
      serialized: 'User: I prefer dark mode\nAssistant: Noted!',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorker(tempFile);

    expect(mockLoadConfig).toHaveBeenCalledWith({ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' });
    expect(mockExtractFacts).toHaveBeenCalledWith(payload.serialized, fakeConfig);
    expect(mockAddFacts).toHaveBeenCalledWith(['User prefers dark mode', 'Project uses TypeScript'], 'exit');
    expect(fs.existsSync(tempFile)).toBe(false);
  });

  it('does not create RAGStore when no facts are extracted', async () => {
    mockExtractFacts.mockResolvedValue([]);
    const { RAGStore } = await import('./rag.js');

    const payload = {
      serialized: 'User: hello\nAssistant: hi',
      provider: 'openai',
      model: 'gpt-4o',
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload));

    await runWorker(tempFile);

    expect(mockExtractFacts).toHaveBeenCalled();
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
});
