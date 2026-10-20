import { describe, it, expect, vi } from 'vitest';
import {
  TalkSession,
  spokenText,
  MAX_CONSECUTIVE_FAILURES,
  type TalkDeps,
  type TalkState,
} from './conversation.js';

const RATE = 16000;
const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * A fake mic that plays one scripted utterance per open. A mic opened while
 * the loop is `thinking` is the follow-up mic, and stays silent unless
 * `followUps` scripts it.
 */
function harness(over: Partial<TalkDeps> = {}, followUps = 0) {
  const states: TalkState[] = [];
  let opens = 0;
  let open = false;
  let followOpens = 0;
  const deps: TalkDeps = {
    rate: RATE,
    // Tiny windows so a few ms of synthetic audio is a whole utterance.
    endpointer: {
      endSilenceMs: 60,
      startMs: 30,
      prerollMs: 30,
      noSpeechMs: 600_000,
      minLevel: 100,
    },
    startMic: (onChunk) => {
      const quiet = new Int16Array(RATE * 0.4).fill(10);
      const loud = new Int16Array(RATE * 0.2).map((_, i) => (i % 2 ? 5000 : -5000));
      if (states[states.length - 1] === 'thinking') {
        let live = true;
        if (followOpens++ < followUps) {
          setTimeout(() => {
            if (!live) return;
            onChunk(quiet);
            onChunk(loud);
            onChunk(quiet);
          }, 0);
        }
        return { stop: () => (live = false) };
      }
      opens++;
      open = true;
      // A macrotask, and only for the first few opens: a loop that reopens the
      // mic from microtasks alone would starve the test's own ticks.
      if (opens <= 3) {
        setTimeout(() => {
          if (!open) return;
          onChunk(quiet);
          onChunk(loud);
          onChunk(quiet);
        }, 0);
      }
      return { stop: () => (open = false) };
    },
    transcribe: vi.fn(async () => 'what time is it'),
    submit: vi.fn(async () => 'It is noon.'),
    speak: vi.fn(async () => {
      // Half-duplex: the mic is closed while Bernard talks.
      expect(open).toBe(false);
    }),
    onState: (s) => states.push(s),
    onError: vi.fn(),
    onEnded: vi.fn(),
    ...over,
  };
  return { deps, states, opens: () => opens };
}

