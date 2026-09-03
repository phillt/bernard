import { describe, it, expect } from 'vitest';
import { createTools } from '../tools/index.js';
import record from './agent-builder.json' with { type: 'json' };

// The bundled manifest is copied byte-for-byte at seed time — `createFull` is
// not on that path, so nothing validates these records at runtime. These are
// the checks that would otherwise only fail as silent misbehaviour.
describe('agent-builder bundled record', () => {
  it('has an id matching its filename', () => {
    // `get(id)` reads `<id>.json` and `roleOf` derives ids from filenames, so a
    // mismatch makes the record unreachable AND unprotected.
    expect(record.id).toBe('agent-builder');
  });

  it('names only tools that actually resolve', () => {
    // An unresolvable name is dropped with only a debugLog, so a typo yields a
    // quietly under-equipped specialist rather than an error.
    //
    // The registry a wrapper dispatch sees is `createTools(surface:'full')`
    // PLUS the four dispatch tools `dispatchToolWrapper` folds in — so
    // `tool_wrapper_run`, which this record needs for its validation step, is
    // never in `createTools` alone. Named here rather than constructed,
    // because building them needs a whole `AgentContext`.
    const WRAPPER_EXTRA = ['agent', 'task', 'specialist_run', 'tool_wrapper_run'];
    const registry = createTools(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { surface: 'full' },
    );
    const reachable = [...Object.keys(registry), ...WRAPPER_EXTRA];
    for (const name of record.targetTools) {
      expect(reachable).toContain(name);
    }
  });

  /**
   * `kind: 'meta'` is load-bearing four times over: `tool_wrapper_run` refuses
   * a `persona`, `toolWrapperDefinition.toolSurface: 'full'` is what makes
   * `specialist` constructible at all, meta runs do not enqueue correction
   * candidates (an external caller's failure must not teach a local
   * specialist), and `withSlot` makes its nested validation acquire free.
   */
  it('is a meta specialist with structured output', () => {
    expect(record.kind).toBe('meta');
    expect(record.structuredOutput).toBe(true);
  });

  it('can create and validate, and nothing else', () => {
    // `specialist` writes the record; `tool_wrapper_run` is the validation
    // step. Deliberately no shell/web: unlike `specialist-creator` this agent
    // is given a described need, not a CLI to research.
    expect(record.targetTools.sort()).toEqual(['specialist', 'tool_wrapper_run']);
  });

  // The matcher scores identityHits / |id segments ∪ name tokens|, so extra
  // words LOWER the score. Two tokens is the best available denominator.
  it('keeps its identity tokens few, which is what the matcher rewards', () => {
    const idSegments = record.id.split('-');
    const nameTokens = record.name.toLowerCase().split(/\s+/);
    expect(new Set([...idSegments, ...nameTokens]).size).toBeLessThanOrEqual(2);
  });

  it('carries no provider or model pin, like every other bundled record', () => {
    expect(record).not.toHaveProperty('provider');
    expect(record).not.toHaveProperty('model');
  });

  // The rule with no code behind it: `grantedToolNames` is an intersection, so
  // an under-declared targetTools silently removes tools from the action.
  it('teaches the intersection rule, which nothing enforces', () => {
    expect(record.systemPrompt).toContain('intersection');
    expect(record.guidelines.join(' ')).toContain('toolAllowlist');
  });
});
