#!/usr/bin/env node

/**
 * Background worker for exit-time RAG fact extraction.
 * Invoked as: node dist/rag-worker.js <tempfile>
 *
 * Reads a JSON temp file containing { serialized, provider, model },
 * extracts facts via LLM, stores them in RAGStore, then cleans up.
 * Runs detached from the parent process — silent failure is fine.
 */

import * as fs from 'node:fs';
import { loadConfig } from './config.js';
import { extractFacts } from './context.js';
import { RAGStore } from './rag.js';

interface TempPayload {
  serialized: string;
  provider: string;
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

  // Extract facts via LLM
  const facts = await extractFacts(payload.serialized, config);

  // Store facts if any were extracted
  if (facts.length > 0) {
    const ragStore = new RAGStore();
    await ragStore.addFacts(facts, 'exit');
  }

  // Clean up temp file
  try {
    fs.unlinkSync(tempFile);
  } catch {
    // Ignore — file may already be gone
  }
}

main().catch(() => process.exit(1));
