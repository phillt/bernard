import type { BernardConfig } from '../../config.js';
import type { ContextMessageInputs } from '../../context-message.js';
import type { ToolMeta } from '../../framework/tools/types.js';
import type { LLMCacheKey } from '../../llm-cache.js';
import type { ModelSite } from '../../model-policy.js';
import type { SourceItemInput } from '../../provenance.js';
import type { Check, Verdict } from '../../rubric.js';
import type { Step } from '../../plan-store.js';

/**
 * Closed discriminated union of invariants the eval harness can assert.
 * Each variant maps to exactly one pure-function call in the runner
 * (`src/__tests__/eval-harness.test.ts`). Adding a new heuristic category
 * means: add a variant here, add a case in the runner switch, add a
 * fixture file that uses it.
 *
 * Issue #178.
 */
export type InvariantSpec =
  | { type: 'system_prompt_excludes'; substrings: string[] }
  | {
      type: 'system_prompt_includes_when';
      condition: Partial<BernardConfig>;
      substring: string;
    }
  | { type: 'context_message_role_is_user'; inputs: ContextMessageInputs }
  | {
      type: 'context_message_includes';
      inputs: ContextMessageInputs;
      substring: string;
    }
  | {
      type: 'context_message_excludes';
      inputs: ContextMessageInputs;
      substring: string;
    }
  | {
      type: 'concise_enabled_when';
      config: Partial<BernardConfig>;
      expected: boolean;
    }
  | {
      type: 'citation_markers_resolve';
      text: string;
      storeItems: SourceItemInput[];
      expectResolved: string[];
    }
  | { type: 'tool_cache_excluded_when_write'; meta: ToolMeta }
  | { type: 'tool_cache_deterministic'; meta: ToolMeta; args: unknown }
  | { type: 'llm_cache_key_partitions'; keyA: LLMCacheKey; keyB: LLMCacheKey }
  | {
      type: 'model_site_resolves_to_tier';
      config: Partial<BernardConfig>;
      site: ModelSite;
      expectedModelName: string;
    }
  | {
      type: 'scratch_clears_on_subject_change';
      userInput: string;
      previousUserInput: string | undefined;
      expectResetAll: boolean;
    }
  | {
      type: 'rubric_verdict_of';
      checks: Check[];
      expected: Verdict;
    }
  | {
      type: 'rubric_plan_evaluates_to';
      steps: Array<Pick<Step, 'id' | 'description' | 'status'> & Partial<Step>>;
      expectedVerdict: Verdict;
      expectChecks?: Array<{ id: string; status: Check['status'] }>;
    }
  | {
      type: 'rubric_post_write_hook';
      meta: ToolMeta;
      args: unknown;
      result: unknown;
      expected: { status: 'pass' | 'warn' | 'fail' } | null;
    };

export type FixtureCategory =
  | 'prompt-boundary'
  | 'context-message'
  | 'concise'
  | 'citations'
  | 'caching'
  | 'model-policy'
  | 'scratch'
  | 'evaluation-rubric';

export interface Fixture {
  name: string;
  category: FixtureCategory;
  invariants: InvariantSpec[];
}

/** Identity helper that lets each fixture file get full TypeScript narrowing on `invariants`. */
export function defineFixture(f: Fixture): Fixture {
  return f;
}
