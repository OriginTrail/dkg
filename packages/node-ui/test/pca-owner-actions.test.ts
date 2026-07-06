// @vitest-environment happy-dom
//
// Owner-action seam delegation + H-B resolver contract.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const HOT = `0x${'11'.repeat(20)}`;
const HW = `0x${'22'.repeat(20)}`;
const EXTERNAL = `0x${'33'.repeat(20)}`;
const AGENT = `0x${'44'.repeat(20)}`;
const CONTRACTS = {
  nft: `0x${'55'.repeat(20)}`,
  token: `0x${'66'.repeat(20)}`,
  chainId: 'base:84532',
  rpcUrls: ['https://rpc.example'],
};

const mocks = vi.hoisted(() => {
  const walletSubmitter = {
    create: vi.fn(),
    registerAgent: vi.fn(),
    deregisterAgent: vi.fn(),
    topUp: vi.fn(),
    settle: vi.fn(),
  };
  return {
    createPca: vi.fn(),
    fetchPca: vi.fn(),
    fetchWalletsBalances: vi.fn(),
    pcaAddAgent: vi.fn(),
    pcaRemoveAgent: vi.fn(),
    pcaTopUp: vi.fn(),
    pcaSettle: vi.fn(),
    walletOwnerActionSubmitter: vi.fn(() => walletSubmitter),
    walletSubmitter,
  };
});

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, ...mocks };
});

vi.mock('../src/ui/web3/walletOwnerActionSubmitter.js', () => ({
  walletOwnerActionSubmitter: mocks.walletOwnerActionSubmitter,
}));

const {
  ReadOnlyOwnerActionError,
  OwnerActionUnavailableError,
  daemonOwnerActionSubmitter,
  resolveOwnerActionSubmitterKind,
  submitterKindForOwnerMode,
  useOwnerActionSubmitterForAccount,
  useOwnerActionSubmitter,
  resolveSignerKindForAccount,
} = await import('../src/ui/pca/ownerActions.js');
const { useWalletStore } = await import('../src/ui/stores/wallet.js');
const { resolvePcaOwnerAccess } = await import('../src/ui/pca/ownerAccess.js');

