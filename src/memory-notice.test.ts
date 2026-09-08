import { describe, it, expect } from 'vitest';
import { memoryCapNotice } from './memory-notice.js';

describe('memoryCapNotice', () => {
  it('says nothing when nothing was dropped', () => {
    expect(memoryCapNotice({ dropped: [], alreadyWarned: false })).toBeNull();
  });

  it('fires once per session', () => {
    expect(memoryCapNotice({ dropped: ['a'], alreadyWarned: true })).toBeNull();
  });

  it('names the keys, because a count is not actionable', () => {
    const notice = memoryCapNotice({
      dropped: ['pr-review-workflow', 'email-accounts'],
      alreadyWarned: false,
    })!;
    expect(notice).toContain('pr-review-workflow');
    expect(notice).toContain('email-accounts');
    // The remedy, and the reassurance that nothing was deleted.
    expect(notice).toContain('still on disk');
    expect(notice).toContain('BERNARD_MAX_PERSISTENT_MEMORY_CHARS');
  });

  it('bounds the list rather than pasting an unbounded store into the transcript', () => {
    const notice = memoryCapNotice({
      dropped: Array.from({ length: 12 }, (_, i) => `k${i}`),
      alreadyWarned: false,
    })!;
    expect(notice).toContain('and 7 more');
    expect(notice).not.toContain('`k11`');
    // The total is still stated — the bound is on the naming, not the count.
    expect(notice).toContain('12 curated memories');
  });

  it('reads correctly for a single entry', () => {
    const notice = memoryCapNotice({ dropped: ['solo'], alreadyWarned: false })!;
    expect(notice).toContain('1 curated memory did not fit');
    expect(notice).toContain('was not shown');
    expect(notice).toContain('It is still on disk');
  });
});
