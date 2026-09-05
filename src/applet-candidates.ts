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
 * The same 30 days as {@link MAX_AGE_MS}, deliberately: that is already the
 * house answer to "how long is a suggestion still current", and a decline is a
 * STRONGER signal than the silence that number was chosen for. Picking a
 * second, different number would be inventing precision nobody has.
 */
export const DECLINE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

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
   * Records that the user said no.
   *
   * A distinct method rather than `updateStatus(id, 'rejected')` at each call
   * site, because a decline is the one status transition with a consequence
   * beyond leaving the pending queue: it stamps `decidedAt`, which is what
   * {@link listSuppressed} reads to keep the detector from proposing the same
   * thing again tomorrow. A call site that flipped the status by hand would
   * silently produce a decline that suppresses nothing — the failure this
   * exists to make unrepresentable.
   */
  decline(id: string): boolean {
    const candidate = this.get(id);
    if (!candidate) return false;
    candidate.status = 'rejected';
    candidate.decidedAt = new Date().toISOString();
    this.write(candidate);
    return true;
  }

  /**
   * Declines still inside their cooldown — what the detector must not re-propose.
   *
   * Reads `decidedAt` and not `detectedAt`: the clock starts when the user said
   * no. A row declined before this field existed has no `decidedAt` and so
   * suppresses nothing, which is the right way to be wrong — the alternative
   * silently extends old declines by however long they sat on disk.
   */
  listSuppressed(now: number = Date.now()): AppletCandidate[] {
    return this.list().filter(
      (c) =>
        c.status === 'rejected' &&
        c.decidedAt !== undefined &&
        now - new Date(c.decidedAt).getTime() < DECLINE_COOLDOWN_MS,
    );
  }

  updateStatus(id: string, status: AppletCandidate['status']): boolean {
    const candidate = this.get(id);
    if (!candidate) return false;
    candidate.status = status;
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
