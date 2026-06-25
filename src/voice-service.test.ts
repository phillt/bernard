import { describe, it, expect } from 'vitest';
import {
  resolveBackend,
  buildSpeakCommand,
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
    expect(args.some(a => a.includes('System.Speech'))).toBe(true);
    expect(args.some(a => a.includes('hello world'))).toBe(true);
  });

  it('escapes single quotes in windows-speech', () => {
    const resolved: ResolvedBackend = { backend: 'windows-speech', bin: 'powershell' };
    const { args } = buildSpeakCommand(resolved, "it's a test");
    expect(args.some(a => a.includes("it''s a test"))).toBe(true);
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
});
