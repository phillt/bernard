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
  /**
   * In-memory count of `status: 'pending'` candidates on disk. Primed from
   * disk on construction (one O(n) pass) and updated by every mutating
   * method, so `enqueue`'s cap check is O(1) instead of O(n*size). Treated
   * as a best-effort cache — when the underlying state is touched outside
   * this instance, callers can refresh via {@link refreshPendingCount}.
   */
  private pendingCount = 0;

  constructor() {
    fs.mkdirSync(CORRECTION_CANDIDATES_DIR, { recursive: true });
    this.refreshPendingCount();
  }

  /** Re-counts pending candidates on disk. O(n) — call after external writes. */
  refreshPendingCount(): void {
    this.pendingCount = this.listPending().length;
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
    // O(1) cap check via the in-memory counter. Non-pending rows
    // (applied/rejected/dismissed/invalid) don't count against the cap so a
    // backlog drain frees space for new correctable candidates.
    if (this.pendingCount >= MAX_PENDING_CORRECTIONS) return undefined;
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
      this.pendingCount++;
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
    // Maintain the pending counter as rows transition in/out of `pending`.
    if (existing.status === 'pending' && merged.status !== 'pending') {
      this.pendingCount = Math.max(0, this.pendingCount - 1);
    } else if (existing.status !== 'pending' && merged.status === 'pending') {
      this.pendingCount++;
    }
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
    opts?: {
      /**
       * Returns the candidate tool names to attribute this candidate to. We
       * iterate them and keep the candidate if ANY classifies as correctable
       * (most-permissive wins). When a specialist has been deleted, callers
       * should still return a best-effort name (e.g. inferred from the error
       * text) so a shell command-not-found doesn't get dismissed.
       */
      toolNameFor?: (candidate: CorrectionCandidate) => string[];
    },
  ): number {
    let dismissed = 0;
    for (const candidate of this.listPending()) {
      const toolNames = opts?.toolNameFor?.(candidate) ?? [];
      // Always include an undefined-toolName classification too — for
      // categories that don't depend on toolName, this still produces the
      // correct answer; for `not_found` / `exec_failed` it returns the
      // conservative (non-correctable) answer so the loop still has to find
      // a positive match to keep the candidate.
      const attempts = toolNames.length > 0 ? toolNames : [undefined];
      let kept = false;
      let lastCategory: Classification['category'] = 'unknown';
      for (const toolName of attempts) {
        const cls = classify({ message: candidate.error, toolName });
        lastCategory = cls.category;
        if (cls.correctable) {
          kept = true;
          break;
        }
      }
      if (kept) continue;
      this.update(candidate.id, {
        status: 'dismissed',
        category: lastCategory,
        notes: `Auto-dismissed: classified as ${lastCategory} (not correctable).`,
      });
      dismissed++;
    }
    return dismissed;
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    try {
      fs.unlinkSync(path.join(CORRECTION_CANDIDATES_DIR, `${id}.json`));
      if (existing?.status === 'pending') {
        this.pendingCount = Math.max(0, this.pendingCount - 1);
      }
      return true;
    } catch {
      return false;
    }
  }
}
