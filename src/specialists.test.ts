import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpecialistStore } from './specialists.js';
import { _resetBuiltinSpecialistCache, ProtectedSpecialistError } from './specialist-authority.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  // Default: pretend the bundled manifest dir is absent so roleOf() classifies
  // everything as a user specialist (existing tests use user ids). The bundled
  // protection block below overrides this to expose a bundled id.
  statSync: vi.fn(() => {
    throw new Error('ENOENT');
  }),
}));

vi.mock('./fs-utils.js', async () => {
  const fsMock = await import('node:fs');
  const atomicWrite = vi.fn();
  // Mirrors the real `copyBundledJsonIfAbsent`, INCLUDING its JSON.parse probe
  // — with `readFileSync` stubbed to '' the probe throws and the copy is
  // skipped, which is what keeps "a protected specialist is never written"
  // observable through the shared `atomicWriteFileSync` spy.
  const copyIfAbsent = (bundledDir: string, destDir: string, file: string): void => {
    const dest = `${destDir}/${file}`;
    if (fsMock.existsSync(dest)) return;
    try {
      const raw = fsMock.readFileSync(`${bundledDir}/${file}`, 'utf-8') as unknown as string;
      JSON.parse(raw);
      atomicWrite(dest, raw);
    } catch {
      // skip individual bad files
    }
  };
  return {
    atomicWriteFileSync: atomicWrite,
    seedOnce: vi.fn((markerPath: string, seedFn: () => void) => {
      if (fsMock.existsSync(markerPath)) return;
      seedFn();
      fsMock.writeFileSync(markerPath, new Date().toISOString(), 'utf-8');
    }),
    // Mirrors the real implementations closely enough to keep the seeding
    // assertions meaningful: the copy still routes through the mocked
    // `atomicWriteFileSync`, which is what the POST_V1 additive-seed test
    // inspects, and the directory seed still respects its marker.
    copyBundledJsonIfAbsent: vi.fn(copyIfAbsent),
    seedBundledJsonDir: vi.fn((bundledDir: string, destDir: string, markerPath: string) => {
      if (fsMock.existsSync(markerPath)) return;
      for (const file of fsMock.readdirSync(bundledDir) as unknown as string[]) {
        if (String(file).endsWith('.json')) copyIfAbsent(bundledDir, destDir, String(file));
      }
      fsMock.writeFileSync(markerPath, new Date().toISOString(), 'utf-8');
    }),
  };
});

const fs = await import('node:fs');
const fsUtils = await import('./fs-utils.js');

/** Mock existsSync to return true for directory checks, false for file checks. */
function mockDirExists(): void {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const s = String(p);
    return !s.endsWith('.json');
  });
}

