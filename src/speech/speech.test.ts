import { describe, it, expect, vi } from 'vitest';
import { pcmToWav } from './wav.js';
import { buildSilenceWav } from '../voice-service.js';
import { buildRawPlayCommand } from './player.js';
import { buildRecordCommand, resolveRecorder, RECORD_RATE } from './recorder.js';
import { Endpointer } from './endpointer.js';
import {
  synthesize,
  transcribe,
  listVoices,
  clearElevenLabsCache,
  ELEVENLABS_DEFAULT_VOICE,
} from './elevenlabs.js';
import { SpeechProviderError } from './types.js';

const RATE = 16000;
const FRAME = (RATE * 30) / 1000;

function silence(ms: number, level = 50): Int16Array {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = (i % 2 ? 1 : -1) * level;
  return out;
}
function tone(ms: number, amp = 6000): Int16Array {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / RATE));
  return out;
}
function feed(e: Endpointer, ...parts: Int16Array[]) {
  return parts.flatMap((p) => e.push(p));
}

describe('pcmToWav', () => {
  it('writes the same header the warmup silence always used', () => {
    const wav = buildSilenceWav(10, 48000, 2);
    const frames = Math.round((48000 * 10) / 1000);
    expect(pcmToWav(new Int16Array(frames * 2), 48000, 2).equals(wav)).toBe(true);
  });

  it('carries the samples after a 44-byte header', () => {
    const wav = pcmToWav(Int16Array.from([1, -1]), RATE);
    expect(wav.length).toBe(48);
    expect(wav.readInt16LE(44)).toBe(1);
    expect(wav.readInt16LE(46)).toBe(-1);
    expect(wav.readUInt32LE(24)).toBe(RATE);
  });
});

describe('command builders', () => {
  it('plays raw mono s16le from stdin on every player', () => {
    expect(buildRawPlayCommand('pw-play', 22050).args).toEqual([
      '--rate',
      '22050',
      '--channels',
      '1',
      '--format',
      's16',
      '-',
    ]);
    expect(buildRawPlayCommand('paplay', 22050).args).toContain('--raw');
    expect(buildRawPlayCommand('aplay', 22050).args).toEqual([
      '-q',
      '-t',
      'raw',
      '-f',
      'S16_LE',
      '-r',
      '22050',
      '-c',
      '1',
    ]);
  });

  it('records 16 kHz mono s16le on every recorder', () => {
    for (const r of ['pw-record', 'parec', 'arecord'] as const) {
      const { bin, args } = buildRecordCommand(r);
      expect(bin).toBe(r);
      expect(args.join(' ')).toContain(String(RECORD_RATE));
    }
  });

  it('resolves recorders in priority order, Linux only', () => {
    expect(resolveRecorder('linux', (b) => b === 'arecord' || b === 'parec')).toBe('parec');
    expect(resolveRecorder('linux', () => false)).toBeNull();
    expect(resolveRecorder('darwin', () => true)).toBeNull();
  });
});

