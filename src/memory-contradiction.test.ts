import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', () => ({ generateText: generateTextMock }));
vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
  traceLlm: (_a: unknown, _b: unknown, fn: any) => fn(),
}));
vi.mock('./model-policy.js', () => ({
  resolveSiteModel: vi.fn(() => ({
    model: { modelId: 'test-model' },
    providerOptions: undefined,
    params: {},
    provider: 'anthropic',
    modelName: 'test-model',
    tier: 'cheap',
    source: 'policy',
  })),
}));

import { checkContradiction, NO_CONTRADICTION } from './memory-contradiction.js';
import type { ConsolidationInput } from './memory-consolidation.js';

const config = { provider: 'anthropic' } as never;
const existing: ConsolidationInput[] = [
  { key: 'daily-blaze-format', content: 'The Daily Blaze template includes a Time line.' },
  { key: 'email-accounts', content: 'Work and personal Gmail.' },
];

function reply(obj: unknown): void {
  generateTextMock.mockResolvedValue({ text: JSON.stringify(obj), usage: {} });
}

beforeEach(() => vi.clearAllMocks());

describe('write-time contradiction detection (#373)', () => {
  it('reports a supersession when the new note states the opposite', async () => {
    reply({
      verdict: 'supersede',
      key: 'daily-blaze-format',
      reason: 'The Time line is now excluded.',
    });
    const v = await checkContradiction(
      { key: 'daily-blaze-no-time', content: 'No Time line in the Daily Blaze.' },
      existing,
      config,
    );
    expect(v).toEqual({
      kind: 'supersede',
      key: 'daily-blaze-format',
      reason: 'The Time line is now excluded.',
    });
  });

  it('is silent for a complementary pair', async () => {
    // The real `email-accounts` case: a note adding a third account does not
    // contradict a note listing two. Measured in #529 as the category most
    // likely to be flagged wrongly.
    reply({ verdict: 'none' });
    const v = await checkContradiction(
      { key: 'email-accounts-professional', content: 'A third, professional account.' },
      existing,
      config,
    );
    expect(v).toBe(NO_CONTRADICTION);
  });

  describe('fails OPEN — the opposite of its two nearest neighbours', () => {
    // `claim-verifier` and `memory-consolidation` both fail closed, because
    // their neutral outcome is "say nothing". Here the neutral outcome is
    // losing a memory the user asked to keep.
    it('on an unparseable reply', async () => {
      generateTextMock.mockResolvedValue({ text: 'not json at all', usage: {} });
      expect(await checkContradiction({ key: 'k', content: 'c' }, existing, config)).toBe(
        NO_CONTRADICTION,
      );
    });

    it('when the model call throws', async () => {
      generateTextMock.mockRejectedValue(new Error('provider down'));
      expect(await checkContradiction({ key: 'k', content: 'c' }, existing, config)).toBe(
        NO_CONTRADICTION,
      );
    });

    it('when the verdict names a key that was never sent', async () => {
      // An invented key would have the caller offer to retire a memory that
      // does not exist.
      reply({ verdict: 'supersede', key: 'no-such-note', reason: 'x' });
      expect(await checkContradiction({ key: 'k', content: 'c' }, existing, config)).toBe(
        NO_CONTRADICTION,
      );
    });

    it('when the verdict names no key at all', async () => {
      reply({ verdict: 'ask', reason: 'x' });
      expect(await checkContradiction({ key: 'k', content: 'c' }, existing, config)).toBe(
        NO_CONTRADICTION,
      );
    });
  });

  it('costs nothing when there is nothing to contradict', async () => {
    expect(await checkContradiction({ key: 'k', content: 'c' }, [], config)).toBe(NO_CONTRADICTION);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('never compares a note against itself', async () => {
    // A same-key write is a replacement the caller asked for. Sending it as
    // "already saved" invites the model to report the note contradicting
    // itself.
    reply({ verdict: 'none' });
    await checkContradiction(
      { key: 'email-accounts', content: 'Work and personal Gmail, plus a third.' },
      existing,
      config,
    );
    const sent = String(generateTextMock.mock.calls[0][0].messages[0].content);
    expect(sent.match(/### email-accounts\n/g) ?? []).toHaveLength(1);
  });

  it('reports its spend, which a tool otherwise has no way to do', async () => {
    reply({ verdict: 'none' });
    const onUsage = vi.fn();
    await checkContradiction({ key: 'k', content: 'c' }, existing, config, { onUsage });
    expect(onUsage).toHaveBeenCalled();
  });
});

/**
 * The corpus is bounded, and the INCOMING note is charged against the bound.
 *
 * The head carries caller-supplied content with no cap of its own, so a head
 * that did not count could push the whole message past `MAX_PERSISTENT_MEMORY_
 * CHARS` — which is the one thing the shared `renderMemoryCorpus` exists to
 * prevent, and the reason the incoming note goes in as `head` rather than being
 * concatenated afterwards.
 */
describe('the message is bounded', () => {
  function userContent(): string {
    return String(generateTextMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content ?? '');
  }

  it('charges the incoming note against the budget, so a huge one crowds out the corpus', async () => {
    reply({ verdict: 'none' });
    const { MAX_PERSISTENT_MEMORY_CHARS } = await import('./context-message.js');
    const huge = 'x'.repeat(MAX_PERSISTENT_MEMORY_CHARS);
    await checkContradiction({ key: 'k', content: huge }, existing, config);
    const sent = userContent();
    expect(sent).toContain(huge);
    // Nothing from the corpus fits beside it — the budget was actually applied
    // to the head, not only to the rows.
    expect(sent).not.toContain('daily-blaze-format');
  });

  it('sends the corpus when the incoming note leaves room', async () => {
    reply({ verdict: 'none' });
    await checkContradiction({ key: 'k', content: 'short' }, existing, config);
    expect(userContent()).toContain('daily-blaze-format');
  });
});
