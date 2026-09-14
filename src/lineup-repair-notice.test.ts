import { describe, it, expect } from 'vitest';
import { lineupRepairNotice } from './lineup-repair-notice.js';

describe('lineupRepairNotice', () => {
  it('says nothing when no repair happened', () => {
    expect(lineupRepairNotice(null)).toBeNull();
    expect(lineupRepairNotice({ ids: [], dead: [] })).toBeNull();
  });

  it('reads as singular for one lineup', () => {
    const notice = lineupRepairNotice({ ids: ['anthropic'], dead: [] });
    expect(notice).toContain('your default model lineup (anthropic) was set up');
    expect(notice).toContain('refreshed it');
    expect(notice).not.toMatch(/lineups|were|them/);
  });

  it('reads as plural for several', () => {
    const notice = lineupRepairNotice({ ids: ['anthropic', 'openai', 'xai'], dead: [] });
    expect(notice).toContain('your default model lineups (anthropic, openai, xai) were set up');
    expect(notice).toContain('refreshed them');
  });

  // The distinction the notice exists to get right: a ladder match re-seeds the
  // whole lineup, so most of what it replaces was working. Only `dead` is
  // measured-not-to-dispatch, and calling a working model broken in the one
  // message explaining an unrequested change is the failure mode here.
  it('only calls out models that could not be used', () => {
    const clean = lineupRepairNotice({ ids: ['xai'], dead: [] });
    expect(clean).not.toContain('could not be used');

    const broken = lineupRepairNotice({
      ids: ['anthropic'],
      dead: ['anthropic/claude-opus-4'],
    });
    expect(broken).toContain('1 of them could not be used at all: anthropic/claude-opus-4');
  });

  it('bounds a long list rather than pasting every id', () => {
    const notice = lineupRepairNotice({
      ids: ['anthropic', 'openai', 'xai'],
      dead: ['a/1', 'b/2', 'c/3', 'd/4', 'e/5'],
    });
    expect(notice).toContain('+2 more');
  });
});
