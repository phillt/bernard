import { describe, expect, it } from 'vitest';
import {
  bloomLevel,
  bloomNeedsCoordinator,
  hasMultiStepLanguage,
  hasReasoningRequest,
  hasToolInvocationKeyword,
  subQuestionCount,
  TOKEN_HIGH,
  TOKEN_LOW,
  tokenCount,
} from './signals.js';

describe('tokenCount', () => {
  it('returns 0 for empty / whitespace-only input', () => {
    expect(tokenCount('')).toBe(0);
    expect(tokenCount('   ')).toBe(0);
    expect(tokenCount('\n\n\t')).toBe(0);
  });

  it('whitespace-tokenizes ignoring repeated/leading/trailing spaces', () => {
    expect(tokenCount('hello world')).toBe(2);
    expect(tokenCount('   hello   world   ')).toBe(2);
    expect(tokenCount('one\ttwo\nthree four')).toBe(4);
  });

  it('treats punctuation as part of the surrounding token', () => {
    expect(tokenCount("what's up, doc?")).toBe(3);
  });

  it('exposes RouterArena tier thresholds', () => {
    expect(TOKEN_LOW).toBe(80);
    expect(TOKEN_HIGH).toBe(200);
    expect(TOKEN_LOW).toBeLessThan(TOKEN_HIGH);
  });
});

