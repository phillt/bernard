import { describe, expect, it } from 'vitest';
import type { BernardConfig } from '../config.js';
import { DefaultQualifier } from './default-qualifier.js';
import type { QualificationInput } from './types.js';

function makeConfig(): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    ragEnabled: true,
    theme: 'bernard',
    maxSteps: 25,
    coordinatorMode: 'auto',
    subagentPac: true,
    toolDetails: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    correctionEnabled: true,
    promptRewriter: true,
    referenceLookup: true,
    referenceLookupTools: [],
    customProviders: {},
  };
}

function qualify(userText: string): ReturnType<DefaultQualifier['qualify']> {
  const input: QualificationInput = { userText, config: makeConfig() };
  return new DefaultQualifier().qualify(input);
}

describe('DefaultQualifier — escalation gates', () => {
  it("multi-step phrasing wins first with 'qualifier:multi-step-language'", () => {
    const r = qualify(
      'first refactor the parser, then update the tests, and after that deploy the change',
    );
    expect(r.strategyId).toBe('react');
    expect(r.reason).toBe('qualifier:multi-step-language');
  });

  it('numbered-list phrasing also fires multi-step', () => {
    const r = qualify('1. clone the repo\n2. install deps\n3. run the tests');
    expect(r.strategyId).toBe('react');
    expect(r.reason).toBe('qualifier:multi-step-language');
  });

  it("tool keyword + Apply/Analyze/Evaluate bloom -> 'qualifier:tool-keyword-and-complexity'", () => {
    const r = qualify('refactor the parser');
    expect(r.strategyId).toBe('react');
    expect(r.reason).toBe('qualifier:tool-keyword-and-complexity');
  });

  it('tool keyword + long-enough message also escalates via tool-keyword-and-complexity', () => {
    // > TOKEN_LOW (80) tokens, plain "search" verb (Remember-tier).
    const longText = 'search for ' + 'the file '.repeat(40) + 'in the repository';
    expect(longText.split(/\s+/).filter(Boolean).length).toBeGreaterThan(80);
    const r = qualify(longText);
    expect(r.strategyId).toBe('react');
    expect(r.reason).toBe('qualifier:tool-keyword-and-complexity');
  });

  it("2+ questions -> 'qualifier:multiple-questions'", () => {
    const r = qualify('how does X work? and why is Y slow?');
    expect(r.strategyId).toBe('react');
    expect(r.reason).toBe('qualifier:multiple-questions');
  });

  it("pure bloom escalation (no tool kw, no multi-step) -> 'qualifier:bloom-<level>'", () => {
    // "compare and recommend" is Evaluate; phrased with no tool-verb / multi-step / 2+ questions.
    const r = qualify('compare and recommend an option for our team');
    expect(r.strategyId).toBe('react');
    expect(r.reason).toBe('qualifier:bloom-evaluate');
  });
});

describe('DefaultQualifier — light-path defaults', () => {
  it("short, no tool kw, no reasoning, <=1 question -> 'qualifier:short-and-simple'", () => {
    const r = qualify('what is 2+2');
    expect(r.strategyId).toBe('normal');
    expect(r.reason).toBe('qualifier:short-and-simple');
  });

  it('greetings stay normal via short-and-simple', () => {
    const r = qualify('hello there');
    expect(r.strategyId).toBe('normal');
    expect(r.reason).toBe('qualifier:short-and-simple');
  });

  it('pure tool keyword on a short ask does NOT escalate (no complexity)', () => {
    // "run ls" — has tool keyword but tokens < 80 and bloom = remember.
    const r = qualify('run ls');
    expect(r.strategyId).toBe('normal');
    // Falls into the middle band: tool kw is present so short-and-simple's
    // `!toolKw` guard fails; we land on default-light.
    expect(r.reason).toBe('qualifier:default-light');
  });

  it("middle band (reasoning request, short ask) -> 'qualifier:default-light'", () => {
    // "explain why" fires the reasoning-request regex; Understand-tier bloom
    // (no escalation); no tool kw, no multi-step, ≤1 question. The
    // `short-and-simple` branch is gated on `!reasoning`, so we land on
    // `default-light` instead.
    const r = qualify('explain why JavaScript uses prototypes');
    expect(r.strategyId).toBe('normal');
    expect(r.reason).toBe('qualifier:default-light');
  });
});

describe('DefaultQualifier — signals payload', () => {
  it('returns the full feature map alongside the decision', () => {
    const r = qualify('refactor the parser');
    expect(r.signals).toMatchObject({
      toolKw: true,
      multiStep: false,
      bloom: 'analyze',
    });
    expect(typeof r.signals?.tokens).toBe('number');
    expect(typeof r.signals?.questions).toBe('number');
  });
});

describe('DefaultQualifier — pure-question gate (broad-verb false positives)', () => {
  // Regression for code-review finding: trivial single-question asks were
  // escalating via the tool-keyword+bloom or bloom-only gates because
  // common nouns ('format', 'test') overlap with TOOL_INVOCATION_VERBS and
  // common applies ('use', 'implement') overlap with BLOOM_APPLY.
  it("'what format should I use?' stays normal (single short question)", () => {
    const r = qualify('what format should I use?');
    expect(r.strategyId).toBe('normal');
    expect(r.reason).toMatch(/^qualifier:(short-and-simple|default-light)$/);
  });

  it("'how do I call this API?' stays normal", () => {
    const r = qualify('how do I call this API?');
    expect(r.strategyId).toBe('normal');
  });

  it("'what test framework should I use?' stays normal", () => {
    const r = qualify('what test framework should I use?');
    expect(r.strategyId).toBe('normal');
  });

  it('a URL-bearing single-clause sentence with no real question is normal', () => {
    // subQuestionCount must ignore URL '?' separators; the only escalation
    // signal here was the spurious multi-question gate.
    const r = qualify('fetch https://api.example.com?limit=10 and https://other.com?page=2');
    expect(r.strategyId).toBe('normal');
  });
});

describe('DefaultQualifier — edge cases', () => {
  it('handles empty user text without throwing', () => {
    const r = qualify('');
    expect(r.strategyId).toBe('normal');
    // 0 tokens < TOKEN_LOW, no kw, no reasoning, 0 questions → short-and-simple.
    expect(r.reason).toBe('qualifier:short-and-simple');
  });

  it('handles whitespace-only input the same way', () => {
    const r = qualify('   \n  ');
    expect(r.strategyId).toBe('normal');
    expect(r.reason).toBe('qualifier:short-and-simple');
  });
});
