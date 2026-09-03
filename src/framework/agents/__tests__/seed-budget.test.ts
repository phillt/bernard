import { describe, it, expect } from 'vitest';
import type { CoreMessage } from 'ai';
import { seedBudgetRefusal, SEED_BUDGET_RATIO } from '../seed-budget.js';

const text = (chars: number): CoreMessage => ({ role: 'user', content: 'x'.repeat(chars) });

describe('seedBudgetRefusal', () => {
  it('allows an ordinary dispatch', () => {
    expect(
      seedBudgetRefusal({ seed: [text(400)], modelName: 'gpt-4.1', prefixChars: 2_000 }),
    ).toBeNull();
  });

  // The case that motivated it: four 10 MB images against a small window.
  // `estimateContentPartTokens` charges a flat 1000 per image, so the seed has
  // to be big in text terms too — which is exactly why the check is on the
  // whole seed rather than on the attachments.
  it('refuses a seed that cannot fit, naming the model and the numbers', () => {
    const refusal = seedBudgetRefusal({
      seed: [text(4_000_000)],
      modelName: 'gpt-4.1',
      prefixChars: 0,
    });
    expect(refusal).toContain('gpt-4.1');
    expect(refusal).toContain('too large');
    // It must name the way out — `provider`/`model` overrides are accepted by
    // `specialist_run` and `tool_wrapper_run` and beat both pin and lineup.
    expect(refusal).toContain('provider');
  });

  it('counts the prefix, not only the seed', () => {
    const window = 128_000; // the default for an unknown model
    const budget = window * SEED_BUDGET_RATIO;
    // A seed just under budget on its own, pushed over by the prefix.
    const seedChars = Math.floor(budget * 3.6 * 0.9);
    expect(
      seedBudgetRefusal({ seed: [text(seedChars)], modelName: 'nope', prefixChars: 0 }),
    ).toBeNull();
    expect(
      seedBudgetRefusal({ seed: [text(seedChars)], modelName: 'nope', prefixChars: 4 * budget }),
    ).not.toBeNull();
  });

  /**
   * A large window must actually be honoured, or the check refuses work the
   * model can do — the failure mode that matters more than a missed catch.
   *
   * Driven by `windowOverride` on both sides rather than by two real model
   * names, so it asserts the arithmetic rather than today's catalog: model
   * windows move, and a test that encodes one turns a vendor's change into a
   * red build.
   */
  it('honours the window it is given', () => {
    const seed = [text(2_000_000)]; // ~556k tokens
    expect(
      seedBudgetRefusal({ seed, modelName: 'any', windowOverride: 200_000, prefixChars: 0 }),
    ).not.toBeNull();
    expect(
      seedBudgetRefusal({ seed, modelName: 'any', windowOverride: 2_000_000, prefixChars: 0 }),
    ).toBeNull();
  });

  // Below `agent.ts`'s 0.9 preflight, because that one has a complete prefix
  // and can truncate; this one has an incomplete prefix and can only refuse.
  it('leaves headroom below the main agent preflight ratio', () => {
    expect(SEED_BUDGET_RATIO).toBeLessThan(0.9);
  });
});
