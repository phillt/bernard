/**
 * The contract between a provider's WIRE response and `normalizeUsage` (#269,
 * #sdk-boundary).
 *
 * `normalizeUsage` is the only door prompt-cache accounting goes through, and
 * `CacheMetadata` cannot guard it: the AI SDK types provider metadata as
 * `Record<string, Record<string, JSONValue>>` and names none of these keys, so
 * every field has to stay optional (measured — see that interface's docstring
 * for the six sites that stop compiling otherwise), and TypeScript does not
 * compare an index signature against an optional property at all. A wrong shape
 * therefore passes silently, reports `cacheReadTokens: 0`, and the only visible
 * symptom is a bill that stops matching the dashboard.
 *
 * So the guard is this file, and three things about it are load-bearing:
 *
 * 1. **It must not `vi.mock('ai')`.** The thing under test is the SDK's own
 *    mapping from wire JSON to `providerMetadata`. Mocking `ai` tests the
 *    fixture instead.
 * 2. **The fixture is the WIRE response, byte-verbatim.** Those field names
 *    (`cache_read_input_tokens`, `prompt_tokens_details.cached_tokens`) are the
 *    providers' public HTTP contract and do not move when the SDK majors — only
 *    the SDK's surfacing of them does. That is what makes the fixture
 *    version-independent and the SDK's mapping the thing being measured.
 * 3. **It asserts the KEY SETS, not only the numbers.** A renamed field read
 *    through an optional property is `undefined`, folds to 0, and every
 *    arithmetic assertion still "passes" in the sense of not throwing about the
 *    rename — it reports a plausible zero. Asserting `Object.keys(...)` makes
 *    the failure name the new key.
 *
 * Both halves matter because the two providers disagree about arithmetic:
 * Anthropic's `input_tokens` EXCLUDES cache reads and writes (so the total is a
 * sum), while an OpenAI-compatible `prompt_tokens` INCLUDES them (so the cached
 * count is a subset). Reading only the Anthropic shape billed every cached
 * xAI/OpenAI token at the full input rate. The OpenAI-compatible half runs
 * through `createXai` deliberately: that is Bernard's only shipped user of
 * `@ai-sdk/openai-compatible`'s cache branch, and nothing else covered it.
 *
 * No API key and no network: both factories accept a `fetch`, which is how
 * `src/providers/index.ts` already installs `stallGuardedFetch`.
 */

import { describe, it, expect } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { generateText } from 'ai';
import { normalizeUsage } from '../token-stats.js';
import {
  ANTHROPIC_CACHE_KEYS,
  OPENAI_COMPATIBLE_CACHE_KEYS,
  type StepFinishPayload,
} from '../types.js';

/** Serves one canned JSON body to whatever the SDK asks for. */
function fetchReturning(body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

/**
 * Runs one `generateText` call against a canned response and hands back the
 * step the SDK produced. `onStepFinish` rather than the returned result,
 * because the step payload is exactly what `runner.ts` forwards to the hooks —
 * so this measures the path production takes, not a parallel one.
 */
async function captureStep(
  model: Parameters<typeof generateText>[0]['model'],
): Promise<StepFinishPayload> {
  let captured: StepFinishPayload | undefined;
  await generateText({
    model,
    messages: [{ role: 'user', content: 'contract probe' }],
    onStepFinish: (step) => {
      captured = step;
    },
  });
  if (!captured) throw new Error('onStepFinish never fired');
  return captured;
}

describe('provider cache-token contract', () => {
  describe('Anthropic (cached tokens are DISJOINT from input_tokens)', () => {
    // Byte-verbatim Anthropic Messages response. 11 uncached input tokens,
    // 222 written to cache, 3333 read from cache, 44 out.
    const WIRE = {
      id: 'msg_contract',
      type: 'message',
      role: 'assistant',
      model: 'claude-contract',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 11,
        cache_creation_input_tokens: 222,
        cache_read_input_tokens: 3333,
        output_tokens: 44,
      },
    };

    const model = () =>
      createAnthropic({ apiKey: 'contract-test', fetch: fetchReturning(WIRE) })('claude-contract');

    it('surfaces exactly the keys normalizeUsage reads', async () => {
      const step = await captureStep(model());
      // Names the new key when the SDK renames one, instead of quietly
      // reporting zero cached tokens.
      expect(Object.keys(step.providerMetadata?.anthropic ?? {}).sort()).toEqual(
        [...ANTHROPIC_CACHE_KEYS].sort(),
      );
      expect(Object.keys(step.usage ?? {}).sort()).toEqual([
        'completionTokens',
        'promptTokens',
        'totalTokens',
      ]);
    });

    it('normalizes to a prompt total that INCLUDES both cache counts', async () => {
      const step = await captureStep(model());
      expect(normalizeUsage(step.usage, step.providerMetadata)).toEqual({
        // 11 uncached + 3333 read + 222 written — the number that reconciles
        // against the billing dashboard.
        promptTokens: 11 + 3333 + 222,
        completionTokens: 44,
        cacheReadTokens: 3333,
        cacheWriteTokens: 222,
      });
    });
  });

  describe('OpenAI-compatible via xAI (cached tokens are a SUBSET of prompt_tokens)', () => {
    // Byte-verbatim OpenAI chat-completions response. 100 prompt tokens of
    // which 60 were cache reads — NOT 160.
    const WIRE = {
      id: 'chatcmpl-contract',
      object: 'chat.completion',
      created: 1,
      model: 'grok-contract',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 60 },
      },
    };

    const model = () =>
      createXai({ apiKey: 'contract-test', fetch: fetchReturning(WIRE) })('grok-contract');

    it('surfaces exactly the key normalizeUsage reads', async () => {
      const step = await captureStep(model());
      // The namespace is derived from the provider id (`"xai.chat"` → `"xai"`),
      // so this also pins that Bernard's namespace-scanning read finds it.
      expect(Object.keys(step.providerMetadata?.xai ?? {}).sort()).toEqual([
        ...OPENAI_COMPATIBLE_CACHE_KEYS,
      ]);
    });

    it('normalizes WITHOUT adding the cached count back in', async () => {
      const step = await captureStep(model());
      expect(normalizeUsage(step.usage, step.providerMetadata)).toEqual({
        // 100, not 160: the provider already counted the cache reads.
        promptTokens: 100,
        completionTokens: 5,
        cacheReadTokens: 60,
        // Implicit caching has no write charge on this path.
        cacheWriteTokens: 0,
      });
    });

    it('is found by namespace scan, not by a hard-coded provider name', async () => {
      // A custom provider wrapping this SDK writes under its own key, which is
      // why `normalizeUsage` scans rather than checking known names. Renaming
      // the namespace must not silently drop the cached count.
      const step = await captureStep(model());
      const renamed = { 'my-local-gateway': step.providerMetadata?.xai };
      expect(normalizeUsage(step.usage, renamed).cacheReadTokens).toBe(60);
    });
  });
});
