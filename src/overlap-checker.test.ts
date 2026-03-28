import { describe, it, expect } from 'vitest';
import {
  computeOverlapScore,
  checkOverlaps,
  computeConfidence,
  OVERLAP_THRESHOLD,
} from './overlap-checker.js';
import { tokenize } from './specialist-matcher.js';

describe('computeOverlapScore', () => {
  it('returns high score for identical content', () => {
    const tokens = {
      name: tokenize('Code Review Specialist'),
      description: tokenize('Reviews code for quality and consistency'),
      systemPrompt: tokenize('You are a meticulous code reviewer'),
      guidelines: tokenize('Check for bugs').concat(tokenize('Verify test coverage')),
    };

    const result = computeOverlapScore(tokens, tokens);
    expect(result.score).toBeCloseTo(1.0, 1);
    expect(result.nameScore).toBeCloseTo(1.0, 1);
    expect(result.descriptionScore).toBeCloseTo(1.0, 1);
    expect(result.promptScore).toBeCloseTo(1.0, 1);
    expect(result.guidelineScore).toBeCloseTo(1.0, 1);
  });

  it('returns low score for completely different content', () => {
    const candidateTokens = {
      name: tokenize('Code Review Specialist'),
      description: tokenize('Reviews code for quality'),
      systemPrompt: tokenize('You are a code reviewer checking for bugs'),
      guidelines: tokenize('Check for bugs'),
    };

    const targetTokens = {
      name: tokenize('Email Triage Agent'),
      description: tokenize('Sorts incoming email messages'),
      systemPrompt: tokenize('You manage and categorize email correspondence'),
      guidelines: tokenize('Prioritize urgent messages'),
    };

    const result = computeOverlapScore(candidateTokens, targetTokens);
    expect(result.score).toBeLessThan(0.15);
  });

  it('returns partial score for partially overlapping content', () => {
    const candidateTokens = {
      name: tokenize('Code Review Specialist'),
      description: tokenize('Reviews code for quality and consistency'),
      systemPrompt: tokenize('You review code carefully and check tests'),
      guidelines: tokenize('Check for bugs and verify test coverage'),
    };

    const targetTokens = {
      name: tokenize('Code Quality Agent'),
      description: tokenize('Ensures code quality through analysis'),
      systemPrompt: tokenize('You analyze code for patterns and quality issues'),
      guidelines: tokenize('Check code style and ensure test quality'),
    };

    const result = computeOverlapScore(candidateTokens, targetTokens);
    expect(result.score).toBeGreaterThan(0.1);
    expect(result.score).toBeLessThan(0.9);
  });

  it('handles empty arrays', () => {
    const emptyTokens = {
      name: [],
      description: [],
      systemPrompt: [],
      guidelines: [],
    };

    const result = computeOverlapScore(emptyTokens, emptyTokens);
    expect(result.score).toBe(0);
    expect(result.nameScore).toBe(0);
  });

  it('handles one side empty', () => {
    const populated = {
      name: tokenize('Code Review'),
      description: tokenize('Reviews code'),
      systemPrompt: tokenize('You review code'),
      guidelines: tokenize('Check bugs'),
    };
    const empty = {
      name: [],
      description: [],
      systemPrompt: [],
      guidelines: [],
    };

    const result = computeOverlapScore(populated, empty);
    expect(result.score).toBe(0);
  });
});

describe('checkOverlaps', () => {
  it('returns best match across multiple specialists', () => {
    const candidate = {
      name: 'Code Review Specialist',
      description: 'Reviews code for quality',
      systemPrompt: 'You are a meticulous code reviewer',
      guidelines: ['Check for bugs', 'Verify tests'],
    };

    const specialists = [
      {
        id: 'email-triage',
        name: 'Email Triage',
        description: 'Sorts email',
      },
      {
        id: 'code-reviewer',
        name: 'Code Reviewer',
        description: 'Reviews code for quality and bugs',
        systemPrompt: 'You review code carefully',
        guidelines: ['Check for bugs'],
      },
    ];

    const result = checkOverlaps(candidate, specialists, []);
    expect(result.bestMatch).not.toBeNull();
    expect(result.bestMatch!.name).toBe('Code Reviewer');
    expect(result.bestMatch!.type).toBe('specialist');
    expect(result.maxScore).toBeGreaterThan(0);
  });

  it('returns zero score with no specialists', () => {
    const candidate = {
      name: 'Code Review',
      description: 'Reviews code',
      systemPrompt: 'You review code',
      guidelines: ['Check bugs'],
    };

    const result = checkOverlaps(candidate, [], []);
    expect(result.maxScore).toBe(0);
    expect(result.bestMatch).toBeNull();
    expect(result.details).toBe('No significant overlap found');
  });

  it('checks pending candidates too', () => {
    const candidate = {
      name: 'Code Review Specialist',
      description: 'Reviews code for quality',
      systemPrompt: 'You review code meticulously',
      guidelines: ['Check bugs'],
    };

    const pendingCandidates = [
      {
        draftId: 'code-reviewer',
        name: 'Code Reviewer',
        description: 'Reviews code for quality',
        systemPrompt: 'You review code',
        guidelines: ['Check for bugs'],
      },
    ];

    const result = checkOverlaps(candidate, [], pendingCandidates);
    expect(result.bestMatch).not.toBeNull();
    expect(result.bestMatch!.type).toBe('candidate');
    expect(result.maxScore).toBeGreaterThan(0);
  });

  it('handles empty candidate fields', () => {
    const candidate = {
      name: '',
      description: '',
      systemPrompt: '',
      guidelines: [],
    };

    const result = checkOverlaps(
      candidate,
      [{ id: 'test', name: 'Test', description: 'Test specialist' }],
      [],
    );

    expect(result.maxScore).toBe(0);
    expect(result.bestMatch).toBeNull();
  });
});

