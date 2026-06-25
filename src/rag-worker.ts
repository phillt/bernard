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
import { loadConfig } from './config.js';
import { extractDomainFacts } from './context.js';
import { RAGStore } from './rag.js';
import { CandidateStore, MAX_PENDING_CANDIDATES } from './specialist-candidates.js';
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
  /** Serialized conversation messages to extract facts from. */
  serialized: string;
  /** LLM provider to use for extraction (e.g. `"anthropic"`). */
  provider: string;
  /** Model identifier to use for extraction. */
  model: string;
}

/**
 * Core worker logic: read a temp-file payload, extract RAG facts, run
 * specialist-candidate detection, then delete the temp file.
 *
 * Exported so tests can call it directly with mocked dependencies rather
 * than re-implementing (and drifting from) the real logic.
 */
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

  if (!payload.serialized || !payload.provider || !payload.model) {
    tryUnlink(filePath);
    return;
  }

  // Load config (reads .env + stored keys), override provider/model from temp file
  const config = loadConfig({ provider: payload.provider, model: payload.model });

  // Extract facts via LLM (domain-specific).
  // Use a hard timeout so a stuck provider doesn't keep this detached process
  // alive indefinitely. AbortSignal.timeout is supported on Node 17.3+.
  const extractSignal = AbortSignal.timeout(WORKER_EXTRACT_TIMEOUT_MS);
  const domainFacts = await extractDomainFacts(
    payload.serialized,
    config,
    undefined,
    extractSignal,
  );

  // Store facts per domain if any were extracted
  const totalFacts = domainFacts.reduce((sum, df) => sum + df.facts.length, 0);
  if (totalFacts > 0) {
    const ragStore = new RAGStore();
    for (const df of domainFacts) {
      await ragStore.addFacts(df.facts, 'exit', df.domain);
    }
  }

  // Specialist candidate detection (non-blocking — runs after facts are stored)
  try {
    const candidateStore = new CandidateStore();
    if (candidateStore.listPending().length < MAX_PENDING_CANDIDATES) {
      // Only calls .list() below — bundled seeding is the REPL's job (#163).
      const specialistStore = new SpecialistStore({ seed: false });
      const candidate = await detectSpecialistCandidate(
        payload.serialized,
        config,
        specialistStore.list(),
        candidateStore.listPending(),
      );
      if (candidate?.type === 'new-candidate') {
        candidateStore.create(candidate.candidate, 'exit');
      }
    }
  } catch {
    // Silent — detection failure must not block anything
  }

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
