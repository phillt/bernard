import { describe, it, expect, vi } from 'vitest';

// Record spawn calls so we can assert warmup-before-speech ordering without
// touching real audio binaries. `execFileSync` throws so the default PATH probe
// simply reports "not installed" if ever hit (the tests below never rely on it).
const { spawnCalls, killCalls, mockState } = vi.hoisted(() => ({
  spawnCalls: [] as { bin: string; args: string[] }[],
  killCalls: [] as string[],
  // `autoClose: false` simulates a hung player that never exits on its own.
  mockState: { autoClose: true },
}));
vi.mock('node:child_process', () => ({
  spawn: (bin: string, args: string[]) => {
    spawnCalls.push({ bin, args });
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const child = {
      unref() {},
      kill(sig?: string) {
        killCalls.push(`${bin}:${sig ?? 'SIGTERM'}`);
      },
      on(ev: string, cb: (...a: unknown[]) => void) {
        (handlers[ev] ||= []).push(cb);
        return child;
      },
    };
    // Emit a clean close on a later tick so the Promise wiring is in place first.
    if (mockState.autoClose) {
      queueMicrotask(() => (handlers['close'] || []).forEach((cb) => cb(0)));
    }
    return child;
  },
  execFileSync: () => {
    throw new Error('which: not available in test');
  },
}));

import {
  resolveBackend,
  buildSpeakCommand,
  resolveWarmupPlayer,
  buildWarmupCommand,
  buildSilenceWav,
  VOICE_BACKEND_VALUES,
  VoiceService,
  type ResolvedBackend,
} from './voice-service.js';

describe('resolveBackend', () => {
  it('returns macos-say on darwin with auto', () => {
    const result = resolveBackend('darwin', 'auto');
    expect(result).toEqual({ backend: 'macos-say', bin: 'say' });
  });

  it('returns windows-speech on win32 with auto', () => {
    const result = resolveBackend('win32', 'auto');
    expect(result).toEqual({ backend: 'windows-speech', bin: 'powershell' });
  });

  it('respects explicit backend override', () => {
    const result = resolveBackend('linux', 'espeak-ng');
    expect(result).toEqual({ backend: 'espeak-ng', bin: 'espeak-ng' });
  });

  it('uses availableBins on linux auto', () => {
    const hasBin = (bin: string) => bin === 'espeak-ng';
    const result = resolveBackend('linux', 'auto', hasBin);
    expect(result).toEqual({ backend: 'espeak-ng', bin: 'espeak-ng' });
  });

  it('returns null when no bins available on linux', () => {
    const result = resolveBackend('linux', 'auto', () => false);
    expect(result).toBeNull();
  });

  it('prefers spd-say over espeak-ng on linux', () => {
    const hasBin = (bin: string) => bin === 'spd-say' || bin === 'espeak-ng';
    const result = resolveBackend('linux', 'auto', hasBin);
    expect(result).toEqual({ backend: 'spd-say', bin: 'spd-say' });
  });
});

describe('buildSpeakCommand', () => {
  it('builds macos-say command with voice and rate', () => {
    const resolved: ResolvedBackend = { backend: 'macos-say', bin: 'say' };
    const { bin, args } = buildSpeakCommand(resolved, 'hello world', { voice: 'Alex', rate: 200 });
    expect(bin).toBe('say');
    expect(args).toContain('-v');
    expect(args).toContain('Alex');
    expect(args).toContain('-r');
    expect(args).toContain('200');
    expect(args).toContain('hello world');
  });

  it('builds espeak command', () => {
    const resolved: ResolvedBackend = { backend: 'espeak', bin: 'espeak' };
    const { bin, args } = buildSpeakCommand(resolved, 'test text', { rate: 160 });
    expect(bin).toBe('espeak');
    expect(args).toContain('-s');
    expect(args).toContain('160');
    expect(args).toContain('test text');
  });

  it('builds espeak-ng command with voice', () => {
    const resolved: ResolvedBackend = { backend: 'espeak-ng', bin: 'espeak-ng' };
    const { bin, args } = buildSpeakCommand(resolved, 'hello', { voice: 'en' });
    expect(bin).toBe('espeak-ng');
    expect(args).toContain('-v');
    expect(args).toContain('en');
  });

  it('builds windows-speech powershell command', () => {
    const resolved: ResolvedBackend = { backend: 'windows-speech', bin: 'powershell' };
    const { bin, args } = buildSpeakCommand(resolved, 'hello world');
    expect(bin).toBe('powershell');
    expect(args.some((a) => a.includes('System.Speech'))).toBe(true);
    expect(args.some((a) => a.includes('hello world'))).toBe(true);
  });

  it('escapes single quotes in windows-speech', () => {
    const resolved: ResolvedBackend = { backend: 'windows-speech', bin: 'powershell' };
    const { args } = buildSpeakCommand(resolved, "it's a test");
    expect(args.some((a) => a.includes("it''s a test"))).toBe(true);
  });
});

describe('resolveWarmupPlayer', () => {
  it('returns null on darwin and win32 (no idle-suspend problem)', () => {
    expect(resolveWarmupPlayer('darwin', () => true)).toBeNull();
    expect(resolveWarmupPlayer('win32', () => true)).toBeNull();
  });

  it('returns null on linux when no player is installed', () => {
    expect(resolveWarmupPlayer('linux', () => false)).toBeNull();
  });

  it('prefers pw-play over paplay and aplay on linux', () => {
    expect(resolveWarmupPlayer('linux', () => true)).toBe('pw-play');
  });

  it('falls back to paplay then aplay', () => {
    expect(resolveWarmupPlayer('linux', (b) => b === 'paplay' || b === 'aplay')).toBe('paplay');
    expect(resolveWarmupPlayer('linux', (b) => b === 'aplay')).toBe('aplay');
  });
});

