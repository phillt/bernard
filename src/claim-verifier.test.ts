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

    const out = await verifyClaims([{ text: 'The sky is blue.', sourceIds: [id] }], store, config);

    expect(out.verdict).toBe('pass');
    expect(out.checks[0].status).toBe('pass');
  });

  it('fails a claim the source does not support', async () => {
    const { store, id } = storeWith('The sky is blue.');
    verdict(false, 'source says nothing about temperature');

    const out = await verifyClaims([{ text: 'It is 30 degrees.', sourceIds: [id] }], store, config);

    expect(out.verdict).toBe('fail');
    expect(out.checks[0].evidence).toContain('temperature');
  });

  // The exact SourceCheckup failure: a real, valid citation attached to words
  // the page never said.
  it('fails a fabricated quote without asking the model', async () => {
    const { store, id } = storeWith('The default timeout is 30 seconds.');

    const out = await verifyClaims(
      [{ text: 'Timeout is 60s.', sourceIds: [id], quote: 'the default timeout is 60 seconds' }],
      store,
      config,
    );

    expect(out.verdict).toBe('fail');
    expect(generateText).not.toHaveBeenCalled();
  });

  // The case Phase 3 exists for — a quote past the old 2,000-char preview cap.
  it('verifies a quote from the middle of a long page', async () => {
    const { store, id } = storeWith('A'.repeat(5000) + ' the needle phrase ' + 'B'.repeat(5000));
    verdict(true);

    const out = await verifyClaims(
      [{ text: 'x', sourceIds: [id], quote: 'the needle phrase' }],
      store,
      config,
    );

    expect(out.verdict).toBe('pass');
  });

  it('fails a claim citing an id nothing registered', async () => {
    const { store } = storeWith('text');

    const out = await verifyClaims([{ text: 'x', sourceIds: ['S99'] }], store, config);

    expect(out.checks[0].status).toBe('fail');
    expect(out.checks[0].evidence).toContain('S99');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('fails a claim that cites nothing', async () => {
    const { store } = storeWith('text');
    const out = await verifyClaims([{ text: 'x', sourceIds: [] }], store, config);
    expect(out.checks[0].evidence).toBe('No source cited.');
  });

  // Fails CLOSED, unlike the pre-turn passes. A silent pass here would turn an
  // unchecked answer into an apparently-checked one.
  it('fails closed on an unparseable verdict', async () => {
    const { store, id } = storeWith('text');
    generateText.mockResolvedValue({ text: 'I think probably yes?', usage: {} });

    const out = await verifyClaims([{ text: 'x', sourceIds: [id] }], store, config);

    expect(out.verdict).toBe('fail');
  });

  it('fails closed when the call throws', async () => {
    const { store, id } = storeWith('text');
    generateText.mockRejectedValue(new Error('network'));

    const out = await verifyClaims([{ text: 'x', sourceIds: [id] }], store, config);

    expect(out.verdict).toBe('fail');
  });

  it('warns rather than passing when there is nothing to check', async () => {
    const out = await verifyClaims([], new ProvenanceStore(), config);
    expect(out.verdict).toBe('warn');
    expect(out.checks).toEqual([]);
  });

  it('takes the worst verdict across claims', async () => {
    const { store, id } = storeWith('text');
    generateText
      .mockResolvedValueOnce({ text: '{"supported":true,"reason":"a"}', usage: {} })
      .mockResolvedValueOnce({ text: '{"supported":false,"reason":"b"}', usage: {} });

    const out = await verifyClaims(
      [
        { text: 'one', sourceIds: [id] },
        { text: 'two', sourceIds: [id] },
      ],
      store,
      config,
    );

    expect(out.verdict).toBe('fail');
    expect(out.checks).toHaveLength(2);
  });
});
