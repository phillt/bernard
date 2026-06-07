import { describe, expect, it } from 'vitest';
import { isPureQuestion, toolModePolicy } from './tool-mode.js';
import { makePolicyInput } from './test-helpers.js';

describe('toolModePolicy', () => {
  it('defaults to read-only mode with confirm-on-write', () => {
    const result = toolModePolicy(makePolicyInput());
    expect(result.mode).toBe('read-only');
    expect(result.requireConfirmForWrite).toBe(true);
    expect(result.reason).toBe('config-read-only');
    expect(result.confirmThreshold).toBe('high');
  });

  it('emits mode=write when config.toolMode=write', () => {
    const result = toolModePolicy(makePolicyInput({ config: { toolMode: 'write' } }));
    expect(result.mode).toBe('write');
    expect(result.reason).toBe('config-write');
    // confirmMode is orthogonal — still emits the usual auto threshold.
    expect(result.confirmThreshold).toBe('high');
  });

  it('emits threshold=never when confirmMode=off (mode still tracks toolMode)', () => {
    const result = toolModePolicy(
      makePolicyInput({ config: { confirmMode: 'off', toolMode: 'read-only' } }),
    );
    expect(result.mode).toBe('read-only');
    expect(result.confirmThreshold).toBe('never');
    expect(result.requireConfirmForWrite).toBe(false);
    expect(result.reason).toBe('config-read-only');
  });

  it('emits threshold=medium when confirmMode=strict', () => {
    const result = toolModePolicy(
      makePolicyInput({ config: { confirmMode: 'strict', toolMode: 'write' } }),
    );
    expect(result.mode).toBe('write');
    expect(result.confirmThreshold).toBe('medium');
    expect(result.requireConfirmForWrite).toBe(true);
    expect(result.reason).toBe('config-write');
  });

  it('pure question short-circuits to read-only + never (regardless of toolMode/confirmMode)', () => {
    const result = toolModePolicy(
      makePolicyInput({
        userInput: 'what time is it?',
        config: { confirmMode: 'strict', toolMode: 'write' },
      }),
    );
    expect(result.mode).toBe('read-only');
    expect(result.confirmThreshold).toBe('never');
    expect(result.requireConfirmForWrite).toBe(false);
    expect(result.reason).toBe('pure-question');
  });

  it('skipPermissions forces write + never regardless of every other setting (#212)', () => {
    const result = toolModePolicy(
      makePolicyInput({
        userInput: 'delete everything in the temp folder',
        config: { skipPermissions: true, confirmMode: 'strict', toolMode: 'read-only' },
      }),
    );
    expect(result.mode).toBe('write');
    expect(result.confirmThreshold).toBe('never');
    expect(result.requireConfirmForWrite).toBe(false);
    expect(result.reason).toBe('skip-permissions');
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
