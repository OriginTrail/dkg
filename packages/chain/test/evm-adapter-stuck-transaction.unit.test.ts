// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import type { ReplacementBroadcastSignal } from '../src/chain-adapter.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const GWEI = 1_000_000_000n;
const KA_LIFECYCLE = '0x38b54901f0ade112fd9002024dbdd0db3d7321b5';
const PUBLISH_CALLDATA = '0x2f9bbcec0000000000000000000000000000000000000000000000000000000000000020';
const RECEIPT_BLOCK_HASH = `0x${'cd'.repeat(32)}`;

function config(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: PRIVATE_KEY,
    adminPrivateKey: ADMIN_KEY,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'gnosis:100',
    ...overrides,
  };
}

/** A wallet bound to a stub endpoint whose latest block carries `baseFeePerGas`. */
function walletOverStubEndpoint(baseFeePerGas: bigint, suggestedTip: bigint, chainId: bigint) {
  return new ethers.Wallet(PRIVATE_KEY).connect({
    getNetwork: async () => ({ chainId, name: 'stub' }),
    estimateGas: async () => 966_191n,
    getTransactionCount: async () => 6722,
    getBlock: async () => ({ baseFeePerGas }),
    send: async (method: string) => {
      if (method !== 'eth_maxPriorityFeePerGas') throw new Error(`unexpected ${method}`);
      return ethers.toQuantity(suggestedTip);
    },
    resolveName: async (name: string) => name,
    _isProvider: true,
  } as never);
}

describe('transaction fee pricing at preparation', () => {
  const request = { to: KA_LIFECYCLE, data: PUBLISH_CALLDATA };

  // Regression, 2026-10-20: the same preparation priced a Gnosis publish at maxFee 150 / tip 100
  // wei over a 23-wei base fee, and at 614-736 / 100 wei over ~257-318 wei, minutes before the
  // base fee reached 4.9M-36M wei.
  it('signs Gnosis transactions at or above the chain floor, whatever the base fee and suggested tip', async () => {
    const adapter: any = new EVMChainAdapter(config({ staticNetwork: false }));
    for (const baseFeePerGas of [23n, 257n, 318n]) {
      const prepared = await adapter.prepareSignerTransaction(
        walletOverStubEndpoint(baseFeePerGas, 100n, 100n),
        request,
      );
      expect(prepared).toMatchObject({
        type: 2,
        chainId: 100n,
        nonce: 6722,
        gasLimit: 966_191n,
        maxFeePerGas: 2n * GWEI,
        maxPriorityFeePerGas: GWEI,
      });
      expect(prepared.maxFeePerGas).toBeGreaterThan(36_000_000n);
    }
  });

  it('prices a chain without a floor at three times the base fee plus the suggested tip', async () => {
    const adapter: any = new EVMChainAdapter(config({ chainId: 'base:8453', staticNetwork: false }));
    const prepared = await adapter.prepareSignerTransaction(
      walletOverStubEndpoint(5_000_000n, 1_000_000n, 8453n),
      request,
    );
    expect(prepared).toMatchObject({ type: 2, maxFeePerGas: 16_000_000n, maxPriorityFeePerGas: 1_000_000n });
  });

  // otReviewAgent on #3393: ethers estimates gas with the fees it is given, and the RPC checks
  // them against the balance, so the operator cap applies before the estimate.
  it('estimates gas under the operator fee cap, so a wallet that affords the capped fee is not refused', async () => {
    const cap = 100_000_000n; // 0.1 gwei
    const balance = 50_000_000_000_000n; // 0.00005 xDAI: affords 50k gas at the cap, not at 2 gwei
    const estimatedWith: bigint[] = [];
    const adapter: any = new EVMChainAdapter(config({ staticNetwork: false, maxFeePerGasWei: cap }));
    const wallet = new ethers.Wallet(PRIVATE_KEY).connect({
      getNetwork: async () => ({ chainId: 100n, name: 'stub' }),
      estimateGas: async (tx: ethers.TransactionRequest) => {
        const maxFeePerGas = BigInt(tx.maxFeePerGas ?? 0n);
        estimatedWith.push(maxFeePerGas);
        if (maxFeePerGas * 50_000n > balance) throw new Error('insufficient funds for gas * price + value');
        return 50_000n;
      },
      getTransactionCount: async () => 6722,
      getBlock: async () => ({ baseFeePerGas: 23n }),
      send: async () => '0x64',
      resolveName: async (name: string) => name,
      _isProvider: true,
    } as never);

    const prepared = await adapter.prepareSignerTransaction(wallet, request);
    expect(estimatedWith).toEqual([cap]);
    expect(prepared).toMatchObject({ gasLimit: 50_000n, maxFeePerGas: cap, maxPriorityFeePerGas: cap });
  });

  // otReviewAgent on #3393: a cap below the base fee must stay the typed FEE_CAP_BELOW_BASE_FEE
  // the publisher retries on, not an RPC estimation error.
  it('rejects a fee cap below the base fee before estimating gas, with the typed error', async () => {
    const adapter: any = new EVMChainAdapter(config({ staticNetwork: false, maxFeePerGasWei: 100n }));
    let estimates = 0;
    const wallet = new ethers.Wallet(PRIVATE_KEY).connect({
      getNetwork: async () => ({ chainId: 100n, name: 'stub' }),
      estimateGas: async () => {
        estimates += 1;
        throw new Error('max fee per gas less than block base fee');
      },
      getTransactionCount: async () => 6722,
      getBlock: async () => ({ baseFeePerGas: 101n }),
      send: async () => '0x64',
      resolveName: async (name: string) => name,
      _isProvider: true,
    } as never);

    await expect(adapter.prepareSignerTransaction(wallet, request))
      .rejects.toMatchObject({ code: 'FEE_CAP_BELOW_BASE_FEE' });
    expect(estimates).toBe(0);
  });

  it('keeps the operator fee cap above the floor', async () => {
    const cap = 1_500_000_000n;
    const adapter: any = new EVMChainAdapter(config({ staticNetwork: false, maxFeePerGasWei: cap }));
    const prepared = await adapter.prepareSignerTransaction(walletOverStubEndpoint(23n, 100n, 100n), request);
    expect(prepared).toMatchObject({ maxFeePerGas: cap, maxPriorityFeePerGas: GWEI });
  });
});

