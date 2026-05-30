import { describe, expect, it } from 'vitest';
import { scratchPolicy } from './scratch.js';
import { makePolicyInput } from './test-helpers.js';

describe('scratchPolicy', () => {
  it('always wipes the per-turn PlanStore', () => {
    // Every branch should preserve the historical PlanStore-clear behavior.
    const cases = [
      makePolicyInput(), // first-turn
      makePolicyInput({ userInput: 'add a test', previousUserInput: 'add a test' }), // same-task
      makePolicyInput({ userInput: 'write a poem', previousUserInput: 'fix the database' }), // subject-change
      makePolicyInput({ userInput: '/CLEAR', previousUserInput: 'hello' }), // explicit
    ];
    for (const input of cases) {
      expect(scratchPolicy(input).resetPlanOnly).toBe(true);
    }
  });

  it('first turn clears all scratch', () => {
    const result = scratchPolicy(
      makePolicyInput({ userInput: 'hello', previousUserInput: undefined }),
    );
    expect(result.resetAll).toBe(true);
    expect(result.deletePlanKey).toBe(true);
    expect(result.reason).toBe('first-turn');
  });

  it('same task preserves scratch (high similarity follow-up)', () => {
    const result = scratchPolicy(
      makePolicyInput({
        userInput: 'add another field to the user model',
        previousUserInput: 'create a user model with name and email fields',
      }),
    );
    expect(result.resetAll).toBe(false);
    expect(result.deletePlanKey).toBe(false);
    expect(result.reason).toBe('same-task');
  });

  it('detects explicit /CLEAR marker', () => {
    const result = scratchPolicy(
      makePolicyInput({ userInput: '/CLEAR', previousUserInput: 'working on something' }),
    );
    expect(result.resetAll).toBe(true);
    expect(result.deletePlanKey).toBe(true);
    expect(result.reason).toBe('explicit-marker');
  });

  it('detects "switching topics" marker', () => {
    const result = scratchPolicy(
      makePolicyInput({
        userInput: 'switching topics now, lets talk about the database',
        previousUserInput: 'fix the database bug',
      }),
    );
    expect(result.resetAll).toBe(true);
    expect(result.reason).toBe('explicit-marker');
  });

  it('detects "new task" marker', () => {
    const result = scratchPolicy(
      makePolicyInput({
        userInput: 'new task: deploy the app',
        previousUserInput: 'deploy the app to staging',
      }),
    );
    expect(result.resetAll).toBe(true);
    expect(result.reason).toBe('explicit-marker');
  });

  it('detects subject change via low Jaccard similarity', () => {
    const result = scratchPolicy(
      makePolicyInput({
        userInput: 'write a haiku about autumn leaves',
        previousUserInput: 'fix the database migration script',
      }),
    );
    expect(result.resetAll).toBe(true);
    expect(result.deletePlanKey).toBe(true);
    expect(result.reason).toBe('subject-change');
  });

  it('Task: prefix on similar content sets deletePlanKey only', () => {
    const result = scratchPolicy(
      makePolicyInput({
        userInput: '[2026-05-29T10:00:00] Task: add another field to the user model',
        previousUserInput: 'create a user model with name and email fields',
      }),
    );
    expect(result.resetAll).toBe(false);
    expect(result.deletePlanKey).toBe(true);
    expect(result.reason).toBe('new-task-marker');
  });

  it('does NOT match explicit-clear markers buried mid-sentence', () => {
    // Anchored regex: phrases like these should be treated as ordinary content
    // and route through the similarity check, not auto-wipe.
    const cases = [
      'show me the new task list',
      'fix the unrelated test',
      'this is for a new plan we discussed',
      'ignore previous edits to foo.ts and continue',
    ];
    for (const userInput of cases) {
      const result = scratchPolicy(
        makePolicyInput({
          userInput,
          previousUserInput: 'we were working on the task list earlier',
        }),
      );
      expect(result.reason).not.toBe('explicit-marker');
    }
  });

  it('matches explicit-clear markers even with [timestamp] / Task: wrapper', () => {
    const result = scratchPolicy(
      makePolicyInput({
        userInput: '[2026-05-29T10:00:00] Task: switching topics, write a haiku',
        previousUserInput: 'fix the database migration',
      }),
    );
    expect(result.reason).toBe('explicit-marker');
    expect(result.resetAll).toBe(true);
  });

  it('short acknowledgements skip subject-change and count as same-task', () => {
    // < 3 content tokens after stop-word filtering. These would otherwise
    // Jaccard ~0 against a substantive prior turn and falsely trigger wipe.
    const cases = ['ok continue', 'yes do it', 'and then?', 'looks good'];
    for (const userInput of cases) {
      const result = scratchPolicy(
        makePolicyInput({
          userInput,
          previousUserInput: 'fix the database migration script and add tests',
        }),
      );
      expect(result.reason).toBe('same-task');
      expect(result.resetAll).toBe(false);
      expect(result.deletePlanKey).toBe(false);
    }
  });

  it('honors configured scratchSubjectThreshold', () => {
    // With a very high threshold even similar-ish turns become subject-change.
    const result = scratchPolicy(
      makePolicyInput({
        userInput: 'add another field to the user model',
        previousUserInput: 'create a user model with name and email fields',
        config: { scratchSubjectThreshold: 0.99 },
      }),
    );
    expect(result.resetAll).toBe(true);
    expect(result.reason).toBe('subject-change');
  });
});
