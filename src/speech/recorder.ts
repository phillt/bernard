import { spawn, type ChildProcess } from 'node:child_process';
import { defaultHasBin } from '../voice-service.js';
import { errorFields, speechLog } from './log.js';

/** How much of a recorder's stderr is kept for the error and the log. */
const STDERR_TAIL = 500;

/**
 * Microphone capture through a system recorder, the same "probe for a binary"
 * shape `resolveBackend` uses for TTS. No native module: PipeWire and
 * PulseAudio already ship a recorder that writes raw PCM to stdout.
 *
 * Linux only for now. macOS (`rec`/sox) and Windows (ffmpeg) are a row each
 * here when they arrive.
 */

export const RECORDER_PRIORITY = ['pw-record', 'parec', 'arecord'] as const;
export type Recorder = (typeof RECORDER_PRIORITY)[number];

/** What every recorder is asked for: what speech-to-text wants, and small. */
export const RECORD_RATE = 16000;

export function resolveRecorder(
  platform: string,
  hasBin: (bin: string) => boolean = defaultHasBin,
): Recorder | null {
  if (platform !== 'linux') return null;
  return RECORDER_PRIORITY.find((r) => hasBin(r)) ?? null;
}

/** Raw s16le, mono, {@link RECORD_RATE}, on stdout. Pure. */
export function buildRecordCommand(recorder: Recorder): { bin: string; args: string[] } {
  switch (recorder) {
    case 'pw-record':
      return {
        bin: 'pw-record',
        args: ['--rate', String(RECORD_RATE), '--channels', '1', '--format', 's16', '-'],
      };
    case 'parec':
      return {
        bin: 'parec',
        args: ['--raw', `--rate=${RECORD_RATE}`, '--channels=1', '--format=s16le'],
      };
    case 'arecord':
      return {
        bin: 'arecord',
        args: ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(RECORD_RATE), '-c', '1'],
      };
  }
}

export interface MicHandle {
  stop(): void;
}

/**
 * Starts recording and hands each PCM chunk to `onChunk`.
 *
 * stdin is `'ignore'`, never inherited: Ink owns `process.stdin`, and a second
 * reader on it would steal keystrokes (`useRawKeys.ts` explains how). stderr is
 * piped, never inherited, because a recorder's warnings would otherwise land in
 * the frame Ink is drawing.
 */
export function startMic(
  recorder: Recorder,
  onChunk: (pcm: Int16Array) => void,
  onError: (err: Error) => void,
): MicHandle {
  const { bin, args } = buildRecordCommand(recorder);
  // stderr is piped and kept (a tail) because it is where a recorder says WHY
  // it failed; with it ignored, "exited with code 1" is all anyone learns.
  let child: ChildProcess | null = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let carry: Buffer | null = null;
  let stopped = false;
  let stderr = '';
  let bytes = 0;
  const t0 = Date.now();
  speechLog('mic:start', { recorder, bin, args, pid: child.pid ?? null });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    // A chunk boundary can split a sample; carry the odd byte to the next one.
    bytes += chunk.length;
    const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    const even = buf.length & ~1;
    carry = even < buf.length ? buf.subarray(even) : null;
    if (even === 0) return;
    const copy = new Uint8Array(even);
    copy.set(buf.subarray(0, even));
    onChunk(new Int16Array(copy.buffer));
  });
  child.on('error', (err) => {
    speechLog('mic:error', { bin, stopped, ...errorFields(err) });
    if (!stopped) onError(err);
  });
  child.on('close', (code, signal) => {
    const tail = stderr.replace(/\s+/g, ' ').trim();
    speechLog('mic:exit', {
      bin,
      code,
      signal,
      stopped,
      ms: Date.now() - t0,
      bytes,
      ...(tail ? { stderr: tail } : {}),
    });
    // Any exit we did not ask for is a dead mic, code 0 included: a recorder
    // whose source device was unplugged can exit cleanly, and staying silent
    // would leave the hint bar saying "listening" to nothing.
    if (!stopped) {
      const how = code === 0 ? 'stopped on its own' : `exited with code ${code ?? signal}`;
      onError(new Error(`${bin} ${how}${tail ? `: ${tail}` : ''}`));
    }
    child = null;
  });

  return {
    stop() {
      stopped = true;
      try {
        child?.kill('SIGTERM');
      } catch {
        // already gone
      }
      child = null;
    },
  };
}