const provider = { request: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as any;

function setConnected(
  address: string | null,
  opts: { provider?: unknown; chainId?: number; expectedChainId?: number; bootstrap?: unknown } = {},
) {
  const nextProvider = Object.prototype.hasOwnProperty.call(opts, 'provider')
    ? opts.provider
    : address
      ? provider
      : null;
  const bootstrap = Object.prototype.hasOwnProperty.call(opts, 'bootstrap')
    ? opts.bootstrap
    : address
      ? CONTRACTS
      : null;
  useWalletStore.setState({
    provider: nextProvider as any,
    providerInfo: null,
    address: address as `0x${string}` | null,
    chainId: opts.chainId ?? (address ? 84532 : null),
    expectedChainId: opts.expectedChainId ?? (address ? 84532 : null),
    bootstrap: bootstrap as any,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setConnected(null);
});

describe('daemonOwnerActionSubmitter delegation contract', () => {
  it('create -> createPca(args), result passed through', async () => {
    mocks.createPca.mockResolvedValue({ accountId: '7' });
    const res = await daemonOwnerActionSubmitter.create({ tokens: '100', primaryNode: '42' });
    expect(mocks.createPca).toHaveBeenCalledWith({ tokens: '100', primaryNode: '42' });
    expect(res).toEqual({ accountId: '7' });
  });

  it('registerAgent -> pcaAddAgent(accountId, agent)', async () => {
    mocks.pcaAddAgent.mockResolvedValue({ registered: true });
    const res = await daemonOwnerActionSubmitter.registerAgent('7', AGENT);
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('7', AGENT);
    expect(res).toEqual({ registered: true });
  });

  it('deregisterAgent -> pcaRemoveAgent(accountId, agent)', async () => {
    mocks.pcaRemoveAgent.mockResolvedValue({ deregistered: true });
    const res = await daemonOwnerActionSubmitter.deregisterAgent('7', AGENT);
    expect(mocks.pcaRemoveAgent).toHaveBeenCalledWith('7', AGENT);
    expect(res).toEqual({ deregistered: true });
  });

  it('topUp -> pcaTopUp(accountId, tokens)', async () => {
    mocks.pcaTopUp.mockResolvedValue({ addedTokens: '50' });
    const res = await daemonOwnerActionSubmitter.topUp('7', '50');
    expect(mocks.pcaTopUp).toHaveBeenCalledWith('7', '50');
    expect(res).toEqual({ addedTokens: '50' });
  });

  it('settle -> pcaSettle(accountId)', async () => {
    mocks.pcaSettle.mockResolvedValue({ settled: true });
    const res = await daemonOwnerActionSubmitter.settle('7');
    expect(mocks.pcaSettle).toHaveBeenCalledWith('7');
    expect(res).toEqual({ settled: true });
  });
});

describe('owner submitter resolver', () => {
  it('classifies wallets[0]-owned as daemon even if that wallet is connected', () => {
    expect(resolveOwnerActionSubmitterKind({ owner: HOT, primaryWallet: HOT, connectedWallet: HOT })).toBe('daemon');
  });

  it('classifies connected owner != wallets[0] as wallet-managed', () => {
    expect(resolveOwnerActionSubmitterKind({ owner: HW, primaryWallet: HOT, connectedWallet: HW })).toBe('wallet');
  });

  it('classifies an unconnected external owner as read-only', () => {
    expect(resolveOwnerActionSubmitterKind({ owner: EXTERNAL, primaryWallet: HOT, connectedWallet: HW })).toBe('read-only');
  });

  it('create ownerKey absent/hot routes to daemon and connected hardware routes to wallet', async () => {
    mocks.createPca.mockResolvedValue({ accountId: '1' });
    mocks.walletSubmitter.create.mockResolvedValue({ accountId: '2' });

    await expect(useOwnerActionSubmitterForAccount().create({ tokens: '0.5', primaryNode: '41' }))
      .resolves.toEqual({ accountId: '1' });
    expect(mocks.createPca).toHaveBeenCalledWith({ tokens: '0.5', primaryNode: '41' });

    await expect(useOwnerActionSubmitterForAccount({ ownerKey: 'hot' }).create({ tokens: '1', primaryNode: '42' }))
      .resolves.toEqual({ accountId: '1' });
    expect(mocks.createPca).toHaveBeenCalledWith({ tokens: '1', primaryNode: '42' });

    setConnected(HW);
    await expect(useOwnerActionSubmitterForAccount({ ownerKey: 'hardware' }).create({ tokens: '2', primaryNode: '43' }))
      .resolves.toEqual({ accountId: '2' });
    expect(mocks.walletOwnerActionSubmitter).toHaveBeenCalled();
    expect(mocks.walletSubmitter.create).toHaveBeenCalledWith({ tokens: '2', primaryNode: '43' });
  });

  it('create ownerKey hardware fails unavailable without provider or expected chain before wallet signing', async () => {
    await expect(useOwnerActionSubmitterForAccount({ ownerKey: 'hardware' }).create({ tokens: '1', primaryNode: '42' }))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    setConnected(HW, { chainId: 1, expectedChainId: 84532 });
    await expect(useOwnerActionSubmitterForAccount({ ownerKey: 'hardware' }).create({ tokens: '1', primaryNode: '42' }))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    setConnected(HW, { bootstrap: null });
    await expect(useOwnerActionSubmitterForAccount({ ownerKey: 'hardware' }).create({ tokens: '1', primaryNode: '42' }))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    expect(mocks.walletOwnerActionSubmitter).not.toHaveBeenCalled();
    expect(mocks.walletSubmitter.create).not.toHaveBeenCalled();
  });

  it('manage write uses daemon when the PCA owner is wallets[0], even if connected', async () => {
    setConnected(HOT);
    mocks.fetchPca.mockResolvedValue({ owner: HOT });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });
    mocks.pcaAddAgent.mockResolvedValue({ registered: true });

    await expect(useOwnerActionSubmitterForAccount({ accountId: '7' }).registerAgent('7', AGENT))
      .resolves.toEqual({ registered: true });

    expect(mocks.fetchPca).toHaveBeenCalledWith('7');
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('7', AGENT);
    expect(mocks.walletSubmitter.registerAgent).not.toHaveBeenCalled();
  });

  it('manage write uses the wallet submitter when connected owner differs from wallets[0]', async () => {
    setConnected(HW);
    mocks.fetchPca.mockResolvedValue({ owner: HW });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });
    mocks.walletSubmitter.topUp.mockResolvedValue({ addedTokens: '10' });

    await expect(useOwnerActionSubmitterForAccount({ accountId: '7' }).topUp('7', '10'))
      .resolves.toEqual({ addedTokens: '10' });

    expect(mocks.pcaTopUp).not.toHaveBeenCalled();
    expect(mocks.walletSubmitter.topUp).toHaveBeenCalledWith('7', '10');
  });

  it('external-owned manage writes fail read-only and do not sign', async () => {
    setConnected(HW);
    mocks.fetchPca.mockResolvedValue({ owner: EXTERNAL });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });

    await expect(useOwnerActionSubmitterForAccount({ accountId: '7' }).deregisterAgent('7', AGENT))
      .rejects.toBeInstanceOf(ReadOnlyOwnerActionError);

    expect(mocks.pcaRemoveAgent).not.toHaveBeenCalled();
    expect(mocks.walletSubmitter.deregisterAgent).not.toHaveBeenCalled();
  });

  it('fetch failures fail unavailable and do not sign', async () => {
    setConnected(HW);
    mocks.fetchPca.mockRejectedValue(new Error('read failed'));

    await expect(useOwnerActionSubmitterForAccount({ accountId: '7' }).topUp('7', '10'))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    expect(mocks.pcaTopUp).not.toHaveBeenCalled();
    expect(mocks.walletSubmitter.topUp).not.toHaveBeenCalled();
  });

  it('connected-owner writes fail unavailable on wrong chain or missing provider before wallet signing', async () => {
    mocks.fetchPca.mockResolvedValue({ owner: HW });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });

    setConnected(HW, { chainId: 1, expectedChainId: 84532 });
    await expect(useOwnerActionSubmitterForAccount({ accountId: '7' }).registerAgent('7', AGENT))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    setConnected(HW, { provider: null });
    await expect(useOwnerActionSubmitterForAccount({ accountId: '7' }).registerAgent('7', AGENT))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    expect(mocks.walletSubmitter.registerAgent).not.toHaveBeenCalled();
  });

  it('settle always routes daemon and never wallet-signs', async () => {
    setConnected(HW);
    mocks.pcaSettle.mockResolvedValue({ settled: true });

    await expect(useOwnerActionSubmitterForAccount({ accountId: '7' }).settle('7')).resolves.toEqual({ settled: true });

    expect(mocks.pcaSettle).toHaveBeenCalledWith('7');
    expect(mocks.walletSubmitter.settle).not.toHaveBeenCalled();
    expect(mocks.fetchPca).not.toHaveBeenCalled();
  });
});

