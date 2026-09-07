#!/usr/bin/env node

/**
 * Background worker for exit-time RAG fact extraction.
 * Invoked as: node dist/rag-worker.js <tempfile>
 *
 * Reads a JSON temp file containing { serialized, provider, model },
 * extracts facts via LLM (domain-specific), stores them in RAGStore, then cleans up.
 * Runs detached from the parent process — silent failure is fine.
 *
 * The core logic is exported as `runWorkerForFile` so tests can drive it
 * directly without exec'ing the built script.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type BernardConfig } from './config.js';
import { extractDomainFacts } from './context.js';
import { RAGStore } from './rag.js';
import { CandidateStore, MAX_PENDING_CANDIDATES } from './specialist-candidates.js';
import {
  AppletCandidateStore,
  MAX_PENDING_APPLET_CANDIDATES,
  isSuppressed,
} from './applet-candidates.js';
import { detectAppletCandidate } from './applet-detector.js';
import { AppRegistry } from './apps/registry.js';
import { MemoryStore } from './memory.js';
import {
  MemoryCandidateStore,
  MAX_PENDING_MEMORY_CANDIDATES,
  isSuppressed as isMemorySuppressed,
} from './memory-candidates.js';
import { consolidationInputs, proposeConsolidation } from './memory-consolidation.js';
import { MEMORY_CONSOLIDATED_MARKER } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';
import { SpecialistStore } from './specialists.js';
import { detectSpecialistCandidate } from './specialist-detector.js';

/** Background fact-extraction timeout (ms). Prevents zombie processes at exit. */
const WORKER_EXTRACT_TIMEOUT_MS = 120_000;

/** Best-effort delete of the temp file; ignores errors (file may already be gone). */
function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore
  }
}

/** Shape of the JSON temp file written by the REPL at exit. */
export interface TempPayload {
  /**
   * Serialized conversation messages to extract facts from.
   *
   * Absent when the session had nothing worth extracting but memory still
   * changed — see {@link TempPayload.consolidateMemory}.
   */
  serialized?: string;
  /** LLM provider to use for extraction (e.g. `"anthropic"`). */
  provider: string;
  /** Model identifier to use for extraction. */
  model: string;
  /**
   * Ask for the memory-consolidation pass (#529).
   *
   * Optional, and separate from `serialized`, because the two arms answer to
   * different gates: fact extraction needs a transcript, and consolidation
   * needs only that memory has changed. The spawn used to be one condition —
   * `if (ragStore && history.length >= MIN_HISTORY_FOR_FACTS)` — which would
   * have made this pass silently never run for a user with RAG off, a setting
   * that has nothing to do with their memory files.
   */
  consolidateMemory?: boolean;
}

/**
 * Core worker logic: read a temp-file payload, extract RAG facts, run
 * specialist-candidate detection, then delete the temp file.
 *
 * Exported so tests can call it directly with mocked dependencies rather
 * than re-implementing (and drifting from) the real logic.
 */
/** Consolidation shares fact extraction's deadline shape; a stuck provider must not outlive the run. */
const WORKER_CONSOLIDATE_TIMEOUT_MS = 60_000;

/**
 * When the consolidation pass last ran. `null` when it never has, or when the
 * marker is unreadable — either way the pass should run.
 */
