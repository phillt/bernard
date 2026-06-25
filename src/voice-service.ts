import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from './paths.js';

/** Default PATH probe: true when `which <bin>` succeeds. */
function defaultHasBin(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export type VoiceBackend = 'auto' | 'macos-say' | 'spd-say' | 'espeak-ng' | 'espeak' | 'windows-speech';

export const VOICE_BACKEND_VALUES: readonly VoiceBackend[] = [
  'auto',
  'macos-say',
  'spd-say',
  'espeak-ng',
  'espeak',
  'windows-speech',
];

/** Maps each concrete backend to its binary name. */
const BACKEND_BIN: Record<Exclude<VoiceBackend, 'auto'>, string> = {
  'macos-say': 'say',
  'spd-say': 'spd-say',
  'espeak-ng': 'espeak-ng',
  'espeak': 'espeak',
  'windows-speech': 'powershell',
};

export interface SpeakOptions {
  voice?: string;
  rate?: number; // words per minute
}

export interface ResolvedBackend {
  backend: Exclude<VoiceBackend, 'auto'>;
  bin: string;
}

/** Resolve the TTS backend to use given platform and config. */
export function resolveBackend(
  platform: string,
  configBackend: VoiceBackend,
  availableBins?: (bin: string) => boolean,
): ResolvedBackend | null {
  const hasBin = availableBins ?? defaultHasBin;

  if (configBackend !== 'auto') {
    return { backend: configBackend, bin: BACKEND_BIN[configBackend] };
  }

  // auto-detect
  if (platform === 'darwin') {
    return { backend: 'macos-say', bin: 'say' };
  }

  if (platform === 'win32') {
    return { backend: 'windows-speech', bin: 'powershell' };
  }

  // Linux/other: try spd-say, espeak-ng, espeak
  if (hasBin('spd-say')) return { backend: 'spd-say', bin: 'spd-say' };
  if (hasBin('espeak-ng')) return { backend: 'espeak-ng', bin: 'espeak-ng' };
  if (hasBin('espeak')) return { backend: 'espeak', bin: 'espeak' };

  return null;
}

/** Build the command args for the resolved backend. */
export function buildSpeakCommand(
  resolved: ResolvedBackend,
  text: string,
  opts?: SpeakOptions,
): { bin: string; args: string[] } {
  const { backend, bin } = resolved;

  switch (backend) {
    case 'macos-say': {
      const args: string[] = [];
      if (opts?.voice) args.push('-v', opts.voice);
      if (opts?.rate) args.push('-r', String(opts.rate));
      args.push(text);
      return { bin, args };
    }

    case 'spd-say': {
      const args: string[] = [];
      if (opts?.rate) {
        // spd-say rate is -100..100 (percent deviation from default)
        // Convert WPM to rough percent: 180wpm = 0%, each 50wpm ~= 25%
        const pct = Math.round(((opts.rate - 180) / 180) * 100);
        args.push('-r', String(Math.max(-100, Math.min(100, pct))));
      }
      args.push(text);
      return { bin, args };
    }

    case 'espeak-ng':
    case 'espeak': {
      const args: string[] = [];
      if (opts?.voice) args.push('-v', opts.voice);
      if (opts?.rate) args.push('-s', String(opts.rate));
      args.push(text);
      return { bin, args };
    }

    case 'windows-speech': {
      const escaped = text.replace(/'/g, "''");
      const args = [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${opts?.rate ? `$s.Rate = ${Math.round((opts.rate - 180) / 18)};` : ''} $s.Speak('${escaped}')`,
      ];
      return { bin, args };
    }
  }
}

// ── Sink warmup ────────────────────────────────────────────────────────────
// On Linux, PipeWire/PulseAudio suspends idle output sinks; HDMI links power
// down entirely. When speech starts, the device takes a few hundred ms to wake,
// clipping the first words. Playing a brief silent buffer through the same audio
// layer immediately before speaking wakes the sink so no words are lost. macOS
// (CoreAudio) and Windows (WASAPI) keep output devices responsive, so this is
// Linux-only.

/** Playback binaries we'll use to wake the sink, in preference order. */
export const WARMUP_PLAYER_PRIORITY = ['pw-play', 'paplay', 'aplay'] as const;
export type WarmupPlayer = (typeof WARMUP_PLAYER_PRIORITY)[number];

const WARMUP_RATE = 48000;
const WARMUP_CHANNELS = 2;

export interface WarmupConfig {
  /** Playback binary that wakes the sink, or null to disable warmup. */
  player: WarmupPlayer | null;
  /** Silence duration in ms; `<= 0` disables warmup. */
  ms: number;
}

/**
 * Resolve a playback binary used to warm up a suspended audio sink before
 * speaking. Returns null on non-Linux platforms (no suspend problem) or when
 * none of the known players is installed.
 */
export function resolveWarmupPlayer(
  platform: string,
  availableBins?: (bin: string) => boolean,
): WarmupPlayer | null {
  if (platform !== 'linux') return null;
  const hasBin = availableBins ?? defaultHasBin;
  for (const p of WARMUP_PLAYER_PRIORITY) {
    if (hasBin(p)) return p;
  }
  return null;
}

/** Build the command to play a WAV through a warmup player. Pure. */
export function buildWarmupCommand(player: WarmupPlayer, wavPath: string): { bin: string; args: string[] } {
  switch (player) {
    case 'aplay':
      return { bin: 'aplay', args: ['-q', wavPath] };
    case 'pw-play':
    case 'paplay':
      return { bin: player, args: [wavPath] };
  }
}

/** Build a minimal PCM (s16le) WAV buffer of `ms` of silence. Pure. */
export function buildSilenceWav(ms: number, rate = WARMUP_RATE, channels = WARMUP_CHANNELS): Buffer {
  const frames = Math.max(1, Math.round((rate * ms) / 1000));
  const bytesPerFrame = channels * 2; // 16-bit samples
  const dataLen = frames * bytesPerFrame;
  const buf = Buffer.alloc(44 + dataLen); // data region stays zero-filled = silence
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * bytesPerFrame, 28); // byte rate
  buf.writeUInt16LE(bytesPerFrame, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

/** Paths of silent WAVs already materialized this process, keyed by duration. */
const _silenceWavPaths = new Map<number, string>();

/** Write (or reuse a cached) silent WAV of `ms` under the XDG cache dir; returns its path. */
export function ensureSilenceWav(ms: number): string {
  const cached = _silenceWavPaths.get(ms);
  if (cached) return cached;
  const p = join(CACHE_DIR, `tts-warmup-${ms}ms.wav`);
  if (!existsSync(p)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(p, buildSilenceWav(ms));
  }
  _silenceWavPaths.set(ms, p);
  return p;
}

export class VoiceService {
  private _child: ChildProcess | null = null;
  private _resolved: ResolvedBackend | null;
  private _warmup: WarmupConfig | null;
  /** Monotonic utterance counter; bumped by stop() so a warmup that finishes
   *  after a cancel/supersede doesn't go on to speak. */
  private _epoch = 0;

  constructor(resolved: ResolvedBackend | null, warmup?: WarmupConfig | null) {
    this._resolved = resolved;
    this._warmup = warmup ?? null;
  }

  get backend(): ResolvedBackend | null {
    return this._resolved;
  }

  /** The resolved sink-warmup player (or null when warmup is inactive), captured
   *  at construction so callers needn't re-probe PATH. */
  get warmupPlayer(): WarmupPlayer | null {
    return this._warmup?.player ?? null;
  }

  async speak(text: string, opts?: SpeakOptions): Promise<void> {
    if (!this._resolved) return;
    this.stop();
    const epoch = ++this._epoch; // claim this utterance

    await this._runWarmup();
    // If stop() or a newer speak() ran during the warmup, abandon this one.
    if (epoch !== this._epoch) return;

    const { bin, args } = buildSpeakCommand(this._resolved, text, opts);

    return new Promise<void>((resolve, reject) => {
      let advanced = false;
      let child: ChildProcess;
      const _advance = (err?: Error) => {
        if (advanced) return;
        advanced = true;
        if (this._child === child) this._child = null;
        if (err) reject(err);
        else resolve();
      };

      child = spawn(bin, args, { stdio: 'ignore', detached: false });
      // Don't let the child's handle keep the event loop alive — the caller
      // voids this promise, so speech must never block process exit. `stop()`
      // still holds the reference and can SIGTERM it while it's playing.
      child.unref();
      this._child = child;

      child.on('error', (err) => _advance(err));
      child.on('close', (code) => {
        if (code !== 0 && code !== null) {
          _advance(new Error(`TTS process exited with code ${code}`));
        } else {
          _advance();
        }
      });
    });
  }

  /** Play a brief silence through the resolved player to wake a suspended sink.
   *  Best-effort: any failure resolves silently rather than blocking speech. */
  private _runWarmup(): Promise<void> {
    const w = this._warmup;
    if (!w || !w.player || w.ms <= 0) return Promise.resolve();

    let wavPath: string;
    try {
      wavPath = ensureSilenceWav(w.ms);
    } catch {
      return Promise.resolve();
    }
    const { bin, args } = buildWarmupCommand(w.player, wavPath);

    return new Promise<void>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, args, { stdio: 'ignore', detached: false });
      } catch {
        resolve();
        return;
      }
      child.unref();
      this._child = child;

      let advanced = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (advanced) return;
        advanced = true;
        clearTimeout(timer);
        // Kill the player. On the safety-timeout path it's still running, and
        // letting it keep the sink open would play concurrently with speech
        // (EBUSY on exclusive-access ALSA devices); on the normal close path
        // it has already exited, so this is a harmless no-op.
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        if (this._child === child) this._child = null;
        resolve();
      };
      // Safety cap so a hung player can never block speech indefinitely.
      timer = setTimeout(finish, w.ms + 1500);
      timer.unref?.();
      child.on('error', finish);
      child.on('close', finish);
    });
  }

  stop(): void {
    // Invalidate any in-flight utterance (including one awaiting warmup).
    this._epoch++;
    if (this._child) {
      try {
        this._child.kill('SIGTERM');
      } catch {
        // ignore
      }
      this._child = null;
    }
  }
}
