/**
 * How fast Bernard talks, as four named speeds rather than a number nobody can
 * judge without hearing it. A zero-import leaf: `voice-service.ts` (local
 * engines) and the `/voice` menu both read it, and the local engines and the
 * cloud voice measure speed differently.
 *
 * The speed is STORED as `voiceRate` in words per minute, which is what every
 * local engine takes and what `BERNARD_VOICE_RATE` already sets, so nothing on
 * disk moves. `regular` is no rate at all — the engine's own default, which is
 * how Bernard has always sounded. A cloud voice takes a multiplier instead,
 * and ElevenLabs accepts only 0.7–1.2, hence the second column.
 */

export type VoiceSpeedId = 'slow' | 'regular' | 'fast' | 'fastest';

export interface VoiceSpeed {
  id: VoiceSpeedId;
  label: string;
  /** Words per minute for a local engine; undefined leaves its default. */
  wpm: number | undefined;
  /** Multiplier for a cloud voice; 1 is its own pace. ElevenLabs caps it at 1.2. */
  multiplier: number;
  /**
   * A further speed-up applied on this machine, pitch kept, for a cloud voice
   * past what the vendor allows. Needs ffmpeg; without it, 1 is what you get.
   */
  localTempo: number;
}

export const VOICE_SPEEDS: readonly VoiceSpeed[] = [
  // Spaced by ear, not evenly: measured against ElevenLabs, 1.1 made a clip
  // ~5% shorter and was indistinguishable from 1.0, while 1.15 was ~12% and
  // 1.2 (its ceiling) ~27%. Fastest goes past the ceiling locally.
  { id: 'slow', label: 'Slow', wpm: 140, multiplier: 0.8, localTempo: 1 },
  { id: 'regular', label: 'Regular', wpm: undefined, multiplier: 1, localTempo: 1 },
  { id: 'fast', label: 'Fast', wpm: 220, multiplier: 1.15, localTempo: 1 },
  { id: 'fastest', label: 'Fastest', wpm: 270, multiplier: 1.2, localTempo: 1.25 },
];

/** The engines' shared default, which `regular` stands for when a number is needed. */
const DEFAULT_WPM = 180;

/**
 * The named speed nearest a stored rate. A rate typed by hand before speeds
 * had names (or through `BERNARD_VOICE_RATE`) still reads as one of the four.
 */
export function voiceSpeedFor(wpm: number | undefined): VoiceSpeed {
  if (wpm === undefined) return VOICE_SPEEDS[1];
  let best = VOICE_SPEEDS[0];
  for (const s of VOICE_SPEEDS) {
    const d = Math.abs((s.wpm ?? DEFAULT_WPM) - wpm);
    if (d < Math.abs((best.wpm ?? DEFAULT_WPM) - wpm)) best = s;
  }
  return best;
}

/** The on-machine speed-up for a cloud voice, given the stored rate. */
export function localTempoFor(wpm: number | undefined): number {
  return voiceSpeedFor(wpm).localTempo;
}

/** What a cloud voice is asked for, given the stored rate. */
export function cloudSpeedFor(wpm: number | undefined): number {
  return voiceSpeedFor(wpm).multiplier;
}
