#!/usr/bin/env node
/**
 * scripts/preview-ink.mjs — Phase B dev harness.
 *
 * Mounts the Ink <App> against a real Bernard agent so a developer can
 * end-to-end validate the #211 round-2 fixes (Shift-Tab Status full-screen,
 * Esc closes overlay without replay artifact) without touching their normal
 * Bernard state.
 *
 * Sets BERNARD_HOME=$(mktemp -d) on every launch so memory, history,
 * provenance, RAG state, etc. are isolated from the user's real install.
 *
 * Run with: `tsx scripts/preview-ink.mjs`
 *
 * Not shipped — this file is dev-only and is not imported from src/, not
 * registered in package.json bin, and not part of the build artifact.
 */
import { createElement } from 'react';
import { render } from 'ink';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate state before any Bernard module reads BERNARD_HOME via src/paths.ts.
process.env.BERNARD_HOME = mkdtempSync(join(tmpdir(), 'bernard-preview-ink-'));
console.log(`[preview-ink] BERNARD_HOME=${process.env.BERNARD_HOME}`);

const { loadConfig } = await import('../src/config.ts');
const { Agent } = await import('../src/agent.ts');
const { assembleContext } = await import('../src/framework/context.ts');
const { HistoryStore } = await import('../src/history.ts');
const { ProvenanceHistoryStore } = await import('../src/provenance-history.ts');
const { MemoryStore } = await import('../src/memory.ts');
const { RoutineStore } = await import('../src/routines.ts');
const { SpecialistStore } = await import('../src/specialists.ts');
const { CandidateStore } = await import('../src/specialist-candidates.ts');
const { App } = await import('../src/ui/App.tsx');

const config = loadConfig();
const memoryStore = new MemoryStore();
const routineStore = new RoutineStore();
const specialistStore = new SpecialistStore();
const candidateStore = new CandidateStore();
const historyStore = new HistoryStore();
const provenanceHistoryStore = new ProvenanceHistoryStore();
const sessionToolAllowlist = new Set();

// No-op tool-callback wiring: the preview's purpose is overlay validation
// (Shift-Tab / Esc), not exercising confirm/block/askUser. Tool callbacks
// resolve immediately with safe defaults so any tool call that would have
// prompted is auto-cancelled rather than hanging the preview.
const toolOptions = {
  shellTimeout: config.shellTimeout,
  confirmDangerous: async () => false,
  confirmAction: async () => false,
  blockAction: async () => 'deny',
  sessionToolAllowlist,
  askUser: async (_questions) => ({ cancelled: true, answered: [] }),
};

const agentCtx = assembleContext({
  config,
  toolOptions,
  stores: {
    memory: memoryStore,
    routines: routineStore,
    specialists: specialistStore,
    candidates: candidateStore,
  },
});
const agent = new Agent(agentCtx);

const onExit = async () => {
  // No MCP / RAG to tear down in this minimal preview.
};

const { waitUntilExit } = render(
  createElement(App, {
    agent,
    config,
    historyStore,
    provenanceHistoryStore,
    sessionToolAllowlist,
    onExit,
  }),
);

await waitUntilExit();
console.log(`[preview-ink] exit. BERNARD_HOME left at ${process.env.BERNARD_HOME}`);
