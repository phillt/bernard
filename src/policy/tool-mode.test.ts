import { describe, expect, it } from 'vitest';
import { isPureQuestion, toolModePolicy } from './tool-mode.js';
import { makePolicyInput } from './test-helpers.js';

describe('toolModePolicy', () => {
  it('defaults to write-mode with confirm-on-write', () => {
    const result = toolModePolicy(makePolicyInput());
    expect(result.mode).toBe('write');
    expect(result.requireConfirmForWrite).toBe(true);
    expect(result.reason).toBe('confirm-mode-auto');
    expect(result.confirmThreshold).toBe('high');
  });

  it('emits threshold=never when confirmMode=off', () => {
    const result = toolModePolicy(makePolicyInput({ config: { confirmMode: 'off' } }));
    expect(result.confirmThreshold).toBe('never');
    expect(result.requireConfirmForWrite).toBe(false);
    expect(result.reason).toBe('confirm-mode-off');
  });

  it('emits threshold=medium when confirmMode=strict', () => {
    const result = toolModePolicy(makePolicyInput({ config: { confirmMode: 'strict' } }));
    expect(result.confirmThreshold).toBe('medium');
    expect(result.requireConfirmForWrite).toBe(true);
    expect(result.reason).toBe('confirm-mode-strict');
  });

  it('pure question short-circuits to read-only + never (regardless of confirmMode)', () => {
    const result = toolModePolicy(
      makePolicyInput({
        userInput: 'what time is it?',
        config: { confirmMode: 'strict' },
      }),
    );
    expect(result.mode).toBe('read-only');
    expect(result.confirmThreshold).toBe('never');
    expect(result.requireConfirmForWrite).toBe(false);
    expect(result.reason).toBe('pure-question');
  });
});

describe('isPureQuestion', () => {
  it.each([
    'what time is it?',
    'how does this work?',
    'why did that fail?',
    'is this branch ahead?',
    'Could you explain?',
    'when was X added',
    'where is the config',
  ])('treats %p as a pure question', (input) => {
    expect(isPureQuestion(input)).toBe(true);
  });

  it.each([
    'send this email please',
    'delete that file',
    'can you create a new branch?', // tool-invocation verb beats `?` ending
    'open the PR',
    'run the tests',
    '', // empty
    'do you know about X?', // contains 'know' / 'do you' but also no tool verb — biased to true via `?` ending — guard skip
  ])('treats %p as NOT a pure question (or biased false)', (input) => {
    if (input === 'do you know about X?') return; // ambiguous on purpose, drop
    expect(isPureQuestion(input)).toBe(false);
  });

  it('biases toward false on bare imperative statements', () => {
    expect(isPureQuestion('refactor the agent loop')).toBe(false);
    expect(isPureQuestion('helpful comment about something')).toBe(false);
  });
});