describe('V10 write speed-up through the adapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function strandedPublish(signer: ethers.Wallet) {
    const signedTx = await signer.signTransaction({
      type: 2,
      chainId: 100n,
      nonce: 6722,
      gasLimit: 966_191n,
      to: KA_LIFECYCLE,
      value: 0n,
      data: PUBLISH_CALLDATA,
      maxFeePerGas: 614n,
      maxPriorityFeePerGas: 100n,
    });
    return { signedTx, txHash: ethers.Transaction.from(signedTx).hash!, nonce: 6722 };
  }

  /**
   * One stub endpoint over Gnosis with the 2026-10-20 spike in force: the wallet's next nonce
   * is 6722 and the base fee is 4.9M wei. A transaction is mined once `mine` names it.
   */
  function stubGnosis(adapter: EVMChainAdapter, events: string[]) {
    const chain = { mined: undefined as string | undefined, nonceReads: 0 };
    const provider = {
      send: async (method: string) => {
        if (method === 'eth_chainId') return '0x64';
        if (method === 'eth_maxPriorityFeePerGas') return '0x64';
        throw new Error(`unexpected ${method}`);
      },
      getTransactionReceipt: async (hash: string) => (hash === chain.mined
        ? { hash, blockNumber: 100, blockHash: RECEIPT_BLOCK_HASH, index: 0, status: 1, logs: [] }
        : null),
      getTransactionCount: async () => {
        chain.nonceReads += 1;
        return 6722;
      },
      getBlock: async (tag: string | number) => (tag === 'latest'
        ? { number: 200, hash: `0x${'ee'.repeat(32)}`, baseFeePerGas: 4_900_000n }
        : { number: tag, hash: RECEIPT_BLOCK_HASH }),
      getBlockNumber: async () => 200,
    };
    (adapter as any).providers = [provider];
    const sent: string[] = [];
    (adapter as any).broadcastSignedTransactionWithRetries = async (signedTx: string, txHash: string) => {
      sent.push(signedTx);
      events.push(`broadcast:${txHash}`);
      // The original is stuck under the spike; a replacement priced above it is mined.
      if (ethers.Transaction.from(signedTx).maxFeePerGas! > 4_900_000n) chain.mined = txHash;
    };
    return { chain, sent };
  }

  /**
   * A V10 publish of `original` that opted in to the speed-up, where every replacement
   * broadcast is refused, as for a wallet that cannot pay a replacement's fee. `outcome`
   * settles with the error the publish fails with; `broadcastAt` holds the clock reading at
   * each broadcast, the original's first.
   */
  function publishRefusingReplacements(
    adapter: EVMChainAdapter,
    signer: ethers.Wallet,
    original: Awaited<ReturnType<typeof strandedPublish>>,
  ) {
    const broadcastAt: number[] = [];
    (adapter as any).broadcastSignedTransactionWithRetries = async (_signedTx: string, txHash: string) => {
      broadcastAt.push(Date.now());
      if (txHash !== original.txHash) {
        throw Object.assign(new Error('insufficient funds for gas * price + value'), { code: 'INSUFFICIENT_FUNDS' });
      }
    };
    const outcome: Promise<unknown> = (adapter as any).dispatchSerializedV10Write(
      signer,
      'publish',
      undefined,
      async () => original,
      () => { throw new Error('null receipt'); },
      undefined,
      async () => {},
    ).catch((err: unknown) => err);
    return { outcome, broadcastAt };
  }

  it('replaces the stranded publish at its nonce and returns the replacement receipt', async () => {
    const adapter = new EVMChainAdapter(config({ receiptTimeoutMs: 1_000 }));
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const original = await strandedPublish(signer);
    const events: string[] = [];
    const { sent } = stubGnosis(adapter, events);
    const replacements: ReplacementBroadcastSignal[] = [];
    // The recovery's own reads reach the RPC client with an absolute deadline
    // (`readTipProvider` delegates to `readProvider`).
    const recoveryReads: Array<[string, unknown]> = [];
    const readProvider = (adapter as any).readProvider.bind(adapter);
    (adapter as any).readProvider = (label: string, fn: unknown, opts?: { deadlineMs?: number }) => {
      if (label === 'stuck transaction check' || label === 'replacement fee pricing') {
        recoveryReads.push([label, opts?.deadlineMs]);
      }
      return readProvider(label, fn, opts);
    };

    const receipt = await (adapter as any).dispatchSerializedV10Write(
      signer,
      'publish',
      undefined,
      async () => original,
      () => { throw new Error('null receipt'); },
      undefined,
      async (signal: ReplacementBroadcastSignal) => {
        replacements.push(signal);
        events.push(`checkpoint:${signal.txHash}`);
      },
    );

    expect(sent).toHaveLength(2);
    const replacement = ethers.Transaction.from(sent[1]);
    expect(events).toEqual([
      `broadcast:${original.txHash}`,
      `checkpoint:${replacement.hash}`,
      `broadcast:${replacement.hash}`,
    ]);
    expect(replacements).toEqual([{ txHash: replacement.hash, nonce: 6722, replacesTxHashes: [original.txHash] }]);
    expect(receipt.hash).toBe(replacement.hash);

    const before = ethers.Transaction.from(original.signedTx);
    for (const field of ['chainId', 'nonce', 'gasLimit', 'to', 'value', 'data'] as const) {
      expect(replacement[field]).toEqual(before[field]);
    }
    expect(replacement.from).toBe(signer.address);
    expect(replacement.maxFeePerGas).toBe(2n * GWEI);
    expect(replacement.maxPriorityFeePerGas).toBe(GWEI);
    expect(recoveryReads.map(([label]) => label)).toEqual(['stuck transaction check', 'replacement fee pricing']);
    for (const [, deadlineMs] of recoveryReads) expect(deadlineMs).toBeTypeOf('number');
  });

  it('never replaces a V10 write whose caller did not opt in, and times out as before', async () => {
    const adapter = new EVMChainAdapter(config({ receiptTimeoutMs: 1_000 }));
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const original = await strandedPublish(signer);
    const events: string[] = [];
    const { chain, sent } = stubGnosis(adapter, events);

    await expect((adapter as any).dispatchSerializedV10Write(
      signer,
      'publish',
      undefined,
      async () => original,
      () => { throw new Error('null receipt'); },
    )).rejects.toMatchObject({ code: 'RPC_TIMEOUT', txHash: original.txHash });
    expect(sent).toHaveLength(1);
    expect(chain.nonceReads).toBe(0);
  });

  // CI, 2026-10-24: on real timers the sleep to the first deadline can end just before
  // Date.now() reaches it. The check then due found the original underpriced and replaced it
  // once more, a fourth broadcast (the next test). Fake timers move the clock with the sleeps.
  it('surfaces the receipt timeout, never the replacement broadcast error', async () => {
    vi.useFakeTimers({ now: 0 });
    const adapter = new EVMChainAdapter(config({ receiptTimeoutMs: 1_000 }));
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const original = await strandedPublish(signer);
    stubGnosis(adapter, []);

    const { outcome, broadcastAt } = publishRefusingReplacements(adapter, signer, original);
    await vi.advanceTimersByTimeAsync(3_000);
    const failure = await outcome;
    // The timeout still names the transaction an endpoint is known to hold. Each refused
    // replacement was given its own window in case an earlier endpoint took it.
    expect(failure).toMatchObject({ code: 'RPC_TIMEOUT', txHash: original.txHash });
    expect(String((failure as Error).message)).toContain('timed out waiting for a receipt after 1000ms');
    expect(String((failure as Error).message)).toContain('deadline renewed 2x');
    expect(broadcastAt).toEqual([0, 1_000, 2_000]);
  });

  // A check that falls due before the deadline replaces the underpriced original at once. That
  // replacement renews no deadline, so the wait still ends after three receipt timeouts.
  it('replaces an underpriced original once a check is due, without renewing the deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    const adapter = new EVMChainAdapter(config({ receiptTimeoutMs: 1_000 }));
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const original = await strandedPublish(signer);
    stubGnosis(adapter, []);
    // The first receipt lookup answers after the first check is due, a quarter of the timeout.
    const [endpoint] = (adapter as any).providers;
    const getTransactionReceipt = endpoint.getTransactionReceipt;
    let lookups = 0;
    endpoint.getTransactionReceipt = async (hash: string) => {
      lookups += 1;
      if (lookups === 1) await new Promise((resolve) => setTimeout(resolve, 300));
      return getTransactionReceipt(hash);
    };

    const { outcome, broadcastAt } = publishRefusingReplacements(adapter, signer, original);
    await vi.advanceTimersByTimeAsync(3_000);
    const failure = await outcome;
    expect(failure).toMatchObject({ code: 'RPC_TIMEOUT', txHash: original.txHash });
    expect(String((failure as Error).message)).toContain('deadline renewed 2x');
    expect(broadcastAt).toEqual([0, 300, 1_000, 2_000]);
  });

  it('replaces a stuck standalone write, which keeps the receipt it is waited for', async () => {
    const adapter = new EVMChainAdapter(config({ receiptTimeoutMs: 1_000 }));
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const original = await strandedPublish(signer);
    const events: string[] = [];
    const { sent } = stubGnosis(adapter, events);
    let progress = 0;

    const receipt = await (adapter as any).sendSignedTransactionAndWait(
      original.signedTx,
      original.txHash,
      'approve V10 publish TRAC',
      { signer, nonce: original.nonce, markProgress: () => { progress += 1; } },
    );
    expect(sent).toHaveLength(2);
    expect(receipt.hash).toBe(ethers.Transaction.from(sent[1]).hash);
    expect(progress).toBe(1);
  });
});