describe('TalkSession', () => {
  it('runs listen → transcribe → think → speak → listen', async () => {
    const h = harness();
    const s = new TalkSession(h.deps);
    s.start();
    for (let i = 0; i < 5; i++) await tick();
    s.stop();
    expect(h.states.slice(0, 5)).toEqual([
      'listening',
      'transcribing',
      'thinking',
      'speaking',
      'listening',
    ]);
    expect(h.deps.submit).toHaveBeenCalledWith('what time is it');
    expect(h.deps.speak).toHaveBeenCalledWith('It is noon.');
  });

  it('listens again without starting a turn when nothing was understood', async () => {
    const h = harness({ transcribe: vi.fn(async () => '   ') });
    const s = new TalkSession(h.deps);
    s.start();
    for (let i = 0; i < 4; i++) await tick();
    s.stop();
    expect(h.deps.submit).not.toHaveBeenCalled();
    expect(h.opens()).toBeGreaterThan(1);
  });

  it('starts no turn for a cough or a click on its own', async () => {
    const h = harness({ transcribe: vi.fn(async () => '[coughs]') });
    const s = new TalkSession(h.deps);
    s.start();
    for (let i = 0; i < 4; i++) await tick();
    s.stop();
    expect(h.deps.submit).not.toHaveBeenCalled();
    expect(h.opens()).toBeGreaterThan(1);
  });

  it('does not hand a click heard mid-turn to the running turn', async () => {
    let release!: (v: string) => void;
    const followUp = vi.fn(() => true);
    const h = harness(
      {
        transcribe: vi
          .fn()
          .mockResolvedValue('')
          .mockResolvedValueOnce('what time is it')
          .mockResolvedValueOnce('[clicking]'),
        submit: vi.fn(() => new Promise<string>((r) => (release = r))),
        followUp,
      },
      1,
    );
    const s = new TalkSession(h.deps);
    s.start();
    for (let i = 0; i < 5; i++) await tick();
    expect(h.deps.transcribe).toHaveBeenCalledTimes(2);
    release('Noon.');
    for (let i = 0; i < 3; i++) await tick();
    s.stop();
    expect(followUp).not.toHaveBeenCalled();
    // Nor held over to become a turn of its own.
    expect(h.deps.submit).toHaveBeenCalledTimes(1);
  });

  it('gives up after repeated transcription failures, saying why', async () => {
    const h = harness({ transcribe: vi.fn(async () => Promise.reject(new Error('401'))) });
    const s = new TalkSession(h.deps);
    s.start();
    for (let i = 0; i < 10; i++) await tick();
    expect(h.deps.transcribe).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
    expect(h.deps.onEnded).toHaveBeenCalledWith(expect.stringContaining('401'));
    expect(s.active).toBe(false);
  });

  it('a stop mid-turn does not speak or reopen the mic', async () => {
    let release!: (v: string) => void;
    const h = harness({ submit: vi.fn(() => new Promise<string>((r) => (release = r))) });
    const s = new TalkSession(h.deps);
    s.start();
    for (let i = 0; i < 3; i++) await tick();
    const opened = h.opens();
    s.stop();
    release('late reply');
    await tick();
    expect(h.deps.speak).not.toHaveBeenCalled();
    expect(h.opens()).toBe(opened);
    expect(h.deps.onEnded).not.toHaveBeenCalled();
  });

  it('ends when the microphone dies', async () => {
    const h = harness({
      startMic: (_c, onError) => {
        queueMicrotask(() => onError(new Error('pw-record exited with code 1')));
        return { stop: () => undefined };
      },
    });
    new TalkSession(h.deps).start();
    await tick();
    expect(h.deps.onEnded).toHaveBeenCalledWith(expect.stringContaining('pw-record'));
  });

  it('hands something said mid-turn to the running turn', async () => {
    let release!: (v: string) => void;
    const followUp = vi.fn(() => true);
    const h = harness(
      {
        transcribe: vi
          .fn()
          .mockResolvedValue('')
          .mockResolvedValueOnce('what time is it')
          .mockResolvedValueOnce('and in Tokyo'),
        submit: vi.fn(() => new Promise<string>((r) => (release = r))),
        followUp,
      },
      1,
    );
    const s = new TalkSession(h.deps);
    s.start();
    for (let i = 0; i < 5; i++) await tick();
    expect(followUp).toHaveBeenCalledWith('and in Tokyo');
    release('Noon here, 4 a.m. in Tokyo.');
    for (let i = 0; i < 3; i++) await tick();
    s.stop();
    // Delivered, so it is not run again as a turn of its own.
    expect(h.deps.submit).toHaveBeenCalledTimes(1);
    expect(h.deps.speak).toHaveBeenCalledWith('Noon here, 4 a.m. in Tokyo.');
  });

  it('runs a follow-up the turn could not take, after speaking the reply', async () => {
    let release!: (v: string) => void;
    const submit = vi
      .fn()
      .mockResolvedValue(null)
      .mockImplementationOnce(() => new Promise<string>((r) => (release = r)))
      .mockResolvedValueOnce('In Tokyo it is 4 a.m.');
    const h = harness(
      {
        transcribe: vi
          .fn()
          .mockResolvedValue('')
          .mockResolvedValueOnce('what time is it')
          .mockResolvedValueOnce('and in Tokyo'),
        submit,
        followUp: () => false,
      },
      1,
    );
    const s = new TalkSession(h.deps);
    s.start();
    for (let i = 0; i < 5; i++) await tick();
    release('It is noon.');
    for (let i = 0; i < 5; i++) await tick();
    s.stop();
    expect(submit).toHaveBeenNthCalledWith(2, 'and in Tokyo');
    expect(h.deps.speak).toHaveBeenNthCalledWith(1, 'It is noon.');
    expect(h.deps.speak).toHaveBeenNthCalledWith(2, 'In Tokyo it is 4 a.m.');
  });

  it('runs follow-ups handed back by the REPL as the next turn', async () => {
    let release!: (v: string) => void;
    const submit = vi
      .fn()
      .mockResolvedValue(null)
      .mockImplementationOnce(() => new Promise<string>((r) => (release = r)))
      .mockResolvedValueOnce('Done.');
    const h = harness({ submit });
    const s = new TalkSession(h.deps);
    s.start();
    for (let i = 0; i < 3; i++) await tick();
    s.queueFollowUps(['  also check the deploy  ', ' ']);
    release('It is noon.');
    for (let i = 0; i < 5; i++) await tick();
    s.stop();
    expect(submit).toHaveBeenNthCalledWith(2, 'also check the deploy');
  });

  it('closes the follow-up mic before speaking', async () => {
    let followLive = 0;
    const h = harness();
    const inner = h.deps.startMic;
    const states: TalkState[] = [];
    h.deps.onState = (st) => states.push(st);
    h.deps.startMic = (onChunk, onError) => {
      const following = states[states.length - 1] === 'thinking';
      const m = following ? { stop: () => undefined } : inner(onChunk, onError);
      if (following) followLive++;
      return {
        stop: () => {
          if (following) followLive--;
          m.stop();
        },
      };
    };
    h.deps.speak = vi.fn(async () => {
      expect(followLive).toBe(0);
    });
    const s = new TalkSession(h.deps);
    s.start();
    for (let i = 0; i < 5; i++) await tick();
    s.stop();
    expect(h.deps.speak).toHaveBeenCalled();
  });
});

describe('spokenText', () => {
  it.each([
    ['[coughs]', ''],
    ['[clicking] [laughter]', ''],
    ['  [coughs] . ', ''],
    ['[coughs] what time is it', 'what time is it'],
    ['send it [clicking] now', 'send it now'],
    ['meet at 3 (or 4)', 'meet at 3 (or 4)'],
    ['42', '42'],
    ['¿qué hora es?', '¿qué hora es?'],
  ])('%j → %j', (raw, want) => {
    expect(spokenText(raw)).toBe(want);
  });
});
