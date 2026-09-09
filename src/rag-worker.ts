#!/usr/bin/env node

/**
 * Background worker for exit-time work nobody should wait for.
 * Invoked as: node dist/rag-worker.js <tempfile>
 *
 * Reads a JSON temp file and runs whichever passes it asks for: RAG fact
 * extraction, specialist and applet candidate detection, and memory
 * consolidation (#529). Then cleans up.
 *
 * **The name is now narrower than the job**, and this is where that became
 * true: three of the four passes have nothing to do with RAG, and #529's gate
 * had to be widened off `ragEnabled` precisely because a memory pass is not a
 * RAG pass. The payload also still lands in `RAG_DIR`, whose orphan reaper is
 * `RAGStore.cleanupStaleTemp` — called from that store's constructor, which a
 * RAG-off session never runs. Called unconditionally below as the cheap half of
 * that fix; renaming the module and moving the payload to `STATE_DIR` is the
 * other half and is filed rather than smuggled in here.
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
import { MEMORY_CONSOLIDATED_MARKER, SPECIALIST_RECALL_MARKER, TOOL_WRAPPER_LOG } from './paths.js';
import { readJsonlTail } from './jsonl.js';
import { debugLog } from './logger.js';
import { extractSpecialistNotes } from './specialist-recall.js';
import type { ReasoningLogEntry } from './reasoning-log.js';
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
  /**
   * Ask for the specialist-recall pass (#501).
   *
   * A third independent gate, for the reason `consolidateMemory` is a second
   * one: this arm reads the REASONING LOG, not the payload, so it needs neither
   * a transcript here nor RAG to be enabled. Hanging it off either would make it
   * silently never run for settings that have nothing to do with what a
   * specialist should remember.
   */
  specialistRecall?: boolean;
}

/**
 * Gives each specialist that ran a memory of its own work (#501).
 *
 * The main agent has had this since the exit worker existed: its transcript is
 * extracted into facts. A specialist got nothing, so the one agent that most
 * needs to remember its own mistakes could not.
 *
 * **Reads the reasoning log rather than a new buffer.** Every dispatch now
 * writes one entry there, so the transcripts are already durable and already
 * survive the process that produced them — a per-session in-memory buffer would
 * be a second mechanism holding the same bytes, and would lose them on a crash.
 *
 * The gate is the marker's INCLUSION CUTOFF, the shape #529 had to correct
 * once: storing the run time makes the trigger set and the input set exact
 * complements, so the most recent work is never examined.
 */
