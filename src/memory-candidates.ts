import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { MEMORY_CANDIDATES_DIR } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';
import type { MemoryProposal } from './memory-consolidation.js';

/**
 * The queue of memory changes Bernard has PROPOSED but not made (#529).
 *
 * A sibling of `AppletCandidateStore` rather than a generalization, on the rule
 * that store's own docstring states and `CorrectionCandidateStore` already
 * proves: the shape recurs — one JSON per record, a pending cap, an age sweep,
 * an atomic write — and the payload does not. There is no `draftId` to
 * validate, no `confidence` (see below), no `actions`, no `overlapScore`.
 *
 * It copies the APPLET store rather than the specialist one on one specific
 * point, and that point is the reason: `decidedAt` + {@link isSuppressed} + a
 * cooldown. A declined proposal has to expire, for the reason recorded on
 * `AppletCandidate.decidedAt` — without it the record leaves `listPending()`
 * and the very next pass proposes the identical thing again, forever.
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
  source: 'exit' | 'clear-save';
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

/**
 * The memory keys a proposal would touch — what a later pass must not re-propose.
 *
 * A free function for the same reason {@link isSuppressed} is: the worker
 * flattens these across suppressed rows in one pass.
 */
export function proposalKeys(c: MemoryCandidate): string[] {
  return c.proposal.keys;
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

  listSuppressed(now: number = Date.now()): MemoryCandidate[] {
    return this.list().filter((c) => isSuppressed(c, now));
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

  delete(id: string): boolean {
    const file = path.join(MEMORY_CANDIDATES_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
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
