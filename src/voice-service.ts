import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from './paths.js';
import { clampForSpeech } from './speech-text.js';
import { wavHeader } from './speech/wav.js';
import { buildRawPlayCommand } from './speech/player.js';
import type { Pcm } from './speech/types.js';

/** Default PATH probe: true when `which <bin>` succeeds. */
export function defaultHasBin(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export type VoiceBackend =
  | 'auto'
  | 'macos-say'
  | 'spd-say'
  | 'espeak-ng'
  | 'espeak'
  | 'windows-speech'
  | CloudVoiceBackend;

/**
 * Backends that synthesize over the network and play the result locally. They
 * resolve to a PLAYER rather than a speech binary, and need a `synthesize`
 * handed to {@link VoiceService} — the vendor lives in `src/speech/`, which this
 * leaf does not import.
 */
export type CloudVoiceBackend = 'elevenlabs';
export const CLOUD_VOICE_BACKENDS: readonly CloudVoiceBackend[] = ['elevenlabs'];
export function isCloudVoiceBackend(b: string): b is CloudVoiceBackend {
  return (CLOUD_VOICE_BACKENDS as readonly string[]).includes(b);
}

export const VOICE_BACKEND_VALUES: readonly VoiceBackend[] = [
  'auto',
  'macos-say',
  'spd-say',
  'espeak-ng',
  'espeak',
  'windows-speech',
  ...CLOUD_VOICE_BACKENDS,
];

/** Maps each concrete local backend to its binary name. */
const BACKEND_BIN: Record<Exclude<VoiceBackend, 'auto' | CloudVoiceBackend>, string> = {
  'macos-say': 'say',
  'spd-say': 'spd-say',
  'espeak-ng': 'espeak-ng',
  espeak: 'espeak',
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

  if (isCloudVoiceBackend(configBackend)) {
    // A cloud voice still needs something local to play the audio through.
    const player = resolveWarmupPlayer(platform, hasBin);
    return player ? { backend: configBackend, bin: player } : null;
  }
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
/**
 * Builds the argv for one utterance.
 *
 * The text is passed through `clampForSpeech` here rather than by each caller,
 * because this is the function that does the unsafe thing: the `windows-speech`
 * branch interpolates it into a PowerShell `-Command`, and Windows caps a
 * command line at 32,767 characters — nothing bounded an assistant reply
 * (#432). Leaving the bound to caller etiquette meant a fourth `speak()` site
 * would silently re-open it. `clampForSpeech` is idempotent and imports
 * nothing, so this stays a leaf→leaf edge.
 */
export function buildSpeakCommand(
  resolved: ResolvedBackend,
  rawText: string,
  opts?: SpeakOptions,
): { bin: string; args: string[] } {
  const { backend, bin } = resolved;
  const text = clampForSpeech(rawText);

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

    case 'elevenlabs':
      // Not a command: the audio is synthesized first and piped to a player.
      throw new Error(`${backend} has no speak command; VoiceService plays it as PCM.`);
  }
}

// ── Sink warmup ────────────────────────────────────────────────────────────
// On Linux, PipeWire/PulseAudio suspends idle output sinks; HDMI links power
// down entirely. When speech starts, the device takes a few hundred ms to wake,
// clipping the first words. Playing a brief silent buffer through the same audio
// layer immediately before speaking wakes the sink so no words are lost. macOS
// (CoreAudio) and Windows (WASAPI) keep output devices responsive, so this is
// Linux-only.

/** How long a `prewarm()` stays good for. Under PipeWire's ~5 s suspend timeout. */
const WARMUP_FRESH_MS = 3000;

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
export function buildWarmupCommand(
  player: WarmupPlayer,
  wavPath: string,
): { bin: string; args: string[] } {
  switch (player) {
    case 'aplay':
      return { bin: 'aplay', args: ['-q', wavPath] };
    case 'pw-play':
    case 'paplay':
      return { bin: player, args: [wavPath] };
  }
}

/** Build a minimal PCM (s16le) WAV buffer of `ms` of silence. Pure. */
export function buildSilenceWav(
  ms: number,
  rate = WARMUP_RATE,
  channels = WARMUP_CHANNELS,
): Buffer {
  const frames = Math.max(1, Math.round((rate * ms) / 1000));
  const dataLen = frames * channels * 2; // 16-bit samples
  // The data region stays zero-filled, which is silence.
  return Buffer.concat([wavHeader(dataLen, rate, channels), Buffer.alloc(dataLen)]);
}

/**
 * Write (or reuse) a silent WAV of `ms` under the XDG cache dir; returns its
 * path. The `existsSync` check is re-run on every call (a cheap, OS-cached stat)
 * so a file removed mid-session — by a cache cleaner or `rm`ed `~/.cache` — is
 * transparently recreated rather than handed to the player as a dead path.
 */
export function ensureSilenceWav(ms: number): string {
  const p = join(CACHE_DIR, `tts-warmup-${ms}ms.wav`);
  if (!existsSync(p)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(p, buildSilenceWav(ms));
  }
  return p;
}

/**
 * How one `speak()` ended. A talk loop needs the difference: `finished` means
 * the person has heard the whole reply and it is their turn, `cancelled` means
 * something else took over and the loop must not start listening on its own.
 */
export type SpeakOutcome = 'finished' | 'cancelled';

/** Network synthesis for a cloud backend, supplied by the caller. */
export type Synthesize = (
  text: string,
  opts: { voice?: string; signal: AbortSignal },
) => Promise<Pcm>;

export class VoiceService {
  private _child: ChildProcess | null = null;
  private _synthesize: Synthesize | null;
  private _synthAbort: AbortController | null = null;
  private _resolved: ResolvedBackend | null;
  private _warmup: WarmupConfig | null;
  /** Monotonic utterance counter; bumped by stop() so a warmup that finishes
   *  after a cancel/supersede doesn't go on to speak. */
  private _epoch = 0;
  /** When the sink was last woken, so a `prewarm()` can stand in for `speak()`'s
   *  own warmup instead of the two running back to back. */
  private _warmedAt = 0;

  constructor(
    resolved: ResolvedBackend | null,
    warmup?: WarmupConfig | null,
    synthesize?: Synthesize | null,
  ) {
    this._resolved = resolved;
    this._warmup = warmup ?? null;
    this._synthesize = synthesize ?? null;
  }

  get backend(): ResolvedBackend | null {
    return this._resolved;
  }

  /** The resolved sink-warmup player (or null when warmup is inactive), captured
   *  at construction so callers needn't re-probe PATH. */
  get warmupPlayer(): WarmupPlayer | null {
    return this._warmup?.player ?? null;
  }

  /**
   * Wakes a suspended sink ahead of time, without speaking (#432).
   *
   * Speech used to start the instant a turn ended, so the warmup overlapped
   * nothing and cost what it cost. Now a normalization round trip sits in
   * front of it, and warming afterwards would add the two together — up to
   * 400 ms of extra silence before the first word, every voiced turn. Calling
   * this unawaited alongside the round trip reclaims all of it.
   *
   * Best-effort and fire-and-forget: it claims no epoch, so it never cancels a
   * real utterance, and a `speak()` that arrives while it is still running just
   * does its own warmup.
   */
  prewarm(): void {
    if (!this._resolved) return;
    void this._runWarmup()
      .then(() => {
        this._warmedAt = Date.now();
      })
      .catch(() => {
        // Warmup is best-effort by contract; a failure just means no head start.
      });
  }

  async speak(text: string, opts?: SpeakOptions): Promise<SpeakOutcome> {
    if (!this._resolved) return 'cancelled';
    this.stop();
    const epoch = ++this._epoch; // claim this utterance
    const resolved = this._resolved;

    if (isCloudVoiceBackend(resolved.backend)) {
      return this._speakCloud(resolved.bin as WarmupPlayer, text, opts, epoch);
    }

    // A recent prewarm already woke the sink. The window is deliberately well
    // under PipeWire's ~5 s idle-suspend timeout, so a hit means the device is
    // still awake rather than merely recently-touched.
    if (Date.now() - this._warmedAt > WARMUP_FRESH_MS) {
      await this._runWarmup();
      // If stop() or a newer speak() ran during the warmup, abandon this one.
      if (epoch !== this._epoch) return 'cancelled';
    }

    const { bin, args } = buildSpeakCommand(resolved, text, opts);
    return this._play(bin, args, epoch);
  }

  /**
   * Synthesize over the network, then pipe the PCM to a local player. The sink
   * warmup runs DURING synthesis rather than after it, so it costs nothing.
   */
  private async _speakCloud(
    player: WarmupPlayer,
    text: string,
    opts: SpeakOptions | undefined,
    epoch: number,
  ): Promise<SpeakOutcome> {
    if (!this._synthesize) throw new Error('No speech provider is configured for this backend.');
    const abort = new AbortController();
    this._synthAbort = abort;
    let pcm: Pcm;
    try {
      const warm =
        Date.now() - this._warmedAt > WARMUP_FRESH_MS ? this._runWarmup() : Promise.resolve();
      [pcm] = await Promise.all([
        this._synthesize(clampForSpeech(text), { voice: opts?.voice, signal: abort.signal }),
        warm,
      ]);
    } catch (err) {
      if (epoch !== this._epoch || abort.signal.aborted) return 'cancelled';
      throw err;
    } finally {
      if (this._synthAbort === abort) this._synthAbort = null;
    }
    if (epoch !== this._epoch) return 'cancelled';
    const { bin, args } = buildRawPlayCommand(player, pcm.rate);
    const bytes = Buffer.from(pcm.samples.buffer, pcm.samples.byteOffset, pcm.samples.byteLength);
    return this._play(bin, args, epoch, bytes);
  }

  private _play(bin: string, args: string[], epoch: number, stdin?: Buffer): Promise<SpeakOutcome> {
    return new Promise<SpeakOutcome>((resolve, reject) => {
      let advanced = false;
      const _advance = (err?: Error) => {
        if (advanced) return;
        advanced = true;
        if (this._child === child) this._child = null;
        // A kill from stop() is a cancel, not a failure.
        if (epoch !== this._epoch) resolve('cancelled');
        else if (err) reject(err);
        else resolve('finished');
      };

      // stderr is kept (a tail) so a failure says what the player said, not
      // only its exit code — a bad voice name or a missing sink lives there.
      const child = spawn(bin, args, {
        stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'],
        detached: false,
      });
      let stderr = '';
      // A piped stream is its own handle; unref it too, or reading stderr
      // would hold the process open where `child.unref()` promises it won't.
      (child.stderr as { unref?: () => void } | null)?.unref?.();
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-500);
      });
      // Don't let the child's handle keep the event loop alive — the caller
      // voids this promise, so speech must never block process exit. `stop()`
      // still holds the reference and can SIGTERM it while it's playing.
      child.unref();
      this._child = child;

      if (stdin && child.stdin) {
        // EPIPE when the player is killed mid-write is a cancel, not a crash.
        child.stdin.on('error', () => undefined);
        child.stdin.end(stdin);
      }

      child.on('error', (err) => _advance(err));
      child.on('close', (code) => {
        if (code !== 0 && code !== null) {
          const tail = stderr.replace(/\s+/g, ' ').trim();
          _advance(new Error(`${bin} exited with code ${code}${tail ? `: ${tail}` : ''}`));
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
    if (!w?.player || w.ms <= 0) return Promise.resolve();

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
      const timer = setTimeout(finish, w.ms + 1500);
      timer.unref?.();
      child.on('error', finish);
      child.on('close', finish);
    });
  }

  stop(): void {
    // Invalidate any in-flight utterance (including one awaiting warmup).
    this._epoch++;
    this._synthAbort?.abort();
    this._synthAbort = null;
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
