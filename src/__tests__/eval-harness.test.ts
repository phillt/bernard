/**
 * Eval/regression harness for Bernard heuristics (issue #178).
 *
 * Each fixture under `fixtures/transcripts/*.fixture.ts` declares a list of
 * `InvariantSpec` entries from a closed discriminated union. This file
 * dispatches each invariant to the matching pure-function call and asserts
 * with a self-describing tag, so a failing Vitest line names exactly which
 * fixture and which invariant regressed without scrolling logs.
 *
 * All assertions are pure — no LLM calls. AI SDK clients are mocked
 * identically to `model-policy.test.ts` so `resolveSiteModel` works.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((m: string) => ({ modelId: `anthropic:${m}` })),
  createAnthropic: vi.fn(() => (m: string) => ({ modelId: `anthropic:${m}` })),
}));
vi.mock('@ai-sdk/openai', () => ({
  openai: { responses: vi.fn((m: string) => ({ modelId: `openai:${m}` })) },
  createOpenAI: vi.fn(() => ({ responses: (m: string) => ({ modelId: `openai:${m}` }) })),
}));
vi.mock('@ai-sdk/xai', () => ({
  xai: vi.fn((m: string) => ({ modelId: `xai:${m}` })),
  createXai: vi.fn(() => (m: string) => ({ modelId: `xai:${m}` })),
}));

import type { BernardConfig } from '../config.js';
import { buildSystemPrompt } from '../agent-prompt.js';
import { buildContextMessage } from '../context-message.js';
import { concisePolicy } from '../policy/concise.js';
import { scratchPolicy } from '../policy/scratch.js';
import { makePolicyInput } from '../policy/test-helpers.js';
import { ProvenanceStore, extractCitationMarkers } from '../provenance.js';
import { isCacheable } from '../framework/tools/types.js';
import {
  CACHE_MISS,
  clearCache,
  getCachedResult,
  setCachedResult,
} from '../framework/tools/result-cache.js';
import { clearLLMCache, getCachedLLM, setCachedLLM } from '../llm-cache.js';
import { resolveSiteModel, _resetModelPolicyLogCacheForTests } from '../model-policy.js';

import type { Fixture, InvariantSpec } from './fixtures/fixture-schema.js';
import { promptBoundaryFixture } from './fixtures/transcripts/prompt-boundary.fixture.js';
import { contextMessageFixture } from './fixtures/transcripts/context-message.fixture.js';
import { conciseFixture } from './fixtures/transcripts/concise.fixture.js';
import { citationsFixture } from './fixtures/transcripts/citations.fixture.js';
import { cachingFixture } from './fixtures/transcripts/caching.fixture.js';
import { modelPolicyFixture } from './fixtures/transcripts/model-policy.fixture.js';
import { scratchFixture } from './fixtures/transcripts/scratch.fixture.js';
import { evaluationRubricFixture } from './fixtures/transcripts/evaluation-rubric.fixture.js';
import { verdictOf } from '../rubric.js';
import { PlanStore } from '../plan-store.js';

const ALL_FIXTURES: Fixture[] = [
  promptBoundaryFixture,
  contextMessageFixture,
  conciseFixture,
  citationsFixture,
  cachingFixture,
  modelPolicyFixture,
  scratchFixture,
  evaluationRubricFixture,
];

const BASE_CONFIG: BernardConfig = makePolicyInput().config;

/**
 * Configs handed to `resolveSiteModel` need provider API keys present,
 * otherwise the tier lookup falls through to `source: 'fallback'` and the
 * `modelName` defaults to `config.model`. The model-policy fixture asserts
 * tier picks, so seed the keys here.
 */
const MODEL_POLICY_KEYS = {
  anthropicApiKey: 'sk-ant-test',
  openaiApiKey: 'sk-openai-test',
  xaiApiKey: 'xai-test',
  apiKeys: { anthropic: 'sk-ant-test', openai: 'sk-openai-test', xai: 'xai-test' },
} satisfies Partial<BernardConfig>;

function tag(fixtureName: string, type: InvariantSpec['type'], idx: number): string {
  return `[fixture: ${fixtureName}] [invariant: ${type}] [case: #${idx}]`;
}

function assertNever(x: never): never {
  throw new Error(`eval-harness: unhandled invariant variant: ${JSON.stringify(x)}`);
}

