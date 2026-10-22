import { describe, it, expect, vi } from 'vitest';
import {
  DictationSession,
  MAX_DICTATION_FAILURES,
  type DictationDeps,
  type DictationState,
} from './dictation.js';

const RATE = 16000;
const tick = () => new Promise((r) => setTimeout(r, 5));
const quiet = () => new Int16Array(RATE * 0.4).fill(10);
const loud = () => new Int16Array(RATE * 0.2).map((_, i) => (i % 2 ? 5000 : -5000));

/**
 * A fake mic whose `say()` plays one utterance into whichever mic is open, on
 * a macrotask as a real recorder's stdout does.
 */
function harness(over: Partial<DictationDeps> = {}) {
  const states: DictationState[] = [];
  const texts: string[] = [];
  let feed: ((pcm: Int16Array) => void) | null = null;
  let opens = 0;
  const deps: DictationDeps = {
    rate: RATE,
    endpointer: {
      endSilenceMs: 60,
      startMs: 30,
      prerollMs: 30,
      noSpeechMs: 600_000,
      minLevel: 100,
    },
    startMic: (onChunk) => {
      opens++;
      feed = onChunk;
      return { stop: () => (feed = null) };
    },
    transcribe: vi.fn(async () => 'hello there'),
    onText: (t) => texts.push(t),
    onState: (s) => states.push(s),
    onError: vi.fn(),
    onEnded: vi.fn(),
    ...over,
  };
  const say = async () => {
    await new Promise((r) => setTimeout(r, 0));
    feed?.(quiet());
    feed?.(loud());
    feed?.(quiet());
    for (let i = 0; i < 3; i++) await tick();
  };
  return { deps, states, texts, say, opens: () => opens, micOpen: () => feed !== null };
}

describe('DictationSession', () => {
  it('hands each utterance over as text and never submits anything', async () => {
    const h = harness();
    const s = new DictationSession(h.deps);
    s.start();
    await h.say();
    await h.say();
    s.stop();
    expect(h.texts).toEqual(['hello there', 'hello there']);
    // One open for the whole session: a pause ends a piece, not the mic.
    expect(h.opens()).toBe(1);
  });

  it('keeps the mic open while a piece is being transcribed', async () => {
    let finish!: (t: string) => void;
    const h = harness({ transcribe: vi.fn(() => new Promise<string>((r) => (finish = r))) });
    const s = new DictationSession(h.deps);
    s.start();
    await h.say();
    expect(h.states).toContain('transcribing');
    expect(h.micOpen()).toBe(true);
    finish('one');
    await tick();
    s.stop();
    expect(h.texts).toEqual(['one']);
  });

  it('delivers pieces in the order they were said, even if a later one returns first', async () => {
    const resolvers: ((t: string) => void)[] = [];
    const h = harness({
      transcribe: vi.fn(() => new Promise<string>((r) => resolvers.push(r))),
    });
    const s = new DictationSession(h.deps);
    s.start();
    await h.say();
    await h.say();
    resolvers[1]('second');
    await tick();
    expect(h.texts).toEqual([]);
    resolvers[0]('first');
    await tick();
    s.stop();
    expect(h.texts).toEqual(['first', 'second']);
  });

  it('drops a cough or a click heard on its own', async () => {
    const h = harness({ transcribe: vi.fn(async () => '[coughs]') });
    const s = new DictationSession(h.deps);
    s.start();
    await h.say();
    s.stop();
    expect(h.texts).toEqual([]);
  });

  it('closes the mic while paused and reopens it on resume', async () => {
    const h = harness();
    const s = new DictationSession(h.deps);
    s.start();
    s.pause();
    expect(h.micOpen()).toBe(false);
    expect(h.states.at(-1)).toBe('paused');
    s.resume();
    expect(h.micOpen()).toBe(true);
    await h.say();
    s.stop();
    expect(h.texts).toEqual(['hello there']);
  });

  it('gives up after repeated transcription failures, saying why', async () => {
    const h = harness({ transcribe: vi.fn(async () => Promise.reject(new Error('401'))) });
    const s = new DictationSession(h.deps);
    s.start();
    for (let i = 0; i < MAX_DICTATION_FAILURES; i++) await h.say();
    expect(h.deps.onEnded).toHaveBeenCalledWith(expect.stringContaining('401'));
    expect(s.active).toBe(false);
  });

  it('delivers nothing after stop', async () => {
    let finish!: (t: string) => void;
    const h = harness({ transcribe: vi.fn(() => new Promise<string>((r) => (finish = r))) });
    const s = new DictationSession(h.deps);
    s.start();
    await h.say();
    s.stop();
    finish('late');
    await tick();
    expect(h.texts).toEqual([]);
    expect(h.deps.onEnded).not.toHaveBeenCalled();
  });

  it('ends when the microphone dies', async () => {
    const h = harness({
      startMic: (_c, onError) => {
        queueMicrotask(() => onError(new Error('pw-record exited with code 1')));
        return { stop: () => undefined };
      },
    });
    new DictationSession(h.deps).start();
    await tick();
    expect(h.deps.onEnded).toHaveBeenCalledWith(expect.stringContaining('pw-record'));
  });
});