describe('Endpointer', () => {
  it('emits one utterance after speech followed by enough silence', () => {
    const e = new Endpointer({ rate: RATE });
    const events = feed(e, silence(400), tone(600), silence(1000));
    expect(events.map((x) => x.type)).toEqual(['speech-start', 'utterance']);
    const utt = events[1];
    if (utt.type !== 'utterance') throw new Error('expected utterance');
    // Includes preroll and the speech, not the calibration window's start.
    expect(utt.samples.length).toBeGreaterThan(tone(600).length);
    expect(utt.samples.length).toBeLessThan(RATE * 2);
  });

  it('keeps listening through a pause shorter than the end silence', () => {
    const e = new Endpointer({ rate: RATE });
    const events = feed(e, silence(400), tone(400), silence(400), tone(400));
    expect(events.map((x) => x.type)).toEqual(['speech-start']);
  });

  it('ignores a click shorter than the start window', () => {
    const e = new Endpointer({ rate: RATE });
    expect(feed(e, silence(400), tone(30), silence(1500))).toEqual([]);
  });

  it('a loud steady room raises the bar rather than reading as speech', () => {
    const e = new Endpointer({ rate: RATE });
    // Hum at ~2000 RMS, calibrated as the floor: never 3x louder than itself.
    expect(feed(e, silence(3000, 2000))).toEqual([]);
  });

  it('cuts an utterance at the maximum length', () => {
    const e = new Endpointer({ rate: RATE, maxUtteranceMs: 900 });
    const types = feed(e, silence(400), tone(2000)).map((x) => x.type);
    expect(types).toContain('utterance');
  });

  it('says no-speech after a long silence', () => {
    const e = new Endpointer({ rate: RATE, noSpeechMs: 600 });
    expect(feed(e, silence(1200)).map((x) => x.type)).toContain('no-speech');
  });

  it('frames chunks of any size identically', () => {
    const whole = new Endpointer({ rate: RATE });
    const split = new Endpointer({ rate: RATE });
    const audio = new Int16Array([...silence(400), ...tone(600), ...silence(1000)]);
    const a = whole.push(audio).map((x) => x.type);
    const b: string[] = [];
    for (let i = 0; i < audio.length; i += FRAME - 7) {
      b.push(...split.push(audio.subarray(i, i + FRAME - 7)).map((x) => x.type));
    }
    expect(b).toEqual(a);
  });
});

