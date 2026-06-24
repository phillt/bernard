import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AI SDK so probes never hit the network. The fake generateText
// resolves for "good-*" models and throws shaped errors for the rest.
const generateTextMock = vi.fn();
vi.mock('ai', () => ({ generateText: (args: unknown) => generateTextMock(args) }));

// getModelForConfig / getProviderOptionsForConfig are pure passthroughs here.
vi.mock('./providers/index.js', () => ({
  getModelForConfig: (_c: unknown, provider: string, model: string) => ({ provider, model }),
  getProviderOptionsForConfig: () => undefined,
}));

import { validateModel, validateLineup, formatLineupValidation } from './model-validate.js';
import { ALL_ROLE_IDS } from './model-roles.js';
import { LINEUP_TIERS, type Lineup } from './lineups.js';

const config = { provider: 'xai', model: 'm' } as never;

/** Build a full 6×3 lineup where every slot uses the same (provider, model). */
function uniformLineup(provider: string, model: string): Lineup {
  const roles = {} as Lineup['roles'];
  for (const role of ALL_ROLE_IDS) {
    roles[role] = {} as Lineup['roles'][typeof role];
    for (const tier of LINEUP_TIERS) roles[role][tier] = { provider, model };
  }
  return { id: 'test', name: 'Test', roles, createdAt: 0, updatedAt: 0 };
}

beforeEach(() => {
  generateTextMock.mockReset();
});

describe('validateModel', () => {
  it('returns ok when the probe call resolves', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok' });
    const r = await validateModel(config, 'xai', 'grok-4.3');
    expect(r.ok).toBe(true);
    expect(r.category).toBeUndefined();
    // The probe sends a tiny request (>= OpenAI's 16-token floor).
    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(generateTextMock.mock.calls[0]![0].maxTokens).toBeGreaterThanOrEqual(16);
  });

  it('classifies a "does not exist" message as not_found even on a 400', async () => {
    generateTextMock.mockRejectedValue(
      Object.assign(new Error("The requested model 'gpt-5-chat' does not exist."), { statusCode: 400 }),
    );
    const r = await validateModel(config, 'openai', 'gpt-5-chat');
    expect(r.ok).toBe(false);
    expect(r.category).toBe('not_found');
  });

  it('classifies a 429 as rate_limit (quota)', async () => {
    generateTextMock.mockRejectedValue(
      Object.assign(new Error('You exceeded your current quota'), { statusCode: 429 }),
    );
    const r = await validateModel(config, 'openai', 'gpt-5.5');
    expect(r.category).toBe('rate_limit');
  });

  it('classifies a 401 as auth', async () => {
    generateTextMock.mockRejectedValue(Object.assign(new Error('bad key'), { statusCode: 401 }));
    const r = await validateModel(config, 'openai', 'gpt-5.5');
    expect(r.category).toBe('auth');
  });

  it('omits temperature for reasoning models (e.g. claude-opus-4-8)', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok' });
    await validateModel(config, 'anthropic', 'claude-opus-4-8');
    expect(generateTextMock).toHaveBeenCalledOnce();
    const args = generateTextMock.mock.calls[0]![0];
    // Temperature must be absent entirely — not undefined, not 0.
    expect(Object.prototype.hasOwnProperty.call(args, 'temperature')).toBe(false);
  });

  it('omits temperature for OpenAI o-series reasoning models', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok' });
    await validateModel(config, 'openai', 'o3');
    const args = generateTextMock.mock.calls[0]![0];
    expect(Object.prototype.hasOwnProperty.call(args, 'temperature')).toBe(false);
  });

  it('sends temperature: 0 for non-reasoning models', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok' });
    await validateModel(config, 'openai', 'gpt-4.1');
    const args = generateTextMock.mock.calls[0]![0];
    expect(args.temperature).toBe(0);
  });
});

describe('validateLineup', () => {
  it('dedupes identical slots to a single probe', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok' });
    const v = await validateLineup(config, uniformLineup('xai', 'grok-4.3'));
    // 18 identical slots collapse to one distinct (provider, model) pair.
    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(v.results).toHaveLength(1);
    expect(v.ok).toBe(true);
    expect(v.results[0]!.slots).toHaveLength(18);
  });

  it('reports failures and the slots that use the broken model', async () => {
    // One bad model in a single slot, the rest good.
    const lineup = uniformLineup('xai', 'grok-4.3');
    lineup.roles.executor.cheap = { provider: 'xai', model: 'grok-build-0.1' };
    generateTextMock.mockImplementation((args: { model: { model: string } }) => {
      if (args.model.model === 'grok-build-0.1') {
        return Promise.reject(Object.assign(new Error('Model not found'), { statusCode: 404 }));
      }
      return Promise.resolve({ text: 'ok' });
    });
    const v = await validateLineup(config, lineup);
    expect(v.ok).toBe(false);
    expect(v.failures).toBe(1);
    const bad = v.results.find((r) => !r.ok)!;
    expect(bad.model).toBe('grok-build-0.1');
    expect(bad.category).toBe('not_found');
    expect(bad.slots).toEqual([{ role: 'executor', tier: 'cheap' }]);

    const report = formatLineupValidation(v);
    expect(report).toContain('✗');
    expect(report).toContain('executor/cheap');
  });
});
