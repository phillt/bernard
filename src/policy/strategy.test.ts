import { describe, expect, it } from 'vitest';
import { strategyPolicy } from './strategy.js';
import { makePolicyInput } from './test-helpers.js';

describe('strategyPolicy', () => {
  describe('coordinatorMode short-circuits', () => {
    it("returns react with 'coordinator-mode-on' when coordinatorMode is 'on'", () => {
      const result = strategyPolicy(
        makePolicyInput({
          // A user message that would otherwise route to react via the qualifier
          // — irrelevant here because 'on' bypasses qualification.
          userInput: 'what is 2+2',
          config: { coordinatorMode: 'on' },
        }),
      );
      expect(result.id).toBe('react');
      expect(result.reason).toBe('coordinator-mode-on');
    });

    it("returns normal with 'coordinator-mode-off' when coordinatorMode is 'off'", () => {
      const result = strategyPolicy(
        makePolicyInput({
          // A user message that would otherwise route to react via the qualifier
          // — irrelevant here because 'off' bypasses qualification.
          userInput:
            'first refactor the parser, then update the tests, and after that deploy the change',
          config: { coordinatorMode: 'off' },
        }),
      );
      expect(result.id).toBe('normal');
      expect(result.reason).toBe('coordinator-mode-off');
    });
  });

  describe("'auto' delegates to the qualifier", () => {
    it("routes a multi-step request to react with a 'qualifier:' reason", () => {
      const result = strategyPolicy(
        makePolicyInput({
          userInput:
            'first refactor the parser, then update the tests, and after that deploy the change',
          config: { coordinatorMode: 'auto' },
        }),
      );
      expect(result.id).toBe('react');
      expect(result.reason).toMatch(/^qualifier:/);
    });

    it("routes a short factual question to normal with a 'qualifier:' reason", () => {
      const result = strategyPolicy(
        makePolicyInput({
          userInput: 'what is 2+2',
          config: { coordinatorMode: 'auto' },
        }),
      );
      expect(result.id).toBe('normal');
      expect(result.reason).toMatch(/^qualifier:/);
    });

    it('forwards the turnIndex into the qualifier context (smoke)', () => {
      // The qualifier doesn't use turnIndex today, but the wiring must not
      // throw and must still return a well-formed decision.
      const result = strategyPolicy(
        makePolicyInput({
          userInput: 'list the files in this directory',
          config: { coordinatorMode: 'auto' },
          turnIndex: 7,
        }),
      );
      expect(['react', 'normal']).toContain(result.id);
      expect(result.reason).toMatch(/^qualifier:/);
    });
  });
});
