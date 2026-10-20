import type { WarmupPlayer } from '../voice-service.js';

/**
 * The command that plays raw mono s16le PCM from stdin. Pure, so each player's
 * flag spelling is pinned by a test rather than discovered at the speaker.
 * The players are the ones sink warmup already resolves, which is what keeps
 * cloud speech free of an mp3 decoder.
 */
export function buildRawPlayCommand(
  player: WarmupPlayer,
  rate: number,
): { bin: string; args: string[] } {
  switch (player) {
    case 'pw-play':
      return {
        bin: 'pw-play',
        args: ['--rate', String(rate), '--channels', '1', '--format', 's16', '-'],
      };
    case 'paplay':
      return {
        bin: 'paplay',
        args: ['--raw', `--rate=${rate}`, '--channels=1', '--format=s16le'],
      };
    case 'aplay':
      return {
        bin: 'aplay',
        args: ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(rate), '-c', '1'],
      };
  }
}
