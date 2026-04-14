import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { CORRECTION_CANDIDATES_DIR } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';

/**
 * A record of a failed tool-wrapper invocation that the correction agent
 * should review at session close. Each candidate captures enough context for
 * a follow-up run (the original input, the attempted call, the error) so the
 * correction agent can propose a fix, validate it by re-executing, and — only
 * if validation succeeds — update the target specialist's examples.
 */
export interface CorrectionCandidate {
  id: string;
  specialistId: string;
  input: string;
  /** Stringified tool call that failed (best-effort capture). */
  attemptedCall: string;
  /** The error message observed. */
  error: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Populated by the correction agent after validation. */
  proposedGood?: string;
  proposedBad?: string;
  /** True only after the proposed good example executed successfully. */
  validated: boolean;
  status: 'pending' | 'applied' | 'rejected' | 'invalid';
  /** Free-form notes from the correction agent (why it rejected, etc.). */
  notes?: string;
}

export const MAX_PENDING_CORRECTIONS = 50;

/**
 * Disk-backed store for correction candidates. Each candidate is a separate
 * JSON file under {@link CORRECTION_CANDIDATES_DIR}. Writes are atomic.
 *
 * Mirrors the `CandidateStore` pattern used for specialist candidates.
 */
export class CorrectionCandidateStore {
  constructor() {
    fs.mkdirSync(CORRECTION_CANDIDATES_DIR, { recursive: true });
  }

  /** Returns all candidates newest-first, skipping corrupt files. */
  list(): CorrectionCandidate[] {
    if (!fs.existsSync(CORRECTION_CANDIDATES_DIR)) return [];
    const files = fs.readdirSync(CORRECTION_CANDIDATES_DIR).filter((f) => f.endsWith('.json'));
    const candidates: CorrectionCandidate[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(CORRECTION_CANDIDATES_DIR, file), 'utf-8');
        candidates.push(JSON.parse(raw) as CorrectionCandidate);
      } catch {
        /* skip corrupt */
      }
    }
    return candidates.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  /** Returns only pending candidates. */
  listPending(): CorrectionCandidate[] {
    return this.list().filter((c) => c.status === 'pending');
  }

  get(id: string): CorrectionCandidate | undefined {
    try {
      const filePath = path.join(CORRECTION_CANDIDATES_DIR, `${id}.json`);
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CorrectionCandidate;
    } catch {
      return undefined;
    }
  }

  /**
   * Enqueues a new pending correction candidate. Silently no-ops when the
   * pending list would exceed {@link MAX_PENDING_CORRECTIONS} — we never want
   * logging to block a tool call.
   */
  enqueue(input: {
    specialistId: string;
    input: string;
    attemptedCall: string;
    error: string;
  }): CorrectionCandidate | undefined {
    // Lightweight count: just count .json files instead of reading+parsing all of them.
    // Slightly over-counts (includes non-pending), but never under-counts pending.
    try {
      const fileCount = fs
        .readdirSync(CORRECTION_CANDIDATES_DIR)
        .filter((f) => f.endsWith('.json')).length;
      if (fileCount >= MAX_PENDING_CORRECTIONS) return undefined;
    } catch {
      return undefined;
    }
    const candidate: CorrectionCandidate = {
      id: crypto.randomUUID(),
      specialistId: input.specialistId,
      input: input.input,
      attemptedCall: input.attemptedCall,
      error: input.error,
      createdAt: new Date().toISOString(),
      validated: false,
      status: 'pending',
    };
    try {
      atomicWriteFileSync(
        path.join(CORRECTION_CANDIDATES_DIR, `${candidate.id}.json`),
        JSON.stringify(candidate, null, 2),
      );
      return candidate;
    } catch {
      return undefined;
    }
  }

  update(id: string, patch: Partial<CorrectionCandidate>): CorrectionCandidate | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged: CorrectionCandidate = { ...existing, ...patch, id: existing.id };
    atomicWriteFileSync(
      path.join(CORRECTION_CANDIDATES_DIR, `${id}.json`),
      JSON.stringify(merged, null, 2),
    );
    return merged;
  }

  delete(id: string): boolean {
    try {
      fs.unlinkSync(path.join(CORRECTION_CANDIDATES_DIR, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }

}
