import { describe, it, expect } from 'vitest';
import { matchSpecialists, tokenize } from './specialist-matcher.js';
import type { SpecialistSummary } from './specialists.js';

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('removes stop words', () => {
    expect(tokenize('review the code for me')).toEqual(['review', 'code']);
  });

  it('drops tokens shorter than 2 chars', () => {
    expect(tokenize('a b cd ef')).toEqual(['cd', 'ef']);
  });

  it('drops numeric-only tokens', () => {
    expect(tokenize('version 42 release')).toEqual(['version', 'release']);
  });

  it('returns empty for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('matchSpecialists', () => {
  const specialists: SpecialistSummary[] = [
    {
      id: 'code-reviewer',
      name: 'Code Reviewer',
      description: 'Reviews code for correctness, style, and security',
    },
    {
      id: 'deploy-manager',
      name: 'Deploy Manager',
      description: 'Manages deployments to staging and production',
    },
    {
      id: 'pr-writer',
      name: 'PR Writer',
      description: 'Writes pull request descriptions from diffs',
    },
  ];

  it('returns empty for empty input', () => {
    expect(matchSpecialists('', specialists)).toEqual([]);
  });

  it('returns empty for no specialists', () => {
    expect(matchSpecialists('review my code', [])).toEqual([]);
  });

  it('returns empty for irrelevant input', () => {
    expect(matchSpecialists('what time is it in Tokyo', specialists)).toEqual([]);
  });

  it('strong match: input covers identity tokens', () => {
    const result = matchSpecialists('review this code please', specialists);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].id).toBe('code-reviewer');
    expect(result[0].score).toBeGreaterThanOrEqual(0.8);
  });

  it('partial match: some identity tokens covered', () => {
    const result = matchSpecialists('deploy this app', specialists);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].id).toBe('deploy-manager');
    expect(result[0].score).toBeGreaterThanOrEqual(0.4);
  });

  it('stem matching: "review" matches "reviewer"', () => {
    const result = matchSpecialists('review', specialists);
    const match = result.find((m) => m.id === 'code-reviewer');
    expect(match).toBeDefined();
    expect(match!.score).toBeGreaterThanOrEqual(0.4);
  });

  it('stem matching: "deployment" matches "deploy"', () => {
    const result = matchSpecialists('deployment status', specialists);
    const match = result.find((m) => m.id === 'deploy-manager');
    expect(match).toBeDefined();
  });

  it('stop words do not inflate scores', () => {
    // "the" and "for" are stop words — only "code" and "review" should matter
    const resultA = matchSpecialists('code review', specialists);
    const resultB = matchSpecialists('the code for the review', specialists);
    const scoreA = resultA.find((m) => m.id === 'code-reviewer')?.score ?? 0;
    const scoreB = resultB.find((m) => m.id === 'code-reviewer')?.score ?? 0;
    expect(scoreA).toBe(scoreB);
  });

  it('multiple specialists sorted by score descending', () => {
    // "pr writer" should match pr-writer strongly; "code" might partially match code-reviewer
    const result = matchSpecialists('write pr description', specialists);
    if (result.length >= 2) {
      expect(result[0].score).toBeGreaterThanOrEqual(result[1].score);
    }
  });

  it('case insensitivity', () => {
    const result = matchSpecialists('CODE REVIEWER', specialists);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].id).toBe('code-reviewer');
  });

  it('scores are between 0 and 1', () => {
    const result = matchSpecialists('code reviewer deploy manager pr writer', specialists);
    for (const m of result) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1);
    }
  });

  it('includes name in results', () => {
    const result = matchSpecialists('review code', specialists);
    const match = result.find((m) => m.id === 'code-reviewer');
    expect(match?.name).toBe('Code Reviewer');
  });

  it('description boosts score but does not solely qualify', () => {
    // "security" appears only in code-reviewer's description, not identity
    const result = matchSpecialists('security', specialists);
    // Should NOT match because identity tokens don't match
    const match = result.find((m) => m.id === 'code-reviewer');
    expect(match).toBeUndefined();
  });
});
