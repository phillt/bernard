import { describe, it, expect } from 'vitest';
import { SPEECH_EXAMPLES } from './speech-examples.js';
import {
  toSpeechText,
  reduceUnresolved,
  speechNormalizeSkipReason,
  clampForSpeech,
  toLiteralSpeech,
  codeSentinel,
  SPEECH_MAX_CHARS,
  TRUNCATION_MARKER,
} from './speech-text.js';

describe('toSpeechText — markup', () => {
  it('turns headings into sentences and drops the hashes', () => {
    expect(toSpeechText('## Model catalog').spokenForm).toBe('Model catalog.');
  });

  it('turns list items into sentences and drops the markers', () => {
    expect(toSpeechText('- one\n- two\n1. three').spokenForm).toBe('one.\ntwo.\nthree.');
  });

  it('does not double-punctuate a line that already ends a sentence', () => {
    expect(toSpeechText('- Already done.').spokenForm).toBe('Already done.');
  });

  it('unwraps emphasis and inline code, keeping the contents', () => {
    expect(toSpeechText('**bold**, _em_, ~~gone~~ and `code`').spokenForm).toBe(
      'bold, em, gone and code',
    );
  });

  it('replaces a fenced block with a sentinel and never speaks its contents', () => {
    const out = toSpeechText('Run:\n\n```bash\nrm -rf /tmp/secret\n```\n\nDone.').spokenForm;
    expect(out).toContain('A bash code block, omitted.');
    expect(out).not.toContain('rm -rf');
  });

  it('does not leak the body of an unterminated fence', () => {
    const out = toSpeechText('Here:\n\n```ts\nconst secret = 1;').spokenForm;
    expect(out).not.toContain('const secret');
    expect(out).toContain('A ts code block, omitted.');
  });

  it('keeps a fence with no info string on the bare sentinel', () => {
    expect(codeSentinel()).toBe('Code block omitted.');
    expect(codeSentinel('bash')).toBe('A bash code block, omitted.');
  });

  it('removes citation markers and footnote definitions', () => {
    expect(toSpeechText('Fetched hourly[^S1]. See[^S12].').spokenForm).toBe('Fetched hourly. See.');
  });

  it('reduces a markdown link to its label and tags nothing', () => {
    // The label IS the human-readable referent, so there is no url left to name.
    const t = toSpeechText('See [the guide](https://example.com/a) for details.');
    expect(t.spokenForm).toBe('See the guide for details.');
    expect(t.unresolved).toEqual([]);
  });

  it('drops blockquote markers, horizontal rules, HTML and pictographs', () => {
    const t = toSpeechText('> quoted\n\n---\n\n<br/>ok 🎉');
    expect(t.spokenForm).toBe('quoted\n\nok 🎉');
    // Pictographs survive stage 1 (they carry no line structure risk) and are
    // dropped at the argv gate, which is the one place that must be safe.
    expect(clampForSpeech(t.spokenForm)).toBe('quoted ok');
  });
});

