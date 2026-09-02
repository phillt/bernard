import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateText = vi.fn();
vi.mock('ai', () => ({ generateText: (...a: unknown[]) => generateText(...a) }));
vi.mock('./model-policy.js', () => ({
  resolveSiteModel: () => ({
    model: { modelId: 'test-model' },
    providerOptions: {},
    params: {},
    provider: 'anthropic',
    modelName: 'test-model',
    tier: 'cheap',
  }),
}));

const { verifyClaims, quoteAppearsIn } = await import('./claim-verifier.js');
const { verdictOf } = await import('./rubric.js');
const { ProvenanceStore } = await import('./provenance.js');

const config = { cacheEnabled: false } as any;
const verdict = (supported: boolean, reason = 'r') =>
  generateText.mockResolvedValue({ text: JSON.stringify({ supported, reason }), usage: {} });

function storeWith(text: string) {
  const store = new ProvenanceStore();
  const id = store.add({
    kind: 'web',
    label: 'Page',
    contentPreview: text.slice(0, 50),
    rawRef: 'https://e.com',
    verifyText: text,
  });
  return { store, id };
}

beforeEach(() => vi.clearAllMocks());

describe('quoteAppearsIn', () => {
  const sources = [
    { verifyText: 'The default\ntimeout is 30 seconds.', contentPreview: '' },
  ] as any;

  it('matches across line breaks introduced by markdown conversion', () => {
    expect(quoteAppearsIn('The default timeout is 30 seconds.', sources)).toBe(true);
  });

  it('rejects a quote the source does not contain', () => {
    expect(quoteAppearsIn('The default timeout is 60 seconds.', sources)).toBe(false);
  });

  it('falls back to the preview when no verifyText was retained', () => {
    expect(quoteAppearsIn('hello', [{ contentPreview: 'well hello there' }] as any)).toBe(true);
  });
});

