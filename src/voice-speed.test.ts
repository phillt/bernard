import { describe, it, expect } from 'vitest';
import { VOICE_SPEEDS, voiceSpeedFor, cloudSpeedFor, localTempoFor } from './voice-speed.js';

describe('voice speeds', () => {
  it('reads each stored speed back as itself', () => {
    for (const s of VOICE_SPEEDS) expect(voiceSpeedFor(s.wpm)).toBe(s);
  });

  it('treats no rate as regular, the voice’s own pace', () => {
    expect(voiceSpeedFor(undefined).id).toBe('regular');
    expect(cloudSpeedFor(undefined)).toBe(1);
  });

  it('reads a hand-typed rate as the nearest named speed', () => {
    expect(voiceSpeedFor(185).id).toBe('regular');
    expect(voiceSpeedFor(100).id).toBe('slow');
    expect(voiceSpeedFor(400).id).toBe('fastest');
  });

  it('keeps every cloud multiplier inside what ElevenLabs accepts', () => {
    for (const s of VOICE_SPEEDS) {
      expect(s.multiplier).toBeGreaterThanOrEqual(0.7);
      expect(s.multiplier).toBeLessThanOrEqual(1.2);
    }
  });

  it('goes past the vendor ceiling only at fastest, and only locally', () => {
    expect(VOICE_SPEEDS.filter((s) => s.localTempo !== 1).map((s) => s.id)).toEqual(['fastest']);
    expect(localTempoFor(undefined)).toBe(1);
  });

  it('never steps by less than an audible amount between neighbours', () => {
    // Measured: 1.1 was indistinguishable from 1.0 against ElevenLabs.
    for (let i = 1; i < VOICE_SPEEDS.length; i++) {
      const a = VOICE_SPEEDS[i - 1];
      const b = VOICE_SPEEDS[i];
      expect(b.multiplier * b.localTempo - a.multiplier * a.localTempo).toBeGreaterThan(0.149);
    }
  });
});
