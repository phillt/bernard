import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BernardConfig } from './config.js';

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
  traceLlm: <T>(_site: string, _model: string, fn: () => Promise<T>) => fn(),
}));

const resolveSiteModelMock = vi.fn();
vi.mock('./model-policy.js', async () => {
  const actual = await vi.importActual<typeof import('./model-policy.js')>('./model-policy.js');
  return { ...actual, resolveSiteModel: (...a: unknown[]) => resolveSiteModelMock(...a) };
});

const generateTextMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateText: (...a: unknown[]) => generateTextMock(...a) };
});

import {
  proposeConsolidation,
  validProposals,
  MAX_PROPOSALS_PER_RUN,
  type MemoryProposal,
} from './memory-consolidation.js';

const config = { cacheEnabled: false } as unknown as BernardConfig;
const reply = (text: string) => ({
  text,
  usage: { promptTokens: 10, completionTokens: 5 },
  providerMetadata: undefined,
});

/**
 * The real store's own texts. These are the fixtures that matter: the design
 * was corrected twice by reading them, and a synthetic "note A / note B" pair
 * would have caught neither error.
 */
const REAL = {
  issue: 'I gave you the link https://github.com/TheNextDialer/CRM/issues/3417',
  'issue-3538':
    'whenever I give you issue numbers, you need to look them up via gh cli and get details yourself.',
  '3772': 'any issue numbers like that need to be researched via gh',
  'email-accounts':
    'phil@phoneburner.com: work email\npowerphillg5@gmail.com: personal email\nBoth authenticated via Google MCP.',
  'email-accounts-professional':
    "contact@felipetadeo.dev is the user's professional (non-work) account, used for pro stuff that is not PhoneBurner work.",
};
const entries = Object.entries(REAL).map(([key, content]) => ({ key, content }));

beforeEach(() => {
  vi.clearAllMocks();
  resolveSiteModelMock.mockReturnValue({
    model: { modelId: 'mock-model' },
    providerOptions: undefined,
    params: {},
    provider: 'anthropic',
    modelName: 'claude-test',
    tier: 'cheap',
  });
});

describe('proposeConsolidation', () => {
  it('resolves the memory-consolidator site', async () => {
    generateTextMock.mockResolvedValue(reply('{"proposals":[]}'));
    await proposeConsolidation(entries, config);
    expect(resolveSiteModelMock).toHaveBeenCalledWith(config, 'memory-consolidator');
  });

  it('returns the proposals the model makes, once they check out', async () => {
    generateTextMock.mockResolvedValue(
      reply(
        JSON.stringify({
          proposals: [
            { kind: 'duplicate', keys: ['issue-3538', '3772'], keeper: 'issue-3538', reason: 'r' },
          ],
        }),
      ),
    );
    const out = await proposeConsolidation(entries, config);
    expect(out).toEqual([
      { kind: 'duplicate', keys: ['issue-3538', '3772'], keeper: 'issue-3538', reason: 'r' },
    ]);
  });

  it('fails CLOSED on unparseable output', async () => {
    // The claim-verifier posture: the neutral outcome here is a proposal to
    // retire the user's own notes, so garbage must propose nothing.
    generateTextMock.mockResolvedValue(reply('I think maybe some of these overlap?'));
    expect(await proposeConsolidation(entries, config)).toEqual([]);
  });

  it('fails closed when the call throws', async () => {
    generateTextMock.mockRejectedValue(new Error('boom'));
    expect(await proposeConsolidation(entries, config)).toEqual([]);
  });

  it('does not call the model for a store too small to have redundancy', async () => {
    expect(await proposeConsolidation(entries.slice(0, 2), config)).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('records usage against the site, so the spend is not invisible', async () => {
    generateTextMock.mockResolvedValue(reply('{"proposals":[]}'));
    const onUsage = vi.fn();
    await proposeConsolidation(entries, config, { onUsage });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0]).toMatchObject({ site: 'memory-consolidator' });
  });

  it('caps the corpus at the budget the repo already owns', async () => {
    // Unbounded, the store this pass exists to serve is by definition the one
    // whose prompt overruns — the cut lands provider-side, the reply is
    // truncated, and `parseStructuredOutput` fails closed. So the LARGEST
    // stores would silently propose nothing, which is the opposite of the
    // point.
    const { MAX_PERSISTENT_MEMORY_CHARS } = await import('./context-message.js');
    generateTextMock.mockResolvedValue(reply('{"proposals":[]}'));
    const huge = Array.from({ length: 60 }, (_, i) => ({
      key: `k${i}`,
      content: 'x'.repeat(1000),
    }));

    await proposeConsolidation(huge, config);

    const content = generateTextMock.mock.calls[0][0].messages[0].content as string;
    expect(content.length).toBeLessThanOrEqual(MAX_PERSISTENT_MEMORY_CHARS + 200);
  });

  it('never cuts a record in half', async () => {
    // Judging half a note is how a standing instruction gets proposed for
    // retirement on the strength of its first sentence.
    generateTextMock.mockResolvedValue(reply('{"proposals":[]}'));
    const huge = Array.from({ length: 60 }, (_, i) => ({
      key: `k${i}`,
      content: `START-${i} ${'x'.repeat(1000)} END-${i}`,
    }));

    await proposeConsolidation(huge, config);

    const content = generateTextMock.mock.calls[0][0].messages[0].content as string;
    const starts = [...content.matchAll(/START-(\d+)/g)].map((m) => m[1]);
    for (const i of starts) expect(content).toContain(`END-${i}`);
    expect(starts.length).toBeGreaterThan(0);
  });

  it('will not honour a proposal about a record the cap cut', async () => {
    // The model cannot have seen it, so naming it is invented by definition.
    const huge = Array.from({ length: 60 }, (_, i) => ({
      key: `k${i}`,
      content: 'x'.repeat(1000),
    }));
    generateTextMock.mockResolvedValue(
      reply(JSON.stringify({ proposals: [{ kind: 'stale', keys: ['k59'], reason: 'r' }] })),
    );
    expect(await proposeConsolidation(huge, config)).toEqual([]);
  });

  it('puts every key and its text in front of the model', async () => {
    generateTextMock.mockResolvedValue(reply('{"proposals":[]}'));
    await proposeConsolidation(entries, config);
    const content = generateTextMock.mock.calls[0][0].messages[0].content as string;
    for (const [key, text] of Object.entries(REAL)) {
      expect(content).toContain(key);
      expect(content).toContain(text.split('\n')[0]);
    }
  });
});