// T2 (#1468) — the mode→submitter-kind projection now lives at the ownerActions boundary (the
// model carries only the owner STATE). daemon→'daemon', wallet→'wallet', external/unknown→
// 'read-only' (network never folded — a wrong-network wallet is still 'wallet' here).
describe('submitterKindForOwnerMode', () => {
  it('maps every owner mode to its submitter kind', () => {
    expect(submitterKindForOwnerMode('daemon')).toBe('daemon');
    expect(submitterKindForOwnerMode('wallet')).toBe('wallet');
    expect(submitterKindForOwnerMode('external')).toBe('read-only');
    expect(submitterKindForOwnerMode('unknown')).toBe('read-only');
  });
});

// #1470 — the folded cross-account signer-kind planner. Pins byte-fidelity to the old inline
// `ApproveWalletsModal.signerKindForAccount` + the gate-caught correlation contract: ALL
// classification inputs (primaryWallet / connectedWallet / walletWrongNetwork) are passed
// EXPLICITLY — NO ambient wallet-store reads and NO wallet-list refetch — so a wallet-list blip
// can't disarm the R4 lock via a planning/execution desync, and the only async is `fetchPca`.
describe('resolveSignerKindForAccount (folded signerKindForAccount)', () => {
  it('daemon: owner == passed primaryWallet ⇒ daemon (no fetchWalletsBalances)', async () => {
    mocks.fetchPca.mockResolvedValue({ owner: HOT });
    expect(await resolveSignerKindForAccount({ accountId: '4', primaryWallet: HOT, connectedWallet: HW, walletWrongNetwork: false })).toBe('daemon');
    expect(mocks.fetchWalletsBalances).not.toHaveBeenCalled();
  });

  it('wallet: owner == connected wallet on the right network ⇒ wallet', async () => {
    mocks.fetchPca.mockResolvedValue({ owner: HW });
    expect(await resolveSignerKindForAccount({ accountId: '4', primaryWallet: HOT, connectedWallet: HW, walletWrongNetwork: false })).toBe('wallet');
    expect(mocks.fetchWalletsBalances).not.toHaveBeenCalled();
  });

  // THE REGRESSION PIN (gate): the wallet branch keys ONLY on the connected wallet — it must NOT
  // depend on this node's wallet list. So a wallet-owned old account still classifies 'wallet' even
  // when the node's primary wallet is unknown (undefined), matching the old inline predicate. A
  // fresh internal fetchWalletsBalances (removed) would have returned undefined here on a blip and
  // silently disarmed the renew device prompt / R4 lock.
  it('wallet branch does NOT depend on the node wallet list: primaryWallet undefined ⇒ still wallet', async () => {
    mocks.fetchPca.mockResolvedValue({ owner: HW });
    expect(await resolveSignerKindForAccount({ accountId: '4', primaryWallet: undefined, connectedWallet: HW, walletWrongNetwork: false })).toBe('wallet');
    expect(mocks.fetchWalletsBalances).not.toHaveBeenCalled();
  });

  it('wrong network wallet owner ⇒ undefined (not counted as a device prompt)', async () => {
    mocks.fetchPca.mockResolvedValue({ owner: HW });
    expect(await resolveSignerKindForAccount({ accountId: '4', primaryWallet: HOT, connectedWallet: HW, walletWrongNetwork: true })).toBeUndefined();
  });

  it('external owner ⇒ undefined', async () => {
    mocks.fetchPca.mockResolvedValue({ owner: EXTERNAL });
    expect(await resolveSignerKindForAccount({ accountId: '4', primaryWallet: HOT, connectedWallet: HW, walletWrongNetwork: false })).toBeUndefined();
  });

  it('fetchPca read failure ⇒ undefined (correlated with the execution path)', async () => {
    mocks.fetchPca.mockRejectedValue(new Error('read failed'));
    expect(await resolveSignerKindForAccount({ accountId: '4', primaryWallet: HOT, connectedWallet: HW })).toBeUndefined();
  });

  it('no accountId ⇒ undefined (no fetch)', async () => {
    expect(await resolveSignerKindForAccount({ accountId: undefined, primaryWallet: HOT, connectedWallet: HW })).toBeUndefined();
    expect(mocks.fetchPca).not.toHaveBeenCalled();
  });
});

