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
  useOwnerActionSubmitter,
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

    await expect(useOwnerActionSubmitter().create({ tokens: '0.5', primaryNode: '41' }))
      .resolves.toEqual({ accountId: '1' });
    expect(mocks.createPca).toHaveBeenCalledWith({ tokens: '0.5', primaryNode: '41' });

    await expect(useOwnerActionSubmitter({ ownerKey: 'hot' }).create({ tokens: '1', primaryNode: '42' }))
      .resolves.toEqual({ accountId: '1' });
    expect(mocks.createPca).toHaveBeenCalledWith({ tokens: '1', primaryNode: '42' });

    setConnected(HW);
    await expect(useOwnerActionSubmitter({ ownerKey: 'hardware' }).create({ tokens: '2', primaryNode: '43' }))
      .resolves.toEqual({ accountId: '2' });
    expect(mocks.walletOwnerActionSubmitter).toHaveBeenCalled();
    expect(mocks.walletSubmitter.create).toHaveBeenCalledWith({ tokens: '2', primaryNode: '43' });
  });

  it('create ownerKey hardware fails unavailable without provider or expected chain before wallet signing', async () => {
    await expect(useOwnerActionSubmitter({ ownerKey: 'hardware' }).create({ tokens: '1', primaryNode: '42' }))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    setConnected(HW, { chainId: 1, expectedChainId: 84532 });
    await expect(useOwnerActionSubmitter({ ownerKey: 'hardware' }).create({ tokens: '1', primaryNode: '42' }))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    setConnected(HW, { bootstrap: null });
    await expect(useOwnerActionSubmitter({ ownerKey: 'hardware' }).create({ tokens: '1', primaryNode: '42' }))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    expect(mocks.walletOwnerActionSubmitter).not.toHaveBeenCalled();
    expect(mocks.walletSubmitter.create).not.toHaveBeenCalled();
  });

  it('manage write uses daemon when the PCA owner is wallets[0], even if connected', async () => {
    setConnected(HOT);
    mocks.fetchPca.mockResolvedValue({ owner: HOT });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });
    mocks.pcaAddAgent.mockResolvedValue({ registered: true });

    await expect(useOwnerActionSubmitter({ accountId: '7' }).registerAgent('7', AGENT))
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

    await expect(useOwnerActionSubmitter({ accountId: '7' }).topUp('7', '10'))
      .resolves.toEqual({ addedTokens: '10' });

    expect(mocks.pcaTopUp).not.toHaveBeenCalled();
    expect(mocks.walletSubmitter.topUp).toHaveBeenCalledWith('7', '10');
  });

  it('external-owned manage writes fail read-only and do not sign', async () => {
    setConnected(HW);
    mocks.fetchPca.mockResolvedValue({ owner: EXTERNAL });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });

    await expect(useOwnerActionSubmitter({ accountId: '7' }).deregisterAgent('7', AGENT))
      .rejects.toBeInstanceOf(ReadOnlyOwnerActionError);

    expect(mocks.pcaRemoveAgent).not.toHaveBeenCalled();
    expect(mocks.walletSubmitter.deregisterAgent).not.toHaveBeenCalled();
  });

  it('fetch failures fail unavailable and do not sign', async () => {
    setConnected(HW);
    mocks.fetchPca.mockRejectedValue(new Error('read failed'));

    await expect(useOwnerActionSubmitter({ accountId: '7' }).topUp('7', '10'))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    expect(mocks.pcaTopUp).not.toHaveBeenCalled();
    expect(mocks.walletSubmitter.topUp).not.toHaveBeenCalled();
  });

  it('connected-owner writes fail unavailable on wrong chain or missing provider before wallet signing', async () => {
    mocks.fetchPca.mockResolvedValue({ owner: HW });
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [HOT] });

    setConnected(HW, { chainId: 1, expectedChainId: 84532 });
    await expect(useOwnerActionSubmitter({ accountId: '7' }).registerAgent('7', AGENT))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    setConnected(HW, { provider: null });
    await expect(useOwnerActionSubmitter({ accountId: '7' }).registerAgent('7', AGENT))
      .rejects.toBeInstanceOf(OwnerActionUnavailableError);

    expect(mocks.walletSubmitter.registerAgent).not.toHaveBeenCalled();
  });

  it('settle always routes daemon and never wallet-signs', async () => {
    setConnected(HW);
    mocks.pcaSettle.mockResolvedValue({ settled: true });

    await expect(useOwnerActionSubmitter({ accountId: '7' }).settle('7')).resolves.toEqual({ settled: true });

    expect(mocks.pcaSettle).toHaveBeenCalledWith('7');
    expect(mocks.walletSubmitter.settle).not.toHaveBeenCalled();
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

    await expect(useOwnerActionSubmitter({ accountId: '7', access }).registerAgent('7', AGENT))
      .resolves.toEqual({ registered: true });

    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('7', AGENT);
    expect(mocks.fetchPca).not.toHaveBeenCalled();
    expect(mocks.fetchWalletsBalances).not.toHaveBeenCalled();
    expect(mocks.walletOwnerActionSubmitter).not.toHaveBeenCalled();
  });

  it('wallet access submits via the browser wallet WITHOUT re-fetching', async () => {
    mocks.walletSubmitter.topUp.mockResolvedValue({ addedTokens: '5' });
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW });

    await expect(useOwnerActionSubmitter({ accountId: '7', access }).topUp('7', '5'))
      .resolves.toEqual({ addedTokens: '5' });

    expect(mocks.walletOwnerActionSubmitter).toHaveBeenCalled();
    expect(mocks.walletSubmitter.topUp).toHaveBeenCalledWith('7', '5');
    expect(mocks.fetchPca).not.toHaveBeenCalled();
    expect(mocks.fetchWalletsBalances).not.toHaveBeenCalled();
  });

  it('read-only access throws ReadOnlyOwnerActionError WITHOUT re-fetching or signing', async () => {
    const access = resolvePcaOwnerAccess({ owner: EXTERNAL, primaryWallet: HOT, connectedWallet: HW });

    await expect(useOwnerActionSubmitter({ accountId: '7', access }).deregisterAgent('7', AGENT))
      .rejects.toBeInstanceOf(ReadOnlyOwnerActionError);

    expect(mocks.fetchPca).not.toHaveBeenCalled();
    expect(mocks.fetchWalletsBalances).not.toHaveBeenCalled();
    expect(mocks.pcaRemoveAgent).not.toHaveBeenCalled();
    expect(mocks.walletSubmitter.deregisterAgent).not.toHaveBeenCalled();
  });

  it('settle stays daemon on the access path (never wallet-signs)', async () => {
    mocks.pcaSettle.mockResolvedValue({ settled: true });
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW });

    await expect(useOwnerActionSubmitter({ accountId: '7', access }).settle('7')).resolves.toEqual({ settled: true });

    expect(mocks.pcaSettle).toHaveBeenCalledWith('7');
    expect(mocks.walletSubmitter.settle).not.toHaveBeenCalled();
  });
});