describe('buildWarmupCommand', () => {
  it('passes -q to aplay', () => {
    expect(buildWarmupCommand('aplay', '/tmp/s.wav')).toEqual({
      bin: 'aplay',
      args: ['-q', '/tmp/s.wav'],
    });
  });

  it('plays the wav path directly for pw-play and paplay', () => {
    expect(buildWarmupCommand('pw-play', '/tmp/s.wav')).toEqual({
      bin: 'pw-play',
      args: ['/tmp/s.wav'],
    });
    expect(buildWarmupCommand('paplay', '/tmp/s.wav')).toEqual({
      bin: 'paplay',
      args: ['/tmp/s.wav'],
    });
  });
});

describe('buildSilenceWav', () => {
  it('emits a valid PCM WAV header with the right data length', () => {
    const ms = 100;
    const rate = 48000;
    const channels = 2;
    const buf = buildSilenceWav(ms, rate, channels);
    const expectedData = Math.round((rate * ms) / 1000) * channels * 2;
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.toString('ascii', 36, 40)).toBe('data');
    expect(buf.readUInt32LE(40)).toBe(expectedData); // data chunk size
    expect(buf.readUInt32LE(4)).toBe(36 + expectedData); // RIFF chunk size
    expect(buf.length).toBe(44 + expectedData);
  });

  it('is pure silence (all samples zero)', () => {
    const buf = buildSilenceWav(10);
    expect(buf.subarray(44).every((b) => b === 0)).toBe(true);
  });
});

describe('VOICE_BACKEND_VALUES', () => {
  it('contains all expected backends', () => {
    expect(VOICE_BACKEND_VALUES).toContain('auto');
    expect(VOICE_BACKEND_VALUES).toContain('macos-say');
    expect(VOICE_BACKEND_VALUES).toContain('spd-say');
    expect(VOICE_BACKEND_VALUES).toContain('espeak-ng');
    expect(VOICE_BACKEND_VALUES).toContain('espeak');
    expect(VOICE_BACKEND_VALUES).toContain('windows-speech');
  });
});

describe('VoiceService', () => {
  it('resolves without error when no backend', async () => {
    const svc = new VoiceService(null);
    await expect(svc.speak('hello')).resolves.toBeUndefined();
  });

  it('stop() is a no-op when nothing playing', () => {
    const svc = new VoiceService(null);
    expect(() => svc.stop()).not.toThrow();
  });

  it('backend getter returns null when no backend', () => {
    const svc = new VoiceService(null);
    expect(svc.backend).toBeNull();
  });

  it('backend getter returns resolved backend', () => {
    const resolved: ResolvedBackend = { backend: 'macos-say', bin: 'say' };
    const svc = new VoiceService(resolved);
    expect(svc.backend).toEqual(resolved);
  });

  it('plays the warmup player before the speech backend', async () => {
    spawnCalls.length = 0;
    const resolved: ResolvedBackend = { backend: 'espeak-ng', bin: 'espeak-ng' };
    const svc = new VoiceService(resolved, { player: 'pw-play', ms: 50 });
    await svc.speak('hello');
    expect(spawnCalls.map((c) => c.bin)).toEqual(['pw-play', 'espeak-ng']);
  });

  it('skips warmup when ms is 0', async () => {
    spawnCalls.length = 0;
    const resolved: ResolvedBackend = { backend: 'espeak-ng', bin: 'espeak-ng' };
    const svc = new VoiceService(resolved, { player: 'pw-play', ms: 0 });
    await svc.speak('hello');
    expect(spawnCalls.map((c) => c.bin)).toEqual(['espeak-ng']);
  });

  it('skips warmup when no player resolved', async () => {
    spawnCalls.length = 0;
    const resolved: ResolvedBackend = { backend: 'espeak-ng', bin: 'espeak-ng' };
    const svc = new VoiceService(resolved, { player: null, ms: 400 });
    await svc.speak('hello');
    expect(spawnCalls.map((c) => c.bin)).toEqual(['espeak-ng']);
  });

  it('kills a hung warmup player on the safety timeout, then speaks', async () => {
    vi.useFakeTimers();
    spawnCalls.length = 0;
    killCalls.length = 0;
    mockState.autoClose = false; // warmup player never exits on its own
    try {
      const resolved: ResolvedBackend = { backend: 'espeak-ng', bin: 'espeak-ng' };
      const svc = new VoiceService(resolved, { player: 'pw-play', ms: 50 });
      const p = svc.speak('hello');
      // Only the warmup child has spawned; speech waits on warmup.
      expect(spawnCalls.map((c) => c.bin)).toEqual(['pw-play']);
      // Re-enable auto-close so the speech child resolves once it spawns.
      mockState.autoClose = true;
      // Advance past the safety cap (ms + 1500) to trip the timeout.
      await vi.advanceTimersByTimeAsync(50 + 1500 + 10);
      await p;
      // The hung warmup child was SIGTERM'd so it can't play over the speech.
      expect(killCalls).toContain('pw-play:SIGTERM');
      // Speech still proceeded after the warmup was force-finished.
      expect(spawnCalls.map((c) => c.bin)).toEqual(['pw-play', 'espeak-ng']);
    } finally {
      mockState.autoClose = true;
      vi.useRealTimers();
    }
  });
});