function runInvariant(fixtureName: string, inv: InvariantSpec, idx: number): void {
  const t = tag(fixtureName, inv.type, idx);
  switch (inv.type) {
    case 'system_prompt_excludes': {
      const prompt = buildSystemPrompt(BASE_CONFIG);
      for (const sub of inv.substrings) {
        expect(prompt, `${t} must not contain "${sub}"`).not.toContain(sub);
      }
      return;
    }
    case 'system_prompt_includes_when': {
      const prompt = buildSystemPrompt({ ...BASE_CONFIG, ...inv.condition });
      expect(prompt, `${t} must contain "${inv.substring}"`).toContain(inv.substring);
      return;
    }
    case 'context_message_role_is_user': {
      const msg = buildContextMessage(inv.inputs);
      expect(msg, `${t} buildContextMessage returned null`).not.toBeNull();
      expect(msg!.role, t).toBe('user');
      return;
    }
    case 'context_message_includes': {
      const msg = buildContextMessage(inv.inputs);
      expect(msg, `${t} buildContextMessage returned null`).not.toBeNull();
      expect(String(msg!.content), `${t} must contain "${inv.substring}"`).toContain(inv.substring);
      return;
    }
    case 'context_message_excludes': {
      const msg = buildContextMessage(inv.inputs);
      const content = msg ? String(msg.content) : '';
      expect(content, `${t} must not contain "${inv.substring}"`).not.toContain(inv.substring);
      return;
    }
    case 'concise_enabled_when': {
      const decision = concisePolicy(makePolicyInput({ config: inv.config }));
      expect(decision.enabled, t).toBe(inv.expected);
      return;
    }
    case 'citation_markers_resolve': {
      const store = new ProvenanceStore();
      for (const item of inv.storeItems) store.add(item);
      const resolved = extractCitationMarkers(inv.text, store);
      expect(resolved, t).toEqual(inv.expectResolved);
      return;
    }
    case 'tool_cache_excluded_when_write': {
      expect(isCacheable(inv.meta), `${t} write-effecting tool was marked cacheable`).toBe(false);
      return;
    }
    case 'tool_cache_deterministic': {
      const sentinel = { value: `eval-harness:${inv.meta.name}` };
      const before = getCachedResult(inv.meta, inv.args);
      expect(before, `${t} cache should start empty for this key`).toBe(CACHE_MISS);
      setCachedResult(inv.meta, inv.args, sentinel);
      const after = getCachedResult(inv.meta, inv.args);
      expect(after, `${t} round-trip mismatch`).toEqual(sentinel);
      return;
    }
    case 'llm_cache_key_partitions': {
      setCachedLLM(inv.keyA, 'value-a');
      const hitA = getCachedLLM(inv.keyA);
      const missB = getCachedLLM(inv.keyB);
      expect(hitA, `${t} keyA write/read round-trip failed`).toBe('value-a');
      expect(missB, `${t} keyB collided with keyA despite differing fields`).toBeUndefined();
      return;
    }
    case 'model_site_resolves_to_tier': {
      const config: BernardConfig = {
        ...BASE_CONFIG,
        ...MODEL_POLICY_KEYS,
        ...inv.config,
      };
      const r = resolveSiteModel(config, inv.site);
      expect(r.tier, t).toBe(inv.expectedTier);
      return;
    }
    case 'scratch_clears_on_subject_change': {
      const decision = scratchPolicy(
        makePolicyInput({
          userInput: inv.userInput,
          previousUserInput: inv.previousUserInput,
        }),
      );
      expect(decision.resetAll, t).toBe(inv.expectResetAll);
      return;
    }
    case 'rubric_verdict_of': {
      expect(verdictOf(inv.checks), t).toBe(inv.expected);
      return;
    }
    case 'rubric_plan_evaluates_to': {
      const store = new PlanStore();
      // Seed via the public API: add() then update() into the target status so
      // the store's invariants stay intact. Signoff/note are passed through.
      for (const s of inv.steps) {
        store.add({ description: s.description, verification: s.verification });
      }
      for (const s of inv.steps) {
        if (s.status !== 'pending') {
          store.update(s.id, s.status, { note: s.note, signoff: s.signoff });
        }
      }
      const rubric = store.evaluateRubric();
      expect(rubric.verdict, `${t} verdict`).toBe(inv.expectedVerdict);
      if (inv.expectChecks) {
        for (const want of inv.expectChecks) {
          const actual = rubric.checks.find((c) => c.id === want.id);
          expect(actual, `${t} missing check ${want.id}`).toBeDefined();
          expect(actual!.status, `${t} check ${want.id} status`).toBe(want.status);
        }
      }
      return;
    }
    case 'rubric_post_write_hook': {
      const hook = inv.meta.verifyOutput;
      expect(hook, `${t} fixture meta missing verifyOutput`).toBeDefined();
      const outcome = hook!(inv.args, inv.result);
      if (inv.expected === null) {
        expect(outcome, `${t} expected null skip`).toBeNull();
      } else {
        expect(outcome, `${t} got null but expected outcome`).not.toBeNull();
        expect(outcome!.status, `${t} outcome status`).toBe(inv.expected.status);
      }
      return;
    }
    default:
      assertNever(inv);
  }
}

describe.each(ALL_FIXTURES)('eval-harness — $name', (fixture) => {
  beforeEach(() => {
    clearCache();
    clearLLMCache();
    _resetModelPolicyLogCacheForTests();
  });

  it.each(fixture.invariants.map((inv, idx) => ({ type: inv.type, idx, inv })))(
    '$type [#$idx]',
    ({ inv, idx }) => {
      runInvariant(fixture.name, inv, idx);
    },
  );
});

describe('eval-harness — meta', () => {
  it.each(ALL_FIXTURES.map((f) => ({ name: f.name, fixture: f })))(
    '$name has at least one invariant',
    ({ name, fixture }) => {
      expect(fixture.invariants.length, `${name} declares no invariants`).toBeGreaterThan(0);
    },
  );
});
