import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pad, parseEther, type Address, type Hex, type TransactionReceipt } from 'viem';

import type { PcaContracts } from '../src/ui/api.js';
import type { Eip1193Provider } from '../src/ui/web3/eip6963.js';

const apiMocks = vi.hoisted(() => ({
  pcaSettle: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, pcaSettle: apiMocks.pcaSettle };
});

import {
  walletOwnerActionSubmitter,
  WalletOwnerActionAbortError,
  WalletOwnerActionSubmitterError,
  WalletOwnerActionUnavailableError,
  type MinimalPublicClient,
  type MinimalWalletClient,
} from '../src/ui/web3/walletOwnerActionSubmitter.js';
import { WalletReceiptRevertedError, WalletReceiptWaitError, WalletTxStepError } from '../src/ui/web3/walletTxError.js';

const OWNER = `0x${'11'.repeat(20)}` as Address;
const OTHER = `0x${'22'.repeat(20)}` as Address;
const NFT = `0x${'33'.repeat(20)}` as Address;
const TOKEN = `0x${'44'.repeat(20)}` as Address;
const APPROVE_HASH = `0x${'aa'.repeat(32)}` as Hex;
const ACTION_HASH = `0x${'bb'.repeat(32)}` as Hex;
const SECOND_ACTION_HASH = `0x${'cc'.repeat(32)}` as Hex;
const UINT72_OVERFLOW = (1n << 72n).toString();
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

const CONTRACTS: PcaContracts = {
  nft: NFT,
  token: TOKEN,
  chainId: 'base:84532',
  rpcUrls: ['https://rpc.example'],
};

function addrTopic(a: Address): Hex {
  return pad(a.toLowerCase() as Hex, { size: 32 });
}

function idTopic(n: bigint): Hex {
  return pad(`0x${n.toString(16)}` as Hex, { size: 32 });
}

function mintLog(to: Address, tokenId: bigint) {
  return {
    address: NFT,
    topics: [TRANSFER, ZERO32, addrTopic(to), idTopic(tokenId)],
    data: '0x',
  };
}

function receipt(hash: Hex, status: TransactionReceipt['status'] = 'success', logs: any[] = []): TransactionReceipt {
  return {
    transactionHash: hash,
    blockHash: `0x${'01'.repeat(32)}`,
    blockNumber: hash === ACTION_HASH ? 2n : 1n,
    contractAddress: null,
    cumulativeGasUsed: 1n,
    effectiveGasPrice: 1n,
    from: OWNER,
    gasUsed: 1n,
    logs,
    logsBloom: `0x${'00'.repeat(256)}`,
    status,
    to: NFT,
    transactionIndex: 0,
    type: 'eip1559',
  } as TransactionReceipt;
}

class FakeProvider implements Eip1193Provider {
  accounts: Address[] = [OWNER];
  chainId = 84532;
  readonly calls: string[] = [];

  async request({ method }: { method: string }): Promise<unknown> {
    this.calls.push(method);
    if (method === 'eth_accounts') return this.accounts;
    if (method === 'eth_chainId') return `0x${this.chainId.toString(16)}`;
    throw new Error(`Unexpected provider method ${method}`);
  }
}