describe('toSpeechText — classes decidable from surface form', () => {
  it('spells a phone number digit by digit and leaves nothing unresolved', () => {
    const t = toSpeechText('Call 206-555-0198 now.');
    expect(t.spokenForm).toBe('Call 2 0 6, 5 5 5, 0 1 9 8 now.');
    expect(t.unresolved).toEqual([]);
  });

  it('moves the currency sigil and keeps the digits for the engine to read', () => {
    expect(toSpeechText('$12.50').spokenForm).toBe('12 dollars and 50 cents');
    expect(toSpeechText('$1').spokenForm).toBe('1 dollar');
    expect(toSpeechText('$1.01').spokenForm).toBe('1 dollars and 1 cent');
  });

  it('does not mis-tag a grouped currency amount as an ambiguous number', () => {
    // The comma is left in place through the tagging scan on purpose — see the
    // ordering note in verbalizeClosedClasses.
    const t = toSpeechText('It cost $1,200 in total.');
    expect(t.spokenForm).toBe('It cost 1200 dollars in total.');
    expect(t.unresolved).toEqual([]);
  });

  it('says an email address', () => {
    expect(toSpeechText('Mail a_b@ex-1.example.com.').spokenForm).toBe(
      'Mail a underscore b at ex dash 1 dot example dot com.',
    );
  });

  it('expands an unambiguous ISO date but leaves an ambiguous slash date', () => {
    expect(toSpeechText('Released 2026-09-02.').spokenForm).toBe('Released September 2, 2026.');
    const slash = toSpeechText('Released 9/2/2026 to everyone.');
    expect(slash.spokenForm).toContain('9/2/2026');
    expect(slash.unresolved).toContain('date');
  });

  it('expands units bound to a digit', () => {
    expect(toSpeechText('250ms, 4GB, 95%, 3.2GHz').spokenForm).toBe(
      '250 milliseconds, 4 gigabytes, 95 percent, 3.2 gigahertz',
    );
  });

  it('expands closed-set abbreviations', () => {
    expect(toSpeechText('Fast, e.g. caching, i.e. speed.').spokenForm).toBe(
      'Fast, for example caching, that is speed.',
    );
  });
});

