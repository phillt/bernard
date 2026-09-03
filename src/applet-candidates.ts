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
}

export const MAX_PENDING_APPLET_CANDIDATES = 10;

/** Age past which a pending suggestion nobody acted on is dismissed. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
