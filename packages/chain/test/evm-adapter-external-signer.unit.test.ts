/**
 * An EVM adapter whose operational wallets sign through an external signer.
 * A transaction is prepared first, across the endpoints, and then signed once.
 * A signer's failure is final: no contract-error recovery that re-runs a whole
 * write reads a signer's refusal as a revert and asks for another signature,
 * whatever text the signer returned. The RPC population of a transaction is
 * bounded by the per-endpoint deadline, for every signer, and the signing
 * request after it is not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { connectRemoteSigners } from '../src/remote-signer-connect.js';
import { RemoteSignerError } from '../src/remote-signer-errors.js';
import { RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS } from '../src/evm-adapter-constants.js';
import {
  InsufficientPublisherFundsError,
  isHubStaleError,
  isTooLowAllowanceError,
} from '../src/evm-adapter-errors.js';
import { startFakeRemoteSigner, type FakeSigner, type FakeSignerOptions } from './helpers/fake-remote-signer.js';

// Well-known Hardhat development accounts.
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TOKEN = 'payer-token-6a7b8c9d0e1f2a3b4c5d6e7f';
const KAV = '0x00000000000000000000000000000000000000a1';
// A signer's refusal that happens to carry every marker a contract recovery path matches on.
const REFUSAL = 'policy refused: execution reverted: TooLowAllowance; UnauthorizedAccess(Only Contracts in Hub); insufficient funds';

const TX: ethers.TransactionRequest = {
  type: 2,
  to: KAV,
  data: '0x095ea7b3',
  value: 0n,
  nonce: 3,
  gasLimit: 120_000n,
  maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  chainId: 31337n,
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function signerRefusingTransactions(options: Partial<FakeSignerOptions> = {}): Promise<FakeSigner> {
  const fake = await startFakeRemoteSigner({
    credentials: [{ token: TOKEN, keys: [PAYER_KEY] }],
    reject: (method) => (method === 'eth_signTransaction' ? { code: -32000, message: REFUSAL } : undefined),
    ...options,
  });
  cleanups.push(() => fake.close());
  return fake;
}

/** The adapter with its protected transaction seams exposed to the test. */
async function adapterFor(fake: FakeSigner): Promise<any> {
  const { operational } = await connectRemoteSigners({ url: fake.url, authToken: TOKEN });
  const adapter = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: '0x00000000000000000000000000000000000000d4',
    chainId: 'evm:31337',
    signers: operational,
    allowNoAdminSigner: true,
  });
  cleanups.push(() => adapter.destroy());
  return adapter;
}

describe('contract recovery never re-signs after a signer refusal', () => {
  it('never reads a signer refusal, or an error wrapping one, as a recoverable revert', () => {
    const refusal = new RemoteSignerError('REMOTE_SIGNER_REJECTED', `Remote signer at unix:/s rejected eth_signTransaction: ${REFUSAL}`);
    for (const err of [refusal, new Error(`publish failed: ${REFUSAL}`, { cause: refusal })]) {
      expect(isTooLowAllowanceError(err)).toBe(false);
      expect(isHubStaleError(err)).toBe(false);
    }
    // Genuine reverts keep their recovery.
    expect(isTooLowAllowanceError(new Error('execution reverted: TooLowAllowance'))).toBe(true);
    expect(isTooLowAllowanceError(Object.assign(new Error('call exception'), { revert: { name: 'TooLowAllowance' } }))).toBe(true);
    expect(isHubStaleError(new Error('execution reverted: UnauthorizedAccess(Only Contracts in Hub)'))).toBe(true);
    expect(isHubStaleError('Only Contracts in Hub')).toBe(false);
  });

  it('asks for one publish signature and no approval when the signer refuses with an allowance revert text', async () => {
    const fake = await signerRefusingTransactions();
    const adapter = await adapterFor(fake);
    const approvals: unknown[] = [];
    adapter.ensureV10ApproveTrac = async (...args: unknown[]) => { approvals.push(args); };
    // Preparation succeeds; the signature after it is refused.
    adapter.prepareAcrossProviders = async (_contract: unknown, _method: unknown, _args: unknown, signer: unknown) => (
      { transaction: TX, signer }
    );
    await expect(adapter.populateAndSignV10WithAllowanceRecovery(adapter.signer, {}, 'publish', {}, KAV, 1n, 'publish approval'))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    expect(fake.calls('eth_signTransaction')).toHaveLength(1);
    expect(approvals).toHaveLength(0);

    // A genuine TooLowAllowance revert from gas estimation still forces one approval and one retry.
    let attempts = 0;
    adapter.prepareAcrossProviders = async (_contract: unknown, _method: unknown, _args: unknown, signer: unknown) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('execution reverted'), { revert: { name: 'TooLowAllowance' } });
      return { transaction: TX, signer };
    };
    const signPrepared = vi.fn(async () => ({ signedTx: '0x02', txHash: '0xab' }));
    adapter.signPreparedTransaction = signPrepared;
    await expect(adapter.populateAndSignV10WithAllowanceRecovery(adapter.signer, {}, 'publish', {}, KAV, 1n, 'publish approval'))
      .resolves.toMatchObject({ txHash: '0xab' });
    expect(attempts).toBe(2);
    expect(approvals).toHaveLength(1);
    expect(signPrepared).toHaveBeenCalledTimes(1);
  });

  it('does not re-resolve the Hub and sign again when the signer refuses with a stale-contract text', async () => {
    const fake = await signerRefusingTransactions();
    const adapter = await adapterFor(fake);
    const init = vi.fn(async () => {});
    const invalidateAll = vi.fn();
    const invalidatePair = vi.fn();
    adapter.init = init;
    adapter.invalidateAllBoundContracts = invalidateAll;
    adapter.invalidateRandomSamplingPair = invalidatePair;
    // These wrappers re-run a whole write, the signature included.
    const sign = () => adapter.signPreparedTransaction({ transaction: TX, signer: adapter.signer });
    await expect(adapter.withHubStaleRetryAny(sign)).rejects.toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    await expect(adapter.withHubStaleRetry(sign)).rejects.toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    expect(fake.calls('eth_signTransaction')).toHaveLength(2);
    expect(init).not.toHaveBeenCalled();
    expect(invalidateAll).not.toHaveBeenCalled();
    expect(invalidatePair).not.toHaveBeenCalled();

    // A genuine stale-Hub revert is still retried once against fresh bindings.
    let calls = 0;
    const stale = async () => {
      calls += 1;
      if (calls === 1) throw new Error('execution reverted: UnauthorizedAccess(Only Contracts in Hub)');
      return 'written';
    };
    await expect(adapter.withHubStaleRetryAny(stale)).resolves.toBe('written');
    expect(calls).toBe(2);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('keeps a signer refusal as it is instead of reporting unfunded wallets', async () => {
    const fake = await signerRefusingTransactions();
    const adapter = await adapterFor(fake);
    adapter.poolHasFundableSigner = async () => false;
    adapter.snapshotPublisherWalletBalances = async () => [];
    const refusal = new RemoteSignerError('REMOTE_SIGNER_REJECTED', `Remote signer at unix:/s rejected eth_signTransaction: ${REFUSAL}`);
    expect(await adapter.enrichInsufficientPublisherFundsError(refusal, adapter.signer, 1n)).toBe(refusal);
    const shortfall = new Error('insufficient funds for gas * price + value');
    expect(await adapter.enrichInsufficientPublisherFundsError(shortfall, adapter.signer, 1n))
      .toBeInstanceOf(InsufficientPublisherFundsError);
  });
});