describe('hasToolInvocationKeyword', () => {
  it.each([
    'run the tests',
    'execute the build',
    'please search the codebase',
    'open the file foo.ts',
    'read README.md',
    'write a new test',
    'edit line 42',
    'create a new specialist',
    'refactor the parser',
    'fix the failing test',
    'implement the new flag',
    'deploy the change',
    'install the dependency',
    'commit and push',
    'merge feature branch',
    'lint the project',
  ])('matches the verb in: %s', (text) => {
    expect(hasToolInvocationKeyword(text)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(hasToolInvocationKeyword('REFACTOR the parser')).toBe(true);
    expect(hasToolInvocationKeyword('Build me a thing')).toBe(true);
  });

  it('does not match verbs embedded as substrings of unrelated words', () => {
    // "creative" must not match "create"; "reading" must not match "read".
    expect(hasToolInvocationKeyword('creative writing tips')).toBe(false);
    // Note: matches only with word boundaries, so "preread" wouldn't match
    // but "I am reading" wouldn't either (no exact verb match).
    expect(hasToolInvocationKeyword('I enjoy reading books')).toBe(false);
  });

  it('returns false on purely descriptive prose', () => {
    expect(hasToolInvocationKeyword('what is the capital of france')).toBe(false);
    expect(hasToolInvocationKeyword('who wrote moby dick')).toBe(false);
  });
});

describe('hasMultiStepLanguage', () => {
  it('matches numbered list markers', () => {
    expect(hasMultiStepLanguage('1. do this\n2. do that')).toBe(true);
    expect(hasMultiStepLanguage('1) first\n2) second')).toBe(true);
  });

  it('matches step-by-step phrasing in either spelling', () => {
    expect(hasMultiStepLanguage('walk me through it step by step')).toBe(true);
    expect(hasMultiStepLanguage('walk me through it step-by-step')).toBe(true);
  });

  it('matches first … then / next / after that / finally', () => {
    expect(hasMultiStepLanguage('first do A, then do B')).toBe(true);
    expect(hasMultiStepLanguage('first do A, next do B')).toBe(true);
    expect(hasMultiStepLanguage('first do A, and finally do C')).toBe(true);
  });

  it('matches connective conjunctions when paired with a task verb', () => {
    // The connective patterns deliberately require a following tool-invocation
    // verb so plain conversational English doesn't escalate (see comment in
    // `signals.ts` near `connectiveWithVerbRe`).
    expect(hasMultiStepLanguage('write X and then run Y')).toBe(true);
    expect(hasMultiStepLanguage('build it; after that deploy it')).toBe(true);
    expect(hasMultiStepLanguage('refactor X and also update tests')).toBe(true);
  });

  it('does NOT match conversational use of the same connectives', () => {
    expect(hasMultiStepLanguage('Python is fast and also readable')).toBe(false);
    expect(hasMultiStepLanguage('I tried X and then Y happened')).toBe(false);
    expect(hasMultiStepLanguage('what happened after that?')).toBe(false);
  });

  it('matches 2+ bullet list', () => {
    expect(hasMultiStepLanguage('- item one\n- item two')).toBe(true);
    expect(hasMultiStepLanguage('* a\n* b')).toBe(true);
  });

  it('returns false on single-step prose', () => {
    expect(hasMultiStepLanguage('what is 2 plus 2')).toBe(false);
    expect(hasMultiStepLanguage('explain how merge sort works')).toBe(false);
    expect(hasMultiStepLanguage('hello there')).toBe(false);
  });
});

describe('subQuestionCount', () => {
  it('returns 0 when no question marks', () => {
    expect(subQuestionCount('do the thing')).toBe(0);
  });

  it('counts trailing-context question marks', () => {
    expect(subQuestionCount('what is 2+2?')).toBe(1);
    expect(subQuestionCount('what is 2+2? and 3+3? and 4+4?')).toBe(3);
  });

  it("ignores URL query-string '?' separators", () => {
    expect(subQuestionCount('fetch https://api.example.com?limit=10')).toBe(0);
    expect(
      subQuestionCount('fetch https://api.example.com?limit=10 and https://other.com?page=2'),
    ).toBe(0);
    // A real trailing question still counts even when URLs are present:
    expect(subQuestionCount('does https://x.com?a=1 work?')).toBe(1);
  });
});

describe('hasReasoningRequest', () => {
  it.each([
    'explain why this fails',
    'analyze the codebase',
    'compare options A and B',
    'help me figure out the bug',
    'walk me through the algorithm',
    'why does this crash',
    'why is the build slow',
    'how should I structure this',
  ])('matches: %s', (text) => {
    expect(hasReasoningRequest(text)).toBe(true);
  });

  it('returns false on plain recall questions', () => {
    expect(hasReasoningRequest('what is the capital of france')).toBe(false);
    expect(hasReasoningRequest('list the files in this directory')).toBe(false);
  });
});

describe('bloomLevel', () => {
  it("defaults to 'remember' when no verbs match", () => {
    expect(bloomLevel('hello there friend')).toBe('remember');
  });

  it("classifies pure recall as 'remember'", () => {
    expect(bloomLevel('what is the capital of france')).toBe('remember');
    expect(bloomLevel('define entropy')).toBe('remember');
    expect(bloomLevel('list the files')).toBe('remember');
  });

  it("classifies paraphrase / explain prompts as 'understand'", () => {
    expect(bloomLevel('explain how merge sort works')).toBe('understand');
    expect(bloomLevel('summarize this paper')).toBe('understand');
    expect(bloomLevel('describe the architecture')).toBe('understand');
  });

  it("classifies concrete application verbs as 'apply'", () => {
    expect(bloomLevel('apply this patch')).toBe('apply');
    expect(bloomLevel('configure nginx for tls')).toBe('apply');
    expect(bloomLevel('set up a new dev environment')).toBe('apply');
  });

  it("classifies design/refactor/debug verbs as 'analyze'", () => {
    expect(bloomLevel('refactor the parser')).toBe('analyze');
    expect(bloomLevel('design a queue subsystem')).toBe('analyze');
    expect(bloomLevel('debug the failing test')).toBe('analyze');
  });

  it("classifies recommend / decide / trade-offs as 'evaluate'", () => {
    expect(bloomLevel('compare and recommend a database')).toBe('evaluate');
    expect(bloomLevel('decide between mutex and channel')).toBe('evaluate');
    expect(bloomLevel('what are the trade-offs')).toBe('evaluate');
  });

  it('returns the highest tier when multiple tiers match', () => {
    // "explain" (understand) + "refactor" (analyze) → analyze wins.
    expect(bloomLevel('explain why we should refactor the parser')).toBe('analyze');
    // "explain" (understand) + "recommend" (evaluate) → evaluate wins.
    expect(bloomLevel('explain and recommend a fix')).toBe('evaluate');
  });
});

describe('bloomNeedsCoordinator', () => {
  it('returns true for Apply/Analyze/Evaluate tiers', () => {
    expect(bloomNeedsCoordinator('apply')).toBe(true);
    expect(bloomNeedsCoordinator('analyze')).toBe(true);
    expect(bloomNeedsCoordinator('evaluate')).toBe(true);
  });

  it('returns false for Remember/Understand tiers', () => {
    expect(bloomNeedsCoordinator('remember')).toBe(false);
    expect(bloomNeedsCoordinator('understand')).toBe(false);
  });
});
