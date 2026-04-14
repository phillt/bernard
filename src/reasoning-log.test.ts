import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReasoningLogEntry } from './reasoning-log.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

const fs = await import('node:fs');

// Re-import the module after mocks are in place so logsDirReady is reset each suite.
// We use vi.resetModules() in beforeEach and dynamic imports inside each test group.

function makeEntry(overrides: Partial<ReasoningLogEntry> = {}): ReasoningLogEntry {
  return {
    ts: '2024-01-15T00:00:00.000Z',
    specialistId: 'shell-wrapper',
    input: 'run ls',
    toolCalls: [{ tool: 'shell', args: { command: 'ls' }, resultPreview: 'file.txt' }],
    finalOutput: 'file.txt',
    status: 'ok',
    ...overrides,
  };
}

describe('appendReasoningLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.resetModules();
  });

  it('creates LOGS_DIR on first call', async () => {
    const { appendReasoningLog } = await import('./reasoning-log.js');
    appendReasoningLog(makeEntry());
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('logs'), { recursive: true });
  });

  it('does not create LOGS_DIR on subsequent calls within the same module instance', async () => {
    const { appendReasoningLog } = await import('./reasoning-log.js');
    appendReasoningLog(makeEntry());
    appendReasoningLog(makeEntry());
    // mkdirSync should be called exactly once (guarded by logsDirReady flag)
    expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
  });

  it('appends a JSONL line to TOOL_WRAPPER_LOG', async () => {
    const { appendReasoningLog } = await import('./reasoning-log.js');
    const entry = makeEntry({ specialistId: 'web-wrapper' });
    appendReasoningLog(entry);
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('tool-wrappers.jsonl'),
      expect.stringContaining('"specialistId":"web-wrapper"'),
      'utf-8',
    );
  });

  it('appended line ends with newline', async () => {
    const { appendReasoningLog } = await import('./reasoning-log.js');
    appendReasoningLog(makeEntry());
    const [, data] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string, string];
    expect(data.endsWith('\n')).toBe(true);
  });

  it('never throws on appendFileSync error', async () => {
    vi.mocked(fs.appendFileSync).mockImplementation(() => {
      throw new Error('disk full');
    });
    const { appendReasoningLog } = await import('./reasoning-log.js');
    expect(() => appendReasoningLog(makeEntry())).not.toThrow();
  });

  it('never throws on mkdirSync error', async () => {
    vi.mocked(fs.mkdirSync).mockImplementation(() => {
      throw new Error('permission denied');
    });
    const { appendReasoningLog } = await import('./reasoning-log.js');
    expect(() => appendReasoningLog(makeEntry())).not.toThrow();
  });
});

describe('readReasoningLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns empty array when log file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { readReasoningLog } = await import('./reasoning-log.js');
    expect(readReasoningLog()).toEqual([]);
  });

  it('parses JSONL lines and returns entries', async () => {
    const e1 = makeEntry({ specialistId: 'shell-wrapper' });
    const e2 = makeEntry({ specialistId: 'web-wrapper' });
    const content = JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(content);
    const { readReasoningLog } = await import('./reasoning-log.js');
    const result = readReasoningLog();
    expect(result).toHaveLength(2);
    expect(result[0].specialistId).toBe('shell-wrapper');
    expect(result[1].specialistId).toBe('web-wrapper');
  });

  it('respects the limit parameter and returns the tail', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        specialistId: `sp-${i}`,
        ts: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(content);
    const { readReasoningLog } = await import('./reasoning-log.js');
    const result = readReasoningLog(3);
    expect(result).toHaveLength(3);
    // Should be the last 3 entries
    expect(result[0].specialistId).toBe('sp-7');
    expect(result[2].specialistId).toBe('sp-9');
  });

  it('skips malformed lines', async () => {
    const good = makeEntry();
    const content = JSON.stringify(good) + '\n' + 'not{json{{\n' + JSON.stringify(good) + '\n';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(content);
    const { readReasoningLog } = await import('./reasoning-log.js');
    const result = readReasoningLog();
    expect(result).toHaveLength(2);
  });

  it('ignores blank lines', async () => {
    const good = makeEntry();
    const content = '\n' + JSON.stringify(good) + '\n\n';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(content);
    const { readReasoningLog } = await import('./reasoning-log.js');
    const result = readReasoningLog();
    expect(result).toHaveLength(1);
  });

  it('returns empty array when readFileSync throws', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('IO error');
    });
    const { readReasoningLog } = await import('./reasoning-log.js');
    expect(readReasoningLog()).toEqual([]);
  });
});

describe('rotateReasoningLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('no-ops when log file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { rotateReasoningLog } = await import('./reasoning-log.js');
    rotateReasoningLog();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('no-ops when entry count is at or below keep', async () => {
    const entries = Array.from({ length: 5 }, () => makeEntry());
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(content);
    const { rotateReasoningLog } = await import('./reasoning-log.js');
    rotateReasoningLog(5);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    rotateReasoningLog(10);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('keeps only the last N entries', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry({ specialistId: `sp-${i}` }));
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(content);
    const { rotateReasoningLog } = await import('./reasoning-log.js');
    rotateReasoningLog(3);
    // Should write to a .tmp file
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.stringContaining('sp-7'),
      'utf-8',
    );
    // The retained content should contain the last 3 entries
    const [, writtenContent] = vi.mocked(fs.writeFileSync).mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(writtenContent).toContain('sp-9');
    expect(writtenContent).not.toContain('sp-6');
  });

  it('renames tmp file into place after writing', async () => {
    const entries = Array.from({ length: 5 }, () => makeEntry());
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(content);
    const { rotateReasoningLog } = await import('./reasoning-log.js');
    rotateReasoningLog(2);
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.stringContaining('tool-wrappers.jsonl'),
    );
  });

  it('never throws on error', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('IO error');
    });
    const { rotateReasoningLog } = await import('./reasoning-log.js');
    expect(() => rotateReasoningLog()).not.toThrow();
  });
});