async function runSpecialistRecall(config: BernardConfig): Promise<void> {
  const lastCutoff = lastRecallAt();
  const cutoff = Date.now();
  const entries = readJsonlTail<ReasoningLogEntry>(TOOL_WRAPPER_LOG, RECALL_LOG_SCAN)
    .filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && (lastCutoff === null || t > lastCutoff) && t <= cutoff;
    })
    .filter((e) => e.specialistId);
  if (entries.length === 0) {
    // Still stamped: otherwise a quiet session re-scans the same tail forever.
    stampRecall(cutoff);
    return;
  }

  // Grouped so one specialist that ran five times gets ONE extraction over all
  // five, not five extractions that cannot see each other. That is also what
  // keeps the call count at one per specialist rather than one per dispatch.
  const byOwner = new Map<string, ReasoningLogEntry[]>();
  for (const e of entries) {
    const list = byOwner.get(e.specialistId);
    if (list) list.push(e);
    else byOwner.set(e.specialistId, [e]);
  }

  const store = new SpecialistStore({ seed: false });
  const memory = new MemoryStore();
  for (const [specialistId, runs] of byOwner) {
    // A deleted specialist's notes would be written under an owner nothing can
    // resolve — unreadable the moment they land, and swept by nothing because
    // the sweep already ran.
    if (!store.get(specialistId)) continue;
    const transcript = runs.map(renderRun).join('\n\n').slice(0, RECALL_TRANSCRIPT_MAX);
    const notes = await extractSpecialistNotes(specialistId, transcript, config, {
      abortSignal: AbortSignal.timeout(WORKER_RECALL_TIMEOUT_MS),
    });
    const owned = memory.asOwner(specialistId);
    for (const note of notes) {
      try {
        owned.writeMemory(note.key, note.content);
      } catch (err) {
        // A key collision with another owner, or an unwritable key. One bad
        // note must not cost the specialist the rest of them.
        debugLog('specialist-recall:write-failed', {
          specialistId,
          key: note.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    debugLog('specialist-recall:wrote', { specialistId, runs: runs.length, notes: notes.length });
  }
  stampRecall(cutoff);
}

/** One logged run, as the extractor sees it. */
function renderRun(e: ReasoningLogEntry): string {
  const calls = e.toolCalls
    .map((c) => `  - ${c.tool}(${JSON.stringify(c.args)}) -> ${c.resultPreview}`)
    .join('\n');
  return [
    `Task: ${e.input}`,
    calls ? `Tools used:\n${calls}` : '  (no tool calls)',
    `Outcome (${e.status}): ${String(e.finalOutput ?? '').slice(0, 600)}`,
  ].join('\n');
}

function lastRecallAt(): number | null {
  try {
    const t = Date.parse(fs.readFileSync(SPECIALIST_RECALL_MARKER, 'utf-8').trim());
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function stampRecall(cutoff: number): void {
  try {
    fs.mkdirSync(path.dirname(SPECIALIST_RECALL_MARKER), { recursive: true });
    atomicWriteFileSync(SPECIALIST_RECALL_MARKER, new Date(cutoff).toISOString() + '\n');
  } catch {
    // A marker that cannot be written costs a repeated scan, not correctness.
  }
}

/**
 * Core worker logic: read a temp-file payload, run the passes it asks for, then
 * delete the temp file. Which passes those are is per-arm — see below; the
 * detectors need a transcript and consolidation needs only that memory changed.
 *
 * Exported so tests can call it directly with mocked dependencies rather
 * than re-implementing (and drifting from) the real logic.
 */
/** Consolidation shares fact extraction's deadline shape; a stuck provider must not outlive the run. */
const WORKER_CONSOLIDATE_TIMEOUT_MS = 60_000;

/** Same deadline shape; a stuck provider must not outlive this detached run. */
const WORKER_RECALL_TIMEOUT_MS = 60_000;

/**
 * How far back to scan the reasoning log.
 *
 * The marker normally makes this a short read, but the log is append-only and
 * rotated by count, so a first run — or one after a long gap — would otherwise
 * parse the whole file. 500 entries is far more than any session produces.
 */
const RECALL_LOG_SCAN = 500;

/** Per-specialist transcript budget, so one busy specialist cannot dominate. */
const RECALL_TRANSCRIPT_MAX = 12_000;

/**
 * How recently written is "too fresh to judge".
 *
 * An AGE rule, not a since-last-run rule, and that distinction is load-bearing
 * — see {@link runMemoryConsolidation}. A note written this session has not had
 * time to become redundant, and proposing to retire it is the fastest way to
 * make someone turn the pass off.
 */
const FRESH_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The inclusion cutoff the last successful pass examined up to. `null` when it
 * never ran, or when the marker is unreadable — either way the pass should run.
 *
 * Note this is a CUTOFF, not a run time. Storing "when we last ran" was a real
 * defect; the docstring on {@link runMemoryConsolidation} has the trace.
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
  const lastCutoff = lastConsolidatedAt();
  const cutoff = Date.now() - FRESH_GRACE_MS;
  const writtenAt = (e: { writtenAt?: string }) => (e.writtenAt ? Date.parse(e.writtenAt) : 0);

  const all = consolidationInputs(store);
  // Is there anything we have not examined yet?
  const changed = lastCutoff === null || all.some((e) => writtenAt(e) > lastCutoff);
  if (!changed) return;

  // Everything old enough to judge. The two predicates read against DIFFERENT
  // clocks on purpose, and an earlier cut had them read against one — which
  // skipped a record permanently.
  //
  // That version stored the RUN TIME and filtered on it, so the trigger set and
  // the input set were exact complements: a record written this session made
  // `changed` true and was then withheld as too fresh, the marker advanced past
  // it, and the next quiet session found `changed` false and returned before
  // looking. The record was examined only if some LATER write re-triggered the
  // gate — so a user's most recent memory was never examined at all, and the
  // steady state carried a permanent one-write lag.
  //
  // Storing the CUTOFF instead breaks the symmetry: a withheld record stays
  // above the stored value and keeps re-triggering, and the next run's cutoff
  // has moved past it, so it is included and the marker then advances past it.
  // It also gives the first run a freshness rail, which the old shape's
  // `lastRun === null ? all : ...` did not — the run where proposing about a
  // note written minutes ago is most likely.
  const entries = all.filter((e) => writtenAt(e) <= cutoff);

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
  const unspoken = entries.filter((e) => !spoken.has(e.key));

  const proposals = await proposeConsolidation(unspoken, config, {
    abortSignal: AbortSignal.timeout(WORKER_CONSOLIDATE_TIMEOUT_MS),
  });
  // Counted locally rather than re-reading. `listPending()` is a full readdir
  // and parse, and `create()` runs its own cap check internally, so the call
  // here made it two directory sweeps per proposal — the exact defect the
  // sibling arm's comment below boasts of having fixed.
  let room = MAX_PENDING_MEMORY_CANDIDATES - pending.length;
  for (const proposal of proposals) {
    if (room-- <= 0) break;
    candidates.create(proposal, 'exit');
  }

  try {
    // The CUTOFF, not `now` — see the partition above.
    atomicWriteFileSync(MEMORY_CONSOLIDATED_MARKER, new Date(cutoff).toISOString() + '\n');
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
  if (!payload.serialized && !payload.consolidateMemory && !payload.specialistRecall) {
    tryUnlink(filePath);
    return;
  }

  // Reap orphaned payloads unconditionally.
  //
  // `RAGStore.cleanupStaleTemp` is static but was only ever reached through the
  // store's CONSTRUCTOR, which a RAG-off session never runs — and since #529
  // widened the spawn gate off `ragEnabled`, exactly those sessions now write
  // `.pending-*.json` into `RAG_DIR`. So the users this change serves were the
  // ones whose orphans nothing collected. One static call, no store built.
  RAGStore.cleanupStaleTemp();

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

  // Specialist recall (#501). Unlike every arm above it WRITES, and the
  // asymmetry is deliberate: consolidation proposes because its records are the
  // user's own and shared, so a wrong retirement changes behaviour everywhere
  // and silently. These are private to one specialist and are deleted with it —
  // and reviewing N specialists' proposals at every startup is a queue nobody
  // drains.
  if (payload.specialistRecall) {
    arms.push(runSpecialistRecall(config));
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
