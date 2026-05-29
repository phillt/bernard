import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { CORRECTION_CANDIDATES_DIR } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';
import type { ToolErrorType } from './framework/tools/types.js';
import type { Classification } from './error-taxonomy.js';

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
  /**
   * Lifecycle:
   *  - `pending`   — newly enqueued, awaiting review.
   *  - `applied`   — correction-agent proposed a fix, orchestrator re-validated
   *                  it, and examples were written to the target specialist.
   *  - `rejected`  — correction-agent validated the fix but declined to commit.
   *  - `invalid`   — correction-agent could not validate a fix.
   *  - `dismissed` — error was classified as non-correctable (e.g. HTTP 404,
   *                  rate limit) and dropped without consulting the agent.
   */
  status: 'pending' | 'applied' | 'rejected' | 'invalid' | 'dismissed';
  /** Failure taxonomy category, set at enqueue time when known. */
  category?: ToolErrorType;
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
    category?: ToolErrorType;
  }): CorrectionCandidate | undefined {
    // Lightweight count: just count pending .json files. Dismissed/applied/etc.
    // candidates count against the cap but don't represent active queue pressure;
    // a separate cleanup pass can reclaim space if needed. Counting pending only
    // means non-correctable dismissals never block correctable enqueues.
    try {
      const pendingCount = this.listPending().length;
      if (pendingCount >= MAX_PENDING_CORRECTIONS) return undefined;
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
      ...(input.category ? { category: input.category } : {}),
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

  /**
   * One-shot backlog drain: re-classifies every `pending` candidate by running
   * `classify` on its stored error and marks any non-correctable one
   * `dismissed`. Idempotent — only touches `status: 'pending'` rows. Returns
   * the number dismissed.
   *
   * Lives here (not in `correction.ts`) so the REPL can call it before the
   * correction-agent runs at session close, draining the cohort of HTTP 404s
   * and rate-limit hits that have accumulated in the queue.
   */
  dismissNonCorrectable(
    classify: (input: { message: string; toolName?: string }) => Classification,
    opts?: { toolNameFor?: (candidate: CorrectionCandidate) => string | undefined },
  ): number {
    let dismissed = 0;
    for (const candidate of this.listPending()) {
      const toolName = opts?.toolNameFor?.(candidate);
      const cls = classify({ message: candidate.error, toolName });
      if (cls.correctable) continue;
      this.update(candidate.id, {
        status: 'dismissed',
        category: cls.category,
        notes: `Auto-dismissed: classified as ${cls.category} (not correctable).`,
      });
      dismissed++;
    }
    return dismissed;
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