function makeHarness(opts: {
  allowanceQueue?: bigint[];
  receipts?: Record<string, TransactionReceipt>;
  receiptErrors?: Record<string, unknown>;
  writeErrors?: Record<string, unknown>;
  mutateAfterReceipt?: (hash: Hex) => void;
  provider?: FakeProvider;
} = {}) {
  const provider = opts.provider ?? new FakeProvider();
  const state = {
    provider,
    address: OWNER,
    chainId: 84532,
    expectedChainId: 84532,
    bootstrap: CONTRACTS,
  };
  const allowanceQueue = [...(opts.allowanceQueue ?? [0n, 0n])];
  const readContract = vi.fn(async (args: any) => {
    if (args.functionName === 'allowance') return allowanceQueue.shift() ?? 0n;
    throw new Error(`Unexpected readContract ${args.functionName}`);
  });
  const receipts: Record<string, TransactionReceipt> = {
    [APPROVE_HASH]: receipt(APPROVE_HASH),
    [ACTION_HASH]: receipt(ACTION_HASH, 'success', [mintLog(OWNER, 9n)]),
    [SECOND_ACTION_HASH]: receipt(SECOND_ACTION_HASH),
    ...(opts.receipts ?? {}),
  };
  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    opts.mutateAfterReceipt?.(hash);
    const err = opts.receiptErrors?.[hash];
    if (err) throw err;
    const r = receipts[hash];
    if (!r) throw new Error(`Missing receipt ${hash}`);
    return r;
  });
  const actionHashes = [ACTION_HASH, SECOND_ACTION_HASH];
  const writeContract = vi.fn(async (args: any) => {
    const writeError = opts.writeErrors?.[args.functionName];
    if (writeError) throw writeError;
    if (args.functionName === 'approve') return APPROVE_HASH;
    const next = actionHashes.shift();
    if (!next) throw new Error('Unexpected writeContract');
    return next;
  });
  const publicClient: MinimalPublicClient = { readContract, waitForTransactionReceipt };
  const walletClient: MinimalWalletClient = { writeContract };
  const submitter = walletOwnerActionSubmitter({
    getWalletState: () => state,
    publicClientFor: () => publicClient,
    walletClientFromProvider: () => walletClient,
  });
  return { submitter, state, provider, readContract, waitForTransactionReceipt, writeContract };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('walletOwnerActionSubmitter create guards', () => {
  it.each([
    ['missing', undefined],
    ['zero', '0'],
    ['negative', '-1'],
    ['non-integer', '1.2'],
    ['uint72 overflow', UINT72_OVERFLOW],
  ])('throws before allowance/approve/send when primaryNode is %s', async (_label, primaryNode) => {
    const h = makeHarness();
    await expect(h.submitter.create({ tokens: '100', primaryNode } as any)).rejects.toBeInstanceOf(
      WalletOwnerActionSubmitterError,
    );
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['too many decimals', '0.0000000000000000001'],
    ['uint96 overflow', '79228162515'],
  ])('throws before allowance/approve/send when tokens is %s', async (_label, tokens) => {
    const h = makeHarness();
    await expect(h.submitter.create({ tokens, primaryNode: '42' })).rejects.toBeInstanceOf(
      WalletOwnerActionSubmitterError,
    );
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('reads allowance(owner,nft), approves the exact amount, then returns the create result shape', async () => {
    const amount = parseEther('123.45');
    const h = makeHarness({ allowanceQueue: [0n, amount] });
    const res = await h.submitter.create({ tokens: '123.45', primaryNode: '42' });

    expect(h.readContract.mock.calls[0]![0]).toMatchObject({
      address: TOKEN,
      functionName: 'allowance',
      args: [OWNER, NFT],
    });
    expect(h.writeContract).toHaveBeenCalledTimes(2);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({
      address: TOKEN,
      functionName: 'approve',
      args: [NFT, amount],
    });
    expect(h.writeContract.mock.calls[1]![0]).toMatchObject({
      address: NFT,
      functionName: 'createAccount',
      args: [amount, 42n],
    });
    expect(res).toEqual({
      accountId: '9',
      txHash: ACTION_HASH,
      blockNumber: 2,
      committedTokens: '123.45',
    });
  });

  it('skips approval when allowance is already sufficient', async () => {
    const amount = parseEther('5');
    const h = makeHarness({ allowanceQueue: [amount] });
    await h.submitter.create({ tokens: '5', primaryNode: '42' });
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'createAccount' });
  });

  it('stops before createAccount when the approve receipt reverted', async () => {
    const amount = parseEther('5');
    const h = makeHarness({
      allowanceQueue: [0n],
      receipts: { [APPROVE_HASH]: receipt(APPROVE_HASH, 'reverted') },
    });
    await expect(h.submitter.create({ tokens: '5', primaryNode: '42' })).rejects.toBeInstanceOf(
      WalletReceiptRevertedError,
    );
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'approve', args: [NFT, amount] });
  });

  it('wraps an approve prompt failure with txStep=approve before any action write', async () => {
    const reject = Object.assign(new Error('user rejected'), { code: 4001 });
    const h = makeHarness({ allowanceQueue: [0n], writeErrors: { approve: reject } });
    await expect(h.submitter.create({ tokens: '5', primaryNode: '42' })).rejects.toMatchObject({
      name: 'WalletTxStepError',
      txStep: 'approve',
      cause: reject,
    });
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'approve' });
  });

  it('does not return success when the action receipt reverted', async () => {
    const amount = parseEther('5');
    const h = makeHarness({
      allowanceQueue: [amount],
      receipts: { [ACTION_HASH]: receipt(ACTION_HASH, 'reverted') },
    });
    await expect(h.submitter.create({ tokens: '5', primaryNode: '42' })).rejects.toBeInstanceOf(
      WalletReceiptRevertedError,
    );
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'createAccount' });
  });

  it('wraps an action prompt failure with txStep=action after allowance is ready', async () => {
    const reject = Object.assign(new Error('user rejected'), { code: 4001 });
    const amount = parseEther('5');
    const h = makeHarness({ allowanceQueue: [amount], writeErrors: { createAccount: reject } });
    try {
      await h.submitter.create({ tokens: '5', primaryNode: '42' });
      throw new Error('expected create to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(WalletTxStepError);
      expect((err as WalletTxStepError).txStep).toBe('action');
      expect((err as WalletTxStepError).cause).toBe(reject);
    }
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls.every((call) => call[0].functionName === 'createAccount')).toBe(true);
  });
});