describe('SpecialistStore', () => {
  let store: SpecialistStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    store = new SpecialistStore();
  });

  it('constructor creates directory', () => {
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('specialists'), {
      recursive: true,
    });
  });

  describe('validateId', () => {
    it('rejects empty string', () => {
      expect(store.validateId('')).toBeTruthy();
    });

    it('rejects uppercase', () => {
      expect(store.validateId('EmailTriage')).toBeTruthy();
    });

    it('rejects special characters', () => {
      expect(store.validateId('email_triage')).toBeTruthy();
      expect(store.validateId('email.triage')).toBeTruthy();
      expect(store.validateId('email triage')).toBeTruthy();
    });

    it('rejects leading hyphen', () => {
      expect(store.validateId('-email')).toBeTruthy();
    });

    it('rejects trailing hyphen', () => {
      expect(store.validateId('email-')).toBeTruthy();
    });

    it('rejects reserved names', () => {
      expect(store.validateId('help')).toContain('reserved');
      expect(store.validateId('clear')).toContain('reserved');
      expect(store.validateId('specialists')).toContain('reserved');
      expect(store.validateId('create-specialist')).toContain('reserved');
      expect(store.validateId('exit')).toContain('reserved');
    });

    it('accepts valid kebab-case', () => {
      expect(store.validateId('email-triage')).toBeNull();
      expect(store.validateId('code-review')).toBeNull();
      expect(store.validateId('data-analyst-v2')).toBeNull();
      expect(store.validateId('a')).toBeNull();
      expect(store.validateId('x1')).toBeNull();
    });

    it('rejects IDs over 60 characters', () => {
      const longId = 'a'.repeat(61);
      expect(store.validateId(longId)).toBeTruthy();
    });

    it('accepts 60-character ID', () => {
      const id60 = 'a'.repeat(60);
      expect(store.validateId(id60)).toBeNull();
    });
  });

  describe('list', () => {
    it('returns empty array when no files', () => {
      expect(store.list()).toEqual([]);
    });

    it('returns sorted specialists', () => {
      const specB = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'You are an email triage specialist.',
        guidelines: ['Prioritize urgent emails'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      const specA = {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code',
        systemPrompt: 'You are a code reviewer.',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['email-triage.json', 'code-review.json'] as any);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(JSON.stringify(specB))
        .mockReturnValueOnce(JSON.stringify(specA));
      const result = store.list();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('code-review');
      expect(result[1].id).toBe('email-triage');
    });

    it('skips corrupt files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['good.json', 'bad.json'] as any);
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(
          JSON.stringify({
            id: 'good',
            name: 'Good',
            description: 'desc',
            systemPrompt: 'prompt',
            guidelines: [],
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }),
        )
        .mockReturnValueOnce('not json{{{');
      const result = store.list();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('good');
    });
  });

  describe('get', () => {
    it('returns specialist by id', () => {
      const specialist = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'You are an email triage specialist.',
        guidelines: ['Prioritize urgent'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));
      expect(store.get('email-triage')).toEqual(specialist);
    });

    it('returns undefined for missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.get('nope')).toBeUndefined();
    });
  });

  describe('create', () => {
    it('writes correct structure', () => {
      mockDirExists();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const specialist = store.create(
        'email-triage',
        'Email Triage',
        'Triage incoming emails',
        'You are an email triage specialist.',
        ['Prioritize urgent emails'],
      );
      expect(specialist.id).toBe('email-triage');
      expect(specialist.name).toBe('Email Triage');
      expect(specialist.description).toBe('Triage incoming emails');
      expect(specialist.systemPrompt).toBe('You are an email triage specialist.');
      expect(specialist.guidelines).toEqual(['Prioritize urgent emails']);
      expect(specialist.createdAt).toBeTruthy();
      expect(specialist.updatedAt).toBe(specialist.createdAt);
      expect(vi.mocked(fsUtils.atomicWriteFileSync)).toHaveBeenCalled();
    });

    it('defaults guidelines to empty array', () => {
      mockDirExists();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const specialist = store.create(
        'code-review',
        'Code Review',
        'Review code',
        'You are a code reviewer.',
      );
      expect(specialist.guidelines).toEqual([]);
    });

    it('throws on invalid id', () => {
      expect(() => store.create('BAD', 'Bad', 'desc', 'prompt')).toThrow();
    });

    it('throws on reserved name', () => {
      expect(() => store.create('help', 'Help', 'desc', 'prompt')).toThrow('reserved');
    });

    it('throws on duplicate', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(() => store.create('email-triage', 'Email Triage', 'desc', 'prompt')).toThrow(
        'already exists',
      );
    });

    it('throws at MAX_SPECIALISTS', () => {
      mockDirExists();
      const files = Array.from({ length: 50 }, (_, i) => `s${i}.json`);
      vi.mocked(fs.readdirSync).mockReturnValue(files as any);
      const specData = {
        id: 'x',
        name: 'X',
        description: 'd',
        systemPrompt: 'p',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specData));
      expect(() => store.create('new-one', 'New', 'desc', 'prompt')).toThrow('Maximum');
    });
  });

  describe('update', () => {
    it('merges fields and bumps updatedAt', () => {
      const original = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'Old prompt',
        guidelines: ['Old rule'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(original));
      const updated = store.update('email-triage', { systemPrompt: 'New prompt' });
      expect(updated).toBeDefined();
      expect(updated!.systemPrompt).toBe('New prompt');
      expect(updated!.name).toBe('Email Triage');
      expect(updated!.guidelines).toEqual(['Old rule']);
      expect(updated!.updatedAt).not.toBe(original.updatedAt);
    });

    it('updates guidelines', () => {
      const original = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'prompt',
        guidelines: ['Old rule'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(original));
      const updated = store.update('email-triage', {
        guidelines: ['New rule 1', 'New rule 2'],
      });
      expect(updated!.guidelines).toEqual(['New rule 1', 'New rule 2']);
    });

    it('returns undefined for missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.update('nope', { name: 'X' })).toBeUndefined();
    });

    it('sets disabled=true and clears it on false (kept off-disk when enabled)', () => {
      const original = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'prompt',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(original));
      const off = store.update('email-triage', { disabled: true });
      expect(off!.disabled).toBe(true);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(off));
      const on = store.update('email-triage', { disabled: false });
      expect(on!.disabled).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('removes file and returns true', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(store.delete('email-triage')).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('returns false for missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.delete('nope')).toBe(false);
    });
  });

  describe('exists', () => {
    it('returns true when file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(store.exists('email-triage')).toBe(true);
    });

    it('returns false when file missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(store.exists('email-triage')).toBe(false);
    });
  });

  describe('getSummaries', () => {
    it('returns id, name, description only', () => {
      const specialist = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'You are an email triage specialist with long prompt...',
        guidelines: ['Rule 1', 'Rule 2'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['email-triage.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));
      const summaries = store.getSummaries();
      expect(summaries).toEqual([
        { id: 'email-triage', name: 'Email Triage', description: 'Triage emails' },
      ]);
    });

    it('includes provider and model when set', () => {
      const specialist = {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code',
        systemPrompt: 'prompt',
        guidelines: [],
        provider: 'xai',
        model: 'grok-code-fast-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['code-review.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));
      const summaries = store.getSummaries();
      expect(summaries).toEqual([
        {
          id: 'code-review',
          name: 'Code Review',
          description: 'Review code',
          provider: 'xai',
          model: 'grok-code-fast-1',
        },
      ]);
    });

    it('excludes disabled specialists (they leave the prompt + auto-matcher)', () => {
      const enabled = {
        id: 'enabled-one',
        name: 'Enabled',
        description: 'on',
        systemPrompt: 'p',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      const disabled = { ...enabled, id: 'disabled-one', name: 'Disabled', disabled: true };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['enabled-one.json', 'disabled-one.json'] as any);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) =>
        JSON.stringify(String(p).includes('disabled-one') ? disabled : enabled),
      );
      const summaries = store.getSummaries();
      expect(summaries.map((s) => s.id)).toEqual(['enabled-one']);
    });
  });

  describe('create with provider/model', () => {
    it('includes provider and model when specified', () => {
      mockDirExists();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const specialist = store.create(
        'code-review',
        'Code Review',
        'Review code',
        'You are a code reviewer.',
        [],
        'xai',
        'grok-code-fast-1',
      );
      expect(specialist.provider).toBe('xai');
      expect(specialist.model).toBe('grok-code-fast-1');
    });

    it('omits provider and model when not specified', () => {
      mockDirExists();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const specialist = store.create(
        'email-triage',
        'Email Triage',
        'Triage emails',
        'You are an email triage specialist.',
      );
      expect(specialist.provider).toBeUndefined();
      expect(specialist.model).toBeUndefined();
      // Verify the JSON doesn't contain provider/model keys
      const writeCall = vi.mocked(fsUtils.atomicWriteFileSync).mock.calls[0];
      const written = JSON.parse(writeCall[1] as string);
      expect('provider' in written).toBe(false);
      expect('model' in written).toBe(false);
    });
  });

  describe('update with provider/model', () => {
    const original = {
      id: 'code-review',
      name: 'Code Review',
      description: 'Review code',
      systemPrompt: 'prompt',
      guidelines: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    it('sets provider and model', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(original));
      const updated = store.update('code-review', { provider: 'xai', model: 'grok-code-fast-1' });
      expect(updated!.provider).toBe('xai');
      expect(updated!.model).toBe('grok-code-fast-1');
    });

    it('clears provider and model with empty string', () => {
      const withOverride = { ...original, provider: 'xai', model: 'grok-code-fast-1' };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(withOverride));
      const updated = store.update('code-review', { provider: '', model: '' });
      expect(updated!.provider).toBeUndefined();
      expect(updated!.model).toBeUndefined();
    });
  });

  describe('createFull', () => {
    it('creates specialist with kind field', () => {
      mockDirExists();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const specialist = store.createFull({
        id: 'test-wrapper',
        name: 'Test',
        description: 'D',
        systemPrompt: 'S',
        kind: 'tool-wrapper',
      });
      expect(specialist.kind).toBe('tool-wrapper');
      expect(vi.mocked(fsUtils.atomicWriteFileSync)).toHaveBeenCalled();
      const written = JSON.parse(vi.mocked(fsUtils.atomicWriteFileSync).mock.calls[0][1] as string);
      expect(written.kind).toBe('tool-wrapper');
    });

    it('creates specialist with targetTools', () => {
      mockDirExists();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const specialist = store.createFull({
        id: 'shell-wrapper',
        name: 'Shell',
        description: 'D',
        systemPrompt: 'S',
        targetTools: ['shell'],
      });
      expect(specialist.targetTools).toEqual(['shell']);
      const written = JSON.parse(vi.mocked(fsUtils.atomicWriteFileSync).mock.calls[0][1] as string);
      expect(written.targetTools).toEqual(['shell']);
    });

    it('creates specialist with goodExamples and badExamples', () => {
      mockDirExists();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const goodEx = { input: 'list files', call: 'ls -la' };
      const badEx = {
        input: 'bad cmd',
        call: 'rm -rf /',
        error: 'dangerous',
        fix: 'use safe path',
      };
      const specialist = store.createFull({
        id: 'ex-wrapper',
        name: 'Ex',
        description: 'D',
        systemPrompt: 'S',
        goodExamples: [goodEx],
        badExamples: [badEx],
      });
      expect(specialist.goodExamples).toEqual([goodEx]);
      expect(specialist.badExamples).toEqual([badEx]);
      const written = JSON.parse(vi.mocked(fsUtils.atomicWriteFileSync).mock.calls[0][1] as string);
      expect(written.goodExamples).toEqual([goodEx]);
      expect(written.badExamples).toEqual([badEx]);
    });

    it('creates specialist with structuredOutput', () => {
      mockDirExists();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      const specialist = store.createFull({
        id: 'structured-wrapper',
        name: 'Structured',
        description: 'D',
        systemPrompt: 'S',
        structuredOutput: true,
      });
      expect(specialist.structuredOutput).toBe(true);
      const written = JSON.parse(vi.mocked(fsUtils.atomicWriteFileSync).mock.calls[0][1] as string);
      expect(written.structuredOutput).toBe(true);
    });

    it('omits optional fields when not provided', () => {
      mockDirExists();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);
      store.createFull({
        id: 'plain-spec',
        name: 'Plain',
        description: 'D',
        systemPrompt: 'S',
      });
      const written = JSON.parse(vi.mocked(fsUtils.atomicWriteFileSync).mock.calls[0][1] as string);
      expect('kind' in written).toBe(false);
      expect('targetTools' in written).toBe(false);
      expect('goodExamples' in written).toBe(false);
      expect('badExamples' in written).toBe(false);
      expect('structuredOutput' in written).toBe(false);
    });
  });

  describe('appendExamples', () => {
    it('appends good and bad examples', () => {
      const base = {
        id: 'shell-wrapper',
        name: 'Shell',
        description: 'D',
        systemPrompt: 'S',
        guidelines: [],
        goodExamples: [{ input: 'existing', call: 'echo hi' }],
        badExamples: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(base));
      const newGood = { input: 'new good', call: 'ls' };
      const newBad = { input: 'new bad', call: 'bad', error: 'err', fix: 'fixed' };
      const updated = store.appendExamples('shell-wrapper', newGood, newBad);
      expect(updated).toBeDefined();
      expect(updated!.goodExamples).toHaveLength(2);
      expect(updated!.goodExamples![1]).toEqual(newGood);
      expect(updated!.badExamples).toHaveLength(1);
      expect(updated!.badExamples![0]).toEqual(newBad);
    });

    it('caps at MAX_EXAMPLES_PER_LIST', () => {
      const tenGoodExamples = Array.from({ length: 10 }, (_, i) => ({
        input: `input${i}`,
        call: `cmd${i}`,
      }));
      const base = {
        id: 'shell-wrapper',
        name: 'Shell',
        description: 'D',
        systemPrompt: 'S',
        guidelines: [],
        goodExamples: tenGoodExamples,
        badExamples: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(base));
      const newGood = { input: 'overflow', call: 'extra' };
      const updated = store.appendExamples('shell-wrapper', newGood);
      expect(updated).toBeDefined();
      expect(updated!.goodExamples).toHaveLength(10);
      // Oldest was dropped; last entry is the new one
      expect(updated!.goodExamples![9]).toEqual(newGood);
      // First entry is no longer input0
      expect(updated!.goodExamples![0].input).toBe('input1');
    });

    it('handles missing specialist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = store.appendExamples('nonexistent', { input: 'x', call: 'y' });
      expect(result).toBeUndefined();
    });

    it('handles undefined existing examples', () => {
      const base = {
        id: 'shell-wrapper',
        name: 'Shell',
        description: 'D',
        systemPrompt: 'S',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(base));
      const newGood = { input: 'first good', call: 'echo ok' };
      const updated = store.appendExamples('shell-wrapper', newGood);
      expect(updated).toBeDefined();
      expect(updated!.goodExamples).toHaveLength(1);
      expect(updated!.goodExamples![0]).toEqual(newGood);
    });
  });

  describe('getSummaries with kind', () => {
    it('includes kind in summary when present', () => {
      const specialist = {
        id: 'shell-wrapper',
        name: 'Shell Wrapper',
        description: 'Wraps shell',
        systemPrompt: 'prompt',
        guidelines: [],
        kind: 'tool-wrapper',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['shell-wrapper.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));
      const summaries = store.getSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].kind).toBe('tool-wrapper');
    });

    it('omits kind from summary when not present', () => {
      const specialist = {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Triage emails',
        systemPrompt: 'prompt',
        guidelines: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['email-triage.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(specialist));
      const summaries = store.getSummaries();
      expect(summaries).toHaveLength(1);
      expect('kind' in summaries[0]).toBe(false);
    });
  });

  describe('bundled protection', () => {
    const bundledRecord = JSON.stringify({
      id: 'shell-wrapper',
      name: 'Shell Wrapper',
      description: 'd',
      systemPrompt: 's',
      guidelines: [],
      kind: 'tool-wrapper',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    beforeEach(() => {
      // Expose `shell-wrapper` as a bundled specialist: make the manifest dir
      // resolvable and list it. Reset the authority cache so each test re-reads.
      _resetBuiltinSpecialistCache();
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(fs.readdirSync).mockReturnValue(['shell-wrapper.json'] as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(bundledRecord);
    });

    it('refuses to delete a bundled specialist', () => {
      expect(() => store.delete('shell-wrapper')).toThrow(ProtectedSpecialistError);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('refuses to update a bundled specialist definition', () => {
      expect(() => store.update('shell-wrapper', { systemPrompt: 'hacked' })).toThrow(
        ProtectedSpecialistError,
      );
      expect(fsUtils.atomicWriteFileSync).not.toHaveBeenCalled();
    });

    it('refuses to toggle disabled on a bundled specialist', () => {
      expect(() => store.update('shell-wrapper', { disabled: true })).toThrow(
        ProtectedSpecialistError,
      );
    });

    it('still lets the correction flow append learned examples to a bundled specialist', () => {
      const updated = store.appendExamples('shell-wrapper', {
        input: 'list files',
        call: 'shell { command: "ls" }',
      });
      expect(updated).toBeDefined();
      expect(updated?.goodExamples).toHaveLength(1);
      expect(fsUtils.atomicWriteFileSync).toHaveBeenCalled();
    });

    it('does not protect user specialists', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          id: 'email-triage',
          name: 'Email Triage',
          description: 'd',
          systemPrompt: 's',
          guidelines: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      expect(() => store.update('email-triage', { name: 'Renamed' })).not.toThrow();
      expect(store.delete('email-triage')).toBe(true);
    });
  });
});

// #417: a new bundled specialist reaches EXISTING installs only if its filename
// is in `POST_V1_BUNDLED`. `.seeded-v1` short-circuits the v1 loop, so dropping
// a JSON file into the manifest directory alone reaches nobody who already ran
// Bernard once — which is nearly everyone.
describe('post-v1 bundled seeding', () => {
  /**
   * An install that has already run once: `.seeded-v1` present, so the v1 loop
   * is skipped, and no per-file post-v1 markers yet.
   */
  function existingInstall(bundledFiles: string[]): void {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
    vi.mocked(fs.readdirSync).mockReturnValue(bundledFiles as any);
    vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p).endsWith('.seeded-v1'));
    vi.mocked(fs.readFileSync).mockImplementation((p: any) =>
      JSON.stringify({ id: String(p).split('/').pop()?.replace('.json', '') }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetBuiltinSpecialistCache();
  });

  it('seeds research-agent onto an install that already has .seeded-v1', () => {
    existingInstall(['web-wrapper.json', 'research-agent.json']);

    new SpecialistStore();

    const written = vi.mocked(fsUtils.atomicWriteFileSync).mock.calls.map((c) => String(c[0]));
    expect(written.some((p) => p.endsWith('research-agent.json'))).toBe(true);
    // The v1 set is NOT re-seeded — that is what the marker is for, and
    // re-seeding would resurrect specialists the user deleted on purpose.
    expect(written.some((p) => p.endsWith('web-wrapper.json'))).toBe(false);
  });

  it('does not resurrect it once its own marker exists', () => {
    existingInstall(['research-agent.json']);
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      return s.endsWith('.seeded-v1') || s.endsWith('.seeded-research-agent');
    });

    new SpecialistStore();

    expect(
      vi
        .mocked(fsUtils.atomicWriteFileSync)
        .mock.calls.some((c) => String(c[0]).endsWith('research-agent.json')),
    ).toBe(false);
  });

  it('never overwrites a copy the user has already edited', () => {
    existingInstall(['research-agent.json']);
    // Marker absent (so seeding is attempted) but the destination file exists.
    // `paths.js` is not mocked in this file, so the destination is the real
    // per-test-home path — match on the leaf rather than a hardcoded dir.
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      return s.endsWith('.seeded-v1') || s.endsWith('/specialists/research-agent.json');
    });

    new SpecialistStore();

    expect(
      vi
        .mocked(fsUtils.atomicWriteFileSync)
        .mock.calls.some((c) => String(c[0]).endsWith('research-agent.json')),
    ).toBe(false);
  });
});
