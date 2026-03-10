import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { SPECIALIST_CANDIDATES_DIR } from './paths.js';

export interface SpecialistCandidate {
  id: string;
  draftId: string;
  name: string;
  description: string;
  systemPrompt: string;
  guidelines: string[];
  confidence: number;
  reasoning: string;
  detectedAt: string;
  source: 'exit' | 'clear-save';
  acknowledged: boolean;
  status: 'pending' | 'accepted' | 'rejected' | 'dismissed';
}

export const MAX_PENDING_CANDIDATES = 10;

/** Max age in ms before a pending candidate is auto-dismissed (30 days). */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Disk-backed store for specialist candidates (auto-detected specialist suggestions).
 *
 * Each candidate is stored as a separate JSON file under `SPECIALIST_CANDIDATES_DIR`.
 * All writes use atomic rename to prevent partial-read corruption.
 */
export class CandidateStore {
  constructor() {
    fs.mkdirSync(SPECIALIST_CANDIDATES_DIR, { recursive: true });
  }

  /** Returns all candidates, skipping corrupt files. */
  list(): SpecialistCandidate[] {
    if (!fs.existsSync(SPECIALIST_CANDIDATES_DIR)) return [];
    const files = fs.readdirSync(SPECIALIST_CANDIDATES_DIR).filter((f) => f.endsWith('.json'));
    const candidates: SpecialistCandidate[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(SPECIALIST_CANDIDATES_DIR, file), 'utf-8');
        candidates.push(JSON.parse(raw) as SpecialistCandidate);
      } catch {
        // skip corrupt files
      }
    }
    return candidates.sort(
      (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
    );
  }

  /** Returns only pending candidates. */
  listPending(): SpecialistCandidate[] {
    return this.list().filter((c) => c.status === 'pending');
  }

  /** Returns a single candidate by ID, or `undefined` if not found. */
  get(id: string): SpecialistCandidate | undefined {
    const filePath = path.join(SPECIALIST_CANDIDATES_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SpecialistCandidate;
    } catch {
      return undefined;
    }
  }

  /**
   * Creates a new candidate from a detection result.
   * Assigns a UUID and timestamps automatically.
   */
  create(
    draft: Omit<SpecialistCandidate, 'id' | 'detectedAt' | 'acknowledged' | 'status' | 'source'>,
    source: 'exit' | 'clear-save' = 'exit',
  ): SpecialistCandidate {
    const pending = this.listPending();
    if (pending.length >= MAX_PENDING_CANDIDATES) {
      throw new Error(`Maximum of ${MAX_PENDING_CANDIDATES} pending candidates reached.`);
    }

    const candidate: SpecialistCandidate = {
      ...draft,
      id: crypto.randomUUID(),
      source,
      detectedAt: new Date().toISOString(),
      acknowledged: false,
      status: 'pending',
    };

    this.atomicWrite(
      path.join(SPECIALIST_CANDIDATES_DIR, `${candidate.id}.json`),
      JSON.stringify(candidate, null, 2),
    );
    return candidate;
  }

  /** Mark a candidate as acknowledged (user has seen it). */
  acknowledge(id: string): boolean {
    const candidate = this.get(id);
    if (!candidate) return false;
    candidate.acknowledged = true;
    this.atomicWrite(
      path.join(SPECIALIST_CANDIDATES_DIR, `${id}.json`),
      JSON.stringify(candidate, null, 2),
    );
    return true;
  }

  /** Update a candidate's status. */
  updateStatus(id: string, status: SpecialistCandidate['status']): boolean {
    const candidate = this.get(id);
    if (!candidate) return false;
    candidate.status = status;
    this.atomicWrite(
      path.join(SPECIALIST_CANDIDATES_DIR, `${id}.json`),
      JSON.stringify(candidate, null, 2),
    );
    return true;
  }

  /** Removes a candidate by ID. Returns `true` if it existed and was deleted. */
  delete(id: string): boolean {
    const filePath = path.join(SPECIALIST_CANDIDATES_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /** Auto-dismiss pending candidates older than 30 days. */
  pruneOld(): number {
    const now = Date.now();
    let pruned = 0;
    for (const candidate of this.listPending()) {
      const age = now - new Date(candidate.detectedAt).getTime();
      if (age > MAX_AGE_MS) {
        this.updateStatus(candidate.id, 'dismissed');
        pruned++;
      }
    }
    return pruned;
  }

  /** Writes data to a `.tmp` file then renames it into place for crash-safe persistence. */
  private atomicWrite(filePath: string, data: string): void {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, filePath);
  }
}
