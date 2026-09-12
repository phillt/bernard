import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

import { WakePanel } from '../WakePanel.js';
import { WAKE_EXCERPT_CHARS } from '../../watchers/wake.js';
import type { WakeData } from '../Thread.js';

/**
 * The panel is now the ONLY render of a wake — `App.tsx` suppresses the user
 * bubble that used to paint the instruction and the whole fenced observation
 * into the transcript seconds later. So what it chooses to show at each detail
 * level is the whole user-facing surface of the feature, and unit tests over
 * props are the cheapest place to pin it.
 *
 * Every case drives the real component from props alone: none of this needs a
 * watcher, a poll or a turn.
 */
function frameOf(data: WakeData, toolDetails: boolean): string {
  const r = render(createElement(WakePanel, { data, toolDetails }));
  const text = stripAnsi(r.lastFrame() ?? '');
  r.unmount();
  return text;
}

const OBSERVED = { bytes: 3277, excerpt: 'a ping from Andie', clipped: true, truncated: false };

describe('WakePanel', () => {
  it('collapses to the first line plus a count and a size', () => {
    const text = frameOf(
      {
        source: 'watcher "beeper-dm"',
        instruction: 'New message in chat 25.\nline two\nline three',
        observation: OBSERVED,
      },
      false,
    );

    expect(text).toContain('⏰ Woken');
    expect(text).toContain('watcher "beeper-dm"');
    expect(text).toContain('New message in chat 25.');
    expect(text).not.toContain('line two');
    expect(text).toContain('2 more instruction lines');
    expect(text).toContain('3.2 KB observed');
    // The excerpt is the half the setting is deciding about.
    expect(text).not.toContain('a ping from Andie');
  });

  it('skips leading blank lines when collapsing, and does not count them', () => {
    // A wake instruction frequently opens with a blank or a heading rule, and a
    // body whose first row is empty reads as a panel that failed to render.
    const text = frameOf(
      { source: 'a watcher', instruction: '\n\nthe real first line\nmore', observation: OBSERVED },
      false,
    );
    expect(text).toContain('the real first line');
    // ONE line is hidden — `more`. Counting every line but the one shown made
    // this say three, re-counting the blanks `findIndex` had just skipped for
    // saying nothing. The case was exercised here before and asserted only on
    // the body, which is how the count went unnoticed.
    expect(text).toContain('1 more instruction line');
    expect(text).not.toContain('3 more instruction lines');
  });

  it('hides nothing for an instruction that is entirely blank', () => {
    // Unreachable from the tool schema, and pinned because the arithmetic makes
    // it the one input where "lines after the one shown" has no shown line to
    // count from: rows exist, none has content, so there is nothing to promise.
    const text = frameOf({ source: 'a watcher', instruction: '\n\n  \n' }, false);
    expect(text).not.toContain('more instruction');
  });

  it('omits the count when there is only one line', () => {
    const text = frameOf({ source: 'a watcher', instruction: 'just this' }, false);
    expect(text).toContain('just this');
    expect(text).not.toContain('more instruction');
    // No observation and nothing hidden: the row is dropped, not rendered
    // empty. A stray `…` on its own line reads as truncated output.
    expect(text).not.toContain('…');
  });

  it('shows a size with no count when a one-line instruction observed something', () => {
    const text = frameOf(
      {
        source: 'a watcher',
        instruction: 'one line',
        observation: { ...OBSERVED, clipped: false },
      },
      false,
    );
    expect(text).toContain('3.2 KB observed');
    expect(text).not.toContain('more instruction');
  });

  it('expands to the whole instruction and a bounded excerpt', () => {
    const text = frameOf(
      { source: 'a watcher', instruction: 'first line\nsecond line', observation: OBSERVED },
      true,
    );

    expect(text).toContain('first line');
    expect(text).toContain('second line');
    expect(text).toContain('↳');
    expect(text).toContain('a ping from Andie');
    expect(text).toContain('3.2 KB observed');
    // `clipped` is what earns the qualifier: without it the reader cannot tell
    // a whole small observation from the front of a large one.
    expect(text).toContain(`showing first ${WAKE_EXCERPT_CHARS}`);
  });

  it('says a size is a floor when the observation was itself truncated', () => {
    // `MAX_OBSERVATION_CHARS` makes `bytes` saturate, so without this a watcher
    // that read a 2 MB page and one that read a 4 KB one report identically —
    // on the surface whose whole job is saying how much is held back.
    const text = frameOf(
      {
        source: 'a watcher',
        instruction: 'x',
        observation: { ...OBSERVED, bytes: 4096, truncated: true },
      },
      false,
    );
    expect(text).toContain('at least 4.0 KB observed');
  });

  it('drops the qualifier when the excerpt IS the observation', () => {
    const text = frameOf(
      {
        source: 'a watcher',
        instruction: 'x',
        observation: { bytes: 40, excerpt: 'all of it', clipped: false },
      },
      true,
    );
    expect(text).toContain('40 B observed');
    expect(text).not.toContain('showing first');
  });

  it('renders no detail row at all for a wake that observed nothing', () => {
    // A `time` watcher — a clock has nothing to observe, and a panel claiming a
    // size for it would be inventing one.
    const text = frameOf({ source: 'a scheduled wake', instruction: 'check the deploy' }, true);
    expect(text).toContain('check the deploy');
    expect(text).not.toContain('observed');
    expect(text).not.toContain('↳');
  });

  it('never takes a chevron', () => {
    // `❯`/`❮` are the transcript's entire voice vocabulary and a woken turn is
    // neither voice — it is the reason Bernard is about to speak.
    const text = frameOf({ source: 'a watcher', instruction: 'do the thing' }, true);
    expect(text).not.toContain('❯');
    expect(text).not.toContain('❮');
    expect(text).toContain('Bernard is acting on this now.');
  });
});
