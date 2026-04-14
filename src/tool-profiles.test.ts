import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyShellCommand,
  detectToolError,
  ToolProfileStore,
  buildToolProfilesPrompt,
  MAX_PROFILE_EXAMPLES,
  type ToolProfile,
} from './tool-profiles.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
}));

vi.mock('./fs-utils.js', () => ({
  atomicWriteFileSync: vi.fn(),
}));

vi.mock('./paths.js', () => ({
  TOOL_PROFILES_DIR: '/mock/tool-profiles',
}));

const fs = await import('node:fs');
const fsUtils = await import('./fs-utils.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<ToolProfile> = {}): ToolProfile {
  return {
    toolName: 'shell.git',
    guidelines: [],
    goodExamples: [],
    badExamples: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    errorCount: 0,
    successCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyShellCommand
// ---------------------------------------------------------------------------

describe('classifyShellCommand', () => {
  it('classifies git commands', () => {
    expect(classifyShellCommand('git status')).toBe('git');
    expect(classifyShellCommand('git log --oneline')).toBe('git');
    expect(classifyShellCommand('git commit -m "msg"')).toBe('git');
  });

  it('classifies gh commands', () => {
    expect(classifyShellCommand('gh pr list')).toBe('gh');
    expect(classifyShellCommand('gh issue create')).toBe('gh');
  });

  it('classifies docker commands', () => {
    expect(classifyShellCommand('docker ps')).toBe('docker');
    expect(classifyShellCommand('docker-compose up -d')).toBe('docker');
    expect(classifyShellCommand('docker build .')).toBe('docker');
  });

  it('classifies npm/yarn/pnpm/bun commands', () => {
    expect(classifyShellCommand('npm install')).toBe('npm');
    expect(classifyShellCommand('yarn add lodash')).toBe('npm');
    expect(classifyShellCommand('pnpm run build')).toBe('npm');
    expect(classifyShellCommand('bun install')).toBe('npm');
  });

  it('classifies filesystem commands', () => {
    expect(classifyShellCommand('ls -la')).toBe('fs');
    expect(classifyShellCommand('find . -name "*.ts"')).toBe('fs');
    expect(classifyShellCommand('cp src dest')).toBe('fs');
    expect(classifyShellCommand('mv old new')).toBe('fs');
    expect(classifyShellCommand('mkdir -p dir')).toBe('fs');
    expect(classifyShellCommand('rm -rf dist')).toBe('fs');
    expect(classifyShellCommand('cat file.txt')).toBe('fs');
    expect(classifyShellCommand('head -n 10 file.txt')).toBe('fs');
    expect(classifyShellCommand('tail -f log')).toBe('fs');
    expect(classifyShellCommand('stat file')).toBe('fs');
  });

  it('classifies http commands', () => {
    expect(classifyShellCommand('curl https://example.com')).toBe('http');
    expect(classifyShellCommand('wget https://example.com/file.tar.gz')).toBe('http');
  });

  it('classifies systemd commands', () => {
    expect(classifyShellCommand('systemctl status nginx')).toBe('systemd');
    expect(classifyShellCommand('service apache2 restart')).toBe('systemd');
    expect(classifyShellCommand('journalctl -u nginx -n 50')).toBe('systemd');
  });

  it('classifies runtime commands', () => {
    expect(classifyShellCommand('python3 script.py')).toBe('runtime');
    expect(classifyShellCommand('python main.py')).toBe('runtime');
    expect(classifyShellCommand('node index.js')).toBe('runtime');
    expect(classifyShellCommand('ruby app.rb')).toBe('runtime');
    expect(classifyShellCommand('tsx src/index.ts')).toBe('runtime');
    expect(classifyShellCommand('ts-node src/index.ts')).toBe('runtime');
  });

  it('returns general for unknown commands', () => {
    expect(classifyShellCommand('echo hello')).toBe('general');
    expect(classifyShellCommand('grep -r foo .')).toBe('general');
    expect(classifyShellCommand('jq . data.json')).toBe('general');
    expect(classifyShellCommand('unknown-tool --flag')).toBe('general');
  });

  it('handles commands with leading whitespace', () => {
    expect(classifyShellCommand('  git status')).toBe('git');
    expect(classifyShellCommand('\tnpm install')).toBe('npm');
    expect(classifyShellCommand('  curl https://example.com')).toBe('http');
  });

  it('does not match partial words (word boundary)', () => {
    // "gitignore" or "ghetto" should not match git/gh
    expect(classifyShellCommand('gitignore')).toBe('general');
    expect(classifyShellCommand('ghetto-app start')).toBe('general');
    expect(classifyShellCommand('nodemon server.js')).toBe('general');
  });
});

// ---------------------------------------------------------------------------
// detectToolError
// ---------------------------------------------------------------------------

describe('detectToolError', () => {
  it('returns isError: false for null result', () => {
    expect(detectToolError('shell', null)).toEqual({ isError: false });
  });

  it('returns isError: false for undefined result', () => {
    expect(detectToolError('shell', undefined)).toEqual({ isError: false });
  });

  describe('shell tool', () => {
    it('returns error when is_error is true', () => {
      const result = detectToolError('shell', { is_error: true, output: 'command not found' });
      expect(result).toEqual({ isError: true, snippet: 'command not found' });
    });

    it('returns isError: false when is_error is false', () => {
      const result = detectToolError('shell', { is_error: false, output: 'success' });
      expect(result).toEqual({ isError: false });
    });

    it('returns isError: false when is_error is absent', () => {
      const result = detectToolError('shell', { output: 'success' });
      expect(result).toEqual({ isError: false });
    });

    it('uses empty string when output is missing', () => {
      const result = detectToolError('shell', { is_error: true });
      expect(result).toEqual({ isError: true, snippet: '' });
    });

    it('truncates output snippet to 200 chars', () => {
      const longOutput = 'e'.repeat(300);
      const result = detectToolError('shell', { is_error: true, output: longOutput });
      expect(result.isError).toBe(true);
      if (result.isError) {
        expect(result.snippet).toHaveLength(200);
      }
    });
  });

  describe('web_read tool', () => {
    it('returns error when result starts with "Error:"', () => {
      const result = detectToolError('web_read', 'Error: network timeout');
      expect(result).toEqual({ isError: true, snippet: 'Error: network timeout' });
    });

    it('returns isError: false for successful string result', () => {
      const result = detectToolError('web_read', '<html>content</html>');
      expect(result).toEqual({ isError: false });
    });

    it('returns isError: false for non-error string not starting with "Error:"', () => {
      const result = detectToolError('web_read', 'Some other content');
      expect(result).toEqual({ isError: false });
    });

    it('truncates snippet to 200 chars', () => {
      const longError = 'Error: ' + 'x'.repeat(300);
      const result = detectToolError('web_read', longError);
      expect(result.isError).toBe(true);
      if (result.isError) {
        expect(result.snippet).toHaveLength(200);
      }
    });
  });

  describe('web_search tool', () => {
    it('returns error when result starts with "Error:"', () => {
      const result = detectToolError('web_search', 'Error: API key invalid');
      expect(result).toEqual({ isError: true, snippet: 'Error: API key invalid' });
    });

    it('returns isError: false for successful results', () => {
      const result = detectToolError('web_search', '[{"title":"Result","url":"https://example.com"}]');
      expect(result).toEqual({ isError: false });
    });
  });

  describe('file_read_lines tool', () => {
    it('returns error when result has error string property', () => {
      const result = detectToolError('file_read_lines', { error: 'File not found' });
      expect(result).toEqual({ isError: true, snippet: 'File not found' });
    });

    it('returns isError: false when no error property', () => {
      const result = detectToolError('file_read_lines', { lines: ['line1', 'line2'] });
      expect(result).toEqual({ isError: false });
    });

    it('returns isError: false when error is not a string', () => {
      const result = detectToolError('file_read_lines', { error: 42 });
      expect(result).toEqual({ isError: false });
    });

    it('truncates error snippet to 200 chars', () => {
      const longError = 'x'.repeat(300);
      const result = detectToolError('file_read_lines', { error: longError });
      expect(result.isError).toBe(true);
      if (result.isError) {
        expect(result.snippet).toHaveLength(200);
      }
    });
  });

  describe('file_edit_lines tool', () => {
    it('returns error when result has error string property', () => {
      const result = detectToolError('file_edit_lines', { error: 'Permission denied' });
      expect(result).toEqual({ isError: true, snippet: 'Permission denied' });
    });

    it('returns isError: false when no error property', () => {
      const result = detectToolError('file_edit_lines', { success: true });
      expect(result).toEqual({ isError: false });
    });
  });

  describe('generic/MCP fallback', () => {
    it('returns error for unknown tool with string starting with "Error"', () => {
      const result = detectToolError('some__mcp__tool', 'Error: something went wrong');
      expect(result).toEqual({ isError: true, snippet: 'Error: something went wrong' });
    });

    it('returns isError: false for unknown tool with non-error string', () => {
      const result = detectToolError('some__mcp__tool', 'Success: operation completed');
      expect(result).toEqual({ isError: false });
    });

    it('returns isError: false for unknown tool with non-string result', () => {
      const result = detectToolError('some__mcp__tool', { data: 'value' });
      expect(result).toEqual({ isError: false });
    });

    it('truncates snippet to 200 chars for generic error', () => {
      const longError = 'Error' + 'x'.repeat(300);
      const result = detectToolError('unknown-tool', longError);
      expect(result.isError).toBe(true);
      if (result.isError) {
        expect(result.snippet).toHaveLength(200);
      }
    });

    it('does not treat "Error" prefix as error for shell tool (uses is_error field instead)', () => {
      // shell tool uses is_error, not string prefix check
      const result = detectToolError('shell', 'Error: something');
      // shell tool checks for object shape; a plain string is an object? No, typeof 'string' !== 'object'
      // so it won't enter the shell branch (which requires typeof result === 'object')
      // It should fall through to the generic branch
      expect(result).toEqual({ isError: true, snippet: 'Error: something' });
    });
  });
});

// ---------------------------------------------------------------------------
// ToolProfileStore
// ---------------------------------------------------------------------------

describe('ToolProfileStore', () => {
  let store: ToolProfileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    store = new ToolProfileStore();
  });

  describe('constructor', () => {
    it('creates the tool-profiles directory', () => {
      expect(fs.mkdirSync).toHaveBeenCalledWith('/mock/tool-profiles', { recursive: true });
    });

    it('seeds defaults when marker is absent', () => {
      // existsSync returns false (marker absent), so writeFileSync is called for marker
      expect(fs.existsSync).toHaveBeenCalledWith('/mock/tool-profiles/.seeded-v1');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/mock/tool-profiles/.seeded-v1',
        expect.any(String),
        'utf-8',
      );
    });

    it('skips seeding when marker already exists', () => {
      vi.clearAllMocks();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');
      new ToolProfileStore();
      // writeFileSync should NOT be called for the seed marker
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('seeds profiles for all built-in tools', () => {
      // atomicWriteFileSync is called for each seeded profile
      const calls = vi.mocked(fsUtils.atomicWriteFileSync).mock.calls;
      const calledPaths = calls.map((c) => c[0]);
      expect(calledPaths).toContain('/mock/tool-profiles/shell.git.json');
      expect(calledPaths).toContain('/mock/tool-profiles/shell.gh.json');
      expect(calledPaths).toContain('/mock/tool-profiles/shell.docker.json');
      expect(calledPaths).toContain('/mock/tool-profiles/shell.npm.json');
      expect(calledPaths).toContain('/mock/tool-profiles/shell.fs.json');
      expect(calledPaths).toContain('/mock/tool-profiles/shell.http.json');
      expect(calledPaths).toContain('/mock/tool-profiles/web_read.json');
      expect(calledPaths).toContain('/mock/tool-profiles/file_read_lines.json');
      expect(calledPaths).toContain('/mock/tool-profiles/file_edit_lines.json');
    });
  });

  describe('get', () => {
    it('returns undefined for missing profiles', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(store.get('shell.git')).toBeUndefined();
    });

    it('returns parsed profile for existing files', () => {
      const profile = makeProfile({ toolName: 'shell.git' });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));
      const result = store.get('shell.git');
      expect(result).toEqual(profile);
    });

    it('returns undefined for corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not-valid-json{{{');
      expect(store.get('shell.git')).toBeUndefined();
    });
  });

  describe('getOrCreate', () => {
    it('returns existing profile when found', () => {
      const profile = makeProfile({ toolName: 'shell.git', errorCount: 5 });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));
      const result = store.getOrCreate('shell.git');
      expect(result.errorCount).toBe(5);
    });

    it('creates new empty profile when not found', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const result = store.getOrCreate('my-new-tool');
      expect(result.toolName).toBe('my-new-tool');
      expect(result.guidelines).toEqual([]);
      expect(result.goodExamples).toEqual([]);
      expect(result.badExamples).toEqual([]);
      expect(result.errorCount).toBe(0);
      expect(result.successCount).toBe(0);
      expect(result.createdAt).toBeTruthy();
      expect(result.updatedAt).toBe(result.createdAt);
    });
  });

  describe('save', () => {
    it('calls atomicWriteFileSync with the correct path', () => {
      const profile = makeProfile({ toolName: 'shell.git' });
      store.save(profile);
      expect(fsUtils.atomicWriteFileSync).toHaveBeenCalledWith(
        '/mock/tool-profiles/shell.git.json',
        expect.any(String),
      );
    });

    it('updates the updatedAt field on save', () => {
      const profile = makeProfile({ toolName: 'shell.git', updatedAt: '2020-01-01T00:00:00.000Z' });
      store.save(profile);
      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('sanitizes special characters in tool key when building filename', () => {
      const profile = makeProfile({ toolName: 'mcp/server:tool@v1' });
      store.save(profile);
      expect(fsUtils.atomicWriteFileSync).toHaveBeenCalledWith(
        '/mock/tool-profiles/mcp-server-tool-v1.json',
        expect.any(String),
      );
    });

    it('preserves dots and hyphens in tool key filename', () => {
      const profile = makeProfile({ toolName: 'shell.git' });
      store.save(profile);
      expect(fsUtils.atomicWriteFileSync).toHaveBeenCalledWith(
        '/mock/tool-profiles/shell.git.json',
        expect.any(String),
      );
    });
  });

  describe('recordBadExample', () => {
    it('creates profile and saves a bad example', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      store.recordBadExample('shell.git', '{"command":"git push --force"}', 'rejected');

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.badExamples).toHaveLength(1);
      expect(saved.badExamples[0].args).toContain('git push --force');
      expect(saved.badExamples[0].errorSnippet).toBe('rejected');
      expect(saved.badExamples[0].fix).toBe('(awaiting successful retry)');
    });

    it('increments errorCount', () => {
      const profile = makeProfile({ toolName: 'shell.git', errorCount: 2 });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));
      store.recordBadExample('shell.git', '{"command":"git push"}', 'error');

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.errorCount).toBe(3);
    });

    it('caps bad examples at MAX_PROFILE_EXAMPLES (ring buffer)', () => {
      const existingBads = Array.from({ length: MAX_PROFILE_EXAMPLES }, (_, i) => ({
        summary: `Failed: example ${i}`,
        args: `args${i}`,
        errorSnippet: `error${i}`,
        fix: '(awaiting successful retry)',
      }));
      const profile = makeProfile({ toolName: 'shell.git', badExamples: existingBads });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

      store.recordBadExample('shell.git', 'new-args', 'new-error');

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.badExamples).toHaveLength(MAX_PROFILE_EXAMPLES);
      // The newest example should be last
      expect(saved.badExamples[MAX_PROFILE_EXAMPLES - 1].errorSnippet).toBe('new-error');
      // The oldest should have been evicted
      expect(saved.badExamples[0].errorSnippet).toBe('error1');
    });

    it('truncates args to 200 chars', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const longArgs = 'a'.repeat(300);
      store.recordBadExample('shell.git', longArgs, 'error');

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.badExamples[0].args).toHaveLength(200);
    });

    it('truncates summary args preview to 80 chars', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const longArgs = 'a'.repeat(120);
      store.recordBadExample('shell.git', longArgs, 'error');

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      // summary is "Failed: " + args.slice(0, 80)
      expect(saved.badExamples[0].summary).toBe(`Failed: ${'a'.repeat(80)}`);
    });
  });

  describe('recordGoodExample', () => {
    it('creates profile and saves a good example', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      store.recordGoodExample('shell.git', '{"command":"git log --oneline"}');

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.goodExamples).toHaveLength(1);
      expect(saved.goodExamples[0].args).toContain('git log --oneline');
      expect(saved.goodExamples[0].summary).toBe('Successful call');
    });

    it('increments successCount', () => {
      const profile = makeProfile({ toolName: 'shell.git', successCount: 7 });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));
      store.recordGoodExample('shell.git', '{"command":"git status"}');

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.successCount).toBe(8);
    });

    it('caps good examples at MAX_PROFILE_EXAMPLES (ring buffer)', () => {
      const existingGoods = Array.from({ length: MAX_PROFILE_EXAMPLES }, (_, i) => ({
        summary: 'Successful call',
        args: `args${i}`,
      }));
      const profile = makeProfile({ toolName: 'shell.git', goodExamples: existingGoods });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

      store.recordGoodExample('shell.git', 'new-args');

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.goodExamples).toHaveLength(MAX_PROFILE_EXAMPLES);
      expect(saved.goodExamples[MAX_PROFILE_EXAMPLES - 1].args).toBe('new-args');
      expect(saved.goodExamples[0].args).toBe('args1');
    });

    it('saves the optional note when provided', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      store.recordGoodExample('shell.git', '{"command":"git diff"}', 'works well');

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.goodExamples[0].note).toBe('works well');
    });
  });

  describe('patchLastBadWithFix', () => {
    it('patches the last bad example when fix is awaiting', () => {
      const profile = makeProfile({
        toolName: 'shell.git',
        badExamples: [
          {
            summary: 'Failed: git push',
            args: '{"command":"git push --force"}',
            errorSnippet: 'rejected',
            fix: '(awaiting successful retry)',
          },
        ],
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

      store.patchLastBadWithFix('shell.git', '{"command":"git push origin main"}');

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.badExamples[0].fix).toBe(
        'Use instead: {"command":"git push origin main"}',
      );
    });

    it('does not patch when last bad example already has a non-awaiting fix', () => {
      const profile = makeProfile({
        toolName: 'shell.git',
        badExamples: [
          {
            summary: 'Failed: git push',
            args: '{"command":"git push --force"}',
            errorSnippet: 'rejected',
            fix: 'Use instead: git push origin main',
          },
        ],
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

      store.patchLastBadWithFix('shell.git', '{"command":"git push origin main --new"}');

      // save should NOT have been called since the fix is already set
      const writeCallsAfterClear = vi.mocked(fsUtils.atomicWriteFileSync).mock.calls;
      const savedData = writeCallsAfterClear.map((c) => JSON.parse(c[1] as string));
      // None of the saves should have changed the fix
      for (const s of savedData) {
        for (const bad of s.badExamples ?? []) {
          expect(bad.fix).not.toBe('Use instead: {"command":"git push origin main --new"}');
        }
      }
    });

    it('does nothing when there are no bad examples', () => {
      const profile = makeProfile({ toolName: 'shell.git', badExamples: [] });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

      vi.mocked(fsUtils.atomicWriteFileSync).mockClear();
      store.patchLastBadWithFix('shell.git', '{"command":"git status"}');

      expect(fsUtils.atomicWriteFileSync).not.toHaveBeenCalled();
    });

    it('does nothing when profile does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      vi.mocked(fsUtils.atomicWriteFileSync).mockClear();
      store.patchLastBadWithFix('nonexistent-tool', 'some-args');

      expect(fsUtils.atomicWriteFileSync).not.toHaveBeenCalled();
    });

    it('truncates working args to 200 chars in fix message', () => {
      const profile = makeProfile({
        toolName: 'shell.git',
        badExamples: [
          {
            summary: 'Failed: cmd',
            args: 'cmd',
            errorSnippet: 'error',
            fix: '(awaiting successful retry)',
          },
        ],
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

      const longArgs = 'a'.repeat(300);
      store.patchLastBadWithFix('shell.git', longArgs);

      const saved = JSON.parse(
        vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.at(-1)![1] as string,
      );
      expect(saved.badExamples[0].fix).toBe(`Use instead: ${'a'.repeat(200)}`);
    });
  });

  describe('list', () => {
    it('returns empty array when directory does not exist', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(store.list()).toEqual([]);
    });

    it('returns empty array when no JSON files present', () => {
      vi.mocked(fs.readdirSync).mockReturnValue(['.seeded-v1'] as any);
      expect(store.list()).toEqual([]);
    });

    it('returns all valid profiles', () => {
      const profileA = makeProfile({ toolName: 'shell.git' });
      const profileB = makeProfile({ toolName: 'web_read' });
      vi.mocked(fs.readdirSync).mockReturnValue(['shell.git.json', 'web_read.json'] as any);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify(profileA))
        .mockReturnValueOnce(JSON.stringify(profileB));

      const result = store.list();
      expect(result).toHaveLength(2);
      expect(result.map((p) => p.toolName)).toContain('shell.git');
      expect(result.map((p) => p.toolName)).toContain('web_read');
    });

    it('skips corrupt files and returns the rest', () => {
      const profile = makeProfile({ toolName: 'shell.git' });
      vi.mocked(fs.readdirSync).mockReturnValue(['shell.git.json', 'corrupt.json'] as any);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify(profile))
        .mockReturnValueOnce('not-valid-json{{{');

      const result = store.list();
      expect(result).toHaveLength(1);
      expect(result[0].toolName).toBe('shell.git');
    });

    it('only reads .json files (ignores others)', () => {
      const profile = makeProfile({ toolName: 'shell.git' });
      vi.mocked(fs.readdirSync).mockReturnValue([
        'shell.git.json',
        '.seeded-v1',
        'notes.txt',
      ] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

      const result = store.list();
      // Only 1 .json file should have been read
      expect(result).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// buildToolProfilesPrompt
// ---------------------------------------------------------------------------

describe('buildToolProfilesPrompt', () => {
  let store: ToolProfileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    store = new ToolProfileStore();
  });

  it('returns empty string when no profiles have guidelines or bad examples', () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['empty.json'] as any);
    const emptyProfile = makeProfile({ toolName: 'shell.git', guidelines: [], badExamples: [] });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(emptyProfile));

    expect(buildToolProfilesPrompt(store)).toBe('');
  });

  it('returns empty string when there are no profiles at all', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    expect(buildToolProfilesPrompt(store)).toBe('');
  });

  it('includes guidelines in output', () => {
    const profile = makeProfile({
      toolName: 'web_read',
      guidelines: ['Always pass a CSS selector', 'URL must start with http'],
    });
    vi.mocked(fs.readdirSync).mockReturnValue(['web_read.json'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

    const output = buildToolProfilesPrompt(store);
    expect(output).toContain('Always pass a CSS selector');
    expect(output).toContain('URL must start with http');
  });

  it('formats shell.* tool names as "shell (X commands)"', () => {
    const profile = makeProfile({
      toolName: 'shell.git',
      guidelines: ['Always check git status first'],
    });
    vi.mocked(fs.readdirSync).mockReturnValue(['shell.git.json'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

    const output = buildToolProfilesPrompt(store);
    expect(output).toContain('shell (git commands)');
    expect(output).not.toContain('shell.git');
  });

  it('keeps non-shell tool names as-is', () => {
    const profile = makeProfile({
      toolName: 'web_read',
      guidelines: ['Always use a selector'],
    });
    vi.mocked(fs.readdirSync).mockReturnValue(['web_read.json'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

    const output = buildToolProfilesPrompt(store);
    expect(output).toContain('### web_read');
  });

  it('shows at most 2 bad examples per tool', () => {
    const bads = Array.from({ length: 4 }, (_, i) => ({
      summary: `Failed: cmd${i}`,
      args: `args${i}`,
      errorSnippet: `error${i}`,
      fix: 'Use instead: fixed-args',
    }));
    const profile = makeProfile({
      toolName: 'shell.git',
      guidelines: ['Check git status'],
      badExamples: bads,
    });
    vi.mocked(fs.readdirSync).mockReturnValue(['shell.git.json'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

    const output = buildToolProfilesPrompt(store);
    // Only the last 2 bad examples (args2, args3) should appear
    expect(output).toContain('args2');
    expect(output).toContain('args3');
    expect(output).not.toContain('args0');
    expect(output).not.toContain('args1');
  });

  it('shows FIX line when fix has a real value', () => {
    const profile = makeProfile({
      toolName: 'shell.git',
      guidelines: ['guideline'],
      badExamples: [
        {
          summary: 'Failed',
          args: 'bad-args',
          errorSnippet: 'error',
          fix: 'Use instead: good-args',
        },
      ],
    });
    vi.mocked(fs.readdirSync).mockReturnValue(['shell.git.json'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

    const output = buildToolProfilesPrompt(store);
    expect(output).toContain('FIX: Use instead: good-args');
  });

  it('does not show FIX line when fix is "(awaiting successful retry)"', () => {
    const profile = makeProfile({
      toolName: 'shell.git',
      guidelines: ['guideline'],
      badExamples: [
        {
          summary: 'Failed',
          args: 'bad-args',
          errorSnippet: 'error',
          fix: '(awaiting successful retry)',
        },
      ],
    });
    vi.mocked(fs.readdirSync).mockReturnValue(['shell.git.json'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

    const output = buildToolProfilesPrompt(store);
    expect(output).not.toContain('FIX:');
    expect(output).not.toContain('(awaiting successful retry)');
  });

  it('includes the section header', () => {
    const profile = makeProfile({
      toolName: 'web_read',
      guidelines: ['Use a selector'],
    });
    vi.mocked(fs.readdirSync).mockReturnValue(['web_read.json'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

    const output = buildToolProfilesPrompt(store);
    expect(output).toContain('## Tool Usage Profiles');
  });

  it('includes profiles that only have bad examples (no guidelines)', () => {
    const profile = makeProfile({
      toolName: 'web_read',
      guidelines: [],
      badExamples: [
        {
          summary: 'Failed',
          args: 'bad-args',
          errorSnippet: 'timeout',
          fix: 'Use instead: better-args',
        },
      ],
    });
    vi.mocked(fs.readdirSync).mockReturnValue(['web_read.json'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(profile));

    const output = buildToolProfilesPrompt(store);
    expect(output).not.toBe('');
    expect(output).toContain('bad-args');
  });

  it('formats multiple shell categories with correct labels', () => {
    const gitProfile = makeProfile({ toolName: 'shell.git', guidelines: ['git tip'] });
    const npmProfile = makeProfile({ toolName: 'shell.npm', guidelines: ['npm tip'] });
    vi.mocked(fs.readdirSync).mockReturnValue(['shell.git.json', 'shell.npm.json'] as any);
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(JSON.stringify(gitProfile))
      .mockReturnValueOnce(JSON.stringify(npmProfile));

    const output = buildToolProfilesPrompt(store);
    expect(output).toContain('shell (git commands)');
    expect(output).toContain('shell (npm commands)');
  });
});
