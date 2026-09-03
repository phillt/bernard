import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { APPLET_CANDIDATES_DIR } from './paths.js';
import { useTempHome } from './__tests__/temp-home.js';
import {
  appletConfidence,
  appletSuggestionBlock,
  buildAppletRequest,
  detectAppletCandidate,
} from './applet-detector.js';
import {
  AppletCandidateStore,
  MAX_PENDING_APPLET_CANDIDATES,
  type AppletCandidate,
} from './applet-candidates.js';
import type { BernardConfig } from './config.js';

useTempHome('applet-detector');

function draft(over: Partial<AppletCandidate> = {}): AppletCandidate {
  return {
    id: 'x',
    draftId: 'expense-log',
    name: 'Expense Log',
    description: 'Log an expense and see the running total',
    actions: ['log', 'total'],
    confidence: 0.9,
    reasoning: 'logged four expenses across two sessions',
    detectedAt: new Date().toISOString(),
    source: 'exit',
    status: 'pending',
    ...over,
  };
}

describe('appletConfidence (#430)', () => {
  /**
   * The reason `computeConfidence` is not reused: two of its four completeness
   * terms read `systemPrompt` and `guidelines`, which an applet does not have.
   * Passing empties would cap an applet 0.14 below a specialist on a component
   * that says nothing about applets — so a well-formed applet must be able to
   * clear the SAME 0.8 threshold the specialist pipeline uses.
   */
  it('lets a complete applet clear the shared 0.8 threshold', () => {
    const score = appletConfidence(0.95, 0, draft(), 4000);
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it('weights overlap, completeness and evidence the same way its sibling does', () => {
    // 0.4 llm + 0.3 overlap-inverse + 0.2 completeness + 0.1 evidence = 1.0
    expect(appletConfidence(1, 0, draft(), 4000)).toBeCloseTo(1, 5);
    // Total overlap removes exactly the 0.3 component.
    expect(appletConfidence(1, 1, draft(), 4000)).toBeCloseTo(0.7, 5);
  });

  it('penalises a draft with no actions and a malformed id', () => {
    const good = appletConfidence(0.95, 0, draft(), 4000);
    const bad = appletConfidence(0.95, 0, draft({ actions: [], draftId: 'Expense_Log' }), 4000);
    expect(bad).toBeLessThan(good);
    // Worth stating plainly rather than asserting a threshold cross: the
    // completeness term is worth 0.2 in total, so — exactly as in
    // `computeConfidence` — it cannot on its own sink a high-confidence,
    // zero-overlap, well-evidenced draft below 0.8. What keeps a bad draft out
    // is the model's own confidence and the overlap check, not this term.
    expect(good - bad).toBeCloseTo(0.14, 5);
  });

  it('clamps a model that reports confidence outside 0-1', () => {
    expect(appletConfidence(5, 0, draft(), 4000)).toBeCloseTo(1, 5);
    expect(appletConfidence(-1, 0, draft(), 4000)).toBeCloseTo(0.6, 5);
  });
});

describe('detectAppletCandidate (#430)', () => {
  it('does not call a model for a transcript too short to show recurrence', async () => {
    // No provider is configured in the temp home, so reaching `generateText`
    // would throw — returning null before that is the property.
    const out = await detectAppletCandidate('too short', {} as BernardConfig, [], []);
    expect(out).toBeNull();
  });

  it('fails soft rather than throwing out of session exit', async () => {
    // A long transcript DOES reach the model call, which cannot succeed here.
    const out = await detectAppletCandidate('x'.repeat(600), {} as BernardConfig, [], []);
    expect(out).toBeNull();
  });
});

describe('AppletCandidateStore (#430)', () => {
  let store: AppletCandidateStore;
  beforeEach(() => {
    store = new AppletCandidateStore();
    for (const c of store.list()) store.delete(c.id);
  });

  it('mints id, timestamp and status, and lists newest first', () => {
    const a = store.create({ ...stripped(draft({ name: 'A' })) });
    const b = store.create({ ...stripped(draft({ name: 'B' })) });
    expect(a.id).not.toBe(b.id);
    expect(a.status).toBe('pending');
    expect(store.list().map((c) => c.name)).toContain('A');
    expect(store.listPending()).toHaveLength(2);
  });

  it('caps pending suggestions so a detector cannot flood the queue', () => {
    for (let i = 0; i < MAX_PENDING_APPLET_CANDIDATES; i++) {
      store.create(stripped(draft({ draftId: `a-${i}` })));
    }
    expect(() => store.create(stripped(draft()))).toThrow(/Maximum of 10/);
    // A rejected one frees a slot — the cap is on PENDING, not on history.
    store.updateStatus(store.listPending()[0].id, 'rejected');
    expect(() => store.create(stripped(draft()))).not.toThrow();
  });

  it('dismisses suggestions nobody acted on for 30 days', () => {
    const stale = store.create(stripped(draft()));
    const fresh = store.create(stripped(draft({ draftId: 'other' })));
    // `create` always stamps now, so ageing one means editing its file — which
    // is also the shape a store written by a previous month's session has.
    const file = path.join(APPLET_CANDIDATES_DIR, `${stale.id}.json`);
    const aged = { ...(JSON.parse(fs.readFileSync(file, 'utf-8')) as AppletCandidate) };
    aged.detectedAt = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(aged), 'utf-8');

    expect(store.pruneOld().pruned).toBe(1);
    expect(store.get(stale.id)?.status).toBe('dismissed');
    expect(store.listPending().map((c) => c.id)).toEqual([fresh.id]);
  });

  it('survives a corrupt file rather than throwing on the exit path', () => {
    store.create(stripped(draft()));
    fs.writeFileSync(path.join(APPLET_CANDIDATES_DIR, 'broken.json'), '{not json', 'utf-8');
    expect(store.list()).toHaveLength(1);
  });
});

function stripped(
  c: AppletCandidate,
): Omit<AppletCandidate, 'id' | 'detectedAt' | 'status' | 'source'> {
  const { id: _i, detectedAt: _d, status: _s, source: _so, ...rest } = c;
  return rest;
}

describe('appletSuggestionBlock (#430)', () => {
  it('marks only the auto-create-eligible ones as offerable', () => {
    const block = appletSuggestionBlock(
      [draft(), draft({ draftId: 'other', name: 'Other' })],
      [draft()],
    );
    const lines = block.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toContain('OFFER to build');
    expect(lines[1]).not.toContain('OFFER to build');
  });

  it('never tells the agent to build one unasked', () => {
    // The whole asymmetry with `autoCreateSpecialists`: the flag widens what is
    // OFFERED, it does not authorise silent authoring.
    expect(appletSuggestionBlock([draft()], [draft()])).toContain('only when the user agrees');
  });
});

describe('buildAppletRequest (#430)', () => {
  it('names the tool and carries the detected fields rather than re-deriving them', () => {
    const req = buildAppletRequest(draft());
    expect(req).toContain('`applet` tool');
    expect(req).toContain('expense-log');
    expect(req).toContain('log, total');
  });

  it('says so when the model proposed no actions', () => {
    expect(buildAppletRequest(draft({ actions: [] }))).toContain('decide from the description');
  });
});