describe('validProposals — the sole gate', () => {
  const known = new Set(Object.keys(REAL));

  it('drops a proposal naming a key that does not exist', () => {
    const p: MemoryProposal[] = [{ kind: 'stale', keys: ['invented-by-the-model'], reason: 'r' }];
    expect(validProposals(p, known)).toEqual([]);
  });

  it('drops a duplicate whose keeper is not in its own group', () => {
    const p: MemoryProposal[] = [
      { kind: 'duplicate', keys: ['issue-3538', '3772'], keeper: 'email-accounts', reason: 'r' },
    ];
    expect(validProposals(p, known)).toEqual([]);
  });

  it('drops a duplicate group of one', () => {
    const p: MemoryProposal[] = [
      { kind: 'duplicate', keys: ['3772'], keeper: '3772', reason: 'r' },
    ];
    expect(validProposals(p, known)).toEqual([]);
  });

  it('drops a merge with no drafted text', () => {
    const p: MemoryProposal[] = [
      { kind: 'merge', keys: ['issue', '3772'], proposedKey: 'k', proposedText: '  ', reason: 'r' },
    ];
    expect(validProposals(p, known)).toEqual([]);
  });

  it('never lets two proposals claim the same memory', () => {
    // Otherwise the user accepts both and the second refers to a record the
    // first already retired.
    const p: MemoryProposal[] = [
      { kind: 'duplicate', keys: ['issue-3538', '3772'], keeper: 'issue-3538', reason: 'r' },
      { kind: 'stale', keys: ['3772'], reason: 'r' },
    ];
    expect(validProposals(p, known)).toHaveLength(1);
  });

  it('caps a run', () => {
    // More inputs than the cap, and an EXACT expectation. With five inputs and
    // a cap of five, `toBeLessThanOrEqual` passes whether the cap exists or
    // not — a test that cannot fail, which the mutation check caught.
    const many = Array.from({ length: MAX_PROPOSALS_PER_RUN + 3 }, (_, i) => `k${i}`);
    const p: MemoryProposal[] = many.map((k) => ({
      kind: 'stale' as const,
      keys: [k],
      reason: 'r',
    }));
    expect(validProposals(p, new Set(many))).toHaveLength(MAX_PROPOSALS_PER_RUN);
  });

  it('keeps a well-formed proposal', () => {
    const p: MemoryProposal[] = [
      { kind: 'duplicate', keys: ['issue-3538', '3772'], keeper: 'issue-3538', reason: 'r' },
    ];
    expect(validProposals(p, known)).toEqual(p);
  });
});
