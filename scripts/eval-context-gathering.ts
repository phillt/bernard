#!/usr/bin/env tsx
/**
 * Eval harness for issue #123 Phase 1 — measures how reliably the in-turn
 * context-gathering prompt (shipped in #124) gets the agent to read named
 * memory before answering questions that depend on stored counts.
 *
 * Usage:
 *   BERNARD_EVAL=1 BERNARD_HOME=/tmp/bernard-eval \
 *     ANTHROPIC_API_KEY=... npx tsx scripts/eval-context-gathering.ts
 *
 * Optional env:
 *   BERNARD_EVAL_RUNS=5              # runs per scenario (default 5)
 *   BERNARD_PROVIDER=anthropic       # provider override
 *   BERNARD_MODEL=claude-sonnet-4-6  # model override
 *
 * The script rejects relative BERNARD_HOME because `src/paths.ts` reads the
 * env var at import time and must resolve to an absolute path.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

if (process.env.BERNARD_EVAL !== '1') {
  console.error('Refusing to run: set BERNARD_EVAL=1 to execute this eval.');
  process.exit(2);
}

if (!process.env.BERNARD_HOME || !path.isAbsolute(process.env.BERNARD_HOME)) {
  const fallback = path.join(os.tmpdir(), `bernard-eval-${Date.now()}`);
  console.error(
    `BERNARD_HOME must be an absolute path (e.g. ${fallback}). ` +
      `Paths resolve at import time, so the env var must be set before this script starts.`,
  );
  process.exit(2);
}

// Lazy-require AFTER env guards so src/paths.ts picks up BERNARD_HOME.
async function main(): Promise<void> {
  const runsPerScenario = Number(process.env.BERNARD_EVAL_RUNS ?? 5);
  const home = process.env.BERNARD_HOME!;

  fs.mkdirSync(home, { recursive: true });

  const { Agent } = await import('../src/agent.js');
  const { MemoryStore } = await import('../src/memory.js');
  const { RAGStore } = await import('../src/rag.js');
  const { loadConfig } = await import('../src/config.js');
  const { MEMORY_DIR } = await import('../src/paths.js');
  const { RoutineStore } = await import('../src/routines.js');
  const { SpecialistStore } = await import('../src/specialists.js');
  const { CandidateStore } = await import('../src/specialist-candidates.js');
  const { resolveReferences } = await import('../src/reference-resolver.js');

  type Scenario = {
    id: string;
    description: string;
    memoryKey: string;
    memoryContent: string;
    prompt: string;
    expectedNumber: number;
    expectedUnit: string;
    /** Extra regexes that also count as "correct answer" (e.g. "1 hour" for 60 min). */
    correctAlternates?: RegExp[];
    /**
     * Patterns for a WRONG total/answer — fires only when the expected number is absent.
     * Must target the final number the model committed to, not intermediate factors.
     */
    wrongTotalPatterns: RegExp[];
  };

  const SCENARIOS: Scenario[] = [
    {
      id: 'A-project-config',
      description: 'named memory + multiplication (services × tests)',
      memoryKey: 'project-config',
      memoryContent: 'Project has 3 services: auth, billing, reports.',
      prompt:
        'Estimate the total test count for the project if each service has about 40 tests. Use my saved project-config memory for the service count.',
      expectedNumber: 120,
      expectedUnit: 'tests',
      wrongTotalPatterns: [/\btotal[^.]{0,40}\b(40|80|160|200)\b/i, /\b(40|80|160|200)\s*tests?\s*total\b/i],
    },
    {
      id: 'B-morning-triage',
      description: 'named memory + multiplication (steps × minutes)',
      memoryKey: 'morning-triage',
      memoryContent:
        'Morning triage routine — 5 steps: inbox, calendar, slack, prs, standup.',
      prompt:
        'How long should my morning triage take if each step is about 8 minutes? Check my morning-triage memory for the step list.',
      expectedNumber: 40,
      expectedUnit: 'min',
      wrongTotalPatterns: [/\babout\s+(16|24|32|48|56|64)\b/i, /=\s*(16|24|32|48|56|64)\b/],
    },
    {
      id: 'C-release-checklist',
      description: 'named memory + addition (items × minutes)',
      memoryKey: 'release-checklist',
      memoryContent:
        'Release checklist — 4 steps: tag, build, smoke-test, announce.',
      prompt:
        'If every release-checklist item takes ~15 minutes, how long is a full release? My release-checklist memory has the step list.',
      expectedNumber: 60,
      expectedUnit: 'min',
      correctAlternates: [/\b1\s*(hour|hr)s?\b/i, /\bone\s+hour\b/i],
      wrongTotalPatterns: [/\babout\s+(30|45|75|90|105)\s*(min|minutes?)\b/i, /=\s*(30|45|75|90|105)\b/],
    },
  ];

  type RunResult = {
    scenarioId: string;
    run: number;
    memoryListed: boolean;
    memoryReadRelevant: boolean;
    finalText: string;
    correctNumber: boolean;
    asked: boolean;
    silentGuess: boolean;
    error?: string;
  };

  /** Scenario that exercises the pre-turn reference resolver (issue #123 redesigned). */
  type ReferenceScenario = {
    id: string;
    description: string;
    memory: Record<string, string>;
    prompt: string;
    /** Keywords that MUST appear in the final assistant text (AND). */
    requiredKeywords: string[];
  };

  const REFERENCE_SCENARIOS: ReferenceScenario[] = [
    {
      id: 'RR-daughter-sandwich',
      description: 'implicit reference — "my daughter her favorite sandwich"',
      memory: {
        'daughter-allyson': 'Allyson Schefflor, age 8, attends Jefferson Elementary.',
        'food-prefs-allyson':
          'Favorite sandwich: BLT on white bread with provolone, lettuce, tomato, mayo, salt, light pepper. Always from Subway.',
      },
      prompt: 'Order my daughter her favorite sandwich.',
      requiredKeywords: ['Allyson', 'BLT', 'Subway'],
    },
  ];

  type ReferenceRunResult = {
    scenarioId: string;
    run: number;
    resolverStatus: 'noop' | 'resolved' | 'ambiguous';
    resolvedEntryCount: number;
    finalText: string;
    passed: boolean;
    error?: string;
  };

  function clearMemoryDir(): void {
    if (!fs.existsSync(MEMORY_DIR)) return;
    for (const f of fs.readdirSync(MEMORY_DIR)) {
      fs.unlinkSync(path.join(MEMORY_DIR, f));
    }
  }

  function extractToolCalls(history: any[]): Array<{ name: string; args: any }> {
    const calls: Array<{ name: string; args: any }> = [];
    for (const msg of history) {
      if (msg.role !== 'assistant') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type === 'tool-call') {
          calls.push({ name: part.toolName, args: part.args ?? part.input });
        }
      }
    }
    return calls;
  }

  function extractFinalAssistantText(history: any[]): string {
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role !== 'assistant') continue;
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((p: any) => p?.type === 'text')
          .map((p: any) => p.text as string);
        if (textParts.length > 0) return textParts.join('\n');
      }
    }
    return '';
  }

  async function runOnce(scenario: Scenario, runIndex: number): Promise<RunResult> {
    clearMemoryDir();
    const memoryStore = new MemoryStore();
    memoryStore.writeMemory(scenario.memoryKey, scenario.memoryContent);

    const config = {
      ...loadConfig(),
      reactMode: false,
      criticMode: false,
    };
    const toolOptions = {
      shellTimeout: config.shellTimeout,
      confirmDangerous: async () => false,
    };
    const ragStore = config.ragEnabled ? new RAGStore() : undefined;

    const agent = new Agent(
      config,
      toolOptions,
      memoryStore,
      undefined,
      undefined,
      undefined,
      undefined,
      ragStore,
      new RoutineStore(),
      new SpecialistStore(),
      new CandidateStore(),
    );

    const result: RunResult = {
      scenarioId: scenario.id,
      run: runIndex,
      memoryListed: false,
      memoryReadRelevant: false,
      finalText: '',
      correctNumber: false,
      asked: false,
      silentGuess: false,
    };

    try {
      await agent.processInput(scenario.prompt);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }

    const history = agent.getHistory();
    const calls = extractToolCalls(history);
    for (const c of calls) {
      if (c.name !== 'memory') continue;
      const action = c.args?.action ?? c.args?.operation;
      if (action === 'list') result.memoryListed = true;
      if (action === 'read') {
        const key = c.args?.key ?? '';
        if (typeof key === 'string' && key === scenario.memoryKey) {
          result.memoryReadRelevant = true;
        }
      }
    }

    const finalText = extractFinalAssistantText(history);
    result.finalText = finalText;

    const expected = String(scenario.expectedNumber);
    const hasExpected =
      new RegExp(`\\b${expected}\\b`).test(finalText) ||
      (scenario.correctAlternates?.some((rx) => rx.test(finalText)) ?? false);
    result.correctNumber = hasExpected;
    result.asked = /\?/.test(finalText) && !hasExpected;

    if (!hasExpected && !result.asked) {
      for (const rx of scenario.wrongTotalPatterns) {
        if (rx.test(finalText)) {
          result.silentGuess = true;
          break;
        }
      }
    }

    return result;
  }

  async function runOnceReference(
    scenario: ReferenceScenario,
    runIndex: number,
  ): Promise<ReferenceRunResult> {
    clearMemoryDir();
    const memoryStore = new MemoryStore();
    for (const [key, content] of Object.entries(scenario.memory)) {
      memoryStore.writeMemory(key, content);
    }

    const config = {
      ...loadConfig(),
      reactMode: false,
      criticMode: false,
    };
    const toolOptions = {
      shellTimeout: config.shellTimeout,
      confirmDangerous: async () => false,
    };
    const ragStore = config.ragEnabled ? new RAGStore() : undefined;

    const agent = new Agent(
      config,
      toolOptions,
      memoryStore,
      undefined,
      undefined,
      undefined,
      undefined,
      ragStore,
      new RoutineStore(),
      new SpecialistStore(),
      new CandidateStore(),
    );

    const result: ReferenceRunResult = {
      scenarioId: scenario.id,
      run: runIndex,
      resolverStatus: 'noop',
      resolvedEntryCount: 0,
      finalText: '',
      passed: false,
    };

    try {
      const resolve = await resolveReferences(scenario.prompt, memoryStore, config);
      result.resolverStatus = resolve.status;
      const resolvedEntries = resolve.status === 'resolved' ? resolve.entries : [];
      result.resolvedEntryCount = resolvedEntries.length;
      await agent.processInput(scenario.prompt, undefined, resolvedEntries);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }

    const history = agent.getHistory();
    const finalText = extractFinalAssistantText(history);
    result.finalText = finalText;
    result.passed = scenario.requiredKeywords.every((kw) =>
      finalText.toLowerCase().includes(kw.toLowerCase()),
    );
    return result;
  }

  const allResults: RunResult[] = [];
  for (const scenario of SCENARIOS) {
    console.log(`\n=== Scenario ${scenario.id} — ${scenario.description} ===`);
    for (let i = 1; i <= runsPerScenario; i++) {
      process.stdout.write(`  run ${i}/${runsPerScenario}… `);
      const r = await runOnce(scenario, i);
      allResults.push(r);
      const tag = r.error
        ? `ERROR (${r.error.slice(0, 60)})`
        : [
            r.memoryReadRelevant ? 'read' : 'no-read',
            r.correctNumber ? 'correct' : r.asked ? 'asked' : r.silentGuess ? 'GUESSED' : 'wrong',
          ].join(' / ');
      console.log(tag);
    }
  }

  console.log('\n=== Summary ===');
  const rows: string[] = [];
  rows.push(
    ['scenario', 'runs', 'memoryRead%', 'correct%', 'asked%', 'silentGuess%', 'errors'].join('\t'),
  );
  for (const scenario of SCENARIOS) {
    const rs = allResults.filter((r) => r.scenarioId === scenario.id);
    const total = rs.length;
    const errors = rs.filter((r) => r.error).length;
    const usable = rs.filter((r) => !r.error);
    const n = Math.max(usable.length, 1);
    const pct = (num: number) => Math.round((num / n) * 100);
    rows.push(
      [
        scenario.id,
        String(total),
        `${pct(usable.filter((r) => r.memoryReadRelevant).length)}%`,
        `${pct(usable.filter((r) => r.correctNumber).length)}%`,
        `${pct(usable.filter((r) => r.asked).length)}%`,
        `${pct(usable.filter((r) => r.silentGuess).length)}%`,
        String(errors),
      ].join('\t'),
    );
  }

  const aggUsable = allResults.filter((r) => !r.error);
  const aggN = Math.max(aggUsable.length, 1);
  const aggPct = (num: number) => Math.round((num / aggN) * 100);
  rows.push(
    [
      'ALL',
      String(allResults.length),
      `${aggPct(aggUsable.filter((r) => r.memoryReadRelevant).length)}%`,
      `${aggPct(aggUsable.filter((r) => r.correctNumber).length)}%`,
      `${aggPct(aggUsable.filter((r) => r.asked).length)}%`,
      `${aggPct(aggUsable.filter((r) => r.silentGuess).length)}%`,
      String(allResults.filter((r) => r.error).length),
    ].join('\t'),
  );

  console.log(rows.join('\n'));

  const refResults: ReferenceRunResult[] = [];
  for (const scenario of REFERENCE_SCENARIOS) {
    console.log(`\n=== Reference Scenario ${scenario.id} — ${scenario.description} ===`);
    for (let i = 1; i <= runsPerScenario; i++) {
      process.stdout.write(`  run ${i}/${runsPerScenario}… `);
      const r = await runOnceReference(scenario, i);
      refResults.push(r);
      const tag = r.error
        ? `ERROR (${r.error.slice(0, 60)})`
        : [
            r.resolverStatus,
            `entries=${r.resolvedEntryCount}`,
            r.passed ? 'PASS' : 'fail',
          ].join(' / ');
      console.log(tag);
    }
  }

  if (REFERENCE_SCENARIOS.length > 0) {
    console.log('\n=== Reference-Resolver Summary ===');
    const refRows: string[] = [];
    refRows.push(['scenario', 'runs', 'resolved%', 'passed%', 'errors'].join('\t'));
    for (const scenario of REFERENCE_SCENARIOS) {
      const rs = refResults.filter((r) => r.scenarioId === scenario.id);
      const total = rs.length;
      const errors = rs.filter((r) => r.error).length;
      const usable = rs.filter((r) => !r.error);
      const n = Math.max(usable.length, 1);
      const pct = (num: number) => Math.round((num / n) * 100);
      refRows.push(
        [
          scenario.id,
          String(total),
          `${pct(usable.filter((r) => r.resolverStatus === 'resolved').length)}%`,
          `${pct(usable.filter((r) => r.passed).length)}%`,
          String(errors),
        ].join('\t'),
      );
    }
    console.log(refRows.join('\n'));
  }

  const resultsPath = path.join(home, 'eval-context-gathering.json');
  fs.writeFileSync(resultsPath, JSON.stringify({ main: allResults, reference: refResults }, null, 2));
  console.log(`\nRaw results written to ${resultsPath}`);

  const silentGuesses = aggUsable.filter((r) => r.silentGuess).length;
  const memoryReadRate = aggUsable.filter((r) => r.memoryReadRelevant).length / aggN;
  console.log(
    `\nDecision inputs — memoryReadRate=${(memoryReadRate * 100).toFixed(0)}%, silentGuesses=${silentGuesses}`,
  );
  console.log(
    memoryReadRate >= 0.8 && silentGuesses === 0
      ? '  → Phase 2 verdict candidate: CLOSE/DEFER issue #123 (covered by #124).'
      : '  → Phase 2 verdict candidate: PROCEED to Phase 3 (rewriter enrichment).',
  );
}

main().catch((err) => {
  console.error('Eval crashed:', err);
  process.exit(1);
});
