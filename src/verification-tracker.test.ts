import { describe, it, expect } from 'vitest';
import { VerificationTracker, tokenize } from './verification-tracker.js';
import type { Step } from './plan-store.js';

const step = (id: number, verification: string): Step => ({
  id,
  description: 'test step',
  verification,
  status: 'done',
  signoff: 'done',
});

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Read README.md')).toEqual(new Set(['read', 'readme']));
  });

  it('drops short tokens', () => {
    expect(tokenize('a b cd efg')).toEqual(new Set(['efg']));
  });

  it('drops stopwords', () => {
    expect(tokenize('the file is in the directory')).toEqual(new Set(['file', 'directory']));
  });

  it('returns empty set on empty / stopword-only input', () => {
    expect(tokenize('')).toEqual(new Set());
    expect(tokenize('the and for')).toEqual(new Set());
  });
});

describe('VerificationTracker.attest', () => {
  it('returns pass when ≥2 tokens are matched across tool calls', () => {
    const t = new VerificationTracker();
    t.recordCall('file_read_lines', { path: 'src/foo.ts' }, 'export const foo = 1;');
    t.recordCall('shell', { command: 'grep readme README.md' }, '');
    const check = t.attest(step(1, 'Read README.md and confirm foo export'));
    expect(check.status).toBe('pass');
    expect(check.evidence).toContain('tokens matched');
  });

  it('returns warn on exactly 1 matched token', () => {
    const t = new VerificationTracker();
    // 'foo' is the only token in verification that appears in any call
    t.recordCall('shell', { command: 'echo foo' }, 'foo');
    const check = t.attest(step(2, 'Confirm widget xenon zephyr foo'));
    expect(check.status).toBe('warn');
  });

  it('returns fail when no recorded calls reference any token', () => {
    const t = new VerificationTracker();
    t.recordCall('shell', { command: 'pwd' }, '/tmp');
    const check = t.attest(step(3, 'Read README.md and confirm foo export'));
    expect(check.status).toBe('fail');
  });

  it('returns fail when no calls were recorded at all', () => {
    const t = new VerificationTracker();
    const check = t.attest(step(4, 'Run tests and confirm passing'));
    expect(check.status).toBe('fail');
    expect(check.evidence).toContain('no tool calls');
  });

  it('returns skip when verification has no informative tokens', () => {
    const t = new VerificationTracker();
    t.recordCall('shell', { command: 'ls' }, 'output');
    const check = t.attest(step(5, 'the and for'));
    expect(check.status).toBe('skip');
  });

  it('matches tokens in tool name, args, or result', () => {
    const t = new VerificationTracker();
    t.recordCall('memory_write', { domain: 'general', text: 'noted' }, 'ok');
    // 'memory' is in tool name, 'general' in args
    const check = t.attest(step(6, 'Persist note to memory in general domain'));
    expect(check.status).toBe('pass');
  });

  it('truncates result text to first ~500 chars', () => {
    const t = new VerificationTracker();
    const huge = 'x'.repeat(1000) + ' uniqueSentinel123';
    t.recordCall('shell', { command: 'cat big' }, huge);
    const check = t.attest(step(7, 'find uniqueSentinel123 in output'));
    // 'uniquesentinel123' is past the 500-char cap, so 'find' is the only
    // remaining (stopword-filtered) candidate → 0/1 matched → fail
    expect(check.status).not.toBe('pass');
  });
});

describe('VerificationTracker bookkeeping', () => {
  it('callCount reflects record + clear', () => {
    const t = new VerificationTracker();
    expect(t.callCount()).toBe(0);
    t.recordCall('shell', { command: 'a' }, '');
    t.recordCall('shell', { command: 'b' }, '');
    expect(t.callCount()).toBe(2);
    t.clear();
    expect(t.callCount()).toBe(0);
  });

  it('attestAll returns one Check per step', () => {
    const t = new VerificationTracker();
    t.recordCall('shell', { command: 'ls README.md' }, 'README.md');
    const checks = t.attestAll([step(1, 'README exists'), step(2, 'foo bar baz')]);
    expect(checks).toHaveLength(2);
    expect(checks[0].id).toBe('attest_step_1');
    expect(checks[1].id).toBe('attest_step_2');
  });
});
