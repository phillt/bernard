#!/usr/bin/env node

/**
 * Background worker for exit-time RAG fact extraction.
 * Invoked as: node dist/rag-worker.js <tempfile>
 *
 * Reads a JSON temp file containing { serialized, provider, model },
 * extracts facts via LLM (domain-specific), stores them in RAGStore, then cleans up.
 * Runs detached from the parent process — silent failure is fine.
 */

import * as fs from 'node:fs';
import { loadConfig } from './config.js';
import { extractDomainFacts } from './context.js';
import { RAGStore } from './rag.js';

/** Shape of the JSON temp file written by the REPL at exit. */
interface TempPayload {
  /** Serialized conversation messages to extract facts from. */
  serialized: string;
  /** LLM provider to use for extraction (e.g. `"anthropic"`). */
  provider: string;
  /** Model identifier to use for extraction. */
  model: string;
}

async function main(): Promise<void> {
  const tempFile = process.argv[2];
  if (!tempFile) process.exit(1);

  // Read and parse the temp file
  let payload: TempPayload;
  try {
    const raw = fs.readFileSync(tempFile, 'utf-8');
    payload = JSON.parse(raw) as TempPayload;
  } catch {
    process.exit(1);
  }

  if (!payload.serialized || !payload.provider || !payload.model) {
    fs.unlinkSync(tempFile);
    process.exit(1);
  }

  // Load config (reads .env + stored keys), override provider/model from temp file
  const config = loadConfig({ provider: payload.provider, model: payload.model });

  // Extract facts via LLM (domain-specific)
  const domainFacts = await extractDomainFacts(payload.serialized, config);

  // Store facts per domain if any were extracted
  const totalFacts = domainFacts.reduce((sum, df) => sum + df.facts.length, 0);
  if (totalFacts > 0) {
    const ragStore = new RAGStore();
    for (const df of domainFacts) {
      await ragStore.addFacts(df.facts, 'exit', df.domain);
    }
  }

  // Clean up temp file
  try {
    fs.unlinkSync(tempFile);
  } catch {
    // Ignore — file may already be gone
  }
}

main().catch(() => process.exit(1));
