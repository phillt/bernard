import type { SemioticClass } from './speech-text.js';

/**
 * The written→spoken fixture for speech text normalization (#432).
 *
 * **This is a prompt input, not only test data.** Every row is rendered into
 * {@link ../speech-normalizer.js}'s few-shot block, so editing this table moves
 * the model's behaviour — not just an assertion. Treat a change here the way you
 * would treat a change to a system prompt.
 *
 * It has two consumers on purpose. `speech-normalizer.ts` renders all of it to
 * teach the model; `speech-text.test.ts` drives the `layer: 'deterministic'`
 * rows as its expectation table. So a class the deterministic stage claims is
 * pinned by the same fixture the model is taught from, and the two cannot drift
 * into contradicting each other about what `$12.50` should sound like.
 *
 * `avoid` carries the failure mode by name. Showing a small model the wrong
 * reading alongside the right one is what stops it reverting to the wrong one —
 * and every `avoid` here is a reading that was actually observed or is the
 * documented default behaviour of a TTS engine given the written form.
 */
export interface SpeechExample {
  semioticClass: SemioticClass;
  /** The written (orthographic) form, as it appears on screen. */
  writtenForm: string;
  /** The spoken form a person would say aloud. */
  spokenForm: string;
  /** A wrong reading worth showing the model explicitly. */
  avoid?: string;
  /**
   * Which layer owns this class. `'deterministic'` rows are decidable from
   * surface form and are resolved by `speech-text.ts` with no model involved;
   * `'llm'` rows need a semantic judgement.
   */
  layer: 'deterministic' | 'llm';
}

export const SPEECH_EXAMPLES: readonly SpeechExample[] = [
  // ── Decidable from surface form: handled in speech-text.ts ──────────────
  {
    semioticClass: 'phone',
    writtenForm: 'Call 206-555-0198 for support.',
    spokenForm: 'Call 2 0 6, 5 5 5, 0 1 9 8 for support.',
    avoid: 'Call two hundred six million, five hundred fifty-five thousand…',
    layer: 'deterministic',
  },
  {
    semioticClass: 'currency',
    writtenForm: 'The total came to $12.50.',
    spokenForm: 'The total came to 12 dollars and 50 cents.',
    avoid: 'The total came to dollar twelve point five zero.',
    layer: 'deterministic',
  },
  {
    semioticClass: 'email',
    writtenForm: 'Email support@example.com.',
    spokenForm: 'Email support at example dot com.',
    avoid: 'Email support at-sign example dot c o m.',
    layer: 'deterministic',
  },
  {
    semioticClass: 'date',
    writtenForm: 'Released 2026-09-02.',
    spokenForm: 'Released September 2, 2026.',
    avoid: 'Released two thousand twenty-six dash zero nine dash zero two.',
    layer: 'deterministic',
  },
  {
    semioticClass: 'measurement',
    writtenForm: 'It finished in 250ms and used 4GB.',
    spokenForm: 'It finished in 250 milliseconds and used 4 gigabytes.',
    avoid: 'It finished in two hundred fifty m s and used four G B.',
    layer: 'deterministic',
  },
  {
    semioticClass: 'code',
    writtenForm: 'Run this:\n\n```bash\nnpm run build && npm link\n```',
    spokenForm: 'Run this: A bash code block, omitted.',
    avoid: 'Run this: backtick backtick backtick bash n p m space run space build…',
    layer: 'deterministic',
  },

  // ── Needs a semantic judgement: handled by the model ────────────────────
  {
    semioticClass: 'url',
    writtenForm: 'See https://www.macrumors.com/guide/m5-max-vs-m5-ultra/ for the comparison.',
    spokenForm: 'See the Mac Rumors guide comparing the M5 Max and M5 Ultra.',
    avoid: 'See h t t p s colon slash slash w w w dot m a c r u m o r s dot com slash…',
    layer: 'llm',
  },
  {
    semioticClass: 'number',
    writtenForm: 'The catalog now lists 1,200 models, up from 900 in 2024.',
    spokenForm:
      'The catalog now lists twelve hundred models, up from nine hundred in twenty twenty-four.',
    avoid: 'up from nine hundred in two thousand and twenty-four',
    layer: 'llm',
  },
  {
    semioticClass: 'identifier',
    writtenForm: 'Fixed in v1.2.0, commit 4f3a91c.',
    spokenForm: 'Fixed in version one point two point zero, commit 4 f 3 a 9 1 c.',
    avoid: 'Fixed in v one point two million, commit four f three a ninety-one c.',
    layer: 'llm',
  },
  {
    semioticClass: 'table',
    writtenForm:
      '| Provider | Models |\n| --- | --- |\n| anthropic | 12 |\n| openai | 34 |\n| xai | 8 |',
    spokenForm: 'Three providers: anthropic with 12 models, openai with 34, and xai with 8.',
    avoid: 'pipe Provider pipe Models pipe, pipe dash dash dash pipe…',
    layer: 'llm',
  },
  {
    semioticClass: 'path',
    writtenForm: 'The change is in /home/user/projects/bernard/src/agent.ts.',
    spokenForm: 'The change is in agent dot t s.',
    avoid: 'The change is in slash home slash user slash projects slash bernard slash…',
    layer: 'llm',
  },
];
