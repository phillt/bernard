import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTempHome } from './__tests__/temp-home.js';
import type { MemoryProposal } from './memory-consolidation.js';
import type { MemoryCandidateStore as StoreType } from './memory-candidates.js';

useTempHome('bernard-memory-candidates');

let MemoryCandidateStore: typeof StoreType;
let isSuppressed: (c: any, now?: number) => boolean;
let DECLINE_COOLDOWN_MS: number;
let MAX_PENDING: number;

beforeEach(async () => {
  vi.resetModules();
  const m = await import('./memory-candidates.js');
  MemoryCandidateStore = m.MemoryCandidateStore;
  isSuppressed = m.isSuppressed;
  DECLINE_COOLDOWN_MS = m.DECLINE_COOLDOWN_MS;
  MAX_PENDING = m.MAX_PENDING_MEMORY_CANDIDATES;
});

const dup: MemoryProposal = {
  kind: 'duplicate',
  keys: ['issue-3538', '3772'],
  keeper: 'issue-3538',
  reason: 'r',
};
const stale: MemoryProposal = { kind: 'stale', keys: ['one-off'], reason: 'r' };

describe('MemoryCandidateStore', () => {
  it('creates a pending proposal and lists it', () => {
    const s = new MemoryCandidateStore();
    const c = s.create(dup);
    expect(c.status).toBe('pending');
    expect(s.listPending().map((x) => x.id)).toEqual([c.id]);
    expect(s.get(c.id)?.proposal).toEqual(dup);
  });

  it('caps pending proposals', () => {
    const s = new MemoryCandidateStore();
    for (let i = 0; i < MAX_PENDING; i++) s.create({ ...stale, keys: [`k${i}`] });
    expect(() => s.create(stale)).toThrow(/Maximum/);
  });

  it('skips a corrupt record rather than throwing — this runs on the exit path', async () => {
    const s = new MemoryCandidateStore();
    s.create(dup);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { MEMORY_CANDIDATES_DIR } = await import('./paths.js');
    fs.writeFileSync(path.join(MEMORY_CANDIDATES_DIR, 'broken.json'), '{ not json', 'utf-8');
    expect(s.list()).toHaveLength(1);
  });
});

describe('declining, and why it has to expire', () => {
  it('stamps decidedAt however the transition is reached', () => {
    // The trap `applet-candidates.ts` records having shipped once: a
    // hand-flipped status was a decline that suppressed nothing.
    const s = new MemoryCandidateStore();
    const viaDecline = s.create(dup);
    const viaStatus = s.create(stale);
    s.decline(viaDecline.id);
    s.updateStatus(viaStatus.id, 'rejected');
    expect(s.get(viaDecline.id)?.decidedAt).toBeTruthy();
    expect(s.get(viaStatus.id)?.decidedAt).toBeTruthy();
  });

  it('suppresses a decline inside the cooldown and releases it after', () => {
    const s = new MemoryCandidateStore();
    const c = s.create(dup);
    s.decline(c.id);
    const declined = s.get(c.id)!;
    expect(isSuppressed(declined)).toBe(true);
    expect(isSuppressed(declined, Date.now() + DECLINE_COOLDOWN_MS + 1)).toBe(false);
  });

  it('does not start a cooldown on accept or dismiss — silence is not a no', () => {
    const s = new MemoryCandidateStore();
    const a = s.create(dup);
    const d = s.create(stale);
    s.updateStatus(a.id, 'accepted');
    s.updateStatus(d.id, 'dismissed');
    expect(s.get(a.id)?.decidedAt).toBeUndefined();
    expect(s.get(d.id)?.decidedAt).toBeUndefined();
    expect(isSuppressed(s.get(a.id)!)).toBe(false);
  });

  it('suppresses nothing for a row declined before decidedAt existed', () => {
    // The right way to be wrong: the alternative silently extends old declines
    // by however long they sat on disk.
    expect(isSuppressed({ status: 'rejected', decidedAt: undefined } as never)).toBe(false);
  });
});

describe('pruneOld', () => {
  it('returns survivors so the startup path reads the directory once', () => {
    const s = new MemoryCandidateStore();
    s.create(dup);
    const { pruned, pending } = s.pruneOld();
    expect(pruned).toBe(0);
    expect(pending).toHaveLength(1);
  });

  it('dismisses a stale pending proposal without starting a cooldown', async () => {
    const s = new MemoryCandidateStore();
    const c = s.create(dup);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { MEMORY_CANDIDATES_DIR } = await import('./paths.js');
    const f = path.join(MEMORY_CANDIDATES_DIR, `${c.id}.json`);
    const rec = JSON.parse(fs.readFileSync(f, 'utf-8'));
    rec.detectedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(f, JSON.stringify(rec), 'utf-8');

    const { pruned, pending } = s.pruneOld();
    expect(pruned).toBe(1);
    expect(pending).toHaveLength(0);
    expect(s.get(c.id)?.status).toBe('dismissed');
    expect(s.get(c.id)?.decidedAt).toBeUndefined();
  });
});