describe('walletOwnerActionSubmitter action shapes', () => {
  it('settle delegates to the daemon API and never wallet-signs', async () => {
    const result = { accountId: '7', settled: true, txHash: SECOND_ACTION_HASH, blockNumber: 3 };
    apiMocks.pcaSettle.mockResolvedValue(result);
    const h = makeHarness();

    await expect(h.submitter.settle('7')).resolves.toEqual(result);

    expect(apiMocks.pcaSettle).toHaveBeenCalledWith('7');
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('registerAgent does not approve and returns the daemon-compatible shape', async () => {
    const h = makeHarness();
    const res = await h.submitter.registerAgent('7', OTHER);
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({
      address: NFT,
      functionName: 'registerAgent',
      args: [7n, OTHER],
    });
    expect(res).toEqual({
      accountId: '7',
      agent: OTHER,
      registered: true,
      adapterSupported: true,
      txHash: ACTION_HASH,
      blockNumber: 2,
    });
  });

  it('deregisterAgent does not approve and returns the daemon-compatible shape', async () => {
    const h = makeHarness();
    const res = await h.submitter.deregisterAgent('7', OTHER);
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.writeContract).toHaveBeenCalledTimes(1);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({
      address: NFT,
      functionName: 'deregisterAgent',
      args: [7n, OTHER],
    });
    expect(res).toEqual({
      accountId: '7',
      agent: OTHER,
      deregistered: true,
      txHash: ACTION_HASH,
      blockNumber: 2,
    });
  });

  it('topUp returns the top-up action hash, not the approve hash, and does not parse a mint', async () => {
    const amount = parseEther('10');
    const h = makeHarness({
      allowanceQueue: [0n, amount],
      receipts: { [ACTION_HASH]: receipt(ACTION_HASH, 'success', []) },
    });
    const res = await h.submitter.topUp('7', '10');
    expect(h.writeContract).toHaveBeenCalledTimes(2);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'approve' });
    expect(h.writeContract.mock.calls[1]![0]).toMatchObject({
      address: NFT,
      functionName: 'topUp',
      args: [7n, amount],
    });
    expect(res).toEqual({
      accountId: '7',
      addedTokens: '10.0',
      txHash: ACTION_HASH,
      blockNumber: 2,
    });
  });

  it('topUp receipt-poll failure exposes the action hash for reconcile, not the approval hash', async () => {
    const amount = parseEther('10');
    const timeout = new Error('request timed out');
    const h = makeHarness({
      allowanceQueue: [0n, amount],
      receiptErrors: { [ACTION_HASH]: timeout },
    });

    try {
      await h.submitter.topUp('7', '10');
      throw new Error('expected topUp to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(WalletReceiptWaitError);
      expect((err as WalletReceiptWaitError).txHash).toBe(ACTION_HASH);
      expect((err as WalletReceiptWaitError).txHash).not.toBe(APPROVE_HASH);
      expect((err as WalletReceiptWaitError).cause).toBe(timeout);
    }

    expect(h.writeContract).toHaveBeenCalledTimes(2);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'approve' });
    expect(h.writeContract.mock.calls[1]![0]).toMatchObject({ functionName: 'topUp' });
  });
});

describe('walletOwnerActionSubmitter connection safety', () => {
  it('does not sign when no provider is connected', async () => {
    const h = makeHarness();
    h.state.provider = null;
    h.state.address = null;
    await expect(h.submitter.topUp('7', '10')).rejects.toBeInstanceOf(WalletOwnerActionUnavailableError);
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('does not sign on the wrong chain', async () => {
    const h = makeHarness();
    h.state.chainId = 1;
    await expect(h.submitter.topUp('7', '10')).rejects.toBeInstanceOf(WalletOwnerActionUnavailableError);
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('does not sign when the connected chain is unknown', async () => {
    const h = makeHarness();
    h.state.chainId = null as any;
    await expect(h.submitter.topUp('7', '10')).rejects.toBeInstanceOf(WalletOwnerActionUnavailableError);
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it.each([
    ['account switch', (h: ReturnType<typeof makeHarness>) => { h.state.address = OTHER; }],
    ['chain switch', (h: ReturnType<typeof makeHarness>) => { h.state.chainId = 1; }],
    ['disconnect', (h: ReturnType<typeof makeHarness>) => { h.state.provider = null; h.state.address = null; }],
    ['provider switch', (h: ReturnType<typeof makeHarness>) => { h.state.provider = new FakeProvider(); }],
    ['provider account switch', (h: ReturnType<typeof makeHarness>) => { h.provider.accounts = [OTHER]; }],
  ])('aborts before the second signature after a mid-flow %s', async (_label, mutate) => {
    const amount = parseEther('5');
    let harness!: ReturnType<typeof makeHarness>;
    harness = makeHarness({
      allowanceQueue: [0n, amount],
      mutateAfterReceipt: (hash) => {
        if (hash === APPROVE_HASH) mutate(harness);
      },
    });
    await expect(harness.submitter.create({ tokens: '5', primaryNode: '42' })).rejects.toBeInstanceOf(
      WalletOwnerActionAbortError,
    );
    expect(harness.writeContract).toHaveBeenCalledTimes(1);
    expect(harness.writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'approve' });
  });
});
