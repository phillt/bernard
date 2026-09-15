import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { Box, Text } from 'ink';
import { ErrorPanel } from '../ErrorPanel.js';
import { NoticePanel } from '../NoticePanel.js';
import { WakePanel } from '../WakePanel.js';
import { hasPresentationChoice, presentationAmbiguousGlyphs } from '../glyph-width.js';
import { PlanPanel } from '../PlanPanel.js';
import { PlanStore } from '../../plan-store.js';
import type { Agent } from '../../agent.js';
import { tick } from './_keys.js';

const WIDTH = 60;
/** Long enough to push the box to the frame's full width, which is the only
 *  place the defect is visible — below that the odd column lands in slack. */
const LONG = 'Reply with exactly one sentence naming the branch and how many files changed.';

async function frameWidths(node: React.ReactElement): Promise<number[]> {
  const { lastFrame } = render(createElement(Box, { flexDirection: 'column', width: WIDTH }, node));
  await tick();
  return stripAnsi(lastFrame() ?? '')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => stringWidth(l));
}

/**
 * A bordered panel's rows all have the same width (#462, found in review).
 *
 * Every `TranscriptPanel` caller used to lead its title with an emoji glyph, and
 * each of those made the header row one column wider than the rest — so the
 * right border wrapped and the corner was lost. `stripAnsi(...).length` is blind
 * to it, because the glyph is one code unit and two columns; only `stringWidth`
 * sees it, which is why nothing caught it for months.
 */
describe('a bordered panel renders a square frame', () => {
  const cases: Array<[string, React.ReactElement]> = [
    [
      'WakePanel',
      createElement(WakePanel, {
        data: { source: 'sent by claude', instruction: LONG },
        toolDetails: false,
      }),
    ],
    [
      'NoticePanel',
      createElement(NoticePanel, {
        data: { sourceKind: 'cli', sourceLabel: 'ci', text: LONG, receivedAt: Date.now() },
      }),
    ],
    [
      'ErrorPanel',
      createElement(ErrorPanel, { data: { title: 'Something failed', message: LONG } }),
    ],
  ];

  it.each(cases)('%s', async (_name, node) => {
    const widths = await frameWidths(node);
    expect(widths.length).toBeGreaterThan(3);
    // Every row, not "the widest is 60": a row one column SHORT leaves a gap
    // before the border, which is the other way this goes wrong — and is exactly
    // what the first attempt at a fix produced on a real terminal.
    expect([...new Set(widths)]).toEqual([WIDTH]);
  });
});

/**
 * The rule the panels have to keep, checked against their real titles.
 *
 * A refusal rather than a repair: the disagreement is between Ink and the
 * terminal about a character's presentation, and neither is ours to settle — so
 * a transformation can only choose which way the frame breaks. What we control
 * is whether such a character reaches a frame at all.
 */
describe('no bordered title carries a glyph whose width is a presentation choice', () => {
  // The rendered header of each panel, which is what a reader actually meets —
  // asserting on the source strings would pass while a title assembled at
  // runtime smuggled one in.
  async function headerRow(node: React.ReactElement): Promise<string> {
    const { lastFrame } = render(
      createElement(Box, { flexDirection: 'column', width: WIDTH }, node),
    );
    await tick();
    return stripAnsi(lastFrame() ?? '').split('\n')[1] ?? '';
  }

  it.each([
    [
      'WakePanel',
      createElement(WakePanel, {
        data: { source: 'sent by ci', instruction: 'x' },
        toolDetails: false,
      }),
    ],
    [
      'NoticePanel',
      createElement(NoticePanel, {
        data: { sourceKind: 'cli', sourceLabel: 'ci', text: 'x', receivedAt: 0 },
      }),
    ],
    ['ErrorPanel', createElement(ErrorPanel, { data: { title: 'Nope', message: 'x' } })],
  ])('%s', async (_name, node) => {
    expect(presentationAmbiguousGlyphs(await headerRow(node))).toEqual([]);
  });
});

describe('hasPresentationChoice', () => {
  it.each([['⏰'], ['✉'], ['⚠'], ['⏹'], ['✔'], ['⚙'], ['ℹ']])(
    'flags %s — two columns, one code unit, and classified as emoji',
    (glyph) => {
      expect(hasPresentationChoice(glyph)).toBe(true);
    },
  );

  it.each([['漢'], ['字'], ['ア'], ['한'], ['😀'], ['✓'], ['»'], ['◷'], ['▲'], ['A']])(
    'leaves %s alone',
    (glyph) => {
      // Each excluded by a DIFFERENT condition, which is why all three are
      // load-bearing: CJK is two columns with no presentation choice, `😀` is a
      // surrogate pair that lays out correctly, and the rest are one column.
      expect(hasPresentationChoice(glyph)).toBe(false);
    },
  );

  it('holds for the plan panel, inside the prompt border', async () => {
    // The one bordered box on screen at all times, and the fixture the first
    // cut of this test lacked: `PlanPanel`'s done-step icon was `✔` — flagged by
    // this module's own predicate — so the PROMPT's border broke the moment a
    // step completed. `glyph-width.ts` said as much and fixed three titles.
    const store = new PlanStore();
    store.create([
      { description: 'a step that is done', verification: 'v' },
      { description: 'a step still to do', verification: 'v' },
    ]);
    store.update(1, 'done');
    const agent = {
      getPlanSnapshot: () => store.view(),
      subscribeToPlanStore: (cb: () => void) => store.subscribe(cb),
    } as unknown as Agent;
    const widths = await frameWidths(
      createElement(
        Box,
        { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
        createElement(PlanPanel, { agent, maxRows: 8, reserveColumns: 4 }),
      ),
    );
    expect(widths.length).toBeGreaterThan(2);
    expect([...new Set(widths)]).toEqual([WIDTH]);
  });

  it('squares a frame that a flagged glyph would break', async () => {
    // Guard the guard: the predicate is only worth anything if the glyphs it
    // flags really do break a frame and the ones it clears really do not.
    const framed = (title: string) =>
      frameWidths(
        createElement(
          Box,
          { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
          createElement(Text, null, title),
          createElement(Text, null, 'y'.repeat(WIDTH - 4)),
        ),
      );
    expect([...new Set(await framed('⏰ title'))]).not.toEqual([WIDTH]);
    expect([...new Set(await framed('◷ title'))]).toEqual([WIDTH]);
    expect([...new Set(await framed('漢字 title'))]).toEqual([WIDTH]);
  });
});
