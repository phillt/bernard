import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { APPLET_CANDIDATES_DIR } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';

/**
 * The queue of applets Bernard has SUGGESTED but not built (#430).
 *
 * A sibling of `CandidateStore` rather than a generalization of it. The two
 * share a shape — one JSON file per record, a pending cap, an age sweep — and
 * `CorrectionCandidateStore` is the existing proof that this shape gets
 * instantiated more than once. What they do not share is the payload:
 * `SpecialistCandidate` carries `systemPrompt`, `guidelines` and an
 * `enhancement` block for merging into an existing specialist, and
 * `reconcileSaved` matches a draft id against a saved specialist id. None of
 * that has an applet meaning. Extracting a base class for the six methods that
 * genuinely overlap would move `SpecialistCandidate`'s five specific ones into
 * a subclass and buy nothing else — the atomic write is already shared, via
 * `fs-utils`, which is where `CandidateStore`'s private copy should go too.
 */
export interface AppletCandidate {
  id: string;
  /** The applet id the model proposes, kebab-case; validated only if accepted. */
  draftId: string;
  name: string;
  description: string;
  /** Action names the model believes the applet needs. Advisory. */
  actions: string[];
  confidence: number;
  reasoning: string;
  detectedAt: string;
  source: 'exit' | 'clear-save';
  status: 'pending' | 'accepted' | 'rejected' | 'dismissed';
  /** Overlap with the closest existing applet or pending candidate (0-1). */
  overlapScore?: number;
  /** Set when the composite cleared `autoCreateThreshold` and one was built. */
  autoCreated?: boolean;
  /**
   * When the user decided, for a status they chose themselves.
   *
   * Only a DECLINE needs it, and it needs it because a decline has to expire:
   * the whole point is that the idea can resurface later once it has re-earned
   * its way in. `detectedAt` cannot serve — that is when Bernard had the idea,
   * not when the user said no, and the gap between them is unbounded.
   */
  decidedAt?: string;
}

export const MAX_PENDING_APPLET_CANDIDATES = 10;

/** Age past which a pending suggestion nobody acted on is dismissed. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a decline suppresses the same idea.
 *
 * A decline is not a veto. The user's own framing: remove it from
 * consideration, drop whatever had built up, and let it come back later if the
 * work really is recurring — *"which is fine"*. So this is a cooldown, not a
 * blocklist, and nothing here ever becomes permanent.
 *
 * `MAX_AGE_MS` itself, not a second literal of the same length: that is
 * already the house answer to "how long is a suggestion still current", and a
 * decline is a STRONGER signal than the silence that number was chosen for.
 * Written as a reference so the two cannot drift apart while a comment still
 * claims they agree.
 */
export const DECLINE_COOLDOWN_MS = MAX_AGE_MS;

/**
 * Whether a declined suggestion is still inside its cooldown.
 *
 * Free of the store so one `list()` can be partitioned into pending and
 * suppressed in a single pass — the shape `pruneOld` already argues for, and
 * which `rag-worker.ts` needs because it wants both sets from one read.
 *
 * Reads `decidedAt`, never `detectedAt`: the clock starts when the user said
 * no, and the gap between having the idea and hearing about it is unbounded. A
 * row declined before this field existed carries no `decidedAt` and suppresses
 * nothing, which is the right way to be wrong — the alternative silently
 * extends old declines by however long they happened to sit on disk.
 */
export function isSuppressed(c: AppletCandidate, now: number = Date.now()): boolean {
  return (
    c.status === 'rejected' &&
    c.decidedAt !== undefined &&
    now - new Date(c.decidedAt).getTime() < DECLINE_COOLDOWN_MS
  );
}

export class AppletCandidateStore {
  constructor() {
    fs.mkdirSync(APPLET_CANDIDATES_DIR, { recursive: true });
  }