describe('verifyClaims', () => {
  it('passes a claim the source supports', async () => {
    const { store, id } = storeWith('The sky is blue on clear days.');
    verdict(true, 'stated directly');

    const checks = await verifyClaims(
      [{ text: 'The sky is blue.', sourceIds: [id] }],
      store,
      config,
    );

    expect(verdictOf(checks)).toBe('pass');
    expect(checks[0].status).toBe('pass');
  });

  it('fails a claim the source does not support', async () => {
    const { store, id } = storeWith('The sky is blue.');
    verdict(false, 'source says nothing about temperature');

    const checks = await verifyClaims(
      [{ text: 'It is 30 degrees.', sourceIds: [id] }],
      store,
      config,
    );

    expect(verdictOf(checks)).toBe('fail');
    expect(checks[0].evidence).toContain('temperature');
  });

  // The exact SourceCheckup failure: a real, valid citation attached to words
  // the page never said.
  it('fails a fabricated quote without asking the model', async () => {
    const { store, id } = storeWith('The default timeout is 30 seconds.');

    const checks = await verifyClaims(
      [{ text: 'Timeout is 60s.', sourceIds: [id], quote: 'the default timeout is 60 seconds' }],
      store,
      config,
    );

    expect(verdictOf(checks)).toBe('fail');
    expect(generateText).not.toHaveBeenCalled();
  });

  // The case Phase 3 exists for — a quote past the old 2,000-char preview cap.
  it('verifies a quote from the middle of a long page', async () => {
    const { store, id } = storeWith('A'.repeat(5000) + ' the needle phrase ' + 'B'.repeat(5000));
    verdict(true);

    const checks = await verifyClaims(
      [{ text: 'x', sourceIds: [id], quote: 'the needle phrase' }],
      store,
      config,
    );

    expect(verdictOf(checks)).toBe('pass');
  });

  it('fails a claim citing an id nothing registered', async () => {
    const { store } = storeWith('text');

    const checks = await verifyClaims([{ text: 'x', sourceIds: ['S99'] }], store, config);

    expect(checks[0].status).toBe('fail');
    expect(checks[0].evidence).toContain('S99');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('fails a claim that cites nothing', async () => {
    const { store } = storeWith('text');
    const checks = await verifyClaims([{ text: 'x', sourceIds: [] }], store, config);
    expect(checks[0].evidence).toBe('No source cited.');
  });

  // Fails CLOSED, unlike the pre-turn passes. A silent pass here would turn an
  // unchecked answer into an apparently-checked one.
  it('fails closed on an unparseable verdict', async () => {
    const { store, id } = storeWith('text');
    generateText.mockResolvedValue({ text: 'I think probably yes?', usage: {} });

    const checks = await verifyClaims([{ text: 'x', sourceIds: [id] }], store, config);

    expect(verdictOf(checks)).toBe('fail');
  });

  it('fails closed when the call throws', async () => {
    const { store, id } = storeWith('text');
    generateText.mockRejectedValue(new Error('network'));

    const checks = await verifyClaims([{ text: 'x', sourceIds: [id] }], store, config);

    expect(verdictOf(checks)).toBe('fail');
  });

  // "nothing was asserted" is the caller's decision now — `verifyWrapperClaims`
  // returns before ever calling in, so this only pins that an empty list costs
  // nothing and invents no checks.
  it('does no work and returns no checks for an empty list', async () => {
    const checks = await verifyClaims([], new ProvenanceStore(), config);
    expect(checks).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('takes the worst verdict across claims', async () => {
    const { store, id } = storeWith('text');
    generateText
      .mockResolvedValueOnce({ text: '{"supported":true,"reason":"a"}', usage: {} })
      .mockResolvedValueOnce({ text: '{"supported":false,"reason":"b"}', usage: {} });

    const checks = await verifyClaims(
      [
        { text: 'one', sourceIds: [id] },
        { text: 'two', sourceIds: [id] },
      ],
      store,
      config,
    );

    expect(verdictOf(checks)).toBe('fail');
    expect(checks).toHaveLength(2);
  });
});

// Review #433: the quote gate runs against the whole retained source (20k) while
// the entailment window is a fraction of it. A head-only window meant a quote
// found at char 12,000 passed the gate, then the model was shown a region that
// did not contain the passage, answered `supported: false`, and — because the
// pass fails closed — rejected a correctly-sourced answer.
describe('the entailment window follows the quote', () => {
  const PASSAGE = 'the retry budget is three attempts';
  const longPage = 'x'.repeat(12000) + ` ${PASSAGE} ` + 'y'.repeat(12000);

  function contentSentToModel(): string {
    const call = generateText.mock.calls.at(-1)![0];
    return call.messages[0].content as string;
  }

  it('shows the model the region the quote gate matched, not the head', async () => {
    const { store, id } = storeWith(longPage);
    verdict(true);

    await verifyClaims(
      [{ text: 'Retries are capped at three.', sourceIds: [id], quote: PASSAGE }],
      store,
      config,
    );

    expect(contentSentToModel()).toContain(PASSAGE);
  });

  it('marks an excerpted window so "not mentioned" is scoped to it', async () => {
    const { store, id } = storeWith(longPage);
    verdict(true);

    await verifyClaims([{ text: 'x', sourceIds: [id], quote: PASSAGE }], store, config);

    expect(contentSentToModel()).toContain('…');
  });

  it('still takes the head when there is no quote to locate', async () => {
    const { store, id } = storeWith('HEADMARK' + 'z'.repeat(20000));
    verdict(true);

    await verifyClaims([{ text: 'x', sourceIds: [id] }], store, config);

    expect(contentSentToModel()).toContain('HEADMARK');
  });

  it('sends a short source whole, with no excerpt marker', async () => {
    const { store, id } = storeWith('short and complete');
    verdict(true);

    await verifyClaims([{ text: 'x', sourceIds: [id], quote: 'complete' }], store, config);

    const sent = contentSentToModel();
    expect(sent).toContain('short and complete');
    expect(sent).not.toContain('…');
  });

  it('matches a quote across a line break the source wraps at', async () => {
    const { store, id } = storeWith(
      'a'.repeat(9000) + '\nthe default\ntimeout is 30 seconds\n' + 'b'.repeat(9000),
    );
    verdict(true);

    await verifyClaims(
      [{ text: 'x', sourceIds: [id], quote: 'the default timeout is 30 seconds' }],
      store,
      config,
    );

    expect(contentSentToModel()).toContain('timeout is 30 seconds');
  });
});

// Review #433: one LLM call per factual sentence is real spend, and was invisible
// to the per-turn odometer and the session ledger.
describe('usage attribution', () => {
  it('reports a usage record per verified claim', async () => {
    const { store, id } = storeWith('text');
    generateText.mockResolvedValue({
      text: '{"supported":true,"reason":"r"}',
      usage: { promptTokens: 10, completionTokens: 2 },
    });
    const onUsage = vi.fn();

    await verifyClaims(
      [
        { text: 'one', sourceIds: [id] },
        { text: 'two', sourceIds: [id] },
      ],
      store,
      config,
      { onUsage },
    );

    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage.mock.calls[0][0].site).toBe('claim-verifier');
  });

  // The deterministic gates short-circuit before any call, so they must not
  // report spend that did not happen.
  it('reports nothing for a claim rejected without a model call', async () => {
    const { store, id } = storeWith('the timeout is 30 seconds');
    const onUsage = vi.fn();

    await verifyClaims(
      [{ text: 'x', sourceIds: [id], quote: 'the timeout is 60 seconds' }],
      store,
      config,
      { onUsage },
    );

    expect(onUsage).not.toHaveBeenCalled();
  });
});
