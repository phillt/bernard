import { spawn, execFileSync, type ChildProcess } from 'node:child_process';

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
  const hasBin = availableBins ?? ((bin: string) => {
    try {
      execFileSync('which', [bin], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });

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

export class VoiceService {
  private _child: ChildProcess | null = null;
  private _resolved: ResolvedBackend | null;

  constructor(resolved: ResolvedBackend | null) {
    this._resolved = resolved;
  }

  get backend(): ResolvedBackend | null {
    return this._resolved;
  }

  speak(text: string, opts?: SpeakOptions): Promise<void> {
    if (!this._resolved) return Promise.resolve();
    this.stop();

    const { bin, args } = buildSpeakCommand(this._resolved, text, opts);

    return new Promise<void>((resolve, reject) => {
      let advanced = false;
      const _advance = (err?: Error) => {
        if (advanced) return;
        advanced = true;
        this._child = null;
        if (err) reject(err);
        else resolve();
      };

      const child = spawn(bin, args, { stdio: 'ignore', detached: false });
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

  stop(): void {
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
