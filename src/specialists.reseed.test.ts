import { describe, it, expect } from 'vitest';
import { mergeBundledDefinition } from './specialists.js';

/**
 * Bundled records could not be updated at all (#519), and that is the blocker
 * the issue does not name: `copyBundledJsonIfAbsent` returns early when the
 * file exists, `seedOnce` returns early once its marker is written, and
 * `permissionsFor` gives builtins `canEditDefinition: false`. So editing
 * `specialist-creator.json` in place reached only fresh installs — which is
 * almost nobody — and "one rule, obeyed by both creators" would have been a
 * hollow fix.
 *
 * The merge is what makes a re-seed safe. Its whole job is the split between
 * what Bernard ships and what this machine learned.
 */
describe('mergeBundledDefinition', () => {
  const shipped = {
    id: 'specialist-creator',
    systemPrompt: 'NEW PROMPT',
    guidelines: ['new rule'],
    role: 'executor',
  };

  it('takes the shipped definition', () => {
    const merged = mergeBundledDefinition(shipped, {
      id: 'specialist-creator',
      systemPrompt: 'OLD PROMPT',
      guidelines: ['old rule'],
    });
    expect(merged.systemPrompt).toBe('NEW PROMPT');
    expect(merged.guidelines).toEqual(['new rule']);
    expect(merged.role).toBe('executor');
  });

  it('keeps what the correction flow taught', () => {
    // `appendExamples` is the ONE channel `permissionsFor` leaves open on a
    // bundled record. Overwriting it would discard the only user-specific thing
    // a protected specialist can accumulate — and would do it silently, on a
    // routine upgrade.
    const merged = mergeBundledDefinition(shipped, {
      id: 'specialist-creator',
      goodExamples: [{ input: 'x', call: 'y' }],
      badExamples: [{ input: 'a', call: 'b', error: 'c' }],
    });
    expect(merged.goodExamples).toEqual([{ input: 'x', call: 'y' }]);
    expect(merged.badExamples).toEqual([{ input: 'a', call: 'b', error: 'c' }]);
  });

  it('keeps facts about this machine, not about the bundle', () => {
    const merged = mergeBundledDefinition(shipped, {
      id: 'specialist-creator',
      createdAt: '2024-01-01T00:00:00.000Z',
      disabled: true,
    });
    expect(merged.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(merged.disabled).toBe(true);
  });

  it('drops a learned field the install does not have, rather than inheriting the bundle’s', () => {
    // A shipped record may carry example bytes; those are the BUNDLE's, and an
    // install that has none should end with none rather than acquiring them as
    // though they had been learned here.
    const merged = mergeBundledDefinition(
      { ...shipped, goodExamples: [{ input: 'shipped', call: 'x' }] },
      { id: 'specialist-creator' },
    );
    expect(merged.goodExamples).toBeUndefined();
  });

  it('stamps updatedAt, because the record on disk really did change', () => {
    // Asserted as a real timestamp, not merely "different from the old one":
    // dropping the stamp leaves `shipped.updatedAt`, which is `undefined` here
    // and so passes an inequality check while recording nothing.
    const before = Date.now();
    const merged = mergeBundledDefinition(shipped, { id: 'x', updatedAt: 'old' });
    expect(typeof merged.updatedAt).toBe('string');
    expect(Date.parse(merged.updatedAt as string)).toBeGreaterThanOrEqual(before);
  });
});