describe('toSpeechText — what it deliberately leaves for the model', () => {
  it('keeps a URL verbatim and tags it', () => {
    // Reducing it here would leave the model nothing to name, making the LLM
    // layer decoration.
    const t = toSpeechText('See https://www.macrumors.com/guide/m5-max/ now.');
    expect(t.spokenForm).toContain('https://www.macrumors.com/guide/m5-max/');
    expect(t.unresolved).toContain('url');
  });

  it('keeps a table as pipe rows and tags it', () => {
    const t = toSpeechText('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(t.spokenForm).toContain('| a | b |');
    expect(t.unresolved).toContain('table');
  });

  it('never regroups a bare digit run, and tags it instead', () => {
    // The guard that matters: an engine reads `1200` as "one thousand two
    // hundred", which is right for a quantity. A digit-grouping heuristic here
    // would say "one two zero zero".
    const t = toSpeechText('It lists 1,200 models, up from 900 in 2024.');
    expect(t.spokenForm).toBe('It lists 1200 models, up from 900 in 2024.');
    expect(t.unresolved).toContain('number');
  });

  it('tags versions, shas and issue references as identifiers', () => {
    expect(toSpeechText('Fixed in v1.2.0.').unresolved).toContain('identifier');
    expect(toSpeechText('Commit 4f3a91c.').unresolved).toContain('identifier');
    expect(toSpeechText('Closes #432.').unresolved).toContain('identifier');
  });

  it('tags a long path', () => {
    expect(toSpeechText('Edit /home/u/p/src/agent.ts.').unresolved).toContain('path');
  });

  it('does not tag code — the contents are gone, so no model could act on it', () => {
    expect(toSpeechText('```js\nx\n```').unresolved).toEqual([]);
  });
});

describe('toSpeechText — bounds', () => {
  it('returns empty with no tags for empty and whitespace-only input', () => {
    for (const input of ['', '   ', '\n\n\t']) {
      const t = toSpeechText(input);
      expect(t.spokenForm).toBe('');
      expect(t.unresolved).toEqual([]);
      expect(t.truncated).toBe(false);
    }
  });

  it('truncates past the cap with a spoken marker', () => {
    const t = toSpeechText('word '.repeat(2000), { maxChars: 200 });
    expect(t.truncated).toBe(true);
    expect(t.spokenForm.length).toBeLessThanOrEqual(200);
    expect(t.spokenForm.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('leaves ordinary prose alone', () => {
    const plain = 'Done. The tests pass and the build is clean.';
    expect(toSpeechText(plain).spokenForm).toBe(plain);
  });
});

describe('reduceUnresolved', () => {
  it('reduces a URL to its host', () => {
    const t = toSpeechText('See https://www.example.com/a/b?q=1 now.');
    expect(reduceUnresolved(t)).toBe('See example dot com now.');
  });

  it('reads a table as one sentence per row', () => {
    const t = toSpeechText('| Provider | Models |\n| --- | --- |\n| anthropic | 12 |\n| xai | 8 |');
    expect(reduceUnresolved(t)).toBe('Provider: anthropic, Models: 12.\nProvider: xai, Models: 8.');
  });

  it('caps a long table and says how many rows it skipped', () => {
    const rows = Array.from({ length: 15 }, (_, i) => `| r${i} | ${i} |`).join('\n');
    const out = reduceUnresolved(toSpeechText(`| a | b |\n| --- | --- |\n${rows}`));
    expect(out).toContain('…and 10 more rows.');
    expect(out).not.toContain('| r0 |');
  });

  it('reduces a path to its basename', () => {
    const t = toSpeechText('Edit /home/u/p/src/agent.ts now.');
    expect(reduceUnresolved(t)).toBe('Edit agent.ts now.');
  });

  it('leaves an unmarked number untouched', () => {
    const t = toSpeechText('It lists 1200 models.');
    expect(reduceUnresolved(t)).toBe('It lists 1200 models.');
  });
});

describe('speechNormalizeSkipReason', () => {
  it('skips empty input', () => {
    expect(speechNormalizeSkipReason(toSpeechText(''))).toBe('empty');
  });

  it('skips when stage 1 resolved everything', () => {
    const t = toSpeechText('Done. The tests pass and the build is clean, which is good news.');
    expect(t.unresolved).toEqual([]);
    expect(speechNormalizeSkipReason(t)).toBe('nothing-ambiguous');
  });

  it('skips a sub-sentence reply even when something is unresolved', () => {
    expect(speechNormalizeSkipReason(toSpeechText('See 2024.'))).toBe('too-short');
  });

  it('runs the model when something is unresolved and there is enough text', () => {
    const t = toSpeechText(
      'The catalog now lists 1200 models across every provider, up from 900 last year.',
    );
    expect(speechNormalizeSkipReason(t)).toBeNull();
  });
});

describe('clampForSpeech', () => {
  it('flattens newlines and squeezes whitespace', () => {
    expect(clampForSpeech('a.\n\nb.\n  c.')).toBe('a. b. c.');
  });

  it('drops control characters', () => {
    expect(clampForSpeech('a\u0007b\u0000c')).toBe('a b c');
  });

  it('is idempotent', () => {
    const once = clampForSpeech('a.\n\n  b. 🎉');
    expect(clampForSpeech(once)).toBe(once);
  });

  it('hard-caps and marks the cut', () => {
    const out = clampForSpeech('word '.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(SPEECH_MAX_CHARS);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe('toLiteralSpeech matches the shared fixture', () => {
  // `SPEECH_EXAMPLES` is also rendered into the normalizer's few-shot block, so
  // driving the deterministic rows from it here is what keeps the model's
  // examples and this stage's behaviour from drifting apart.
  for (const ex of SPEECH_EXAMPLES.filter((e) => e.layer === 'deterministic')) {
    it(`${ex.semioticClass}: ${ex.writtenForm.slice(0, 40)}`, () => {
      expect(toLiteralSpeech(ex.writtenForm)).toBe(ex.spokenForm);
    });
  }

  it('never emits pipe rows, so the literal path is always speakable', () => {
    const out = toLiteralSpeech('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(out).not.toContain('|');
  });
});

describe('URL boundaries', () => {
  it('does not swallow the sentence-ending period', () => {
    // `…/pricing.` matching through the full stop would delete the period along
    // with the URL, running two sentences into one.
    const t = toSpeechText('Pricing is at https://www.example.com/pricing. Run the build.');
    expect(reduceUnresolved(t)).toBe('Pricing is at example dot com. Run the build.');
  });

  it('does not swallow a trailing comma or closing paren', () => {
    const t = toSpeechText('See https://example.com/a, then stop. (https://example.com/b)');
    const out = reduceUnresolved(t);
    expect(out).toContain('example dot com, then stop.');
    expect(out).not.toContain('https://');
  });
});