  list(): AppletCandidate[] {
    if (!fs.existsSync(APPLET_CANDIDATES_DIR)) return [];
    const out: AppletCandidate[] = [];
    for (const file of fs.readdirSync(APPLET_CANDIDATES_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        out.push(
          JSON.parse(
            fs.readFileSync(path.join(APPLET_CANDIDATES_DIR, file), 'utf-8'),
          ) as AppletCandidate,
        );
      } catch {
        // A corrupt file is skipped, never thrown from: this store is read on
        // the session-exit path, where a throw loses the whole detection run.
      }
    }
    return out.sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
  }

  listPending(): AppletCandidate[] {
    return this.list().filter((c) => c.status === 'pending');
  }

  get(id: string): AppletCandidate | undefined {
    const file = path.join(APPLET_CANDIDATES_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as AppletCandidate;
    } catch {
      return undefined;
    }
  }

  create(
    draft: Omit<AppletCandidate, 'id' | 'detectedAt' | 'status' | 'source'>,
    source: AppletCandidate['source'] = 'exit',
  ): AppletCandidate {
    if (this.listPending().length >= MAX_PENDING_APPLET_CANDIDATES) {
      throw new Error(`Maximum of ${MAX_PENDING_APPLET_CANDIDATES} pending candidates reached.`);
    }
    const candidate: AppletCandidate = {
      ...draft,
      id: crypto.randomUUID(),
      source,
      detectedAt: new Date().toISOString(),
      status: 'pending',
    };
    this.write(candidate);
    return candidate;
  }

  /**
   * Records that the user said no. The name call sites should use.
   *
   * The stamp itself lives in {@link updateStatus}, so a decline written the
   * long way is still a decline — this reads better at a call site without
   * being the only place the invariant holds. An earlier cut put the stamp
   * here alone and claimed that made a hand-flipped status unrepresentable; it
   * did not, and a test pinned the broken behaviour as expected.
   */
  decline(id: string): boolean {
    return this.updateStatus(id, 'rejected');
  }

  /**
   * Declines still inside their cooldown — what the detector must not re-propose.
   *
   * A convenience over {@link isSuppressed}; the worker partitions one `list()`
   * with that predicate instead, since it needs the pending rows from the same
   * read.
   */
  listSuppressed(now: number = Date.now()): AppletCandidate[] {
    return this.list().filter((c) => isSuppressed(c, now));
  }

  updateStatus(id: string, status: AppletCandidate['status']): boolean {
    const candidate = this.get(id);
    if (!candidate) return false;
    candidate.status = status;
    if (status === 'rejected') candidate.decidedAt = new Date().toISOString();
    // Stamped here rather than in {@link decline}, so status and `decidedAt`
    // are written together however the transition is reached. A decline
    // without the stamp suppresses nothing — it leaves the pending queue and
    // the very next detector run re-proposes the same applet — and putting the
    // stamp only in the named method leaves that trap fully reachable through
    // the API next to it.
    //
    // Only `rejected`. `dismissed` is the 30-day age sweep and `accepted` is a
    // build: silence is not a no, so neither starts a cooldown.

    this.write(candidate);
    return true;
  }

  delete(id: string): boolean {
    const file = path.join(APPLET_CANDIDATES_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  /**
   * Dismisses pending suggestions older than 30 days, and hands back the ones
   * that survived.
   *
   * Returning the survivors rather than a count is what lets the REPL's startup
   * path — its only caller that needs both — read the directory once. It used to
   * `pruneOld()` and then `listPending()`, which is two full readdir + parse
   * passes over a store nothing ever compacts (only PENDING is capped at 10;
   * accepted and dismissed rows accumulate for the life of the install), paid on
   * every single launch.
   */
  pruneOld(): { pruned: number; pending: AppletCandidate[] } {
    const now = Date.now();
    const pending: AppletCandidate[] = [];
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

  private write(candidate: AppletCandidate): void {
    atomicWriteFileSync(
      path.join(APPLET_CANDIDATES_DIR, `${candidate.id}.json`),
      JSON.stringify(candidate, null, 2),
    );
  }
}
