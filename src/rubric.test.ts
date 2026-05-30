import { describe, it, expect } from 'vitest';
import { verdictOf, countByStatus, renderRubricLine, type Check, type Rubric } from './rubric.js';

const c = (status: Check['status'], extra: Partial<Check> = {}): Check => ({
  id: extra.id ?? 'x',
  label: extra.label ?? 'check',
  status,
  evidence: extra.evidence,
});

describe('verdictOf', () => {
  it('returns pass on empty list', () => {
    expect(verdictOf([])).toBe('pass');
  });

  it('returns pass when all checks pass', () => {
    expect(verdictOf([c('pass'), c('pass')])).toBe('pass');
  });

  it('returns pass when only skips are present', () => {
    expect(verdictOf([c('skip'), c('skip')])).toBe('pass');
  });

  it('returns warn on mixed pass + warn', () => {
    expect(verdictOf([c('pass'), c('warn'), c('pass')])).toBe('warn');
  });

  it('returns fail on any fail (even mixed with warn)', () => {
    expect(verdictOf([c('warn'), c('pass'), c('fail')])).toBe('fail');
  });

  it('treats skip as neutral', () => {
    expect(verdictOf([c('skip'), c('warn')])).toBe('warn');
    expect(verdictOf([c('skip'), c('pass')])).toBe('pass');
  });
});

describe('countByStatus', () => {
  it('tallies all four statuses', () => {
    const checks = [c('pass'), c('pass'), c('warn'), c('fail'), c('skip'), c('skip')];
    expect(countByStatus(checks)).toEqual({ pass: 2, warn: 1, fail: 1, skip: 2 });
  });

  it('zero-fills statuses with no checks', () => {
    expect(countByStatus([])).toEqual({ pass: 0, warn: 0, fail: 0, skip: 0 });
  });
});

describe('renderRubricLine', () => {
  it('emits PASS with no reason when verdict is pass', () => {
    const r: Rubric = { verdict: 'pass', checks: [c('pass'), c('pass')] };
    expect(renderRubricLine(r)).toBe('eval: PASS (2✓)');
  });

  it('emits FAIL with first failing check label as reason', () => {
    const r: Rubric = {
      verdict: 'fail',
      checks: [c('pass'), c('fail', { label: 'plan_terminal', evidence: '2 unresolved' })],
    };
    expect(renderRubricLine(r)).toBe('eval: FAIL (1✓ 1✗) — plan_terminal (2 unresolved)');
  });

  it('honors an explicit reason on the rubric', () => {
    const r: Rubric = { verdict: 'warn', checks: [c('warn')], reason: 'custom' };
    expect(renderRubricLine(r)).toBe('eval: WARN (1⚠) — custom');
  });

  it('renders an empty rubric with no tally', () => {
    expect(renderRubricLine({ verdict: 'pass', checks: [] })).toBe('eval: PASS');
  });
});