describe('the RPC population of a transaction is bounded, its signing request is not', () => {
  const payer = new ethers.Wallet(PAYER_KEY);

  /**
   * An adapter over two endpoints and a payer signer whose RPC population
   * (nonce, gas, fees) on the first endpoint, when `stallFirst`, waits until
   * released. A write runs the adapter's own two steps: preparation across the
   * endpoints, then the one signature.
   */
  function twoEndpoints(options: {
    external: boolean;
    stallFirst: boolean;
    signTransaction: (tx: ethers.TransactionRequest) => Promise<string>;
  }) {
    let release!: () => void;
    const stalled = new Promise<ethers.TransactionRequest>((resolve) => { release = () => resolve(TX); });
    const providers = [{ endpoint: 0 }, { endpoint: 1 }];
    const bound = providers.map(({ endpoint }) => ({
      address: payer.address,
      provider: null,
      ...(options.external ? { isExternalSigner: true as const } : {}),
      populateTransaction: vi.fn(() => (options.stallFirst && endpoint === 0 ? stalled : Promise.resolve(TX))),
      signTransaction: options.signTransaction,
    }));
    const signer = {
      address: payer.address,
      ...(options.external ? { isExternalSigner: true as const } : {}),
      connect: (provider: { endpoint: number }) => bound[provider.endpoint],
    };
    const adapter: any = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      rpcUrls: ['http://127.0.0.1:2'],
      hubAddress: '0x00000000000000000000000000000000000000d4',
      chainId: 'evm:31337',
      staticNetwork: false,
      privateKey: PAYER_KEY,
      allowNoAdminSigner: true,
    });
    cleanups.push(() => adapter.destroy());
    adapter.providers = providers;
    const contract = { connect: () => ({ doWrite: { populateTransaction: async () => ({ to: KAV, data: TX.data }) } }) };
    const write = async () => adapter.signPreparedTransaction(
      await adapter.prepareAcrossProviders(contract, 'doWrite', [], signer, 'publish'),
    );
    return { write, bound, release };
  }

  for (const kind of ['external', 'local'] as const) {
    it(`fails a stalled population of ${kind === 'external' ? 'an external' : 'a local'} signer over at the deadline, and never signs it late`, async () => {
      vi.useFakeTimers();
      const signTransaction = vi.fn(async (tx: ethers.TransactionRequest) => payer.signTransaction(tx));
      const { write, bound, release } = twoEndpoints({ external: kind === 'external', stallFirst: true, signTransaction });
      const pending = write();
      await vi.advanceTimersByTimeAsync(RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS + 1);
      // The stalled endpoint was cut off at the deadline; the next one prepared the transaction.
      await expect(pending).resolves.toMatchObject({ nonce: 3 });
      expect(bound[1].populateTransaction).toHaveBeenCalledTimes(1);
      expect(signTransaction).toHaveBeenCalledTimes(1);

      // The population the first endpoint finally answers is never signed.
      release();
      await vi.runAllTimersAsync();
      expect(signTransaction).toHaveBeenCalledTimes(1);
    });
  }

  it('does not cut off a slow external signing request at the population deadline', async () => {
    vi.useFakeTimers();
    const signTransaction = vi.fn((tx: ethers.TransactionRequest) => new Promise<string>((resolve) => {
      setTimeout(() => resolve(payer.signTransaction(tx)), RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS + 5_000);
    }));
    const { write, bound } = twoEndpoints({ external: true, stallFirst: false, signTransaction });
    const pending = write();
    await vi.advanceTimersByTimeAsync(RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS + 6_000);
    await expect(pending).resolves.toMatchObject({ nonce: 3 });
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(bound[1].populateTransaction).not.toHaveBeenCalled();
  });
});