describe('computeConfidence', () => {
  it('returns high score with high LLM confidence and low overlap', () => {
    const score = computeConfidence(
      0.95,
      0.0,
      {
        systemPrompt: 'You are a specialist',
        guidelines: ['Rule 1', 'Rule 2'],
        description: 'A detailed description here',
        draftId: 'my-specialist',
      },
      2000,
    );

    // LLM: 0.95 * 0.4 = 0.38
    // Overlap inverse: (1 - 0) * 0.3 = 0.3
    // Completeness: (0.4 + 0.3 + 0.2 + 0.1) * 0.2 = 0.2
    // Evidence: min(1, 2000/2000) * 0.1 = 0.1
    // Total: 0.38 + 0.3 + 0.2 + 0.1 = 0.98
    expect(score).toBeCloseTo(0.98, 1);
  });

  it('reduces score for high-overlap candidates', () => {
    const lowOverlap = computeConfidence(
      0.9,
      0.0,
      {
        systemPrompt: 'You are a specialist',
        guidelines: ['Rule 1'],
        description: 'A detailed description here',
        draftId: 'my-specialist',
      },
      1000,
    );

    const highOverlap = computeConfidence(
      0.9,
      0.8,
      {
        systemPrompt: 'You are a specialist',
        guidelines: ['Rule 1'],
        description: 'A detailed description here',
        draftId: 'my-specialist',
      },
      1000,
    );

    // High overlap should significantly reduce score
    expect(highOverlap).toBeLessThan(lowOverlap);
    expect(lowOverlap - highOverlap).toBeGreaterThan(0.2);
  });

  it('weights work correctly with zero values', () => {
    const score = computeConfidence(
      0,
      0,
      {
        systemPrompt: '',
        guidelines: [],
        description: '',
        draftId: 'x',
      },
      0,
    );

    // LLM: 0
    // Overlap inverse: (1 - 0) * 0.3 = 0.3
    // Completeness: 0
    // Evidence: 0
    expect(score).toBeCloseTo(0.3, 1);
  });

  it('clamps LLM confidence to [0, 1]', () => {
    const tooHigh = computeConfidence(
      2.0,
      0,
      {
        systemPrompt: 'prompt',
        guidelines: [],
        description: '',
        draftId: 'ab',
      },
      0,
    );

    const max = computeConfidence(
      1.0,
      0,
      {
        systemPrompt: 'prompt',
        guidelines: [],
        description: '',
        draftId: 'ab',
      },
      0,
    );

    expect(tooHigh).toBe(max);
  });

  it('handles conversation length scaling correctly', () => {
    const short = computeConfidence(
      0.8,
      0,
      {
        systemPrompt: 'prompt',
        guidelines: ['rule'],
        description: 'A nice description',
        draftId: 'my-spec',
      },
      100,
    );

    const long = computeConfidence(
      0.8,
      0,
      {
        systemPrompt: 'prompt',
        guidelines: ['rule'],
        description: 'A nice description',
        draftId: 'my-spec',
      },
      5000,
    );

    expect(long).toBeGreaterThan(short);
    // Difference should be within the evidence component range (max 0.1)
    expect(long - short).toBeLessThanOrEqual(0.1);
  });
});

describe('OVERLAP_THRESHOLD', () => {
  it('is 0.6', () => {
    expect(OVERLAP_THRESHOLD).toBe(0.6);
  });
});
