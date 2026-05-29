#!/usr/bin/env tsx
/**
 * Eval harness for issue #173 — measures whether the agent attaches
 * `[^Sn]` citation markers to factual claims sourced from the per-turn
 * ProvenanceStore (and refrains from spamming markers on opinion turns).
 *
 * Usage:
 *   BERNARD_EVAL=1 BERNARD_HOME=/tmp/bernard-eval-cite \
 *     ANTHROPIC_API_KEY=... npx tsx scripts/eval-citation-coverage.ts
 *
 * Optional env:
 *   BERNARD_EVAL_RUNS=3              # runs per scenario (default 3)
 *   BERNARD_PROVIDER=anthropic       # provider override
 *   BERNARD_MODEL=claude-sonnet-4-6  # model override
 *
 * Each scenario seeds the ProvenanceStore with one or two synthetic web
 * sources before calling `agent.processInput`. The model's job is to
 * answer using those facts and attach `[^Sn]` markers. The harness then
 * measures:
 *
 *   - citationCoverage: % of factual-scenario runs whose response contains
 *     at least one VALID `[^Sn]` marker.
 *   - opinionCleanliness: % of opinion-scenario runs that did NOT attach
 *     any `[^Sn]` markers (no source was registered — citing would be
 *     hallucinated).
 *   - unverifiedRate: % of runs with at least one `[unverified]` prefix
 *     (signal that the model honours the fallback when no source matches).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

if (process.env.BERNARD_EVAL !== '1') {
  console.error('Refusing to run: set BERNARD_EVAL=1 to execute this eval.');
  process.exit(2);
}

if (!process.env.BERNARD_HOME || !path.isAbsolute(process.env.BERNARD_HOME)) {
  const fallback = path.join(os.tmpdir(), `bernard-eval-cite-${Date.now()}`);
  console.error(
    `BERNARD_HOME must be an absolute path (e.g. ${fallback}). ` +
      `Paths resolve at import time, so the env var must be set before this script starts.`,
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const runsPerScenario = Number(process.env.BERNARD_EVAL_RUNS ?? 3);
  const home = process.env.BERNARD_HOME!;
  fs.mkdirSync(home, { recursive: true });

  const { Agent } = await import('../src/agent.js');
  const { MemoryStore } = await import('../src/memory.js');
  const { loadConfig } = await import('../src/config.js');
  const { assembleContext } = await import('../src/framework/context.js');
  const { RoutineStore } = await import('../src/routines.js');
  const { SpecialistStore } = await import('../src/specialists.js');
  const { CandidateStore } = await import('../src/specialist-candidates.js');
  const { CorrectionCandidateStore } = await import('../src/correction-candidates.js');
  const { ToolProfileStore } = await import('../src/tool-profiles.js');
  const { ProvenanceStore } = await import('../src/provenance.js');

  type SeedSource = { kind: 'web'; label: string; rawRef: string; contentPreview: string };
  type Scenario = {
    id: string;
    description: string;
    /** When set, the harness pre-registers these in the ProvenanceStore. */
    seedSources: SeedSource[];
    prompt: string;
    /** factual = should cite; opinion = should NOT cite (no sources seeded). */
    kind: 'factual' | 'opinion';
  };

  const SCENARIOS: Scenario[] = [
    {
      id: 'F-bernard-readme',
      description: 'factual fact from seeded web source',
      kind: 'factual',
      seedSources: [
        {
          kind: 'web',
          label: 'Bernard README',
          rawRef: 'https://example.com/bernard',
          contentPreview:
            'Bernard is a local CLI AI agent built on the Vercel AI SDK. It supports Anthropic, OpenAI, and xAI providers and stores its data under XDG directories.',
        },
      ],
      prompt:
        'According to the Bernard README I just read (registered as a source this turn), which AI SDK does Bernard build on, and what providers does it support? Answer in 1–2 sentences.',
    },
    {
      id: 'F-two-sources',
      description: 'two facts from two seeded sources',
      kind: 'factual',
      seedSources: [
        {
          kind: 'web',
          label: 'Mars facts',
          rawRef: 'https://example.com/mars',
          contentPreview: 'Mars has two small moons, Phobos and Deimos.',
        },
        {
          kind: 'web',
          label: 'Jupiter facts',
          rawRef: 'https://example.com/jupiter',
          contentPreview: 'Jupiter has 95 known moons, the four largest being the Galilean moons.',
        },
      ],
      prompt:
        'Using the planetary fact pages registered as sources this turn, how many moons does Mars have, and how many known moons does Jupiter have? One short sentence per planet.',
    },
    {
      id: 'O-color-preference',
      description: 'opinion question — no sources registered',
      kind: 'opinion',
      seedSources: [],
      prompt:
        'Which colour do you find most calming, blue or green, and why? Just give a short personal opinion — no need to look anything up.',
    },
  ];

  type RunResult = {
    scenarioId: string;
    run: number;
    kind: 'factual' | 'opinion';
    finalText: string;
    markerIds: string[];
    validMarkerCount: number;
    invalidMarkerCount: number;
    hasUnverified: boolean;
    error?: string;
  };

  async function runOnce(scenario: Scenario, runIndex: number): Promise<RunResult> {
    const config = { ...loadConfig(), reactMode: false };
    const toolOptions = {
      shellTimeout: config.shellTimeout,
      confirmDangerous: async () => false,
    };
    const provenance = new ProvenanceStore();
    for (const s of scenario.seedSources) {
      provenance.add(s);
    }
    const ctx = assembleContext({
      config,
      toolOptions,
      stores: {
        memory: new MemoryStore(),
        routines: new RoutineStore(),
        specialists: new SpecialistStore(),
        candidates: new CandidateStore(),
        correction: new CorrectionCandidateStore(),
        toolProfiles: new ToolProfileStore(),
      },
      provenance,
    });
    const agent = new Agent(ctx);

    const result: RunResult = {
      scenarioId: scenario.id,
      run: runIndex,
      kind: scenario.kind,
      finalText: '',
      markerIds: [],
      validMarkerCount: 0,
      invalidMarkerCount: 0,
      hasUnverified: false,
    };

    try {
      await agent.processInput(scenario.prompt);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }

    const history = agent.getHistory();
    let finalText = '';
    for (let i = history.length - 1; i >= 0; i--) {
      const msg: any = history[i];
      if (msg.role !== 'assistant') continue;
      if (typeof msg.content === 'string') {
        finalText = msg.content;
        break;
      }
      if (Array.isArray(msg.content)) {
        const t = msg.content
          .filter((p: any) => p?.type === 'text')
          .map((p: any) => p.text as string)
          .join('\n');
        if (t) {
          finalText = t;
          break;
        }
      }
    }
    result.finalText = finalText;

    const allMatches = Array.from(finalText.matchAll(/\[\^(S\d+)\]/g)).map((m) => m[1]);
    const cited = agent.getLastCitedSources();
    const citedSet = new Set(cited.map((s) => s.id));
    result.markerIds = allMatches;
    result.validMarkerCount = allMatches.filter((id) => citedSet.has(id)).length;
    result.invalidMarkerCount = allMatches.length - result.validMarkerCount;
    result.hasUnverified = /\[unverified\]/i.test(finalText);
    return result;
  }

  const allResults: RunResult[] = [];
  for (const scenario of SCENARIOS) {
    console.log(`\n=== ${scenario.id} (${scenario.kind}) — ${scenario.description} ===`);
    for (let i = 1; i <= runsPerScenario; i++) {
      process.stdout.write(`  run ${i}/${runsPerScenario}… `);
      const r = await runOnce(scenario, i);
      allResults.push(r);
      console.log(
        r.error
          ? `ERROR (${r.error.slice(0, 60)})`
          : `markers=[${r.markerIds.join(',') || '–'}] valid=${r.validMarkerCount} invalid=${r.invalidMarkerCount} unverified=${r.hasUnverified}`,
      );
    }
  }

  const factual = allResults.filter((r) => r.kind === 'factual' && !r.error);
  const opinion = allResults.filter((r) => r.kind === 'opinion' && !r.error);
  const pct = (num: number, den: number) =>
    den === 0 ? 'n/a' : `${Math.round((num / den) * 100)}%`;

  const citationCoverage = factual.filter((r) => r.validMarkerCount >= 1).length;
  const opinionClean = opinion.filter((r) => r.markerIds.length === 0).length;
  const invalidMarkers = allResults.reduce((acc, r) => acc + r.invalidMarkerCount, 0);

  console.log('\n=== Summary ===');
  console.log(
    [
      `factualRuns=${factual.length}`,
      `opinionRuns=${opinion.length}`,
      `citationCoverage=${pct(citationCoverage, factual.length)}`,
      `opinionCleanliness=${pct(opinionClean, opinion.length)}`,
      `invalidMarkers=${invalidMarkers}`,
    ].join(' '),
  );

  const resultsPath = path.join(home, 'eval-citation-coverage.json');
  fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
  console.log(`\nRaw results written to ${resultsPath}`);

  const coverage = factual.length === 0 ? 0 : citationCoverage / factual.length;
  console.log(
    coverage >= 0.6 && invalidMarkers === 0
      ? '  → Verdict candidate: keep citations policy default ON.'
      : '  → Verdict candidate: investigate before keeping default ON (coverage low or invalid markers seen).',
  );
}

main().catch((err) => {
  console.error('Eval crashed:', err);
  process.exit(1);
});
