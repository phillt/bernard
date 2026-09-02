import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyClaims = vi.fn();
vi.mock('../claim-verifier.js', () => ({ verifyClaims: (...a: unknown[]) => verifyClaims(...a) }));

const { verifyWrapperClaims } = await import('./tool-wrapper-run.js');
const { ProvenanceStore } = await import('../provenance.js');

function ctx() {
  return {
    provenance: new ProvenanceStore(),
    config: {} as any,
    postWriteChecks: [] as any[],
  } as any;
}

const ok = (result: unknown) => ({ status: 'ok' as const, result });

beforeEach(() => vi.clearAllMocks());

describe('verifyWrapperClaims (#417)', () => {
  // Opt-in by shape: a wrapper that reports no claims is untouched and pays
  // nothing, so this stays off the path of every existing specialist.
  it('leaves a result with no claims alone, without calling the verifier', async () => {
    expect(await verifyWrapperClaims(ok({ answer: 'hi' }), ctx())).toBeNull();
    expect(await verifyWrapperClaims(ok('a plain string'), ctx())).toBeNull();
    expect(verifyClaims).not.toHaveBeenCalled();
  });

  it('does not verify a result that already failed', async () => {
    const r = { status: 'error' as const, result: { claims: [{ text: 'x', sourceIds: ['S1'] }] } };
    expect(await verifyWrapperClaims(r, ctx())).toBeNull();
    expect(verifyClaims).not.toHaveBeenCalled();
  });

  it('leaves a supported answer untouched and records its checks', async () => {
    verifyClaims.mockResolvedValue({
      verdict: 'pass',
      checks: [{ id: 'claim_1', label: 'x', status: 'pass' }],
    });
    const c = ctx();

    const out = await verifyWrapperClaims(ok({ claims: [{ text: 'x', sourceIds: ['S1'] }] }), c);

    expect(out).toBeNull();
    // Published into the turn rubric alongside plan and post-write checks.
    expect(c.postWriteChecks).toHaveLength(1);
  });

  // The point of the whole feature: an unsupported claim fails the run.
  it('turns an unsupported claim into an error the parent sees', async () => {
    verifyClaims.mockResolvedValue({
      verdict: 'fail',
      checks: [
        { id: 'claim_1', label: 'The sky is green.', status: 'fail', evidence: 'S1: not stated' },
        { id: 'claim_2', label: 'ok one', status: 'pass' },
      ],
    });

    const out = await verifyWrapperClaims(
      ok({ answer: 'a', claims: [{ text: 'The sky is green.', sourceIds: ['S1'] }] }),
      ctx(),
    );

    expect(out?.status).toBe('error');
    expect(out?.error).toContain('1/2');
    expect(out?.error).toContain('The sky is green.');
    // The answer is preserved so the caller can see what was rejected.
    expect((out?.result as any).answer).toBe('a');
  });

  it('does not fail the run on a warn verdict', async () => {
    verifyClaims.mockResolvedValue({ verdict: 'warn', checks: [] });
    expect(
      await verifyWrapperClaims(ok({ claims: [{ text: 'x', sourceIds: ['S1'] }] }), ctx()),
    ).toBeNull();
  });

  // A malformed claims array is not "nothing to check" — passing it through
  // would present an unverified answer as a verified one.
  it('rejects claims reported in an unusable shape', async () => {
    const out = await verifyWrapperClaims(ok({ claims: ['just a string', { nope: 1 }] }), ctx());

    expect(out?.status).toBe('error');
    expect(out?.error).toContain('could not be verified');
    expect(verifyClaims).not.toHaveBeenCalled();
  });
});
