import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { MEMORY_CANDIDATES_DIR } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';
import type { MemoryProposal } from './memory-proposal.js';

/**
 * The queue of memory changes Bernard has PROPOSED but not made (#529).
 *
 * A sibling of `AppletCandidateStore`, and the honest version of that claim is
 * narrower than the one this file first made. It cited `applet-candidates.ts`'s
 * argument against generalizing `CandidateStore` — but that argument turns on
 * the specialist store's five non-overlapping METHODS (`reconcileSaved`,
 * `acknowledge`) and this file did not copy that store. It copied the applet
 * one, whose methods are a near-clone of these.
 *
 * Extraction is still not worth it, for a different reason: of the three stores
 * left with this shape, only these two are close. `CandidateStore` has
 * `enhancement`/`reconcileSaved`/`acknowledged` and no cooldown. Two near-clones
 * do not carry a base class either — and if a fourth arrives, the piece to lift is
 * `isSuppressed` + `MAX_AGE_MS` + `pruneOld` as free functions over a
 * `{detectedAt, status, decidedAt}` structural type, not a class.
 *
 * There WERE four. `CorrectionCandidateStore` was the fourth and is gone (#564):
 * its consumer needed retry, retention and oldest-first, which is a work queue
 * rather than a proposal store, so it moved to `work-queue.ts` instead of being
 * generalised together with these. Worth knowing, because that module is the
 * nearest thing in the tree to the base class this comment declines to write and
 * it is deliberately NOT one — a proposal waits for a person and has a cooldown
 * on being declined; an item of work waits for a pass and has an attempt count.
 *
 * What it does copy deliberately is `decidedAt` + {@link isSuppressed} + a
 * cooldown, which the specialist store lacks. A declined proposal has to
 * expire, for the reason recorded on `AppletCandidate.decidedAt` — without it
 * the record leaves `listPending()` and the very next pass proposes the
 * identical thing again, forever.
 *
 * **No confidence score, deliberately.** `structured-output.ts` states the
 * house rule — *"models are poor at calibrating those"* — and the two detectors
 * are the exception only because theirs is one term of a composite consumed by
 * `autoCreateThreshold`. Nothing gates on a number here: every proposal is
 * shown, and `applet-detector.ts` already records what an unconsumed gate is
 * worth — *"The gate had never once fired."*
 */
export interface MemoryCandidate {
  id: string;
  /** What is proposed. The keys inside were checked against the live store at creation. */
  proposal: MemoryProposal;
  detectedAt: string;
  source: 'exit';
  status: 'pending' | 'accepted' | 'rejected' | 'dismissed';
  /**
   * When the user decided, for a status they chose themselves.
   *
   * Only a DECLINE needs it, and needs it because a decline has to expire —
   * `detectedAt` is when Bernard had the idea, not when the user said no.
   */
  decidedAt?: string;
}

export const MAX_PENDING_MEMORY_CANDIDATES = 10;

/** Age past which a pending proposal nobody acted on is dismissed. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a decline suppresses the same proposal.
 *
 * `MAX_AGE_MS` itself, not a second literal of the same length — the reference
 * form `applet-candidates.ts` uses, so the two cannot drift while a comment
 * claims they agree. A decline is a cooldown, not a veto: a note the user keeps
 * today may genuinely be spent in a year.
 */
export const DECLINE_COOLDOWN_MS = MAX_AGE_MS;

/**
 * Whether a declined proposal is still inside its cooldown.
 *
 * Free of the store so one `list()` can be partitioned into pending and
 * suppressed in a single pass — what the exit worker needs, since it wants both
 * sets from one read.
 */
export function isSuppressed(c: MemoryCandidate, now: number = Date.now()): boolean {
  return (
    c.status === 'rejected' &&
    c.decidedAt !== undefined &&
    now - new Date(c.decidedAt).getTime() < DECLINE_COOLDOWN_MS
  );
}

export class MemoryCandidateStore {
  constructor() {
    fs.mkdirSync(MEMORY_CANDIDATES_DIR, { recursive: true });
  }

  list(): MemoryCandidate[] {
    if (!fs.existsSync(MEMORY_CANDIDATES_DIR)) return [];
    const out: MemoryCandidate[] = [];
    for (const file of fs.readdirSync(MEMORY_CANDIDATES_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        out.push(
          JSON.parse(
            fs.readFileSync(path.join(MEMORY_CANDIDATES_DIR, file), 'utf-8'),
          ) as MemoryCandidate,
        );
      } catch {
        // A corrupt file is skipped, never thrown from: this store is read on
        // the session-exit path, where a throw loses the whole run.
      }
    }
    return out.sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
  }

  listPending(): MemoryCandidate[] {
    return this.list().filter((c) => c.status === 'pending');
  }

  get(id: string): MemoryCandidate | undefined {
    const file = path.join(MEMORY_CANDIDATES_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as MemoryCandidate;
    } catch {
      return undefined;
    }
  }

  create(proposal: MemoryProposal, source: MemoryCandidate['source'] = 'exit'): MemoryCandidate {
    if (this.listPending().length >= MAX_PENDING_MEMORY_CANDIDATES) {
      throw new Error(`Maximum of ${MAX_PENDING_MEMORY_CANDIDATES} pending proposals reached.`);
    }
    const candidate: MemoryCandidate = {
      id: crypto.randomUUID(),
      proposal,
      source,
      detectedAt: new Date().toISOString(),
      status: 'pending',
    };
    this.write(candidate);
    return candidate;
  }

  /** Records that the user said no. The name call sites should use. */
  decline(id: string): boolean {
    return this.updateStatus(id, 'rejected');
  }

  updateStatus(id: string, status: MemoryCandidate['status']): boolean {
    const candidate = this.get(id);
    if (!candidate) return false;
    candidate.status = status;
    // Stamped here rather than only in `decline`, so status and `decidedAt` are
    // written together however the transition is reached — the trap
    // `applet-candidates.ts` records having shipped once, where a hand-flipped
    // status was a decline that suppressed nothing.
    //
    // Only `rejected`. `dismissed` is the age sweep and `accepted` is a change
    // the user asked for: silence is not a no, so neither starts a cooldown.
    if (status === 'rejected') candidate.decidedAt = new Date().toISOString();
    this.write(candidate);
    return true;
  }

  /**
   * Dismisses pending proposals older than 30 days, and hands back the
   * survivors — the shape that lets the REPL startup path read the directory
   * once instead of `pruneOld()` then `listPending()`.
   */
  pruneOld(): { pruned: number; pending: MemoryCandidate[] } {
    const now = Date.now();
    const pending: MemoryCandidate[] = [];
    let pruned = 0;
    for (const c of this.listPending()) {
      if (now - new Date(c.detectedAt).getTime() > MAX_AGE_MS) {
        this.updateStatus(c.id, 'dismissed');
        pruned++;
      } else {
        pending.push(c);
      }
    }
    return { pruned, pending };
  }

  private write(candidate: MemoryCandidate): void {
    atomicWriteFileSync(
      path.join(MEMORY_CANDIDATES_DIR, `${candidate.id}.json`),
      JSON.stringify(candidate, null, 2),
    );
  }
}
