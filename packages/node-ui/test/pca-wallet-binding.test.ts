// @vitest-environment happy-dom
//
// B1 — the pre-flight wallet-binding probe (§9.5). Pure read-only logic: per op wallet,
// resolve UNBOUND / own-bound (deregister-first) / sponsor-bound (skip) / inconclusive (#9),
// and the self-coverage outlook that drives the zero-coverage informed-consent warning.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pcaAgentAccount: vi.fn(),
  fetchPca: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, pcaAgentAccount: mocks.pcaAgentAccount, fetchPca: mocks.fetchPca };
});

const { resolveWalletBinding, probeWalletBindings, selfCoverageOutlook } = await import('../src/ui/pca/walletBinding.js');

const OWNER = '0x9A3f000000000000000000000000000000000E41D';
const SPONSOR = '0x1111111111111111111111111111111111111111';
const W = '0xWALLET00000000000000000000000000000000aa';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe('resolveWalletBinding', () => {
  it('UNBOUND when the wallet is an agent on no account', async () => {
    mocks.pcaAgentAccount.mockResolvedValue({ agent: W, accountId: null });
    const b = await resolveWalletBinding(W, OWNER);
    expect(b).toMatchObject({ boundTo: null, canOwn: false, inconclusive: false });
    expect(mocks.fetchPca).not.toHaveBeenCalled(); // no owner read needed when unbound
  });

  it('own-bound (canOwn) when the bound account is owned by this node', async () => {
    mocks.pcaAgentAccount.mockResolvedValue({ agent: W, accountId: '7' });
    mocks.fetchPca.mockResolvedValue({ accountId: '7', owner: OWNER });
    const b = await resolveWalletBinding(W, OWNER);
    expect(b).toMatchObject({ boundTo: '7', canOwn: true, inconclusive: false });
  });

  it('sponsor-bound (NOT canOwn) when the bound account is owned by someone else', async () => {
    mocks.pcaAgentAccount.mockResolvedValue({ agent: W, accountId: '9' });
    mocks.fetchPca.mockResolvedValue({ accountId: '9', owner: SPONSOR });
    const b = await resolveWalletBinding(W, OWNER);
    expect(b).toMatchObject({ boundTo: '9', canOwn: false, inconclusive: false });
  });

  it('INCONCLUSIVE (#9) when the agent probe rejects — never asserted unbound/ownable', async () => {
    mocks.pcaAgentAccount.mockRejectedValue(new Error('boom'));
    const b = await resolveWalletBinding(W, OWNER);
    expect(b).toMatchObject({ boundTo: null, canOwn: false, inconclusive: true });
  });

  it('INCONCLUSIVE when the owner read of a bound account fails (don’t assume ownable)', async () => {
    mocks.pcaAgentAccount.mockResolvedValue({ agent: W, accountId: '9' });
    mocks.fetchPca.mockRejectedValue(new Error('rpc'));
    const b = await resolveWalletBinding(W, OWNER);
    expect(b).toMatchObject({ boundTo: '9', canOwn: false, inconclusive: true });
  });
});

describe('selfCoverageOutlook', () => {
  const mk = (over: Partial<{ boundTo: string | null; canOwn: boolean; inconclusive: boolean }>) =>
    ({ wallet: W, boundTo: null, canOwn: false, inconclusive: false, ...over });

  it('zeroSelfCoverage when EVERY wallet is sponsor-bound (none coverable, none inconclusive)', async () => {
    const o = selfCoverageOutlook([mk({ boundTo: '9' }), mk({ boundTo: '8' })]);
    expect(o.zeroSelfCoverage).toBe(true);
    expect(o.sponsorBound).toHaveLength(2);
    expect(o.selfCoverable).toHaveLength(0);
  });

  it('NOT zeroSelfCoverage with any coverable wallet (unbound or own-bound)', async () => {
    expect(selfCoverageOutlook([mk({ boundTo: null }), mk({ boundTo: '9' })]).zeroSelfCoverage).toBe(false);
    expect(selfCoverageOutlook([mk({ boundTo: '7', canOwn: true }), mk({ boundTo: '9' })]).zeroSelfCoverage).toBe(false);
  });

  it('NOT zeroSelfCoverage while a probe is inconclusive (#9 — don’t assert "covers none")', async () => {
    const o = selfCoverageOutlook([mk({ inconclusive: true }), mk({ boundTo: '9' })]);
    expect(o.zeroSelfCoverage).toBe(false);
    expect(o.inconclusive).toHaveLength(1);
  });

  it('empty wallet set → not zeroSelfCoverage', async () => {
    expect(selfCoverageOutlook([]).zeroSelfCoverage).toBe(false);
  });

  it('ownBound (M3) counts wallets on a PCA the node owns — the migration-disclosure source', async () => {
    const o = selfCoverageOutlook([mk({ boundTo: '4', canOwn: true }), mk({ boundTo: '9' }), mk({ boundTo: null })]);
    expect(o.ownBound).toHaveLength(1);
    expect(o.ownBound[0].boundTo).toBe('4');
    expect(o.sponsorBound).toHaveLength(1); // #9 (not ownable)
    expect(o.selfCoverable).toHaveLength(2); // own-bound #4 (migrate) + unbound
  });
});

describe('probeWalletBindings', () => {
  it('resolves every wallet in parallel', async () => {
    mocks.pcaAgentAccount.mockImplementation(async (w: string) =>
      w === W ? { agent: w, accountId: '7' } : { agent: w, accountId: null },
    );
    mocks.fetchPca.mockResolvedValue({ accountId: '7', owner: OWNER });
    const out = await probeWalletBindings([W, '0xother'], OWNER);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ boundTo: '7', canOwn: true });
    expect(out[1]).toMatchObject({ boundTo: null });
  });
});