function lastConsolidatedAt(): number | null {
  try {
    const t = Date.parse(fs.readFileSync(MEMORY_CONSOLIDATED_MARKER, 'utf-8').trim());
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Proposes what memory could shed, and queues it. Writes no memory.
 *
 * ## The gate is `writtenAt`, not a content hash
 *
 * #513 already stamps every write, so "has anything changed since we last
 * looked" is answerable from metadata that exists. A hash would be a second
 * mechanism for a question one already answers — and the same comparison,
 * applied per record rather than across the store, is also the "too fresh to
 * judge" rail: a note written after the last pass has not had time to become
 * redundant, and proposing to retire something the user wrote this session is
 * the fastest way to make them turn this off.
 *
 * The marker is written whether or not anything was proposed. Otherwise an
 * unchanged store re-runs the model every session forever, which is exactly
 * what the gate is for.
 */
async function runMemoryConsolidation(config: BernardConfig): Promise<void> {
  const store = new MemoryStore();
  const lastRun = lastConsolidatedAt();

  const all = consolidationInputs(store);
  const changed =
    lastRun === null || all.some((e) => e.writtenAt && Date.parse(e.writtenAt) > lastRun);
  if (!changed) return;

  // Records newer than the last pass are withheld rather than the run being
  // skipped: the rest of the store is still worth looking at.
  const entries =
    lastRun === null ? all : all.filter((e) => !e.writtenAt || Date.parse(e.writtenAt) <= lastRun);

  const candidates = new MemoryCandidateStore();
  const existing = candidates.list();
  const pending = existing.filter((c) => c.status === 'pending');
  if (pending.length >= MAX_PENDING_MEMORY_CANDIDATES) return;

  // Keys already spoken for — pending proposals and declines inside their
  // cooldown. Without this the pass re-proposes what the user just said no to,
  // which is the whole reason a decline outlives the moment it is made.
  const spoken = new Set<string>();
  for (const c of existing) {
    if (c.status === 'pending' || isMemorySuppressed(c)) {
      for (const k of c.proposal.keys) spoken.add(k);
    }
  }
  const fresh = entries.filter((e) => !spoken.has(e.key));

  const proposals = await proposeConsolidation(fresh, config, {
    abortSignal: AbortSignal.timeout(WORKER_CONSOLIDATE_TIMEOUT_MS),
  });
  for (const proposal of proposals) {
    if (candidates.listPending().length >= MAX_PENDING_MEMORY_CANDIDATES) break;
    candidates.create(proposal, 'exit');
  }

  try {
    atomicWriteFileSync(MEMORY_CONSOLIDATED_MARKER, new Date().toISOString() + '\n');
  } catch {
    // Best-effort, like every other marker in the repo. Losing it costs one
    // redundant pass, not correctness.
  }
}

export async function runWorkerForFile(filePath: string): Promise<void> {
  // Read and parse the temp file
  let payload: TempPayload;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    payload = JSON.parse(raw) as TempPayload;
  } catch {
    // Malformed/missing file — clean up and bail.
    tryUnlink(filePath);
    return;
  }

  // `provider`/`model` are still required — `loadConfig` needs them either way.
  // `serialized` is not: a session with nothing worth extracting can still ask
  // for a memory pass, which is why the gate below is per-arm rather than one
  // guard over the whole run.
  if (!payload.provider || !payload.model) {
    tryUnlink(filePath);
    return;
  }
  if (!payload.serialized && !payload.consolidateMemory) {
    tryUnlink(filePath);
    return;
  }

  // Load config (reads .env + stored keys), override provider/model from temp file
  const config = loadConfig({ provider: payload.provider, model: payload.model });

  // Extract facts via LLM (domain-specific).
  // Use a hard timeout so a stuck provider doesn't keep this detached process
  // alive indefinitely. AbortSignal.timeout is supported on Node 17.3+.
  const serialized = payload.serialized;
  if (serialized) {
    const extractSignal = AbortSignal.timeout(WORKER_EXTRACT_TIMEOUT_MS);
    const domainFacts = await extractDomainFacts(serialized, config, undefined, extractSignal);

    // Store facts per domain if any were extracted
    const totalFacts = domainFacts.reduce((sum, df) => sum + df.facts.length, 0);
    if (totalFacts > 0) {
      const ragStore = new RAGStore();
      for (const df of domainFacts) {
        await ragStore.addFacts(df.facts, 'exit', df.domain);
      }
    }
  }

  // Independent cheap-tier passes, run CONCURRENTLY: this process exists only
  // to finish and exit, and awaiting them in sequence doubled its wall clock
  // for no dependency between them. Each is its own settled arm, because a
  // failure in one must not cost the others their result — and `allSettled`,
  // not `all`, so a rejection cannot skip the temp file cleanup below.
  //
  // The arms are ASSEMBLED rather than listed, because they no longer share a
  // gate: the two detectors read the transcript, and consolidation (#529) reads
  // memory — which a session with nothing worth extracting can still have
  // changed.
  const arms: Array<Promise<unknown>> = [];

  // Specialist and applet candidate detection (#430).
  //
  // Each `listPending()` is read ONCE and used for both the cap gate and the
  // detector's "already suggested" list; the two used to be separate calls, i.e.
  // a second full readdir and parse of the same directory.
  if (serialized) {
    arms.push(
      (async () => {
        const candidateStore = new CandidateStore();
        const pending = candidateStore.listPending();
        if (pending.length >= MAX_PENDING_CANDIDATES) return;
        // Only calls .list() below — bundled seeding is the REPL's job (#163).
        const specialistStore = new SpecialistStore({ seed: false });
        const candidate = await detectSpecialistCandidate(
          serialized,
          config,
          specialistStore.list(),
          pending,
        );
        if (candidate?.type === 'new-candidate') {
          candidateStore.create(candidate.candidate, 'exit');
        }
      })(),
      (async () => {
        const appletCandidates = new AppletCandidateStore();
        // ONE read, partitioned. `list()` readdirs and parses every record, and
        // `listPending()` + `listSuppressed()` would each do their own — measured
        // at exactly 2x, on a store nothing ever compacts. That is the defect the
        // sibling comment above and `pruneOld`'s docstring both already name.
        const all = appletCandidates.list();
        const pending = all.filter((c) => c.status === 'pending');
        if (pending.length >= MAX_PENDING_APPLET_CANDIDATES) return;
        const detected = await detectAppletCandidate(
          serialized,
          config,
          new AppRegistry().listIds(),
          pending,
          // Declines inside their cooldown. This is the whole reason a decline
          // lasts longer than the moment it is made: without it the record leaves
          // `listPending()` and the very next run has no memory of it.
          all.filter((c) => isSuppressed(c)),
        );
        if (detected) appletCandidates.create(detected.candidate, 'exit');
      })(),
    );
  }

  // Memory consolidation (#529). Proposes; never writes a memory — the
  // invariant the two arms above already keep, and the reason this is safe to
  // run unattended at all.
  if (payload.consolidateMemory) {
    arms.push(runMemoryConsolidation(config));
  }

  await Promise.allSettled(arms);

  // Clean up temp file
  tryUnlink(filePath);
}

async function main(): Promise<void> {
  const tempFile = process.argv[2];
  if (!tempFile) process.exit(1);

  await runWorkerForFile(tempFile);
}

// Only run main() when executed as a standalone script (not imported by tests).
// Compare resolved paths so this works for both:
//   node dist/rag-worker.js   (production)
//   tsx  src/rag-worker.ts    (dev)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(() => process.exit(1));
}