describe('ElevenLabs client', () => {
  it('asks for raw PCM with the key header and the default voice', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 0, 2, 0, 9])));
    const pcm = await synthesize('hi', 'k', {}, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE}`);
    expect(url).toContain('output_format=pcm_22050');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('k');
    expect(JSON.parse(init.body as string).text).toBe('hi');
    // The odd trailing byte is dropped, not read as half a sample.
    expect(Array.from(pcm.samples)).toEqual([1, 2]);
    expect(pcm.rate).toBe(22050);
  });

  it('uploads a WAV and returns the transcript', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ text: '  hello there ' }));
    const text = await transcribe(
      { samples: new Int16Array(160), rate: RATE },
      'k',
      {},
      fetchImpl as unknown as typeof fetch,
    );
    expect(text).toBe('hello there');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/speech-to-text$/);
    const form = init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v1');
    expect(form.get('tag_audio_events')).toBe('false');
    expect((form.get('file') as Blob).type).toBe('audio/wav');
  });

  it("surfaces the vendor's own reason, not just the status", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"detail":{"status":"invalid_api_key"}}', { status: 401 }),
    );
    const err = await synthesize('hi', 'bad', {}, fetchImpl as unknown as typeof fetch).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SpeechProviderError);
    expect(err.message).toContain('401');
    expect(err.message).toContain('invalid_api_key');
  });

  it('passes the abort signal through', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ text: '' }));
    const ac = new AbortController();
    await transcribe(
      { samples: new Int16Array(2), rate: RATE },
      'k',
      { signal: ac.signal },
      fetchImpl as unknown as typeof fetch,
    );
    const sent = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    expect(sent.aborted).toBe(false);
    ac.abort();
    expect(sent.aborted).toBe(true);
  });

  it('gives up on a request that never answers, saying it timed out', async () => {
    // Answers only by rejecting when its signal fires, like a stalled socket.
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_r, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    const err = await transcribe(
      { samples: new Int16Array(2), rate: RATE },
      'k',
      { timeoutMs: 20 },
      fetchImpl as unknown as typeof fetch,
    ).catch((e: Error) => e);
    expect((err as Error).message).toContain('timed out');
  });

  it('keeps Esc an abort rather than reporting it as a timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_r, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    const ac = new AbortController();
    const p = transcribe(
      { samples: new Int16Array(2), rate: RATE },
      'k',
      { signal: ac.signal, timeoutMs: 10_000 },
      fetchImpl as unknown as typeof fetch,
    ).catch((e: Error) => e);
    ac.abort();
    expect(((await p) as Error).message).not.toContain('timed out');
  });

  it('sends no voice settings, and reads none, at the voice’s own pace and tuning', async () => {
    clearElevenLabsCache();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 0])));
    await synthesize('hi', 'k', { speed: 1 }, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).voice_settings).toBeUndefined();
  });

  it('merges speed and tuning onto the voice’s stored settings', async () => {
    clearElevenLabsCache();
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/settings')
        ? Response.json({
            stability: 0.4,
            similarity_boost: 0.8,
            style: 0,
            use_speaker_boost: true,
          })
        : new Response(new Uint8Array([1, 0])),
    );
    await synthesize(
      'hi',
      'k',
      { speed: 1.5, tuning: { stability: 0.9 } },
      fetchImpl as unknown as typeof fetch,
    );
    const post = fetchImpl.mock.calls.find(([u]) => (u as string).includes('/text-to-speech/'));
    const sent = JSON.parse((post as unknown as [string, RequestInit])[1].body as string);
    // The tuned field wins, the rest is the voice's own, and the speed is
    // clamped to ElevenLabs' accepted range rather than refused.
    expect(sent.voice_settings).toEqual({
      stability: 0.9,
      similarity_boost: 0.8,
      style: 0,
      use_speaker_boost: true,
      speed: 1.2,
    });
  });

  it('still speaks, with only what was asked, when the stored settings cannot be read', async () => {
    clearElevenLabsCache();
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/settings')
        ? new Response('{"detail":{"status":"missing_permissions"}}', { status: 401 })
        : new Response(new Uint8Array([1, 0])),
    );
    await synthesize('hi', 'k', { tuning: { style: 0.3 } }, fetchImpl as unknown as typeof fetch);
    const post = fetchImpl.mock.calls.find(([u]) => (u as string).includes('/text-to-speech/'));
    const sent = JSON.parse((post as unknown as [string, RequestInit])[1].body as string);
    expect(sent.voice_settings).toEqual({ style: 0.3 });
  });

  it('reads a voice’s stored settings once per account, not once per voice id', async () => {
    clearElevenLabsCache();
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/settings')
        ? Response.json({ stability: 0.4 })
        : new Response(new Uint8Array([1, 0])),
    );
    const opts = { tuning: { style: 0.3 } };
    await synthesize('a', 'key-one', opts, fetchImpl as unknown as typeof fetch);
    await synthesize('b', 'key-one', opts, fetchImpl as unknown as typeof fetch);
    await synthesize('c', 'key-two', opts, fetchImpl as unknown as typeof fetch);
    const reads = fetchImpl.mock.calls.filter(([u]) => (u as string).endsWith('/settings'));
    expect(reads).toHaveLength(2);
  });

  it('lists voices with their traits, skipping malformed entries', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        voices: [
          {
            voice_id: 'abc',
            name: 'Rachel',
            category: 'premade',
            labels: { accent: 'american', gender: 'female', use_case: 'narration' },
          },
          { name: 'no id' },
        ],
      }),
    );
    const voices = await listVoices('k', fetchImpl as unknown as typeof fetch);
    expect(voices).toEqual([
      {
        id: 'abc',
        name: 'Rachel',
        traits: ['american', 'female', 'narration'],
        category: 'premade',
      },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/voices$/);
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('k');
  });

  it('says which permission a restricted key lacks when listing voices', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"detail":{"status":"missing_permissions"}}', { status: 401 }),
    );
    const err = await listVoices('k', fetchImpl as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(SpeechProviderError);
    expect(err.message).toContain('missing_permissions');
  });

  it.each([
    ['Daniel', ELEVENLABS_DEFAULT_VOICE],
    ['en-us+f3', ELEVENLABS_DEFAULT_VOICE],
    ['  ', ELEVENLABS_DEFAULT_VOICE],
    ['21m00Tcm4TlvDq8ikWAM', '21m00Tcm4TlvDq8ikWAM'],
  ])('sends voice %j as %j', async (voice, want) => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 0])));
    await synthesize('hi', 'k', { voice }, fetchImpl as unknown as typeof fetch);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain(`/v1/text-to-speech/${want}?`);
  });
});
