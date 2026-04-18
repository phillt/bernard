import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectSpecialistCandidate } from './specialist-detector.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('./providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
  getModelProfile: vi.fn(() => ({
    family: 'test',
    preferredFormat: 'minimal',
    stripCoTLanguage: false,
    wrapUserMessage: (m: string) => m,
    systemSuffix: '',
  })),
}));

const mockGenerateText = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    generateText: (...args: any[]) => mockGenerateText(...args),
  };
});

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
}));

function makeConfig() {
  return {
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    maxSteps: 25,
    ragEnabled: true,
    theme: 'bernard',
    criticMode: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    anthropicApiKey: 'sk-test',
  };
}

describe('detectSpecialistCandidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateText.mockReset();
  });

  it('returns null for short conversations', async () => {
    const result = await detectSpecialistCandidate('short', makeConfig(), [], []);
    expect(result).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('returns null when shouldCreate is false', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({ shouldCreate: false, candidate: null }),
    });

    const longText = 'x'.repeat(600);
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], []);
    expect(result).toBeNull();
  });

  it('returns null when confidence is below threshold', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreate: true,
        candidate: {
          draftId: 'code-review',
          name: 'Code Review',
          description: 'Reviews code',
          systemPrompt: 'You review code.',
          guidelines: [],
          confidence: 0.5,
          reasoning: 'Weak pattern.',
        },
      }),
    });

    const longText = 'x'.repeat(600);
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], []);
    expect(result).toBeNull();
  });

  it('returns null when draftId matches existing specialist', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreate: true,
        candidate: {
          draftId: 'code-review',
          name: 'Code Review',
          description: 'Reviews code',
          systemPrompt: 'You review code.',
          guidelines: ['Check for bugs'],
          confidence: 0.9,
          reasoning: 'Strong pattern.',
        },
      }),
    });

    const longText = 'x'.repeat(600);
    const existingSpecialists = [{ id: 'code-review', name: 'Code Review', description: 'desc' }];
    const result = await detectSpecialistCandidate(longText, makeConfig(), existingSpecialists, []);
    expect(result).toBeNull();
  });

  it('returns null when draftId matches pending candidate', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreate: true,
        candidate: {
          draftId: 'code-review',
          name: 'Code Review',
          description: 'Reviews code',
          systemPrompt: 'You review code.',
          guidelines: [],
          confidence: 0.9,
          reasoning: 'Strong pattern.',
        },
      }),
    });

    const longText = 'x'.repeat(600);
    const pendingCandidates = [
      {
        id: 'uuid-1',
        draftId: 'code-review',
        name: 'Code Review',
        description: 'Reviews code',
        systemPrompt: 'prompt',
        guidelines: [],
        confidence: 0.9,
        reasoning: 'reason',
        detectedAt: new Date().toISOString(),
        source: 'exit' as const,
        acknowledged: false,
        status: 'pending' as const,
      },
    ];
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], pendingCandidates);
    expect(result).toBeNull();
  });

  it('returns valid candidate for strong pattern', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreate: true,
        candidate: {
          draftId: 'code-review',
          name: 'Code Review Specialist',
          description: 'Reviews code for quality and consistency',
          systemPrompt: 'You are a meticulous code reviewer.',
          guidelines: ['Check for bugs', 'Verify test coverage'],
          confidence: 0.9,
          reasoning:
            'User repeatedly delegated code reviews with specific behavioral instructions.',
        },
      }),
    });

    const longText = 'x'.repeat(600);
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], []);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('new-candidate');
    if (result!.type === 'new-candidate') {
      expect(result!.candidate.draftId).toBe('code-review');
      expect(result!.candidate.name).toBe('Code Review Specialist');
      // Confidence is now composite (not raw LLM confidence)
      expect(result!.candidate.confidence).toBeGreaterThan(0);
      expect(result!.candidate.guidelines).toEqual(['Check for bugs', 'Verify test coverage']);
    }
  });

  it('handles markdown-fenced JSON response', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text:
        '```json\n' +
        JSON.stringify({
          shouldCreate: true,
          candidate: {
            draftId: 'data-analyst',
            name: 'Data Analyst',
            description: 'Analyzes data',
            systemPrompt: 'You are a data analyst.',
            guidelines: [],
            confidence: 0.8,
            reasoning: 'Pattern detected.',
          },
        }) +
        '\n```',
    });

    const longText = 'x'.repeat(600);
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], []);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('new-candidate');
    if (result!.type === 'new-candidate') {
      expect(result!.candidate.draftId).toBe('data-analyst');
    }
  });

  it('returns null for malformed JSON', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'not valid json at all {{{}}}',
    });

    const longText = 'x'.repeat(600);
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], []);
    expect(result).toBeNull();
  });

  it('returns null on LLM error', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('API rate limit'));

    const longText = 'x'.repeat(600);
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], []);
    expect(result).toBeNull();
  });

  it('returns null when candidate missing required fields', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreate: true,
        candidate: {
          draftId: '',
          name: '',
          description: '',
          systemPrompt: '',
          guidelines: [],
          confidence: 0.9,
          reasoning: 'Pattern detected.',
        },
      }),
    });

    const longText = 'x'.repeat(600);
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], []);
    expect(result).toBeNull();
  });

  it('returns null when response text is empty', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: '' });

    const longText = 'x'.repeat(600);
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], []);
    expect(result).toBeNull();
  });

  it('returns null when name matches existing specialist (case-insensitive)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreate: true,
        candidate: {
          draftId: 'code-reviewer',
          name: 'Code Review',
          description: 'Reviews code',
          systemPrompt: 'You review code.',
          guidelines: [],
          confidence: 0.9,
          reasoning: 'Strong pattern.',
        },
      }),
    });

    const longText = 'x'.repeat(600);
    const existingSpecialists = [{ id: 'code-review', name: 'code review', description: 'desc' }];
    const result = await detectSpecialistCandidate(longText, makeConfig(), existingSpecialists, []);
    expect(result).toBeNull();
  });

  it('returns null when draftId is a prefix of existing specialist id', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreate: true,
        candidate: {
          draftId: 'code-review',
          name: 'Code Review Pro',
          description: 'Reviews code',
          systemPrompt: 'You review code.',
          guidelines: [],
          confidence: 0.9,
          reasoning: 'Strong pattern.',
        },
      }),
    });

    const longText = 'x'.repeat(600);
    const existingSpecialists = [
      { id: 'code-reviewer', name: 'Code Reviewer', description: 'desc' },
    ];
    const result = await detectSpecialistCandidate(longText, makeConfig(), existingSpecialists, []);
    expect(result).toBeNull();
  });

  it('returns null when existing specialist id is a prefix of draftId', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreate: true,
        candidate: {
          draftId: 'code-reviewer',
          name: 'Code Reviewer Pro',
          description: 'Reviews code',
          systemPrompt: 'You review code.',
          guidelines: [],
          confidence: 0.9,
          reasoning: 'Strong pattern.',
        },
      }),
    });

    const longText = 'x'.repeat(600);
    const existingSpecialists = [{ id: 'code-review', name: 'Code Review', description: 'desc' }];
    const result = await detectSpecialistCandidate(longText, makeConfig(), existingSpecialists, []);
    expect(result).toBeNull();
  });

  it('returns null when name matches pending candidate (case-insensitive)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreate: true,
        candidate: {
          draftId: 'different-id',
          name: 'Code Review',
          description: 'Reviews code',
          systemPrompt: 'You review code.',
          guidelines: [],
          confidence: 0.9,
          reasoning: 'Strong pattern.',
        },
      }),
    });

    const longText = 'x'.repeat(600);
    const pendingCandidates = [
      {
        id: 'uuid-1',
        draftId: 'code-review',
        name: 'code review',
        description: 'Reviews code',
        systemPrompt: 'prompt',
        guidelines: [],
        confidence: 0.9,
        reasoning: 'reason',
        detectedAt: new Date().toISOString(),
        source: 'exit' as const,
        acknowledged: false,
        status: 'pending' as const,
      },
    ];
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], pendingCandidates);
    expect(result).toBeNull();
  });

  it('returns null when draftId is a prefix of pending candidate draftId', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreate: true,
        candidate: {
          draftId: 'code-review',
          name: 'Code Review Pro',
          description: 'Reviews code',
          systemPrompt: 'You review code.',
          guidelines: [],
          confidence: 0.9,
          reasoning: 'Strong pattern.',
        },
      }),
    });

    const longText = 'x'.repeat(600);
    const pendingCandidates = [
      {
        id: 'uuid-1',
        draftId: 'code-reviewer',
        name: 'Code Reviewer',
        description: 'desc',
        systemPrompt: 'prompt',
        guidelines: [],
        confidence: 0.8,
        reasoning: 'reason',
        detectedAt: new Date().toISOString(),
        source: 'exit' as const,
        acknowledged: false,
        status: 'pending' as const,
      },
    ];
    const result = await detectSpecialistCandidate(longText, makeConfig(), [], pendingCandidates);
    expect(result).toBeNull();
  });
});
