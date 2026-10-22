/**
 * How a cloud voice is tuned — ElevenLabs' `voice_settings`, by Bernard's
 * names. A zero-import leaf because `config.ts` parses it and the vendor
 * module and `/voice` both read it.
 *
 * Every field is optional, and absent means "the voice's own": each voice in
 * an ElevenLabs library carries its own stored settings, and a field left
 * unset here is filled from those rather than from a Bernard default.
 */
export interface VoiceTuning {
  /** 0–1. Low is more expressive and varied; high is steadier and flatter. */
  stability?: number;
  /** 0–1. How closely it holds to the original voice. */
  similarity?: number;
  /** 0–1. Exaggerates the voice's style; costs latency above zero. */
  style?: number;
  /** Boosts likeness to the original speaker; costs a little latency. */
  speakerBoost?: boolean;
}

export type TuningField = keyof VoiceTuning;

export interface TuningChoice {
  label: string;
  /** Undefined is "the voice's own". */
  value: number | boolean | undefined;
}

/**
 * The choices `/voice` offers per field. Named steps rather than a 0–1 number,
 * for the reason speed is: a number nobody can judge without hearing it is not
 * a choice. "Voice default" is first in every list, so leaving a field alone
 * is always one keystroke away.
 */
export const TUNING_FIELDS: readonly {
  field: TuningField;
  label: string;
  description: string;
  choices: readonly TuningChoice[];
}[] = [
  {
    field: 'stability',
    label: 'Stability',
    description:
      'Low sounds more expressive and changes from line to line; high is steadier and flatter.',
    choices: [
      { label: 'Voice default', value: undefined },
      { label: 'Expressive', value: 0.3 },
      { label: 'Balanced', value: 0.5 },
      { label: 'Steady', value: 0.8 },
    ],
  },
  {
    field: 'similarity',
    label: 'Similarity',
    description: 'How closely it sticks to the original voice. Too high can carry its artefacts.',
    choices: [
      { label: 'Voice default', value: undefined },
      { label: 'Loose', value: 0.5 },
      { label: 'Close', value: 0.75 },
      { label: 'Very close', value: 0.95 },
    ],
  },
  {
    field: 'style',
    label: 'Style',
    description: 'Exaggerates the voice’s character. Anything above none answers a little slower.',
    choices: [
      { label: 'Voice default', value: undefined },
      { label: 'None', value: 0 },
      { label: 'Some', value: 0.3 },
      { label: 'Strong', value: 0.6 },
    ],
  },
  {
    field: 'speakerBoost',
    label: 'Speaker boost',
    description: 'Sharpens likeness to the original speaker, for a little latency.',
    choices: [
      { label: 'Voice default', value: undefined },
      { label: 'On', value: true },
      { label: 'Off', value: false },
    ],
  },
];

/** The label of a field's current value; a value set by hand reads as itself. */
export function tuningLabel(field: TuningField, tuning: VoiceTuning | undefined): string {
  const value = tuning?.[field];
  const spec = TUNING_FIELDS.find((f) => f.field === field);
  const hit = spec?.choices.find((c) => c.value === value);
  if (hit) return hit.label;
  return String(value);
}

/** Validates a stored value, dropping anything out of range rather than trusting it. */
export function parseVoiceTuning(raw: unknown): VoiceTuning | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const unit = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
  const out: VoiceTuning = {};
  const stability = unit(r.stability);
  const similarity = unit(r.similarity);
  const style = unit(r.style);
  if (stability !== undefined) out.stability = stability;
  if (similarity !== undefined) out.similarity = similarity;
  if (style !== undefined) out.style = style;
  if (typeof r.speakerBoost === 'boolean') out.speakerBoost = r.speakerBoost;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** True when nothing is set, i.e. the voice speaks as stored. */
export function isUntuned(tuning: VoiceTuning | undefined): boolean {
  return !tuning || Object.values(tuning).every((v) => v === undefined);
}
