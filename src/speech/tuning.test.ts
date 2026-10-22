import { describe, it, expect } from 'vitest';
import { TUNING_FIELDS, parseVoiceTuning, tuningLabel, isUntuned } from './tuning.js';

describe('voice tuning', () => {
  it('keeps valid fields and drops anything out of range or of the wrong type', () => {
    expect(
      parseVoiceTuning({ stability: 0.5, similarity: 2, style: 'x', speakerBoost: true }),
    ).toEqual({ stability: 0.5, speakerBoost: true });
    expect(parseVoiceTuning({ stability: -1 })).toBeUndefined();
    expect(parseVoiceTuning('nope')).toBeUndefined();
  });

  it('labels every offered choice as itself, and an unset field as the voice’s own', () => {
    for (const f of TUNING_FIELDS) {
      expect(f.choices[0]).toEqual({ label: 'Voice default', value: undefined });
      for (const c of f.choices) {
        const tuning = c.value === undefined ? undefined : { [f.field]: c.value };
        expect(tuningLabel(f.field, tuning)).toBe(c.label);
      }
    }
  });

  it('treats no tuning as untuned', () => {
    expect(isUntuned(undefined)).toBe(true);
    expect(isUntuned({})).toBe(true);
    expect(isUntuned({ style: 0 })).toBe(false);
  });
});