// Item 3 (#1375) — when the caller passes the display-resolved `access`, the submitter is
// selected ONCE up-front and the manage writes submit DIRECTLY, with no per-write owner/wallet
// re-fetch. (The absent-access path above is unchanged; the wallet submitter's per-prompt
// liveness guards still run on every write — covered by pca-wallet-owner-actions.)
describe('useOwnerActionSubmitter access-path (resolve signer once)', () => {
  it('daemon access submits via the daemon EOA WITHOUT re-fetching owner/wallets', async () => {
    mocks.pcaAddAgent.mockResolvedValue({ registered: true });
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HOT });

    await expect(useOwnerActionSubmitter({ access }).registerAgent('7', AGENT))
      .resolves.toEqual({ registered: true });

    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('7', AGENT);
    expect(mocks.fetchPca).not.toHaveBeenCalled();
    expect(mocks.fetchWalletsBalances).not.toHaveBeenCalled();
    expect(mocks.walletOwnerActionSubmitter).not.toHaveBeenCalled();
  });

  it('T1 — wallet access RE-VERIFIES ownership at call time: re-fetches the owner, then signs via the wallet', async () => {
    setConnected(HW);
    mocks.fetchPca.mockResolvedValue({ owner: HW }); // on-chain owner still matches the connected wallet
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });
    mocks.walletSubmitter.topUp.mockResolvedValue({ addedTokens: '5' });
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('wallet');

    await expect(useOwnerActionSubmitter({ access }).topUp('7', '5'))
      .resolves.toEqual({ addedTokens: '5' });

    // T1: it does NOT pin from the render-time access — it re-fetches the PCA owner first...
    expect(mocks.fetchPca).toHaveBeenCalledWith('7');
    // ...and only then signs via the wallet submitter.
    expect(mocks.walletSubmitter.topUp).toHaveBeenCalledWith('7', '5');
  });

  it('T1 — wallet access with a STALE owner re-classifies to read-only: throws, NO approve/write attempted', async () => {
    setConnected(HW);
    // On-chain the owner has MOVED to EXTERNAL since the render-time access said 'wallet'.
    mocks.fetchPca.mockResolvedValue({ owner: EXTERNAL });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('wallet'); // the stale render-time classification

    await expect(useOwnerActionSubmitter({ access }).topUp('7', '5'))
      .rejects.toBeInstanceOf(ReadOnlyOwnerActionError);

    // The re-fetch caught the stale owner and returned read-only FIRST — the wallet approve/write
    // (approveExactIfNeeded → grant TRAC) is NEVER attempted, and no daemon spend either.
    expect(mocks.fetchPca).toHaveBeenCalledWith('7');
    expect(mocks.walletSubmitter.topUp).not.toHaveBeenCalled();
    expect(mocks.pcaTopUp).not.toHaveBeenCalled();
  });

  it('read-only access throws ReadOnlyOwnerActionError WITHOUT re-fetching or signing', async () => {
    const access = resolvePcaOwnerAccess({ owner: EXTERNAL, primaryWallet: HOT, connectedWallet: HW });

    await expect(useOwnerActionSubmitter({ access }).deregisterAgent('7', AGENT))
      .rejects.toBeInstanceOf(ReadOnlyOwnerActionError);

    expect(mocks.fetchPca).not.toHaveBeenCalled();
    expect(mocks.fetchWalletsBalances).not.toHaveBeenCalled();
    expect(mocks.pcaRemoveAgent).not.toHaveBeenCalled();
    expect(mocks.walletSubmitter.deregisterAgent).not.toHaveBeenCalled();
  });

  it('settle stays daemon on the access path (never wallet-signs)', async () => {
    mocks.pcaSettle.mockResolvedValue({ settled: true });
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW });

    await expect(useOwnerActionSubmitter({ access }).settle('7')).resolves.toEqual({ settled: true });

    expect(mocks.pcaSettle).toHaveBeenCalledWith('7');
    expect(mocks.walletSubmitter.settle).not.toHaveBeenCalled();
  });

  it('UNKNOWN access falls back to the RESOLVING path (re-fetches → self-heals), not pinned read-only', async () => {
    // A genuinely daemon-owned account whose caller snapshot transiently missed (or a
    // just-created replacement PCA not yet chain-readable) ⇒ access.mode==='unknown'. The
    // write must re-fetch + resolve daemon, NOT fail read-only forever on the access path.
    mocks.fetchPca.mockResolvedValue({ owner: HOT });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });
    mocks.pcaAddAgent.mockResolvedValue({ registered: true });
    const access = resolvePcaOwnerAccess({ owner: undefined, primaryWallet: HOT, connectedWallet: HOT });
    expect(access.mode).toBe('unknown');

    await expect(useOwnerActionSubmitter({ access }).registerAgent('7', AGENT))
      .resolves.toEqual({ registered: true });

    // Fell back to the resolving path: RE-FETCHED the owner and resolved daemon → registered.
    expect(mocks.fetchPca).toHaveBeenCalledWith('7');
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('7', AGENT);
  });

  it("T5: daemon-owned target whose wallets are STILL LOADING (primaryWalletState 'loading') is NOT pinned read-only", async () => {
    // The approve modal builds access before fetchWalletsBalances resolves — owner known,
    // primaryWallet undefined. WITHOUT the loading state that would misclassify a daemon-owned PCA
    // as external → pin read-only → fail a valid owner approval. With primaryWalletState 'loading'
    // it is 'unknown', so the write re-fetches wallets and routes daemon; approval succeeds.
    mocks.fetchPca.mockResolvedValue({ owner: HOT });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });
    mocks.pcaAddAgent.mockResolvedValue({ registered: true });
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: undefined, connectedWallet: HW, primaryWalletState: 'loading' });
    expect(access.mode).toBe('unknown'); // NOT 'external' — the fix

    await expect(useOwnerActionSubmitter({ access }).registerAgent('8', AGENT))
      .resolves.toEqual({ registered: true });

    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('8', AGENT); // daemon, via the re-fetch
    expect(mocks.walletSubmitter.registerAgent).not.toHaveBeenCalled();
  });
});
