/**
 * Unit tests for evm-adapter pure helpers and constructor-only surface (07 EVM_MODULE —
 * revert decoding used across chain operations). No live RPC / Hardhat.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Interface, ethers } from 'ethers';
import {
  computeApprovalAction,
  decodeEvmError,
  effectivePublishAllowance,
  enrichEvmError,
  EVMChainAdapter,
  InsufficientPublisherFundsError,
  isNoFundedPublisherWalletError,
  isTooLowAllowanceError,
  resolveRpcUrls,
  V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE,
  type EVMAdapterConfig,
} from '../src/evm-adapter.js';
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_REPLENISH_TARGET_ALLOWANCE,
  DEFAULT_REFILL_BELOW_FRACTION,
  type ApprovalPolicy,
} from '../src/chain-adapter.js';
import { _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';
import { isChainRpcTransportError } from '../src/chain-rpc-transport-error.js';
import {
  DEFAULT_FINALITY_CONFIRMATIONS,
  confirmedStateBlockAtHead,
  requiredHeadBlockForReceipt,
  resolveFinalityConfirmations,
  resolveReceiptTimeoutMs,
  RPC_READ_STALL_TIMEOUT_MS,
  RPC_RECEIPT_TIMEOUT_MS,
} from '../src/evm-adapter-constants.js';
import { connectable } from './connectable.js';

// Isolate the process-wide RPC failover stats + dedup window before EVERY test
// so a failover/exhaustion warning emitted by one test can't suppress (via the
// shared dedup window) a `console.warn` assertion in another — and so the new
// failover-log lines are observed against a clean slate (otReviewAgent #1329).
beforeEach(() => {
  _resetRpcFailoverStatsForTest();
});

it('defaults an omitted receipt deadline to ten minutes', () => {
  expect(resolveReceiptTimeoutMs(undefined)).toBe(600_000);
  expect(RPC_RECEIPT_TIMEOUT_MS).toBe(600_000);
});

it('rejects an explicitly invalid receipt deadline at the adapter boundary', () => {
  expect(() => new EVMChainAdapter(minimalConfig({ receiptTimeoutMs: 999 })))
    .toThrow(/receiptTimeoutMs must be a finite number >= 1000/);
});

it('defaults mined-receipt finality to one confirmation', () => {
  expect(resolveFinalityConfirmations(undefined)).toBe(1);
  expect(DEFAULT_FINALITY_CONFIRMATIONS).toBe(1);
  expect((new EVMChainAdapter(minimalConfig()) as any).finalityConfirmations).toBe(1);
});

it('accepts an explicit confirmation depth and rejects invalid values', () => {
  expect(resolveFinalityConfirmations(7)).toBe(7);
  expect((new EVMChainAdapter(minimalConfig({ finalityConfirmations: 7 })) as any)
    .finalityConfirmations).toBe(7);
  for (const value of [null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => resolveFinalityConfirmations(value)).toThrow(
      /finalityConfirmations must be an integer >= 1/,
    );
  }
});

it('uses one confirmation-depth calculation for receipts and pinned state', () => {
  expect(requiredHeadBlockForReceipt(100, 1)).toBe(100);
  expect(requiredHeadBlockForReceipt(100, 7)).toBe(106);
  expect(confirmedStateBlockAtHead(106, 7)).toBe(100);
  expect(confirmedStateBlockAtHead(5, 7)).toBeNull();
});

it('caps populated transaction fee fields when the operator sets maxFeePerGasWei', async () => {
  const cap = 100_000_000n;
  const adapter: any = new EVMChainAdapter(minimalConfig({ maxFeePerGasWei: cap }));
  const wallet = new ethers.Wallet(DEPLOYER_PK).connect({
    getNetwork: async () => ({ chainId: 31337n, name: 'stub' }),
    estimateGas: async () => 21_000n,
    getTransactionCount: async () => 3,
    getFeeData: async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
    getBlock: async () => ({ baseFeePerGas: 1n }),
    resolveName: async (name: string) => name,
    _isProvider: true,
  } as never);
  const { signedTx } = await adapter.signPopulatedTransaction(wallet, {
    to: '0x0000000000000000000000000000000000000002',
    value: 0n,
    nonce: 3,
    gasLimit: 21_000n,
    chainId: 31337,
    type: 2,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const decoded = ethers.Transaction.from(signedTx);
  expect(decoded.maxFeePerGas).toBe(cap);
  expect(decoded.maxPriorityFeePerGas).toBe(cap);
  expect(() => new EVMChainAdapter(minimalConfig({ maxFeePerGasWei: 0n })))
    .toThrow(/maxFeePerGasWei must be greater than zero/);
});

it('rejects an EIP-1559 fee cap below the current base fee before signing', async () => {
  const adapter: any = new EVMChainAdapter(minimalConfig({ maxFeePerGasWei: 100n }));
  const wallet = new ethers.Wallet(DEPLOYER_PK).connect({
    getNetwork: async () => ({ chainId: 31337n, name: 'stub' }),
    estimateGas: async () => 21_000n,
    getTransactionCount: async () => 3,
    getFeeData: async () => ({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n }),
    getBlock: async () => ({ baseFeePerGas: 101n }),
    resolveName: async (name: string) => name,
    _isProvider: true,
  } as never);

  await expect(adapter.signPopulatedTransaction(wallet, {
    to: '0x0000000000000000000000000000000000000002',
    value: 0n,
    nonce: 3,
    gasLimit: 21_000n,
    chainId: 31337,
    type: 2,
    maxFeePerGas: 1_000n,
    maxPriorityFeePerGas: 100n,
  })).rejects.toMatchObject({ code: 'FEE_CAP_BELOW_BASE_FEE' });
});

it('caps a legacy gas price without applying the EIP-1559 base-fee rule', async () => {
  const cap = 100n;
  const adapter: any = new EVMChainAdapter(minimalConfig({ maxFeePerGasWei: cap }));
  const wallet = new ethers.Wallet(DEPLOYER_PK).connect({
    getNetwork: async () => ({ chainId: 31337n, name: 'stub' }),
    estimateGas: async () => 21_000n,
    getTransactionCount: async () => 3,
    getFeeData: async () => ({ gasPrice: 1_000n }),
    resolveName: async (name: string) => name,
    _isProvider: true,
  } as never);
  const { signedTx } = await adapter.signPopulatedTransaction(wallet, {
    to: '0x0000000000000000000000000000000000000002',
    value: 0n,
    nonce: 3,
    gasLimit: 21_000n,
    chainId: 31337,
    type: 0,
    gasPrice: 1_000n,
  });

  expect(ethers.Transaction.from(signedTx).gasPrice).toBe(cap);
});

describe('EVMChainAdapter historical KA update verification', () => {
  const kaId = 42n;
  const publisher = '0x1111111111111111111111111111111111111111';
  const other = '0x3333333333333333333333333333333333333333';
  const storageAddress = '0x2222222222222222222222222222222222222222';
  const root = ethers.keccak256(ethers.toUtf8Bytes('historical-update'));
  const blockHash = `0x${'34'.repeat(32)}`;
  const iface = new Interface([
    'event KnowledgeAssetUpdated(uint256 indexed id, address indexed author, string updateOperationId, bytes32 merkleRoot, uint256 byteSize, uint96 tokenAmount)',
  ]);

  /**
   * r28 (🔴 3821721213) — the register read is now BLOCK-SENSITIVE: the position is derived
   * from this receipt's block only, so the harness must answer differently for `blockNumber` and
   * `blockNumber - 1`. `priorRoots` is the asset's history BEFORE the receipt's block; anything
   * beyond it in `roots` is what that block wrote.
   */
  function adapterWithHistoricalRead(
    roots: unknown[] | Error,
    priorRoots: unknown[] = [],
  ): { adapter: EVMChainAdapter; latestRead: ReturnType<typeof recorder> } {
    const adapter: any = new EVMChainAdapter(minimalConfig());
    adapter.initialized = true;
    adapter.init = async () => {};
    const encoded = iface.encodeEventLog(
      iface.getEvent('KnowledgeAssetUpdated')!,
      [kaId, publisher, 'op', root, 10n, 1n],
    );
    adapter.getTransactionReceiptWithFailover = async () => ({
      status: 1,
      blockNumber: 77,
      blockHash,
      index: 2,
      logs: [{ address: storageAddress, topics: encoded.topics, data: encoded.data }],
    });
    adapter.contracts.knowledgeAssetStorage = {
      getAddress: async () => storageAddress,
      interface: iface,
    };
    const latestRead = recorder(async () => publisher);
    adapter.readContractWithOptions = async (
      _contract: unknown, label: string, _method: string, args: readonly unknown[],
    ) => {
      if (roots instanceof Error) throw roots;
      const blockTag = (args[1] as { blockTag?: number } | undefined)?.blockTag;
      // The pre-block read: everything written before the receipt's block.
      if (label === 'kas.getMerkleRootsBeforeUpdateBlock' || blockTag === 76) return priorRoots;
      return roots;
    };
    return { adapter, latestRead };
  }

  it('returns canonical block placement for a verified update receipt', async () => {
    const { adapter } = adapterWithHistoricalRead([{ publisher, merkleRoot: root }]);

    await expect(adapter.verifyKAUpdate('0xreceipt', kaId, publisher)).resolves.toMatchObject({
      verified: true,
      blockNumber: 77,
      blockHash,
      txIndex: 2,
      merkleRootCount: 1n,
    });
  });

  it('an A -> B -> A history across SEPARATE blocks still yields the third position [r28]', async () => {
    // 🔴 3821721213 — r17 counted matches across the WHOLE register, which at this blockTag is
    // the asset's entire history, not this block's writes. One publisher writing A, then B, then A
    // again in three separate blocks therefore produced two matches for A, dropped the position,
    // and left the third update permanently held — the exact case this PR exists to settle, made
    // unrecoverable by its own ambiguity guard. Ambiguity belongs to the RECEIPT'S BLOCK.
    const { adapter } = adapterWithHistoricalRead(
      // Full history as of the receipt's block: A(1), B(2), A(3) — the third is this receipt's.
      [
        { publisher, merkleRoot: root },
        { publisher, merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('B')) },
        { publisher, merkleRoot: root },
      ],
      // Everything written BEFORE this block: the first two.
      [
        { publisher, merkleRoot: root },
        { publisher, merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('B')) },
      ],
    );

    await expect(adapter.verifyKAUpdate('0xreceipt', kaId, publisher)).resolves.toMatchObject({
      verified: true,
      merkleRootCount: 3n,
    });
  });

  it('two identical writes in the SAME block are still ambiguous [r28]', async () => {
    // The discriminating half: the guard must keep working for genuine same-block ambiguity, which
    // is what it was added for. Same history, but both A entries land in the receipt's block.
    const { adapter } = adapterWithHistoricalRead(
      [
        { publisher, merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('B')) },
        { publisher, merkleRoot: root },
        { publisher, merkleRoot: root },
      ],
      [{ publisher, merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('B')) }],
    );

    const verdict = await adapter.verifyKAUpdate('0xreceipt', kaId, publisher);
    expect(verdict).toMatchObject({ verified: true });
    expect(verdict.merkleRootCount).toBeUndefined();
  });

  it('drops the position — but keeps the verification — when the register match is AMBIGUOUS', async () => {
    // r17 (3814893084) — the register entries carry no transaction hash, so a (publisher, root)
    // match is this receipt's only link to a position, and that link holds only while the match is
    // unique. Two identical writes by the same publisher in this one block make the position a
    // guess. The root is still provably ours at this block, so the verdict stays verified and
    // simply omits the position; downstream an update with no position defers.
    const { adapter } = adapterWithHistoricalRead([
      { publisher, merkleRoot: root },
      { publisher: other, merkleRoot: ethers.ZeroHash },
      { publisher, merkleRoot: root },
    ]);

    const verdict = await adapter.verifyKAUpdate('0xreceipt', kaId, publisher);

    expect(verdict).toMatchObject({ verified: true, blockNumber: 77, blockHash });
    expect(verdict.merkleRootCount).toBeUndefined();
  });

  it('still reports the position when exactly one register entry matches', async () => {
    // The discriminating pair for the row above: same register, one matching entry, and the
    // position is reported. Without this, dropping the position unconditionally would pass.
    const { adapter } = adapterWithHistoricalRead([
      { publisher: other, merkleRoot: ethers.ZeroHash },
      { publisher, merkleRoot: root },
    ]);

    await expect(adapter.verifyKAUpdate('0xreceipt', kaId, publisher))
      .resolves.toMatchObject({ verified: true, merkleRootCount: 2n });
  });

  it.each([
    ['receipt-block history has no matching publisher/root', [{ publisher, merkleRoot: ethers.ZeroHash }]],
    ['receipt-block history cannot be read', new Error('archive state unavailable')],
  ])('fails closed when %s', async (_label, historicalResult) => {
    const { adapter, latestRead } = adapterWithHistoricalRead(historicalResult as unknown[] | Error);

    await expect(adapter.verifyKAUpdate('0xreceipt', kaId, publisher))
      .resolves.toEqual({ verified: false });
    expect(latestRead.calls).toHaveLength(0);
  });

  it.each([
    'RPC_ENDPOINTS_EXHAUSTED',
    'RPC_RECEIPT_LOOKUP_FAILED',
    'RPC_TIMEOUT',
  ])('preserves typed %s receipt failures for durable retry', async (code) => {
    const { adapter } = adapterWithHistoricalRead([]);
    const transportError = Object.assign(new Error(`transport failed: ${code}`), { code });
    (adapter as any).getTransactionReceiptWithFailover = async () => {
      throw transportError;
    };

    await expect(adapter.verifyKAUpdate('0xreceipt', kaId, publisher))
      .rejects.toBe(transportError);
  });

  it('preserves typed receipt-block history failures for durable retry', async () => {
    const transportError = Object.assign(new Error('archive RPC timed out'), {
      code: 'RPC_TIMEOUT',
    });
    const { adapter } = adapterWithHistoricalRead(transportError);

    await expect(adapter.verifyKAUpdate('0xreceipt', kaId, publisher))
      .rejects.toBe(transportError);
  });
});

describe('EVMChainAdapter getIdentityIdForAddress cache', () => {
  const ADDR = '0x00000000000000000000000000000000000000a1';
  const ADDR2 = '0x00000000000000000000000000000000000000a2';
  const identityInterface = new Interface([
    'event IdentityCreated(uint72 indexed identityId, bytes32 indexed operationalKey, bytes32 indexed adminKey)',
  ]);
  const profileInterface = new Interface([
    'event ProfileCreated(uint72 indexed identityId)',
  ]);

  function identityCreatedLog(identityId: bigint) {
    const encoded = identityInterface.encodeEventLog(
      identityInterface.getEvent('IdentityCreated')!,
      [identityId, ethers.ZeroHash, ethers.ZeroHash],
    );
    return { topics: encoded.topics, data: encoded.data };
  }

  function profileCreatedLog(identityId: bigint) {
    const encoded = profileInterface.encodeEventLog(
      profileInterface.getEvent('ProfileCreated')!,
      [identityId],
    );
    return { topics: encoded.topics, data: encoded.data };
  }

  function makeIdentityLookupAdapter(values: bigint[]) {
    const a: any = new EVMChainAdapter(minimalConfig());
    a.initialized = true;
    a.init = async () => { a.initialized = true; };
    a.resolveContract = recorder(async () => ({}));
    let i = 0;
    const readContract = recorder(async () => {
      const value = values[Math.min(i, values.length - 1)];
      i++;
      return value;
    });
    a.readContract = readContract;
    return { a, readContract };
  }

  it('invalid addresses return 0 without an RPC read', async () => {
    const { a, readContract } = makeIdentityLookupAdapter([1n]);
    await expect(a.getIdentityIdForAddress('not-an-address')).resolves.toBe(0n);
    expect(readContract.calls).toHaveLength(0);
  });

  it('coalesces concurrent negative lookups but does not cache the negative result', async () => {
    const { a, readContract } = makeIdentityLookupAdapter([0n, 42n]);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => a.getIdentityIdForAddress(ADDR)),
    );
    expect(results.every((value) => value === 0n)).toBe(true);
    expect(readContract.calls).toHaveLength(1);

    await expect(a.getIdentityIdForAddress(ADDR)).resolves.toBe(42n);
    expect(readContract.calls).toHaveLength(2);
  });

  it('refreshes positive lookups after the positive TTL', async () => {
    vi.useFakeTimers({ now: 0 });
    const { a, readContract } = makeIdentityLookupAdapter([7n, 9n]);

    try {
      await expect(a.getIdentityIdForAddress(ADDR)).resolves.toBe(7n);
      await expect(a.getIdentityIdForAddress(ADDR)).resolves.toBe(7n);
      expect(readContract.calls).toHaveLength(1);

      vi.setSystemTime(5 * 60_000 + 1);

      await expect(a.getIdentityIdForAddress(ADDR)).resolves.toBe(9n);
      expect(readContract.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('local registration and removal update the bounded positive cache', async () => {
    const { a, readContract } = makeIdentityLookupAdapter([0n]);

    a.seedIdentityIdForAddress(ADDR, 7n);
    await expect(a.getIdentityIdForAddress(ADDR)).resolves.toBe(7n);
    expect(readContract.calls).toHaveLength(0);

    a.clearIdentityIdForAddress(ADDR);
    await expect(a.getIdentityIdForAddress(ADDR)).resolves.toBe(0n);
    expect(readContract.calls).toHaveLength(1);
  });

  it('coalesces concurrent self getIdentityId reads through the address cache', async () => {
    const { a, readContract } = makeIdentityLookupAdapter([42n]);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => a.getIdentityId()),
    );

    expect(results.every((value) => value === 42n)).toBe(true);
    expect(readContract.calls).toHaveLength(1);
    expect(readContract.calls[0][3]).toBe((a as any).signer.address);
  });

  it('caches positive self getIdentityId results and refreshes them after the positive TTL', async () => {
    vi.useFakeTimers({ now: 0 });
    const { a, readContract } = makeIdentityLookupAdapter([7n, 9n]);

    try {
      await expect(a.getIdentityId()).resolves.toBe(7n);
      await expect(a.getIdentityId()).resolves.toBe(7n);
      expect(readContract.calls).toHaveLength(1);

      vi.setSystemTime(5 * 60_000 + 1);

      await expect(a.getIdentityId()).resolves.toBe(9n);
      expect(readContract.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches a zero self getIdentityId result only for the short signer TTL', async () => {
    vi.useFakeTimers({ now: 0 });
    const { a, readContract } = makeIdentityLookupAdapter([0n, 42n]);

    try {
      await expect(a.getIdentityId()).resolves.toBe(0n);
      await expect(a.getIdentityId()).resolves.toBe(0n);
      expect(readContract.calls).toHaveLength(1);

      vi.setSystemTime(15_001);

      await expect(a.getIdentityId()).resolves.toBe(42n);
      expect(readContract.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares the short signer zero cache between getIdentityId and getIdentityIdForAddress', async () => {
    vi.useFakeTimers({ now: 0 });
    const { a, readContract } = makeIdentityLookupAdapter([0n, 42n]);

    try {
      await expect(a.getIdentityId()).resolves.toBe(0n);
      await expect(a.getIdentityIdForAddress((a as any).signer.address)).resolves.toBe(0n);
      expect(readContract.calls).toHaveLength(1);

      vi.setSystemTime(15_001);

      await expect(a.getIdentityIdForAddress((a as any).signer.address)).resolves.toBe(42n);
      await expect(a.getIdentityId()).resolves.toBe(42n);
      expect(readContract.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares cache entries between getIdentityId and getIdentityIdForAddress for the signer', async () => {
    const { a, readContract } = makeIdentityLookupAdapter([42n]);

    await expect(a.getIdentityId()).resolves.toBe(42n);
    await expect(a.getIdentityIdForAddress((a as any).signer.address)).resolves.toBe(42n);

    expect(readContract.calls).toHaveLength(1);
  });

  it('identity id reads populate the canonical IdentityStorage lazy binding', async () => {
    const a: any = new EVMChainAdapter(minimalConfig());
    const identityStorage = { identityStorage: true };
    a.initialized = true;
    a.init = async () => { a.initialized = true; };
    a.resolveContract = recorder(async () => identityStorage);
    a.readContract = recorder(async (_contract: unknown, _label: string, method: string) => (
      method === 'getIdentityId' ? 42n : true
    ));

    await expect(a.getIdentityId()).resolves.toBe(42n);
    expect(a.contracts.identityStorage).toBe(identityStorage);

    await expect(a.isOperationalWalletRegistered(42n, ADDR)).resolves.toBe(true);
    expect(a.resolveContract.calls).toHaveLength(1);
    expect(a.readContract.calls).toHaveLength(2);
    expect(a.readContract.calls[0][0]).toBe(identityStorage);
    expect(a.readContract.calls[1][0]).toBe(identityStorage);
  });

  it('identity-id misses re-resolve the memo-served binding and auto-heal a rotated address without an explicit hook (#1583)', async () => {
    // #1583 keeps `getIdentityStorage({ refresh: true })` on every identity-id
    // miss. The re-resolve is memo-served — the ADDRESS is cached in
    // `resolveContractAddress`, so no Hub RPC on the hot path — which is what
    // makes it cheap. What it buys back: a Hub rotation the event poller MISSES
    // is still picked up when the address memo TTL-expires (≤30s), WITHOUT
    // relying on an explicit invalidation hook firing. Here `resolveContract` is
    // stubbed to stand in for the memo: it returns the same handle until the
    // test rotates it.
    const ADDR3 = '0x00000000000000000000000000000000000000a3';
    const a: any = new EVMChainAdapter(minimalConfig());
    const oldIdentityStorage = { target: '0x0000000000000000000000000000000000000101' };
    const newIdentityStorage = { target: '0x0000000000000000000000000000000000000102' };
    let current = oldIdentityStorage;
    a.initialized = true;
    a.init = async () => { a.initialized = true; };
    a.resolveContract = recorder(async () => current);
    // VALUE read keys off the WALLET address (not the contract), so each distinct
    // wallet is a fresh/uncached read even though the binding is shared.
    a.readContract = recorder(async (_c: unknown, _l: string, _m: string, addr: string) => (
      addr === ethers.getAddress(ADDR) ? 7n : 9n
    ));

    // Two distinct-wallet misses each re-resolve (refresh: true), but the memo
    // returns the SAME address, so the binding is stable and no cache is flushed;
    // the `getIdentityId` VALUE read stays fresh/uncached (one readContract each).
    await expect(a.getIdentityIdForAddress(ADDR)).resolves.toBe(7n);
    expect(a.contracts.identityStorage).toBe(oldIdentityStorage);
    await expect(a.getIdentityIdForAddress(ADDR2)).resolves.toBe(9n);
    expect(a.contracts.identityStorage).toBe(oldIdentityStorage);
    expect(a.resolveContract.calls).toHaveLength(2);
    expect(a.readContract.calls).toHaveLength(2);

    // The memo rotates (TTL expiry surfacing a poller-missed Hub rotation). The
    // next miss re-resolves to the new address; the address-change guard flushes
    // the identity caches and rebinds — no explicit invalidation hook required.
    current = newIdentityStorage;
    await expect(a.getIdentityIdForAddress(ADDR3)).resolves.toBe(9n);
    expect(a.contracts.identityStorage).toBe(newIdentityStorage);
    expect(a.resolveContract.calls).toHaveLength(3);
    expect(a.readContract.calls).toHaveLength(3);
  });

  it('IdentityStorage Hub rotation invalidates cached identity ids and the lazy contract binding', async () => {
    const { a, readContract } = makeIdentityLookupAdapter([7n, 9n]);

    await expect(a.getIdentityId()).resolves.toBe(7n);
    await expect(a.getIdentityId()).resolves.toBe(7n);
    expect(readContract.calls).toHaveLength(1);

    (a as any).contracts.identityStorage = { stale: true };
    const init = recorder(async () => { (a as any).initialized = true; });
    (a as any).init = init;
    (a as any).applyHubRotationEventName('IdentityStorage');

    expect((a as any).contracts.identityStorage).toBeUndefined();
    expect((a as any).initialized).toBe(false);
    await expect(a.getIdentityId()).resolves.toBe(9n);
    expect(init.calls).toHaveLength(1);
    expect((a as any).initialized).toBe(true);
    expect(readContract.calls).toHaveLength(2);
  });

  it('bulk bound-contract invalidation clears signer identity cache and IdentityStorage binding', async () => {
    const { a, readContract } = makeIdentityLookupAdapter([7n, 9n]);

    await expect(a.getIdentityId()).resolves.toBe(7n);
    await expect(a.getIdentityId()).resolves.toBe(7n);
    expect(readContract.calls).toHaveLength(1);

    (a as any).contracts.identityStorage = { stale: true };
    (a as any).invalidateAllBoundContracts();

    expect((a as any).contracts.identityStorage).toBeUndefined();
    await expect(a.getIdentityId()).resolves.toBe(9n);
    expect(readContract.calls).toHaveLength(2);
  });

  it('ensureProfile seeds the signer identity cache after IdentityCreated', async () => {
    const { a, readContract } = makeIdentityLookupAdapter([0n, 0n]);
    a.contracts.identity = { interface: identityInterface };
    a.contracts.profile = { interface: profileInterface };
    a.sendContractTransaction = recorder(async () => ({
      logs: [identityCreatedLog(77n)],
      hash: '0x' + '12'.repeat(32),
      blockNumber: 1,
      index: 0,
      status: 1,
    }));

    await expect(a.ensureProfile({ stakeAmount: 0n })).resolves.toBe(77n);
    await expect(a.getIdentityId()).resolves.toBe(77n);
    expect(readContract.calls).toHaveLength(2);
  });

  it('ensureProfile freshly rechecks a cached signer zero before creating a profile', async () => {
    const { a, readContract } = makeIdentityLookupAdapter([0n, 55n]);
    a.sendContractTransaction = recorder(async () => {
      throw new Error('ensureProfile should not create a duplicate profile');
    });

    await expect(a.getIdentityId()).resolves.toBe(0n);
    await expect(a.ensureProfile({ stakeAmount: 0n })).resolves.toBe(55n);
    await expect(a.getIdentityId()).resolves.toBe(55n);
    expect(readContract.calls).toHaveLength(2);
    expect(a.sendContractTransaction.calls).toHaveLength(0);
  });

  it('registerIdentity seeds the signer identity cache after IdentityCreated', async () => {
    const a: any = new EVMChainAdapter(minimalConfig());
    const readContract = recorder(async () => 99n);
    a.init = async () => undefined;
    a.contracts.identity = { interface: identityInterface };
    a.contracts.profile = { interface: profileInterface };
    a.readContract = readContract;
    a.sendContractTransaction = recorder(async () => ({
      logs: [identityCreatedLog(88n)],
      hash: '0x' + '34'.repeat(32),
      blockNumber: 1,
      index: 0,
      status: 1,
    }));

    await expect(a.registerIdentity({ publicKey: new Uint8Array([1]), signature: new Uint8Array() })).resolves.toBe(88n);
    await expect(a.getIdentityId()).resolves.toBe(88n);
    expect(readContract.calls).toHaveLength(0);
  });

  it('registerIdentity seeds the signer identity cache after ProfileCreated fallback', async () => {
    const { a, readContract } = makeIdentityLookupAdapter([0n, 99n]);
    a.contracts.identity = { interface: identityInterface };
    a.contracts.profile = { interface: profileInterface };
    a.sendContractTransaction = recorder(async () => ({
      logs: [profileCreatedLog(89n)],
      hash: '0x' + '56'.repeat(32),
      blockNumber: 1,
      index: 0,
      status: 1,
    }));

    await expect(a.getIdentityId()).resolves.toBe(0n);
    await expect(a.registerIdentity({ publicKey: new Uint8Array([1]), signature: new Uint8Array() })).resolves.toBe(89n);
    await expect(a.getIdentityId()).resolves.toBe(89n);
    expect(readContract.calls).toHaveLength(1);
  });
});

describe('EVMChainAdapter random sampling identity lookup', () => {
  it('createChallenge reads back by the emitted identity without pre-reading signer identity', async () => {
    const a: any = new EVMChainAdapter(minimalConfig());
    const challengeIdentityId = 99n;
    const cachedIdentityId = 42n;
    const contextGraphId = 3n;
    const rsInterface = new Interface([
      'event ChallengeGenerated(uint72 indexed identityId,uint256 indexed contextGraphId,uint256 knowledgeAssetId,uint256 chunkId,uint256 epoch,uint256 activeProofPeriodStartBlock)',
    ]);
    const encoded = rsInterface.encodeEventLog(
      rsInterface.getEvent('ChallengeGenerated')!,
      [challengeIdentityId, contextGraphId, 11n, 2n, 3n, 4n],
    );
    const receipt = {
      hash: '0x' + '11'.repeat(32),
      blockNumber: 123,
      index: 4,
      logs: [{ topics: encoded.topics, data: encoded.data }],
    };
    const challengeRaw = {
      knowledgeAssetId: 11n,
      knowledgeAssetStorageContract: ethers.ZeroAddress,
      chunkId: 2n,
      epoch: 3n,
      activeProofPeriodStartBlock: 4n,
      proofingPeriodDurationInBlocks: 5n,
      solved: false,
      isCurated: false,
      challengeLeafCount: 1n,
      challengeRoot: ethers.ZeroHash,
    };
    const rss = { __rss: true };
    const rs = { interface: rsInterface };
    const readContract = recorder(async () => challengeRaw);
    const sendContractTransaction = recorder(async () => receipt as any);

    a.init = async () => undefined;
    a.getIdentityId = recorder(async () => cachedIdentityId);
    a.getRandomSampling = async () => ({ rs, rss });
    a.readContract = readContract;
    a.sendContractTransaction = sendContractTransaction;
    // Keep selection deterministic (this test is about the identity read-back,
    // not wallet rotation) so it doesn't hit a live balance RPC.
    a.nextRandomSamplingSigner = async () => a.signer;

    const result = await a.createChallenge();

    expect(a.getIdentityId.calls).toHaveLength(0);
    expect(sendContractTransaction.calls[0][1]).toBe('createChallenge');
    expect(readContract.calls).toHaveLength(1);
    expect(readContract.calls[0][0]).toBe(rss);
    expect(readContract.calls[0][1]).toBe('rss.getNodeChallenge');
    expect(readContract.calls[0][3]).toBe(challengeIdentityId);
    expect(result.contextGraphId).toBe(contextGraphId);
    expect(result.challenge.knowledgeAssetId).toBe(11n);
  });

  it('createChallenge signs with the wallet selected by nextRandomSamplingSigner (not hardcoded pool[0])', async () => {
    const a: any = new EVMChainAdapter(minimalConfig({ additionalKeys: [OTHER_PK] }));
    const w1 = a.signerPool[1];
    expect(w1.address).not.toBe(a.signer.address);
    const rsInterface = new Interface([
      'event ChallengeGenerated(uint72 indexed identityId,uint256 indexed contextGraphId,uint256 knowledgeAssetId,uint256 chunkId,uint256 epoch,uint256 activeProofPeriodStartBlock)',
    ]);
    const encoded = rsInterface.encodeEventLog(rsInterface.getEvent('ChallengeGenerated')!, [7n, 3n, 11n, 2n, 3n, 4n]);
    const receipt = { hash: '0x' + '11'.repeat(32), blockNumber: 1, index: 0, logs: [{ topics: encoded.topics, data: encoded.data }] };
    const challengeRaw = {
      knowledgeAssetId: 11n, knowledgeAssetStorageContract: ethers.ZeroAddress, chunkId: 2n, epoch: 3n,
      activeProofPeriodStartBlock: 4n, proofingPeriodDurationInBlocks: 5n, solved: false, isCurated: false,
      challengeLeafCount: 1n, challengeRoot: ethers.ZeroHash,
    };
    a.init = async () => undefined;
    a.getRandomSampling = async () => ({ rs: { interface: rsInterface }, rss: {} });
    a.readContract = recorder(async () => challengeRaw);
    const sendSpy = recorder(async () => receipt);
    a.sendContractTransaction = sendSpy;
    // Force selection to the SECOND operational wallet: if createChallenge were
    // still pinned to this.signer (pool[0]) the send would use it, not w1.
    a.nextRandomSamplingSigner = recorder(async () => w1);

    await a.createChallenge();

    expect(a.nextRandomSamplingSigner.calls).toHaveLength(1);
    expect(sendSpy.calls[0][1]).toBe('createChallenge');
    expect(sendSpy.calls[0][3]).toBe(w1); // the SELECTED signer
    expect(sendSpy.calls[0][5]).toEqual({ gasLimitBufferBps: 5_000 }); // gas headroom preserved
  });

  it('submitProof signs with the wallet selected by nextRandomSamplingSigner', async () => {
    const a: any = new EVMChainAdapter(minimalConfig({ additionalKeys: [OTHER_PK] }));
    const w1 = a.signerPool[1];
    const receipt = { hash: '0x' + '22'.repeat(32), blockNumber: 5, index: 0, status: 1, logs: [] };
    a.init = async () => undefined;
    a.getRandomSampling = async () => ({ rs: {} });
    const sendSpy = recorder(async () => receipt);
    a.sendContractTransaction = sendSpy;
    a.nextRandomSamplingSigner = recorder(async () => w1);

    await a.submitProof(new Uint8Array([1, 2, 3]), []);

    expect(a.nextRandomSamplingSigner.calls).toHaveLength(1);
    expect(sendSpy.calls[0][1]).toBe('submitProof');
    expect(sendSpy.calls[0][3]).toBe(w1); // the SELECTED signer
  });

  // ── self-heal for STALE eligibility: an out-of-band removed wallet that
  // lingers in registeredOperationalAddresses reverts ProfileDoesntExist; the
  // RS send evicts it and retries once on the primary signer (pool[0]).
  const profileDoesntExistError = () => {
    const iface = new Interface(['error ProfileDoesntExist(uint72 identityId)']);
    const e: any = new Error('execution reverted: unknown custom error');
    e.data = iface.encodeErrorResult('ProfileDoesntExist', [0n]); // enrichEvmError reads e.data
    return e;
  };

  it('sendRandomSamplingTx self-heals a ProfileDoesntExist revert: evicts the stale wallet, retries on pool[0]', async () => {
    const a: any = new EVMChainAdapter(minimalConfig({ additionalKeys: [OTHER_PK] }));
    const w0 = a.signer;              // pool[0], the always-registered identity anchor
    const w1 = a.signerPool[1];
    expect(w1.address).not.toBe(w0.address);
    a.registeredOperationalAddresses.add(w1.address.toLowerCase()); // stale: in-set but removed on-chain
    a.nextRandomSamplingSigner = async () => w1;                    // rotation picks the stale wallet
    const okReceipt = { hash: '0xok', status: 1 } as any;
    const sendSpy = recorder(async (_c: any, _m: any, _args: any, signer: any) => {
      if (signer.address === w1.address) throw profileDoesntExistError();
      return okReceipt;
    });
    a.sendContractTransaction = sendSpy;
    const clearSpy = recorder(() => undefined);
    a.clearIdentityIdForAddress = clearSpy;

    const result = await a.sendRandomSamplingTx({}, 'createChallenge', [], 'label');

    expect(result).toBe(okReceipt);
    expect(sendSpy.calls).toHaveLength(2);            // w1 (reverts) → retry w0
    expect(sendSpy.calls[0][3]).toBe(w1);
    expect(sendSpy.calls[1][3]).toBe(w0);             // retried on the primary anchor
    expect(a.registeredOperationalAddresses.has(w1.address.toLowerCase())).toBe(false); // evicted
    expect(clearSpy.calls).toHaveLength(1);           // stale cached identityId dropped
  });

  it('sendRandomSamplingTx does NOT retry a non-ProfileDoesntExist revert (propagates, no eviction)', async () => {
    const a: any = new EVMChainAdapter(minimalConfig({ additionalKeys: [OTHER_PK] }));
    const w1 = a.signerPool[1];
    a.registeredOperationalAddresses.add(w1.address.toLowerCase());
    a.nextRandomSamplingSigner = async () => w1;
    const sendSpy = recorder(async () => { throw new Error('This challenge is no longer active'); });
    a.sendContractTransaction = sendSpy;

    await expect(a.sendRandomSamplingTx({}, 'createChallenge', [], 'label')).rejects.toThrow('no longer active');
    expect(sendSpy.calls).toHaveLength(1);            // no retry
    expect(a.registeredOperationalAddresses.has(w1.address.toLowerCase())).toBe(true); // not evicted
  });

  it('sendRandomSamplingTx does NOT self-heal when the PRIMARY signer reverts (nothing safer to retry)', async () => {
    const a: any = new EVMChainAdapter(minimalConfig()); // single wallet → pool[0] only
    a.nextRandomSamplingSigner = async () => a.signer;
    const sendSpy = recorder(async () => { throw profileDoesntExistError(); });
    a.sendContractTransaction = sendSpy;

    await expect(a.sendRandomSamplingTx({}, 'createChallenge', [], 'label')).rejects.toThrow();
    expect(sendSpy.calls).toHaveLength(1);            // primary revert → no retry loop
  });
});


const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b63b91100';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

// Plain hand-rolled call recorder: records every call's args, runs the real
// impl, returns its result. Replaces vitest's fake-fn API one-for-one without
// pulling in the mock framework.
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

async function flushAsyncWork(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    ...overrides,
  };
}

describe('decodeEvmError / enrichEvmError (07 EVM_MODULE — custom errors)', () => {
  it('returns null for too-short hex', () => {
    expect(decodeEvmError('0x')).toBeNull();
    expect(decodeEvmError('0x1234')).toBeNull();
  });

  it('decodes BatchNotFound from merged Hub ABI errors', () => {
    const iface = new Interface(['error BatchNotFound(uint256 batchId)']);
    const data = iface.encodeErrorResult('BatchNotFound', [42n]);
    const d = decodeEvmError(data);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('BatchNotFound');
    expect(d!.args[0]).toBe(42n);
  });

  it('accepts Uint8Array input', () => {
    const iface = new Interface(['error BatchNotFound(uint256 batchId)']);
    const hex = iface.encodeErrorResult('BatchNotFound', [7n]);
    const bytes = ethers.getBytes(hex);
    const d = decodeEvmError(bytes);
    expect(d?.name).toBe('BatchNotFound');
  });

  it('enrichEvmError replaces unknown custom error substring when data is decodable', () => {
    const iface = new Interface(['error InvalidKARange(uint64 startKAId, uint64 endKAId)']);
    const data = iface.encodeErrorResult('InvalidKARange', [1n, 2n]);
    const err = new Error(
      `execution reverted (unknown custom error data="${data}")`,
    );
    const name = enrichEvmError(err);
    expect(name).toBe('InvalidKARange');
    expect(err.message).not.toContain('unknown custom error');
    expect(err.message).toContain('InvalidKARange');
  });

  it('enrichEvmError returns null when message has no data=', () => {
    expect(enrichEvmError(new Error('rpc failed'))).toBeNull();
  });

  it('decodes NotBatchPublisher from V10 contract errors', () => {
    const iface = new Interface(['error NotBatchPublisher(uint256 batchId, address caller)']);
    const data = iface.encodeErrorResult('NotBatchPublisher', [5n, '0x0000000000000000000000000000000000000001']);
    const d = decodeEvmError(data);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('NotBatchPublisher');
    expect(d!.args[0]).toBe(5n);
  });

  it('decodes KnowledgeAssetExpired', () => {
    const iface = new Interface(['error KnowledgeAssetExpired(uint256 id, uint256 currentEpoch, uint256 endEpoch)']);
    const data = iface.encodeErrorResult('KnowledgeAssetExpired', [1n, 100n, 50n]);
    const d = decodeEvmError(data);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('KnowledgeAssetExpired');
  });

  it('decodes CannotUpdateImmutableKnowledgeAsset', () => {
    const iface = new Interface(['error CannotUpdateImmutableKnowledgeAsset(uint256 id)']);
    const data = iface.encodeErrorResult('CannotUpdateImmutableKnowledgeAsset', [7n]);
    const d = decodeEvmError(data);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('CannotUpdateImmutableKnowledgeAsset');
  });

  it('enrichEvmError returns decoded name for V10 errors', () => {
    const iface = new Interface(['error NotBatchPublisher(uint256 batchId, address caller)']);
    const data = iface.encodeErrorResult('NotBatchPublisher', [3n, '0x0000000000000000000000000000000000000001']);
    const err = new Error(`execution reverted (unknown custom error data="${data}")`);
    const name = enrichEvmError(err);
    expect(name).toBe('NotBatchPublisher');
    expect(err.message).toContain('NotBatchPublisher');
    expect(err.message).not.toContain('unknown custom error');
  });

  it('returns null for unrecognized error selector', () => {
    expect(decodeEvmError('0xdeadbeef')).toBeNull();
  });
});

describe('isNoFundedPublisherWalletError (code-first + shared message marker)', () => {
  it('matches the structured code', () => {
    expect(isNoFundedPublisherWalletError({ code: 'NO_FUNDED_PUBLISHER_WALLET' })).toBe(true);
  });
  it('matches the shared message marker when .code is dropped by a wrapper', () => {
    // Same semantics as the daemon-side predicate — keyed on the dkg-core
    // "No operational wallet has enough funds" prefix, not the literal code.
    expect(isNoFundedPublisherWalletError(new Error('No operational wallet has enough funds to publish.'))).toBe(true);
  });
  it('does NOT match unrelated errors', () => {
    expect(isNoFundedPublisherWalletError({ code: 'CALL_EXCEPTION' })).toBe(false);
    expect(isNoFundedPublisherWalletError(new Error('insufficient funds for gas'))).toBe(false);
    expect(isNoFundedPublisherWalletError(undefined)).toBe(false);
    expect(isNoFundedPublisherWalletError(null)).toBe(false);
  });
});

describe('EVMChainAdapter constructor / getters (no init)', () => {
  it('sets chainType, chainId default, and signer pool', () => {
    const a = new EVMChainAdapter(minimalConfig({ chainId: 'evm:84532' }));
    expect(a.chainType).toBe('evm');
    expect(a.chainId).toBe('evm:84532');
    expect(a.getSignerAddress()).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(a.getSignerAddresses()).toHaveLength(1);
    expect(a.getSignerAddresses()[0]).toBe(a.getSignerAddress());
  });

  it('includes additionalKeys in signer pool (round-robin for publish)', () => {
    const a = new EVMChainAdapter(minimalConfig({ additionalKeys: [OTHER_PK] }));
    const addrs = a.getSignerAddresses();
    expect(addrs).toHaveLength(2);
    expect(addrs[0]).not.toBe(addrs[1]);
  });

  it('rejects adminPrivateKey when it duplicates an operational key', () => {
    expect(() => new EVMChainAdapter(minimalConfig({ adminPrivateKey: DEPLOYER_PK })))
      .toThrow('EVM adminPrivateKey must be distinct from operational keys');
  });

  it('rejects invalid tokenAddress overrides', () => {
    expect(() => new EVMChainAdapter(minimalConfig({ tokenAddress: 'not-an-address' })))
      .toThrow('Invalid tokenAddress');
  });

  it('allows missing adminPrivateKey for backwards-compatible publish/read-only adapters', () => {
    expect(() => new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:59998',
      privateKey: DEPLOYER_PK,
      hubAddress: '0x0000000000000000000000000000000000000001',
      chainId: 'evm:31337',
    })).not.toThrow();

    expect(() => new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:59998',
      privateKey: DEPLOYER_PK,
      hubAddress: '0x0000000000000000000000000000000000000001',
      chainId: 'evm:31337',
      allowNoAdminSigner: true,
    })).not.toThrow();
  });

  it('getProvider returns JsonRpcProvider', () => {
    const a = new EVMChainAdapter(minimalConfig());
    expect(a.getProvider()).toBeDefined();
    expect(typeof a.getProvider().getBlockNumber).toBe('function');
  });

  it('issues un-batched JSON-RPC requests (batchMaxCount=1) so a rate-limited read rejects on its own awaited promise — issue #939', async () => {
    // With ethers' default batching, several concurrent reads coalesce into a
    // single ARRAY-bodied HTTP request; a whole-batch rate-limit error then
    // rejects on the un-awaited batch-drain promise → unhandled "could not
    // coalesce error" rejection (~30k observed live). batchMaxCount:1 sends
    // each read as its own single-object request, so the error attaches to the
    // awaited promise and is caught by the gossip/finalization verifyOnChain
    // try/catch. We assert the observable contract: no request body is an array.
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(raw) as unknown;
        bodies.push(parsed);
        const reqs = Array.isArray(parsed) ? parsed : [parsed];
        const results = reqs.map((r) => ({ jsonrpc: '2.0', id: (r as { id: number }).id, result: '0x1' }));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      const a = new EVMChainAdapter(minimalConfig({ rpcUrl: `http://127.0.0.1:${port}` }));
      const provider = a.getProvider();
      // Three DIFFERENT concurrent read methods so ethers cannot in-flight-dedupe
      // them; default batching would still fold them into one array request.
      await Promise.all([
        provider.getBlockNumber(),
        provider.getBalance(ethers.ZeroAddress),
        provider.getTransactionCount(ethers.ZeroAddress),
      ]);
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      expect(bodies.every((b) => !Array.isArray(b))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('falls back to getContextGraph when ContextGraphStorage lacks getAccessPolicy', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const getAccessPolicy = recorder(async (_id: bigint) => {
      const err = new Error('missing revert data');
      (err as any).code = 'CALL_EXCEPTION';
      throw err;
    });
    const getContextGraph = recorder(async (_id: bigint) => ({
      owner_: ethers.ZeroAddress,
      participantAgents: [],
      metadataBatchId: 0n,
      active: true,
      createdAt: 1n,
      accessPolicy: 1n,
      publishPolicy: 0n,
      publishAuthority: ethers.ZeroAddress,
      publishAuthorityAccountId: 0n,
    }));
    (a as any).init = async () => undefined;
    (a as any).contracts.contextGraphStorage = connectable({
      getAccessPolicy,
      getContextGraph,
    });

    await expect(a.getContextGraphAccessPolicy(6n)).resolves.toBe(1);
    expect(getAccessPolicy.calls.at(-1)).toEqual([6n]);
    expect(getContextGraph.calls.at(-1)).toEqual([6n]);
  });

  it('parses accessPolicy from tuple fallback results', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    (a as any).init = async () => undefined;
    (a as any).contracts.contextGraphStorage = connectable({
      getAccessPolicy: recorder(async () => {
        throw new Error('selector unavailable');
      }),
      getContextGraph: recorder(async () => [
        ethers.ZeroAddress,
        [],
        0n,
        true,
        1n,
        0n,
        1n,
        ethers.ZeroAddress,
        0n,
      ]),
    });

    await expect(a.getContextGraphAccessPolicy(7n)).resolves.toBe(0);
  });

  it('surfaces context graph liveness RPC failures instead of reporting inactive', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const rpcError = new Error('rpc unavailable');
    (a as any).init = async () => undefined;
    (a as any).contracts.contextGraphStorage = connectable({
      isContextGraphActive: recorder(async () => {
        throw rpcError;
      }),
    });

    await expect(a.isContextGraphActiveOnChain(8n)).rejects.toThrow('rpc unavailable');
  });

  it('returns false for a successful inactive context graph liveness read', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const isContextGraphActive = recorder(async (_id: bigint) => false);
    (a as any).init = async () => undefined;
    (a as any).contracts.contextGraphStorage = connectable({ isContextGraphActive });

    await expect(a.isContextGraphActiveOnChain(9n)).resolves.toBe(false);
    expect(isContextGraphActive.calls.at(-1)).toEqual([9n]);
  });

  it('surfaces missing ContextGraphStorage as unknown instead of reporting inactive', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    (a as any).init = async () => undefined;
    (a as any).contracts.contextGraphStorage = undefined;

    await expect(a.isContextGraphActiveOnChain(10n)).rejects.toThrow('ContextGraphStorage not deployed');
  });

  it('uses configured tokenAddress without resolving Hub.Token during init', async () => {
    const tokenAddress = ethers.getAddress(`0x${'22'.repeat(20)}`);
    const contractAddress = ethers.getAddress(`0x${'11'.repeat(20)}`);
    const assetStorageAddress = ethers.getAddress(`0x${'33'.repeat(20)}`);
    const a = new EVMChainAdapter(minimalConfig({ tokenAddress }));
    const getContractAddress = recorder(async (name: string) => {
      if (name === 'Token') throw new Error('Hub.Token should not be resolved when tokenAddress is configured');
      return contractAddress;
    });
    (a as any).contracts.hub = connectable({
      getContractAddress,
      getAssetStorageAddress: recorder(async () => assetStorageAddress),
      on: recorder(async () => undefined),
    });

    await (a as any).init();

    expect(getContractAddress.calls).not.toContainEqual(['Token']);
    await expect((a as any).contracts.token.getAddress()).resolves.toBe(tokenAddress);
  });

  it('dedupes configured RPC URLs in priority order', () => {
    expect(resolveRpcUrls('https://primary.example', [
      'https://primary.example',
      ' https://backup-a.example ',
      'https://backup-b.example',
      'https://backup-a.example',
    ])).toEqual([
      'https://primary.example',
      'https://backup-a.example',
      'https://backup-b.example',
    ]);

    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://primary.example', 'https://backup.example'],
    }));
    expect(a.getRpcUrls()).toEqual(['https://primary.example', 'https://backup.example']);
  });

  it('receipt lookup succeeds on backup when primary throws retryable provider error', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const receipt = { hash: '0xabc', blockNumber: 12, status: 1, logs: [] };
    const primary = {
      getTransactionReceipt: recorder(async () => {
        const err = new Error('socket hang up');
        (err as any).code = 'ECONNRESET';
        throw err;
      }),
    };
    const backup = { getTransactionReceipt: recorder(async () => receipt) };
    (a as any).providers = [primary, backup];

    await expect((a as any).getTransactionReceiptWithFailover('0xabc')).resolves.toBe(receipt);
    expect(primary.getTransactionReceipt.calls).toHaveLength(1);
    expect(backup.getTransactionReceipt.calls).toHaveLength(1);
  });

  it('fails receipt lookup immediately when every RPC endpoint errors', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const primary = {
      getTransactionReceipt: recorder(async () => {
        const err = new Error('socket hang up');
        (err as any).code = 'ECONNRESET';
        throw err;
      }),
    };
    const backup = {
      getTransactionReceipt: recorder(async () => {
        const err = new Error('502 bad gateway');
        (err as any).status = 502;
        throw err;
      }),
    };
    (a as any).providers = [primary, backup];

    await expect((a as any).getTransactionReceiptWithFailover('0xabc')).rejects.toMatchObject({
      code: 'RPC_RECEIPT_LOOKUP_FAILED',
    });
    expect(primary.getTransactionReceipt.calls).toHaveLength(1);
    expect(backup.getTransactionReceipt.calls).toHaveLength(1);
  });

  it('does not fail over deterministic CALL_EXCEPTION errors', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const err = new Error('execution reverted');
    (err as any).code = 'CALL_EXCEPTION';
    const primary = { getTransactionReceipt: recorder(async () => { throw err; }) };
    const backup = { getTransactionReceipt: recorder(async () => null) };
    (a as any).providers = [primary, backup];

    await expect((a as any).getTransactionReceiptWithFailover('0xabc')).rejects.toBe(err);
    expect(backup.getTransactionReceipt.calls).toEqual([]);
  });

  it('tries backup RPC when contract transaction population is rate-limited', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const primaryProvider = { name: 'primary' } as any;
    const backupProvider = { name: 'backup' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, primaryProvider);
    const receipt = { hash: '0xabc', blockNumber: 12, status: 1, logs: [] };
    const populated = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
    // mockImplementationOnce → mockResolvedValueOnce chain modelled as a queue
    // the recorder shifts through (rejection modelled by throwing).
    const populateQueue: Array<() => Promise<any>> = [
      async () => {
        const err = new Error('429 too many requests');
        (err as any).status = 429;
        throw err;
      },
      async () => populated,
    ];
    const populateTransaction = recorder(async () => (populateQueue.shift() ?? (async () => populated))());
    const runners: any[] = [];
    const contract = {
      connect: recorder((runner: any) => {
        runners.push(runner);
        return { createContextGraph: { populateTransaction } };
      }),
    };
    (a as any).providers = [primaryProvider, backupProvider];
    const signPopulatedTransaction = recorder(async (..._a: unknown[]) => ({
      signedTx: '0xdeadbeef',
      txHash: receipt.hash,
    }));
    (a as any).signPopulatedTransaction = signPopulatedTransaction;
    (a as any).sendSignedTransactionAndWait = recorder(async () => receipt);

    await expect((a as any).sendContractTransaction(
      contract,
      'createContextGraph',
      [],
      signer,
      'create on-chain context graph',
    )).resolves.toBe(receipt);

    expect(populateTransaction.calls).toHaveLength(2);
    expect(runners.map((runner) => runner.provider)).toEqual([primaryProvider, backupProvider]);
    expect(signPopulatedTransaction.calls).toContainEqual([
      runners[1],
      populated,
    ]);
  });

  it('inflates gasLimit by gasLimitBufferBps when populate leaves it unset (OOG headroom)', async () => {
    // createChallenge's gas depends on per-block randomness, so the adapter
    // estimates once and inflates the limit. Verify the buffered branch
    // actually mutates the populated tx that gets signed (Codex review:
    // previously only covered indirectly through flaky Hardhat e2e).
    const a = new EVMChainAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    const provider = { name: 'only' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, provider);
    const receipt = { hash: '0xabc', blockNumber: 7, status: 1, logs: [] };
    // No gasLimit from populate → buffered-estimate path runs.
    const populated: any = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
    const populateTransaction = recorder(async () => populated);
    const estimateGas = recorder(async () => 1_000_000n);
    const contract = {
      connect: recorder(() => ({ createChallenge: { populateTransaction, estimateGas } })),
    };
    (a as any).providers = [provider];
    const signSpy = recorder(async (..._a: any[]) => ({ signedTx: '0xdead', txHash: receipt.hash }));
    (a as any).signPopulatedTransaction = signSpy;
    (a as any).sendSignedTransactionAndWait = recorder(async () => receipt);

    await expect((a as any).sendContractTransaction(
      contract,
      'createChallenge',
      [],
      signer,
      'create random-sampling challenge',
      { gasLimitBufferBps: 5_000 },
    )).resolves.toBe(receipt);

    expect(estimateGas.calls).toHaveLength(1);
    // 1_000_000 * (10_000 + 5_000) / 10_000 = 1_500_000
    expect(signSpy.calls[0][1].gasLimit).toBe(1_500_000n);
  });

  it('falls back to the unbuffered signing flow and warns when buffered estimateGas throws', async () => {
    const a = new EVMChainAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    const provider = { name: 'only' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, provider);
    const receipt = { hash: '0xabc', blockNumber: 9, status: 1, logs: [] };
    const populated: any = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
    const populateTransaction = recorder(async () => populated);
    const estimateGas = recorder(async () => { throw new Error('estimate boom'); });
    const contract = {
      connect: recorder(() => ({ createChallenge: { populateTransaction, estimateGas } })),
    };
    (a as any).providers = [provider];
    const signSpy = recorder(async (..._a: any[]) => ({ signedTx: '0xdead', txHash: receipt.hash }));
    (a as any).signPopulatedTransaction = signSpy;
    (a as any).sendSignedTransactionAndWait = recorder(async () => receipt);
    const origWarn = console.warn;
    const warnSpy = recorder((..._a: unknown[]) => undefined);
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      await expect((a as any).sendContractTransaction(
        contract,
        'createChallenge',
        [],
        signer,
        'create random-sampling challenge',
        { gasLimitBufferBps: 5_000 },
      )).resolves.toBe(receipt);

      // No headroom applied — gasLimit stays unset so ethers estimates during
      // signing (unbuffered, but no worse than before the buffer existed).
      expect(signSpy.calls[0][1].gasLimit).toBeUndefined();
      expect(warnSpy.calls).toHaveLength(1);
      expect(String(warnSpy.calls[0][0])).toContain('buffered gas estimation failed');
    } finally {
      console.warn = origWarn;
    }
  });

  it('skips gas estimation when populate already set gasLimit (buffer is a no-op)', async () => {
    const a = new EVMChainAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    const provider = { name: 'only' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, provider);
    const receipt = { hash: '0xabc', blockNumber: 11, status: 1, logs: [] };
    const populated: any = { to: '0x0000000000000000000000000000000000000001', data: '0x1234', gasLimit: 800_000n };
    const populateTransaction = recorder(async () => populated);
    const estimateGas = recorder(async () => 1_000_000n);
    const contract = {
      connect: recorder(() => ({ createChallenge: { populateTransaction, estimateGas } })),
    };
    (a as any).providers = [provider];
    const signSpy = recorder(async (..._a: any[]) => ({ signedTx: '0xdead', txHash: receipt.hash }));
    (a as any).signPopulatedTransaction = signSpy;
    (a as any).sendSignedTransactionAndWait = recorder(async () => receipt);

    await expect((a as any).sendContractTransaction(
      contract,
      'createChallenge',
      [],
      signer,
      'create random-sampling challenge',
      { gasLimitBufferBps: 5_000 },
    )).resolves.toBe(receipt);

    expect(estimateGas.calls).toEqual([]);
    expect(signSpy.calls[0][1].gasLimit).toBe(800_000n);
  });

  it('fails over to the next RPC when buffered estimateGas is rate-limited (keeps the OOG headroom)', async () => {
    // A retryable estimate failure must NOT silently drop the gas headroom
    // by signing unbuffered against the failing provider — that reintroduces
    // the OOG this guards against. Instead the outer loop should fail over to
    // a healthy RPC that can estimate, and the buffer is still applied
    // (Codex review).
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const primaryProvider = { name: 'primary' } as any;
    const backupProvider = { name: 'backup' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, primaryProvider);
    const receipt = { hash: '0xabc', blockNumber: 13, status: 1, logs: [] };
    // Fresh populated per provider so provider #1's discarded attempt can't
    // leak a gasLimit onto provider #2.
    const populateTransaction = recorder(async () => (
      { to: '0x0000000000000000000000000000000000000001', data: '0x1234' } as any
    ));
    // mockImplementationOnce → mockResolvedValueOnce chain as a shift()ed queue.
    const estimateQueue: Array<() => Promise<bigint>> = [
      async () => {
        const err = new Error('429 too many requests');
        (err as any).status = 429;
        throw err;
      },
      async () => 1_000_000n,
    ];
    const estimateGas = recorder(async () => (estimateQueue.shift() ?? (async () => 1_000_000n))());
    const runners: any[] = [];
    const contract = {
      connect: recorder((runner: any) => {
        runners.push(runner);
        return { createChallenge: { populateTransaction, estimateGas } };
      }),
    };
    (a as any).providers = [primaryProvider, backupProvider];
    const signSpy = recorder(async (..._a: any[]) => ({ signedTx: '0xdead', txHash: receipt.hash }));
    (a as any).signPopulatedTransaction = signSpy;
    (a as any).sendSignedTransactionAndWait = recorder(async () => receipt);
    const origWarn = console.warn;
    const warnSpy = recorder((..._a: unknown[]) => undefined);
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      await expect((a as any).sendContractTransaction(
        contract,
        'createChallenge',
        [],
        signer,
        'create random-sampling challenge',
        { gasLimitBufferBps: 5_000 },
      )).resolves.toBe(receipt);

      expect(estimateGas.calls).toHaveLength(2);
      expect(populateTransaction.calls).toHaveLength(2);
      // Buffer still applied on the healthy provider.
      expect(signSpy.calls[0][1].gasLimit).toBe(1_500_000n);
      // Signed against the BACKUP runner, not the rate-limited primary.
      expect(signSpy.calls[0][0].provider).toBe(backupProvider);
      // Failover, not silent fallback: the "headroom not applied" fallback
      // warning must NOT fire (the buffer was applied on the healthy backup).
      const headroomWarnings = warnSpy.calls.filter(
        (c: unknown[]) => String(c[0]).includes('buffered gas estimation failed'),
      );
      expect(headroomWarnings).toEqual([]);
      // The failover itself is now observable as exactly one dedup'd line (the
      // W3 failover logger) — asserted separately from the gas-headroom concern
      // so neither masks the other.
      const failoverWarnings = warnSpy.calls.filter(
        (c: unknown[]) => String(c[0]).includes('RPC failover'),
      );
      expect(failoverWarnings).toHaveLength(1);
    } finally {
      console.warn = origWarn;
    }
  });

  it('names exhausted RPC endpoints when transaction population fails everywhere', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const primaryProvider = { name: 'primary' } as any;
    const backupProvider = { name: 'backup' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, primaryProvider);
    const populateTransaction = recorder(async () => {
      const err = new Error('429 too many requests');
      (err as any).status = 429;
      throw err;
    });
    const contract = {
      connect: recorder(() => ({ createContextGraph: { populateTransaction } })),
    };
    (a as any).providers = [primaryProvider, backupProvider];
    const signPopulatedTransaction = recorder(async () => ({
      signedTx: '0xdeadbeef',
      txHash: '0xabc',
    }));
    (a as any).signPopulatedTransaction = signPopulatedTransaction;
    const sendSignedTransactionAndWait = recorder(async () => ({}));
    (a as any).sendSignedTransactionAndWait = sendSignedTransactionAndWait;

    let thrown: any;
    try {
      await (a as any).sendContractTransaction(
        contract,
        'createContextGraph',
        [],
        signer,
        'create on-chain context graph',
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({
      code: 'RPC_ENDPOINTS_EXHAUSTED',
      // The structured rpcUrls property is the canonical config list (diagnostic;
      // never serialized into an HTTP response body — only code/txHash/message
      // reach clients).
      rpcUrls: ['https://primary.example', 'https://backup.example'],
    });
    // The MESSAGE names the endpoints HOST-ONLY: a configured rpcUrl may carry
    // an API key and err.message IS surfaced to HTTP clients via echoing paths
    // (e.g. the create+publish 207 tail), so it must never embed full URLs.
    expect(thrown.message).toContain('primary.example');
    expect(thrown.message).toContain('backup.example');
    expect(thrown.message).not.toContain('https://');
    expect(populateTransaction.calls).toHaveLength(2);
    expect(signPopulatedTransaction.calls).toEqual([]);
    expect(sendSignedTransactionAndWait.calls).toEqual([]);
  });

  it('single-provider exhaustion keeps the RPC_ENDPOINTS_EXHAUSTED code but preserves the original message verbatim (#895 / Codex PR #901)', async () => {
    // One configured RPC → no failover, but downstream classifiers
    // (`/api/context-graph/register`) still key the transient-outage 503 off
    // the RPC_ENDPOINTS_EXHAUSTED code, so the code MUST survive. The
    // single-endpoint case must NOT, however, rewrite the message into the
    // multi-endpoint "failed on all configured RPC endpoints (…)" aggregate —
    // there is no second endpoint, so the original message reads cleaner and
    // message-inspecting callers keep seeing it unchanged.
    const a = new EVMChainAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    const onlyProvider = { name: 'only' } as any;
    const signer = new ethers.Wallet(DEPLOYER_PK, onlyProvider);
    const populateTransaction = recorder(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8545');
    });
    const contract = {
      connect: recorder(() => ({ createContextGraph: { populateTransaction } })),
    };
    (a as any).providers = [onlyProvider];
    const signPopulatedTransaction = recorder(() => undefined);
    (a as any).signPopulatedTransaction = signPopulatedTransaction;
    const sendSignedTransactionAndWait = recorder(() => undefined);
    (a as any).sendSignedTransactionAndWait = sendSignedTransactionAndWait;

    let thrown: any;
    try {
      await (a as any).sendContractTransaction(
        contract,
        'createContextGraph',
        [],
        signer,
        'create on-chain context graph',
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({
      code: 'RPC_ENDPOINTS_EXHAUSTED',
      rpcUrls: ['https://only.example'],
    });
    // Message stays byte-identical — no "failed on all configured RPC
    // endpoints (…)" aggregate, and the label is not prepended.
    expect(thrown.message).toBe('connect ECONNREFUSED 127.0.0.1:8545');
    expect(thrown.message).not.toContain('all configured RPC endpoints');
    // The original error is preserved as the cause.
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect((thrown as { cause: Error }).cause.message).toBe('connect ECONNREFUSED 127.0.0.1:8545');
    expect(populateTransaction.calls).toHaveLength(1);
    expect(signPopulatedTransaction.calls).toEqual([]);
    expect(sendSignedTransactionAndWait.calls).toEqual([]);
  });

  it('broadcasts the exact same signed raw transaction to backup after primary send failure', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0x02f86c0180843b9aca0084773594008252089400000000000000000000000000000000000000018080c001a0' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const txHash = '0x' + '11'.repeat(32);
    const blockHash = '0x' + '45'.repeat(32);
    const receipt = { hash: txHash, blockNumber: 45, blockHash, status: 1, logs: [] };
    const primary = {
      broadcastTransaction: recorder(async (_raw: string) => {
        const err = new Error('429 too many requests');
        (err as any).status = 429;
        throw err;
      }),
      getTransactionReceipt: recorder(async () => null),
      getBlockNumber: recorder(async () => 45),
      getBlock: recorder(async () => ({ number: 45, hash: blockHash })),
    };
    const backup = {
      broadcastTransaction: recorder(async (_raw: string) => ({ hash: txHash })),
      getTransactionReceipt: recorder(async () => receipt),
      getBlockNumber: recorder(async () => 45),
      getBlock: recorder(async () => ({ number: 45, hash: blockHash })),
    };
    (a as any).providers = [primary, backup];

    await expect((a as any).sendSignedTransactionAndWait(signedTx, txHash, 'unit write')).resolves.toBe(receipt);
    expect(primary.broadcastTransaction.calls).toContainEqual([signedTx]);
    expect(backup.broadcastTransaction.calls).toContainEqual([signedTx]);
  });

  it('stamps RPC_ENDPOINTS_EXHAUSTED when broadcast fails over EVERY endpoint (#1329 review R-1)', async () => {
    // Without the code stamp, a broadcast-time exhaustion (after a provider
    // populated/signed) surfaces code-less and the daemon maps it to a generic
    // 500 instead of the intended retryable 503.
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0xdeadbeef';
    const txHash = '0x' + '22'.repeat(32);
    const throttled = (name: string) => ({
      broadcastTransaction: recorder(async (_raw: string) => {
        const err = new Error(`429 too many requests (${name})`);
        (err as any).status = 429;
        throw err;
      }),
    });
    (a as any).providers = [throttled('primary'), throttled('backup')];
    const origWarn = console.warn;
    console.warn = (() => undefined) as typeof console.warn;
    try {
      await expect((a as any).broadcastSignedTransactionWithFailover(signedTx, txHash, 'unit write'))
        .rejects.toMatchObject({
          code: 'RPC_ENDPOINTS_EXHAUSTED',
          rpcUrls: ['https://primary.example', 'https://backup.example'],
        });
    } finally {
      console.warn = origWarn;
    }
  });

  it('preserves the transaction hash when post-broadcast receipt lookup exhausts RPC endpoints', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0xdeadbeef';
    const txHash = '0x' + '55'.repeat(32);
    const primaryProvider = {
      name: 'primary',
      broadcastTransaction: recorder(async () => ({ hash: txHash })),
      getTransactionReceipt: recorder(async () => {
        const err = new Error('429 too many requests');
        (err as any).status = 429;
        throw err;
      }),
    };
    const backupProvider = {
      name: 'backup',
      broadcastTransaction: recorder(async () => ({ hash: txHash })),
      getTransactionReceipt: recorder(async () => {
        const err = new Error('502 bad gateway');
        (err as any).status = 502;
        throw err;
      }),
    };
    const signer = new ethers.Wallet(DEPLOYER_PK, primaryProvider as any);
    const populated = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
    const populateTransaction = recorder(async () => populated);
    const contract = {
      connect: recorder(() => ({ createContextGraph: { populateTransaction } })),
    };
    (a as any).providers = [primaryProvider, backupProvider];
    const signPopulatedTransaction = recorder(async () => ({ signedTx, txHash }));
    (a as any).signPopulatedTransaction = signPopulatedTransaction;

    await expect((a as any).sendContractTransaction(
      contract,
      'createContextGraph',
      [],
      signer,
      'create on-chain context graph',
    )).rejects.toMatchObject({
      code: 'RPC_RECEIPT_LOOKUP_FAILED',
      txHash,
    });
    expect(populateTransaction.calls).toHaveLength(1);
    expect(signPopulatedTransaction.calls).toHaveLength(1);
    expect(primaryProvider.broadcastTransaction.calls).toContainEqual([signedTx]);
    expect(backupProvider.broadcastTransaction.calls).toEqual([]);
    expect(primaryProvider.getTransactionReceipt.calls).toContainEqual([txHash]);
    expect(backupProvider.getTransactionReceipt.calls).toContainEqual([txHash]);
  });

  it('classifies receipt wait expiry as a timeout and preserves the transaction hash', async () => {
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig({
        receiptTimeoutMs: 1_000,
        rpcUrls: ['https://backup.example'],
      }));
      const signedTx = '0xdeadbeef';
      const txHash = '0x' + '66'.repeat(32);
      const primary = {
        name: 'primary',
        broadcastTransaction: recorder(async () => ({ hash: txHash })),
        // Hung lower-level receipt attempt: the overall 1s budget must win over
        // the transport's normal 5s per-attempt cap.
        getTransactionReceipt: recorder(async () => new Promise<never>(() => {})),
      };
      const backup = {
        name: 'backup',
        broadcastTransaction: recorder(async () => ({ hash: txHash })),
        getTransactionReceipt: recorder(async () => null),
      };
      const signer = new ethers.Wallet(DEPLOYER_PK, primary as any);
      const populated = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
      const populateTransaction = recorder(async () => populated);
      const contract = {
        connect: recorder(() => ({ createContextGraph: { populateTransaction } })),
      };
      (a as any).providers = [primary, backup];
      const signPopulatedTransaction = recorder(async () => ({ signedTx, txHash }));
      (a as any).signPopulatedTransaction = signPopulatedTransaction;

      const thrown = (async () => {
        try {
          await (a as any).sendContractTransaction(
            contract,
            'createContextGraph',
            [],
            signer,
            'create on-chain context graph',
          );
          return undefined;
        } catch (err) {
          return err;
        }
      })();
      await vi.advanceTimersByTimeAsync(1_001);

      const timeoutErr = await thrown;
      expect(timeoutErr).toMatchObject({ code: 'RPC_TIMEOUT', txHash });
      // The production receipt-wait timeout emitter must throw a recognised
      // chain-transport error (so the daemon maps it to 504), not a bare shape.
      expect(isChainRpcTransportError(timeoutErr)).toBe(true);
      expect(populateTransaction.calls).toHaveLength(1);
      expect(signPopulatedTransaction.calls).toHaveLength(1);
      expect(primary.broadcastTransaction.calls).toContainEqual([signedTx]);
      expect(primary.getTransactionReceipt.calls).toHaveLength(1);
      // The first hung lookup consumes the shared operation budget; the
      // transport pass must stop instead of continuing in the background.
      expect(backup.getTransactionReceipt.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces the ten-minute receipt deadline when adapter config omits it', async () => {
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const signedTx = '0xdeadbeef';
      const txHash = '0x' + '67'.repeat(32);
      const provider = {
        name: 'primary',
        broadcastTransaction: recorder(async () => ({ hash: txHash })),
        getTransactionReceipt: recorder(async () => null),
      };
      const signer = new ethers.Wallet(DEPLOYER_PK, provider as any);
      const populated = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
      const populateTransaction = recorder(async () => populated);
      const contract = {
        connect: recorder(() => ({ createContextGraph: { populateTransaction } })),
      };
      (a as any).providers = [provider];
      const signPopulatedTransaction = recorder(async () => ({ signedTx, txHash }));
      (a as any).signPopulatedTransaction = signPopulatedTransaction;

      const outcome = (a as any).sendContractTransaction(
        contract,
        'createContextGraph',
        [],
        signer,
        'create on-chain context graph',
      ).then(
        (value: unknown) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      let settled = false;
      void outcome.finally(() => { settled = true; });

      // Pin the adapter's observable boundary without consulting the production
      // timeout constant: the old three-minute default must remain pending.
      await vi.advanceTimersByTimeAsync(180_001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(419_998);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);

      const result = await outcome;
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { code: 'RPC_TIMEOUT', txHash },
      });
      expect(result.status === 'rejected' ? (result.reason as Error).message : '')
        .toContain('after 600000ms');
      expect(populateTransaction.calls).toHaveLength(1);
      expect(signPopulatedTransaction.calls).toHaveLength(1);
      expect(provider.broadcastTransaction.calls).toContainEqual([signedTx]);
      expect(provider.getTransactionReceipt.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats already-known transaction responses as accepted and polls receipts', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0xdeadbeef';
    const txHash = '0x' + '22'.repeat(32);
    const blockHash = '0x' + '46'.repeat(32);
    const receipt = { hash: txHash, blockNumber: 46, blockHash, status: 1, logs: [] };
    const primary = {
      broadcastTransaction: recorder(async () => {
        throw new Error('already known');
      }),
      getTransactionReceipt: recorder(async () => receipt),
      getBlockNumber: recorder(async () => 46),
      getBlock: recorder(async () => ({ number: 46, hash: blockHash })),
    };
    const backup = {
      broadcastTransaction: recorder(async () => ({ hash: txHash })),
      getTransactionReceipt: recorder(async () => receipt),
      getBlockNumber: recorder(async () => 46),
      getBlock: recorder(async () => ({ number: 46, hash: blockHash })),
    };
    (a as any).providers = [primary, backup];

    await expect((a as any).sendSignedTransactionAndWait(signedTx, txHash, 'unit write')).resolves.toBe(receipt);
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    expect(backup.broadcastTransaction.calls).toEqual([]);
    expect(primary.getTransactionReceipt.calls).toContainEqual([txHash]);
  });

  it('does not treat a generic nonce-too-low response as proof that the exact transaction was accepted', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0xdeadbeef';
    const txHash = '0x' + '44'.repeat(32);
    const primary = {
      broadcastTransaction: recorder(async () => {
        const err = new Error('nonce too low');
        (err as any).code = 'NONCE_EXPIRED';
        throw err;
      }),
      getTransactionReceipt: recorder(async () => null),
    };
    const backup = {
      broadcastTransaction: recorder(async () => ({ hash: txHash })),
      getTransactionReceipt: recorder(async () => null),
    };
    (a as any).providers = [primary, backup];

    await expect((a as any).sendSignedTransactionAndWait(signedTx, txHash, 'unit write'))
      .rejects.toMatchObject({ code: 'NONCE_EXPIRED' });
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    expect(backup.broadcastTransaction.calls).toEqual([]);
    expect(primary.getTransactionReceipt.calls).toEqual([]);
    expect(backup.getTransactionReceipt.calls).toEqual([]);
  });

  it('throws CALL_EXCEPTION when a mined write receipt reverted', async () => {
    const a = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
    }));
    const signedTx = '0xdeadbeef';
    const txHash = '0x' + '33'.repeat(32);
    const blockHash = '0x' + '47'.repeat(32);
    const receipt = { hash: txHash, blockNumber: 47, blockHash, status: 0, logs: [] };
    const primary = {
      broadcastTransaction: recorder(async () => ({ hash: txHash })),
      getTransactionReceipt: recorder(async () => receipt),
      getBlockNumber: recorder(async () => 47),
      getBlock: recorder(async () => ({ number: 47, hash: blockHash })),
    };
    const backup = {
      broadcastTransaction: recorder(async () => ({ hash: txHash })),
      getTransactionReceipt: recorder(async () => receipt),
      getBlockNumber: recorder(async () => 47),
      getBlock: recorder(async () => ({ number: 47, hash: blockHash })),
    };
    (a as any).providers = [primary, backup];

    await expect((a as any).sendSignedTransactionAndWait(signedTx, txHash, 'unit write')).rejects.toMatchObject({
      code: 'CALL_EXCEPTION',
      receipt,
    });
    expect(backup.getTransactionReceipt.calls).toEqual([]);
  });

  it('signMessage returns 32-byte r and vs (no contract init)', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const digest = ethers.randomBytes(32);
    const sig = await a.signMessage(digest);
    expect(sig.r).toHaveLength(32);
    expect(sig.vs).toHaveLength(32);
  });

  it('reserves distinct authorized publisher signers across concurrent address probes', async () => {
    const a = new EVMChainAdapter(minimalConfig({ additionalKeys: [OTHER_PK] }));
    const [firstAddress, secondAddress] = a.getSignerAddresses();
    (a as any).init = async () => undefined;
    (a as any).contracts.contextGraphs = connectable({
      isAuthorizedPublisher: recorder(async () => {
        await Promise.resolve();
        return true;
      }),
    });

    const [firstReserved, secondReserved] = await Promise.all([
      a.getAuthorizedPublisherAddress(1n),
      a.getAuthorizedPublisherAddress(1n),
    ]);

    expect(firstReserved).toBe(firstAddress);
    expect(secondReserved).toBe(secondAddress);
  });

  it('accepts randomSamplingHubRefreshMs override without RPC contact', () => {
    const a = new EVMChainAdapter(minimalConfig({ randomSamplingHubRefreshMs: 60_000 }));
    expect(a.chainType).toBe('evm');
  });

  it('startHubRotationListener validates Hub binding with a startup head baseline but without RPC logs', async () => {
    const a: any = new EVMChainAdapter(minimalConfig());
    const iface = new ethers.Interface([
      'event NewContract(string contractName, address newContractAddress)',
      'event ContractChanged(string contractName, address newContractAddress)',
      'event NewAssetStorage(string contractName, address newContractAddress)',
      'event AssetStorageChanged(string contractName, address newContractAddress)',
    ]);
    const provider = {
      getBlockNumber: recorder(async () => 1_000),
      getLogs: recorder(async () => {
        throw new Error('startup should not read logs');
      }),
    };
    a.providers = [provider];
    a.rpcUrls = ['https://primary.example'];
    a.primaryProvider = provider;
    a.provider = provider;
    a.contracts.hub = {
      interface: iface,
      getAddress: async () => '0x0000000000000000000000000000000000000001',
    };
    await expect(a.startHubRotationListener()).resolves.toBeUndefined();

    expect(provider.getBlockNumber.calls).toEqual([[]]);
    expect(provider.getLogs.calls).toEqual([]);
    expect(a.hubRotationPoller.isStarted).toBe(true);
  });

  it('startHubRotationListener refuses partial Hub rotation event ABI', async () => {
    const a: any = new EVMChainAdapter(minimalConfig());
    const iface = new ethers.Interface([
      'event NewContract(string contractName, address newContractAddress)',
      'event ContractChanged(string contractName, address newContractAddress)',
      'event NewAssetStorage(string contractName, address newContractAddress)',
    ]);
    const provider = {
      getBlockNumber: recorder(async () => 1_000),
      getLogs: recorder(async () => []),
    };
    a.providers = [provider];
    a.rpcUrls = ['https://primary.example'];
    a.primaryProvider = provider;
    a.provider = provider;
    a.contracts.hub = {
      interface: iface,
      getAddress: async () => '0x0000000000000000000000000000000000000001',
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(a.startHubRotationListener()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
        'Hub rotation poller setup disabled: Hub ABI is missing required rotation event AssetStorageChanged',
      ));
    } finally {
      warnSpy.mockRestore();
    }

    expect(provider.getBlockNumber.calls).toEqual([]);
    expect(provider.getLogs.calls).toEqual([]);
    expect(a.hubRotationPoller.isStarted).toBe(false);
  });

  it('startHubRotationListener uses one startup head baseline while backup reads still work', async () => {
    const a: any = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://primary.example',
      rpcUrls: ['https://backup.example'],
      staticNetwork: true,
    }));
    const primaryError = new Error('429 too many requests');
    (primaryError as any).status = 429;
    const primaryProvider = {
      send: recorder(async () => { throw primaryError; }),
      getBlockNumber: recorder(async () => {
        throw new Error('primary read should fail before blockNumber');
      }),
    };
    const backupProvider = {
      send: recorder(async (method: string) => {
        expect(method).toBe('eth_chainId');
        return '0x7a69';
      }),
      getBlockNumber: recorder(async () => 123),
    };
    a.primaryProvider = primaryProvider;
    a.provider = primaryProvider;
    a.providers = [primaryProvider, backupProvider];
    a.rpcUrls = ['https://primary.example', 'https://backup.example'];
    a.contracts.hub = {
      interface: new ethers.Interface([
        'event NewContract(string contractName, address newContractAddress)',
        'event ContractChanged(string contractName, address newContractAddress)',
        'event NewAssetStorage(string contractName, address newContractAddress)',
        'event AssetStorageChanged(string contractName, address newContractAddress)',
      ]),
      getAddress: async () => '0x0000000000000000000000000000000000000001',
    };

    await expect(a.startHubRotationListener()).resolves.toBeUndefined();
    await flushAsyncWork();
    expect(a.hubRotationPoller.isStarted).toBe(true);

    await expect(a.readProvider('getBlockNumber', (p: any) => p.getBlockNumber()))
      .resolves.toBe(123);
    expect(primaryProvider.getBlockNumber.calls).toEqual([]);
    expect(backupProvider.getBlockNumber.calls).toHaveLength(2);
  });

  it('startHubRotationListener wires Hub rotation names into adapter invalidation without subscriptions', async () => {
    vi.useFakeTimers({ now: 0 });
    const a: any = new EVMChainAdapter(minimalConfig());
    const iface = new ethers.Interface([
      'event NewContract(string contractName, address newContractAddress)',
      'event ContractChanged(string contractName, address newContractAddress)',
      'event NewAssetStorage(string contractName, address newContractAddress)',
      'event AssetStorageChanged(string contractName, address newContractAddress)',
    ]);
    const changed = iface.encodeEventLog(iface.getEvent('ContractChanged')!, [
      'ContextGraphs',
      '0x00000000000000000000000000000000000000c1',
    ]);
    let head = 1_000;
    let includeRotationLog = false;
    const provider = {
      getBlockNumber: recorder(async () => head),
      getLogs: recorder(async (_filter: any) => includeRotationLog ? [{
        blockNumber: 1_001,
        blockHash: '0x' + '30'.repeat(32),
        transactionHash: '0x' + '31'.repeat(32),
        index: 0,
        topics: changed.topics,
        data: changed.data,
      }] : []),
      destroy: recorder(() => undefined),
    };
    const on = recorder(async () => {
      throw new Error('ethers subscription should not be installed');
    });
    a.providers = [provider];
    a.rpcUrls = ['https://primary.example'];
    a.primaryProvider = provider;
    a.provider = provider;
    a.contracts.hub = {
      interface: iface,
      getAddress: async () => '0x0000000000000000000000000000000000000001',
      on,
    };
    a.contracts.contextGraphs = { stale: true };
    a.cachedKav10Address = { value: '0x00000000000000000000000000000000000000aa', cachedAt: 1 };
    a.initialized = true;

    try {
      await expect(a.startHubRotationListener()).resolves.toBeUndefined();
      await flushAsyncWork();
      includeRotationLog = true;
      head = 1_001;
      await vi.advanceTimersByTimeAsync(30_000);
      a.destroy();

      expect(on.calls).toEqual([]);
      expect(provider.getLogs.calls).toHaveLength(1);
      expect(provider.getLogs.calls[0][0]).toMatchObject({
        address: '0x0000000000000000000000000000000000000001',
        fromBlock: 951,
        toBlock: 1_001,
      });
      expect(provider.getLogs.calls[0][0].topics[0]).toEqual([
        iface.getEvent('ContractChanged')!.topicHash,
        iface.getEvent('NewContract')!.topicHash,
        iface.getEvent('AssetStorageChanged')!.topicHash,
        iface.getEvent('NewAssetStorage')!.topicHash,
      ]);
      expect(a.contracts.contextGraphs).toEqual({ stale: true });
      expect(a.cachedKav10Address).toBeUndefined();
      expect(a.initialized).toBe(false);
      expect(a.hubRotationPoller.isStarted).toBe(false);
    } finally {
      a.destroy();
      vi.useRealTimers();
    }
  });

  it('destroy clears the Hub rotation poll interval', async () => {
    vi.useFakeTimers({ now: 0 });
    const a: any = new EVMChainAdapter(minimalConfig());
    const iface = new ethers.Interface([
      'event NewContract(string contractName, address newContractAddress)',
      'event ContractChanged(string contractName, address newContractAddress)',
      'event NewAssetStorage(string contractName, address newContractAddress)',
      'event AssetStorageChanged(string contractName, address newContractAddress)',
    ]);
    const provider = {
      getBlockNumber: recorder(async () => 1_000),
      getLogs: recorder(async (_filter: any) => []),
      destroy: recorder(() => undefined),
    };
    a.providers = [provider];
    a.rpcUrls = ['https://primary.example'];
    a.primaryProvider = provider;
    a.provider = provider;
    a.contracts.hub = {
      interface: iface,
      getAddress: async () => '0x0000000000000000000000000000000000000001',
    };

    try {
      await expect(a.startHubRotationListener()).resolves.toBeUndefined();
      await flushAsyncWork();
      expect(provider.getBlockNumber.calls).toHaveLength(1);
      expect(provider.getLogs.calls).toHaveLength(0);

      a.destroy();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(provider.getBlockNumber.calls).toHaveLength(1);
      expect(provider.getLogs.calls).toHaveLength(0);
      expect(provider.destroy.calls).toHaveLength(1);
      expect(a.hubRotationPoller.isStarted).toBe(false);
    } finally {
      a.destroy();
      vi.useRealTimers();
    }
  });

  it('invalidateRandomSamplingPair drops both the cache AND the side-channel contract handles (Codex N15)', () => {
    const a = new EVMChainAdapter(minimalConfig());
    (a as any).contracts.randomSampling = { dummy: 'rs' };
    (a as any).contracts.randomSamplingStorage = { dummy: 'rss' };
    (a as any).randomSamplingPairCache.cached = { rs: 'x', rss: 'y' };
    (a as any).randomSamplingPairCache.resolvedAt = Date.now();

    expect(a.isRandomSamplingReady()).toBe(true);
    (a as any).invalidateRandomSamplingPair();
    expect(a.isRandomSamplingReady()).toBe(false);
    expect((a as any).randomSamplingPairCache.peek()).toBeNull();
  });

  it('resolveAndAssignRandomSamplingPair refuses to write stale handles back when invalidate() raced the await (Codex N16)', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    let releaseResolve: ((v: { rs: any; rss: any }) => void) = () => {};
    const stalePair = { rs: { stale: 'rs' }, rss: { stale: 'rss' } };

    (a as any).randomSamplingPairCache = {
      _gen: 0,
      currentGeneration() { return this._gen; },
      get() {
        return new Promise((resolve) => { releaseResolve = resolve; });
      },
    };

    const pending = (a as any).resolveAndAssignRandomSamplingPair() as Promise<unknown>;
    (a as any).randomSamplingPairCache._gen += 1;
    releaseResolve(stalePair);
    const returned = await pending;

    expect(returned).toBe(stalePair);
    expect((a as any).contracts.randomSampling).toBeUndefined();
    expect((a as any).contracts.randomSamplingStorage).toBeUndefined();
    expect(a.isRandomSamplingReady()).toBe(false);
  });

  it('resolveAndAssignRandomSamplingPair writes handles when no invalidate() raced (happy path)', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const freshPair = { rs: { fresh: 'rs' }, rss: { fresh: 'rss' } };

    (a as any).randomSamplingPairCache = {
      _gen: 5,
      currentGeneration() { return this._gen; },
      get: async () => freshPair,
    };

    const returned = await (a as any).resolveAndAssignRandomSamplingPair();
    expect(returned).toBe(freshPair);
    expect((a as any).contracts.randomSampling).toBe(freshPair.rs);
    expect((a as any).contracts.randomSamplingStorage).toBe(freshPair.rss);
  });

  it('isContractMissingRevert recognises both the legacy (ZeroAddress→string) shape and ContractDoesNotExist revert (Codex N16)', () => {
    const a = new EVMChainAdapter(minimalConfig());
    expect((a as any).isContractMissingRevert(new Error('reverted with custom error ContractDoesNotExist("RandomSampling")'))).toBe(true);
    expect((a as any).isContractMissingRevert(new Error('AddressDoesNotExist(0x123)'))).toBe(true);
    expect((a as any).isContractMissingRevert(new Error('Contract "X" not found in Hub at 0xabc'))).toBe(false);
    expect((a as any).isContractMissingRevert(new Error('execution reverted: ProfileDoesntExist(0)'))).toBe(false);
    expect((a as any).isContractMissingRevert('not an error')).toBe(false);
  });

  it('getActiveProofPeriodStatus stays best-effort when getActiveProofingPeriodDurationInBlocks rejects (Codex round 3)', async () => {
    // Codex round 3 on PR #369 — pulling the live duration alongside
    // status must NOT promote the duration RPC to a hard prerequisite.
    // If a transient RPC error hits only the second leg, the status
    // read should still succeed with `proofingPeriodDurationInBlocks:
    // undefined` and the prover falls back to the cached challenge
    // duration.
    const a = new EVMChainAdapter(minimalConfig());
    const fakeRs = {
      getActiveProofPeriodStatus: async () => ({
        activeProofPeriodStartBlock: 1234n,
        isValid: true,
      }),
      getActiveProofingPeriodDurationInBlocks: async () => {
        throw new Error('TransientRpc502BadGateway');
      },
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    const status = await a.getActiveProofPeriodStatus();
    expect(status.activeProofPeriodStartBlock).toBe(1234n);
    expect(status.isValid).toBe(true);
    expect(status.proofingPeriodDurationInBlocks).toBeUndefined();
  });

  it('getActiveProofPeriodStatus stays best-effort when getActiveProofingPeriodDurationInBlocks is missing entirely (Codex round 4)', async () => {
    // Codex round 4 on PR #369 — `Promise.allSettled([..., rs.getX()])`
    // is NOT enough. If older RS deployments omit the method from their
    // ABI entirely, `rs.getActiveProofingPeriodDurationInBlocks()`
    // throws SYNCHRONOUSLY (TypeError: ... is not a function) while
    // building the allSettled input array, before allSettled can wrap
    // the rejection. Verify the wrapper handles "method literally
    // doesn't exist" cleanly.
    const a = new EVMChainAdapter(minimalConfig());
    // Note: getActiveProofingPeriodDurationInBlocks is NOT defined.
    const fakeRs = {
      getActiveProofPeriodStatus: async () => ({
        activeProofPeriodStartBlock: 7n,
        isValid: true,
      }),
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    const status = await a.getActiveProofPeriodStatus();
    expect(status.activeProofPeriodStartBlock).toBe(7n);
    expect(status.isValid).toBe(true);
    expect(status.proofingPeriodDurationInBlocks).toBeUndefined();
  });

  it('getActiveProofPeriodStatus stays best-effort when getActiveProofingPeriodDurationInBlocks throws synchronously (Codex round 4)', async () => {
    // Defence-in-depth for ethers Contract proxies that resolve the
    // missing-fn into a throw at call-time rather than returning a
    // rejected promise.
    const a = new EVMChainAdapter(minimalConfig());
    const fakeRs = {
      getActiveProofPeriodStatus: async () => ({
        activeProofPeriodStartBlock: 42n,
        isValid: false,
      }),
      getActiveProofingPeriodDurationInBlocks: () => {
        throw new TypeError('this.constructor.getFunction is not a function');
      },
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    const status = await a.getActiveProofPeriodStatus();
    expect(status.activeProofPeriodStartBlock).toBe(42n);
    expect(status.isValid).toBe(false);
    expect(status.proofingPeriodDurationInBlocks).toBeUndefined();
  });

  it('getActiveProofPeriodStatus surfaces the real status read failure (does not swallow the primary leg)', async () => {
    // The best-effort behaviour from the previous test must NOT extend
    // to the primary status read — if `getActiveProofPeriodStatus` itself
    // fails, the prover MUST hear about it (otherwise we'd silently
    // pin to a fabricated default and the prover's wall-clock check
    // would compare against a nonsense activeProofPeriodStartBlock).
    const a = new EVMChainAdapter(minimalConfig());
    const fakeRs = {
      getActiveProofPeriodStatus: async () => {
        throw new Error('UpstreamRPCBadGateway');
      },
      getActiveProofingPeriodDurationInBlocks: async () => 600n,
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    await expect(a.getActiveProofPeriodStatus()).rejects.toThrow('UpstreamRPCBadGateway');
  });

  it('getActiveProofPeriodStatus populates proofingPeriodDurationInBlocks when both reads succeed', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const fakeRs = {
      getActiveProofPeriodStatus: async () => ({
        activeProofPeriodStartBlock: 9000n,
        isValid: false,
      }),
      getActiveProofingPeriodDurationInBlocks: async () => 50n,
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    const status = await a.getActiveProofPeriodStatus();
    expect(status.activeProofPeriodStartBlock).toBe(9000n);
    expect(status.isValid).toBe(false);
    expect(status.proofingPeriodDurationInBlocks).toBe(50n);
  });

  it('getActiveProofPeriodStatus does not stall when the duration probe hangs (Codex round 5, fake-timers)', async () => {
    // A provider that accepts the request but never resolves — e.g.
    // RPC slow path, half-broken websocket — would otherwise pin
    // every status read until the underlying timeout (often >30s)
    // and silently freeze the prover loop. The 2s race must kick
    // in long before the primary status leg comes back, returning
    // `undefined` so the prover falls back to the cached duration.
    //
    // Codex round 6 on PR #369: drive setTimeout via fake timers
    // instead of waiting on real wall clock. Real-time assertions
    // are flaky under loaded CI / long GC pauses.
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const fakeRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 1234n,
          isValid: true,
        }),
        getActiveProofingPeriodDurationInBlocks: () =>
          new Promise(() => {/* never resolves */}),
      };
      (a as any).init = async () => undefined;
      (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
      const inflight = a.getActiveProofPeriodStatus();
      // Advance past DURATION_PROBE_TIMEOUT_MS (2000) to fire the
      // fallback resolve and let the awaited Promise.all settle.
      await vi.advanceTimersByTimeAsync(2001);
      const status = await inflight;
      expect(status.activeProofPeriodStartBlock).toBe(1234n);
      expect(status.isValid).toBe(true);
      expect(status.proofingPeriodDurationInBlocks).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('getActiveProofPeriodStatus single-flights the duration probe (Codex round 6)', async () => {
    // A hung probe must NOT cause one stuck `eth_call` per tick —
    // the adapter has to reuse the in-flight promise across
    // overlapping calls so cardinality stays at 1. Without this
    // guard, a long-lived node in a hung-RPC state would leak one
    // stuck request per tick and eventually exhaust handles.
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const probeCalls = recorder(() => undefined);
      const fakeRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 7n,
          isValid: false,
        }),
        getActiveProofingPeriodDurationInBlocks: () => {
          probeCalls();
          return new Promise(() => {/* never resolves */});
        },
      };
      (a as any).init = async () => undefined;
      (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
      // Three back-to-back tick calls; each times out at 2s with
      // fallback `undefined`. The duration probe MUST be issued
      // exactly once across all three because the in-flight
      // promise from tick #1 is still pending.
      const calls = [
        a.getActiveProofPeriodStatus(),
        a.getActiveProofPeriodStatus(),
        a.getActiveProofPeriodStatus(),
      ];
      await vi.advanceTimersByTimeAsync(2001);
      const results = await Promise.all(calls);
      for (const r of results) {
        expect(r.activeProofPeriodStartBlock).toBe(7n);
        expect(r.isValid).toBe(false);
        expect(r.proofingPeriodDurationInBlocks).toBeUndefined();
      }
      expect(probeCalls.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the duration probe slot when the resolved RS Contract instance changes (TTL refresh, Codex round 8)', async () => {
    // The TTL-refresh path of HubResolutionCache re-resolves the
    // contract to a freshly constructed Contract instance WITHOUT
    // calling invalidateRandomSamplingPair() and WITHOUT bumping
    // the (invalidate-only) generation counter. A probe started
    // against the old contract must NOT be paired with the new
    // contract's status. The guard compares the resolved Contract
    // by reference identity — a refresh always hands back a new
    // instance, so this fires on both same-address and changed-
    // address refreshes.
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const probeCalls = recorder(() => undefined);
      const oldRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 1n,
          isValid: true,
        }),
        getActiveProofingPeriodDurationInBlocks: () => {
          probeCalls();
          return new Promise(() => {/* hang */});
        },
      };
      // Distinct Contract instance with the same shape — simulates
      // the post-refresh Contract a TTL re-resolve would produce
      // even when the underlying address is unchanged.
      const refreshedRs = { ...oldRs };
      (a as any).init = async () => undefined;
      (a as any).getRandomSampling = async () => ({ rs: oldRs, rss: {} });
      const first = a.getActiveProofPeriodStatus();
      await vi.advanceTimersByTimeAsync(2001);
      await first;
      expect(probeCalls.calls).toHaveLength(1);
      // TTL refresh: re-resolve hands back a fresh Contract instance.
      (a as any).getRandomSampling = async () => ({ rs: refreshedRs, rss: {} });
      const second = a.getActiveProofPeriodStatus();
      await vi.advanceTimersByTimeAsync(2001);
      await second;
      // Contract identity changed → slot was dropped → fresh probe issued.
      expect(probeCalls.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the duration probe slot when it exceeds MAX_PROBE_AGE_MS (Codex round 8)', async () => {
    // A truly hung probe (underlying eth_call never settles) must
    // not suppress every fresh probe forever. The age guard kicks
    // in after 30s and abandons the slot so the next call can
    // issue a new one — capping leaked-handle growth to one per
    // 30s window instead of one per tick.
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const probeCalls = recorder(() => undefined);
      const fakeRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 1n,
          isValid: true,
        }),
        getActiveProofingPeriodDurationInBlocks: () => {
          probeCalls();
          return new Promise(() => {/* hang */});
        },
      };
      (a as any).init = async () => undefined;
      (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
      const first = a.getActiveProofPeriodStatus();
      await vi.advanceTimersByTimeAsync(2001);
      await first;
      expect(probeCalls.calls).toHaveLength(1);
      // Fast-forward past MAX_PROBE_AGE_MS (30s).
      await vi.advanceTimersByTimeAsync(30_001);
      const second = a.getActiveProofPeriodStatus();
      await vi.advanceTimersByTimeAsync(2001);
      await second;
      // Slot was abandoned by the age guard, fresh probe was started.
      expect(probeCalls.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidateRandomSamplingPair drops the in-flight duration probe so a Hub rotation forces a fresh one (Codex round 7)', async () => {
    // If a probe was started against the OLD RandomSampling contract
    // and Hub rotates before it settles:
    //   - Without this fix: the next status call would pair the new
    //     contract's status with the old contract's stale duration,
    //     OR (if the old probe hangs) suppress every fresh probe
    //     forever via the single-flight guard.
    //   - With this fix: invalidate() drops the slot; the next call
    //     issues a fresh probe against the new contract.
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const probeCalls = recorder(() => undefined);
      const oldRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 1n,
          isValid: true,
        }),
        getActiveProofingPeriodDurationInBlocks: () => {
          probeCalls();
          return new Promise(() => {/* old contract probe hangs */});
        },
      };
      const newRs = {
        getActiveProofPeriodStatus: async () => ({
          activeProofPeriodStartBlock: 2n,
          isValid: true,
        }),
        getActiveProofingPeriodDurationInBlocks: async () => {
          probeCalls();
          return 555n;
        },
      };
      (a as any).init = async () => undefined;
      (a as any).getRandomSampling = async () => ({ rs: oldRs, rss: {} });
      const stale = a.getActiveProofPeriodStatus();
      await vi.advanceTimersByTimeAsync(2001);
      await stale;
      expect(probeCalls.calls).toHaveLength(1);
      // Simulate Hub rotation: invalidate the RS pair cache.
      (a as any).invalidateRandomSamplingPair();
      // Swap in the NEW contract for the next call.
      (a as any).getRandomSampling = async () => ({ rs: newRs, rss: {} });
      vi.useRealTimers();
      const fresh = await a.getActiveProofPeriodStatus();
      expect(fresh.activeProofPeriodStartBlock).toBe(2n);
      expect(fresh.proofingPeriodDurationInBlocks).toBe(555n);
      // Probe must have run against the NEW contract — total
      // probeCalls is now 2 (old hung + new succeeded).
      expect(probeCalls.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getActiveProofPeriodStatus issues a fresh probe after the previous one settles (Codex round 6)', async () => {
    // Once the in-flight probe rejects/resolves, the next call MUST
    // be allowed to issue a new one — otherwise a single transient
    // failure would permanently disable the live duration read.
    const a = new EVMChainAdapter(minimalConfig());
    const probeCalls = recorder(() => undefined);
    let attempt = 0;
    const fakeRs = {
      getActiveProofPeriodStatus: async () => ({
        activeProofPeriodStartBlock: 99n,
        isValid: true,
      }),
      getActiveProofingPeriodDurationInBlocks: async () => {
        probeCalls();
        attempt += 1;
        if (attempt === 1) throw new Error('first attempt fails');
        return 77n;
      },
    };
    (a as any).init = async () => undefined;
    (a as any).getRandomSampling = async () => ({ rs: fakeRs, rss: {} });
    const first = await a.getActiveProofPeriodStatus();
    expect(first.proofingPeriodDurationInBlocks).toBeUndefined();
    // Wait a microtask so the .finally that clears the slot runs.
    await Promise.resolve();
    const second = await a.getActiveProofPeriodStatus();
    expect(second.proofingPeriodDurationInBlocks).toBe(77n);
    expect(probeCalls.calls).toHaveLength(2);
  });

  it('coerces randomSamplingHubRefreshMs<=0 to the default TTL (no "disable refresh" mode)', () => {
    // The "disable refresh entirely" mode is intentionally not
    // supported — without a TTL backstop, a missed Hub event on a
    // read-only path (e.g. getActiveProofPeriodStatus) would leave
    // the adapter pinned to a stale RandomSampling address until
    // restart. The constructor coerces values <=0 (and undefined) to
    // the same 5-minute default. We verify by peeking the underlying
    // cache's ttlMs option.
    const DEFAULT_TTL_MS = 5 * 60 * 1000;
    const aZero = new EVMChainAdapter(minimalConfig({ randomSamplingHubRefreshMs: 0 }));
    const aNeg = new EVMChainAdapter(minimalConfig({ randomSamplingHubRefreshMs: -42 }));
    const aDefault = new EVMChainAdapter(minimalConfig());
    const ttlOf = (a: EVMChainAdapter) =>
      ((a as any).randomSamplingPairCache.opts as { ttlMs: number }).ttlMs;
    expect(ttlOf(aZero)).toBe(DEFAULT_TTL_MS);
    expect(ttlOf(aNeg)).toBe(DEFAULT_TTL_MS);
    expect(ttlOf(aDefault)).toBe(DEFAULT_TTL_MS);
  });
});

// #894 round-2 / Codex PR #901: register-503-under-RPC-outage. Uses a real
// loopback HTTP server (not Hardhat) that returns HTTP 429 for every JSON-RPC
// call, mirroring `daemon-http-behavior-extra.test.ts`'s `startRateLimitedRpc`.
// ethers v6's default FetchRequest retries 429 with backoff far longer than any
// caller timeout, so a chain read (`init()`'s Hub lookups, on the critical path
// of `createOnChainContextGraph`) would hang for minutes. The bounded
// `retryFunc` must make the read surface `RPC_ENDPOINTS_EXHAUSTED` in seconds so
// `/api/context-graph/register` returns 503 (not hang / 500).
describe('init() RPC-exhaustion bounding (perpetual 429)', () => {
  let server: Server | null = null;
  let url = '';
  // Track every adapter the tests build so teardown can `destroy()` them. Under
  // a perpetual 429 the provider keeps retrying with backoff on a keep-alive
  // socket AFTER the call rejects; if we don't tear it down, that live
  // connection keeps `server.close()` from ever invoking its callback, and the
  // afterEach hook blows past vitest's 10s hook-timeout (the flaky CI failure).
  const adapters: EVMChainAdapter[] = [];
  function track(a: EVMChainAdapter): EVMChainAdapter {
    adapters.push(a);
    return a;
  }

  async function startRateLimited429(): Promise<string> {
    server = createServer((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'rate limited' } }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('mock RPC failed to bind');
    return `http://127.0.0.1:${addr.port}`;
  }

  afterEach(async () => {
    // Stop ethers' background retry loop / idle sockets FIRST, then force-close
    // any still-open connections, so `server.close()` resolves promptly instead
    // of hanging on the provider's in-flight 429 retry.
    for (const a of adapters.splice(0)) {
      try { a.destroy(); } catch { /* destroy() is idempotent */ }
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('surfaces RPC_ENDPOINTS_EXHAUSTED from createOnChainContextGraph within a bounded time under a perpetually rate-limited RPC', async () => {
    url = await startRateLimited429();
    const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: url, rpcUrls: [] })));

    const start = Date.now();
    let thrown: any;
    try {
      await a.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 0 });
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - start;

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    // The classifier (`classifyRegisterContextGraphError`) maps the code → 503
    // and surfaces `.message`; it must read as an RPC-endpoint exhaustion so the
    // register test's `/RPC|endpoint|rate/i` body assertion holds.
    expect(thrown.message).toMatch(/RPC|endpoint|rate/i);
    expect(thrown.rpcUrls).toEqual([url]);
    // Bounded: well under the daemon route / test 120s ceiling. The budget is
    // ~6s of retry; allow generous slack for the in-flight network bootstrap.
    expect(elapsed).toBeLessThan(45_000);
  }, 60_000);

});

describe('PR3 / RC11 — publish-preflight TTL cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('getEvmChainId issues exactly one provider.getNetwork call across repeat reads', async () => {
    const a = new EVMChainAdapter(minimalConfig({ staticNetwork: false }));
    const getNetwork = recorder(async () => ({ chainId: 31337n }));
    // R1/#1336: getEvmChainId now reads via readProvider (this.rpcFailover.read)
    // over this.providers[] (was this.provider.getNetwork). Mock this.providers[0];
    // the TTL-cache / dedup / no-cache-on-failure behaviour is unchanged (the
    // cache wraps the read facade), so the assertions below are preserved verbatim.
    (a as unknown as { providers: Array<{ getNetwork: () => Promise<{ chainId: bigint }> }> }).providers = [{
      getNetwork: getNetwork as unknown as () => Promise<{ chainId: bigint }>,
    }];

    expect(await a.getEvmChainId()).toBe(31337n);
    expect(await a.getEvmChainId()).toBe(31337n);
    expect(await a.getEvmChainId()).toBe(31337n);
    expect(getNetwork.calls).toHaveLength(1);
  });

  it('getKnowledgeAssetsLifecycleAddress caches the contract address across repeat reads', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const getAddress = recorder(async () => '0xCONTRACT');
    (a as unknown as { init: () => Promise<void> }).init = async () => undefined;
    (a as unknown as { contracts: { knowledgeAssetsLifecycle: { getAddress: () => Promise<string> } } }).contracts = {
      knowledgeAssetsLifecycle: { getAddress: getAddress as unknown as () => Promise<string> },
    };

    expect(await a.getKnowledgeAssetsLifecycleAddress()).toBe('0xCONTRACT');
    expect(await a.getKnowledgeAssetsLifecycleAddress()).toBe('0xCONTRACT');
    expect(getAddress.calls).toHaveLength(1);
  });

  it('getMinimumRequiredSignatures caches across repeat reads', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const minimumRequiredSignatures = recorder(async () => 3n);
    (a as unknown as { init: () => Promise<void> }).init = async () => undefined;
    (a as unknown as { contracts: { parametersStorage: { minimumRequiredSignatures: () => Promise<bigint> } } }).contracts = {
      parametersStorage: connectable({
        minimumRequiredSignatures: minimumRequiredSignatures as unknown as () => Promise<bigint>,
      }),
    };

    expect(await a.getMinimumRequiredSignatures()).toBe(3);
    expect(await a.getMinimumRequiredSignatures()).toBe(3);
    expect(await a.getMinimumRequiredSignatures()).toBe(3);
    expect(minimumRequiredSignatures.calls).toHaveLength(1);
  });

  it('refreshes after the 1h TTL expires', async () => {
    vi.useFakeTimers({ now: 0 });
    const a = new EVMChainAdapter(minimalConfig({ staticNetwork: false }));
    let returned = 31337n;
    const getNetwork = recorder(async () => ({ chainId: returned }));
    // R1/#1336: getEvmChainId now reads via readProvider (this.rpcFailover.read)
    // over this.providers[] (was this.provider.getNetwork). Mock this.providers[0];
    // the TTL-cache / dedup / no-cache-on-failure behaviour is unchanged (the
    // cache wraps the read facade), so the assertions below are preserved verbatim.
    (a as unknown as { providers: Array<{ getNetwork: () => Promise<{ chainId: bigint }> }> }).providers = [{
      getNetwork: getNetwork as unknown as () => Promise<{ chainId: bigint }>,
    }];

    expect(await a.getEvmChainId()).toBe(31337n);
    expect(getNetwork.calls).toHaveLength(1);

    vi.setSystemTime(60 * 60 * 1000 - 1);
    expect(await a.getEvmChainId()).toBe(31337n);
    expect(getNetwork.calls).toHaveLength(1);

    vi.setSystemTime(60 * 60 * 1000 + 1);
    returned = 84532n;
    expect(await a.getEvmChainId()).toBe(84532n);
    expect(getNetwork.calls).toHaveLength(2);
  });

  it('invalidatePublishPreflightCache forces a fresh read on next call', async () => {
    const a = new EVMChainAdapter(minimalConfig({ staticNetwork: false }));
    const getNetwork = recorder(async () => ({ chainId: 31337n }));
    // R1/#1336: getEvmChainId now reads via readProvider (this.rpcFailover.read)
    // over this.providers[] (was this.provider.getNetwork). Mock this.providers[0];
    // the TTL-cache / dedup / no-cache-on-failure behaviour is unchanged (the
    // cache wraps the read facade), so the assertions below are preserved verbatim.
    (a as unknown as { providers: Array<{ getNetwork: () => Promise<{ chainId: bigint }> }> }).providers = [{
      getNetwork: getNetwork as unknown as () => Promise<{ chainId: bigint }>,
    }];

    await a.getEvmChainId();
    await a.getEvmChainId();
    expect(getNetwork.calls).toHaveLength(1);
    a.invalidatePublishPreflightCache();
    await a.getEvmChainId();
    expect(getNetwork.calls).toHaveLength(2);
  });

  it('does NOT cache failures (next call retries the underlying read)', async () => {
    const a = new EVMChainAdapter(minimalConfig({ staticNetwork: false }));
    let attempts = 0;
    const getNetwork = recorder(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('rate limited');
      return { chainId: 31337n };
    });
    // R1/#1336: getEvmChainId now reads via readProvider (this.rpcFailover.read)
    // over this.providers[] (was this.provider.getNetwork). Mock this.providers[0];
    // the TTL-cache / dedup / no-cache-on-failure behaviour is unchanged (the
    // cache wraps the read facade), so the assertions below are preserved verbatim.
    (a as unknown as { providers: Array<{ getNetwork: () => Promise<{ chainId: bigint }> }> }).providers = [{
      getNetwork: getNetwork as unknown as () => Promise<{ chainId: bigint }>,
    }];

    await expect(a.getEvmChainId()).rejects.toThrow('rate limited');
    // Second call should retry — failure was not memoised.
    expect(await a.getEvmChainId()).toBe(31337n);
    expect(getNetwork.calls).toHaveLength(2);
  });

  it('abandons timed-out static chain-id validations so the next read retries', async () => {
    vi.useFakeTimers({ now: 0 });
    const a: any = new EVMChainAdapter(minimalConfig({ staticNetwork: true }));
    let calls = 0;
    const provider = {
      send: vi.fn(async (method: string) => {
        expect(method).toBe('eth_chainId');
        calls += 1;
        if (calls === 1) {
          return new Promise<never>(() => undefined);
        }
        return '0x7a69';
      }),
    };
    a.providers = [provider];
    a.rpcUrls = ['https://primary.example'];

    const first = a.getEvmChainId();
    const firstTimeout = expect(first).rejects.toThrow('configured chainId validation timed out');
    await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS);
    await firstTimeout;

    await expect(a.getEvmChainId()).resolves.toBe(31337n);
    expect(provider.send).toHaveBeenCalledTimes(2);
  });
});

describe('effectivePublishAllowance (V10 approval-ceiling policy)', () => {
  // Empirical motivation, May 2026 on Base Sepolia (`miles-publish-stress-26may`):
  // a publish with JS-side `params.tokenAmount === 0n` reverted with
  // `TooLowAllowance(token, 0, 1)` because the auto-approve path skipped
  // approval entirely (`currentAllowance < 0n` is never true). The contract
  // pulls `transferFrom(..., 1n)` even for zero-value publishes. These tests
  // pin down the policy that floors approvals at the on-chain minimum.

  it('exposes the on-chain minimum constant as 1n', () => {
    expect(V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE).toBe(1n);
  });

  it('floors at 1n when tokenAmount is 0n (the bug we hit)', () => {
    expect(effectivePublishAllowance(0n)).toBe(1n);
  });

  it('floors at 1n when tokenAmount equals the minimum', () => {
    expect(effectivePublishAllowance(1n)).toBe(1n);
  });

  it('passes through tokenAmount when larger than the minimum', () => {
    expect(effectivePublishAllowance(42n)).toBe(42n);
    expect(effectivePublishAllowance(10n ** 18n)).toBe(10n ** 18n);
  });

  it('respects an injected on-chain minimum (forward-compat for contract upgrades)', () => {
    expect(effectivePublishAllowance(0n, 10n)).toBe(10n);
    expect(effectivePublishAllowance(5n, 10n)).toBe(10n);
    expect(effectivePublishAllowance(50n, 10n)).toBe(50n);
  });

  it('preserves the bounded-approval security property (never returns MaxUint256 unless asked)', () => {
    // The policy must never silently widen approval beyond what the caller
    // requested — that would defeat the per-publish ceiling that protects
    // the operational wallet against a compromised KA contract.
    const huge = 10n ** 30n;
    expect(effectivePublishAllowance(huge)).toBe(huge);
    expect(effectivePublishAllowance(huge)).not.toBe(ethers.MaxUint256);
  });
});

describe('computeApprovalAction — per-publish (default, backward-compatible)', () => {
  // Reproduces every code path the policy-less adapter took before this
  // PR. New operators inherit this default; explicit `mode: 'per-publish'`
  // produces identical behaviour.

  const policy: ApprovalPolicy = { mode: 'per-publish' };

  it('matches DEFAULT_APPROVAL_POLICY', () => {
    expect(DEFAULT_APPROVAL_POLICY.mode).toBe('per-publish');
  });

  it('approves the 1n floor when tokenAmount=0n and currentAllowance=0n', () => {
    const action = computeApprovalAction(policy, 0n, 0n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(1n);
  });

  it('skips approve when current already covers the publish floor (0n / 1n)', () => {
    expect(computeApprovalAction(policy, 0n, 1n)).toEqual({
      needsApprove: false,
      targetAllowance: 1n,
    });
  });

  it('approves exactly tokenAmount when current is short', () => {
    const action = computeApprovalAction(policy, 1000n, 500n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(1000n);
  });

  it('does not re-approve when current >= tokenAmount', () => {
    expect(computeApprovalAction(policy, 1000n, 1000n).needsApprove).toBe(false);
    expect(computeApprovalAction(policy, 1000n, 5000n).needsApprove).toBe(false);
  });

  it('never widens approval beyond tokenAmount (bounded-per-publish security property)', () => {
    const action = computeApprovalAction(policy, 10n ** 18n, 0n);
    expect(action.targetAllowance).toBe(10n ** 18n);
    expect(action.targetAllowance).not.toBe(ethers.MaxUint256);
  });
});

describe('computeApprovalAction — replenishing (recommended for mainnet)', () => {
  // Approve a configurable ceiling once; refill when current drops below
  // `target × refillBelowFraction`. Pre-mainnet stress run on Base Sepolia
  // showed this would amortise approve-gas to ~1/9 of the per-publish
  // policy at default config.

  it('exposes sane defaults', () => {
    // 1000 TRAC = 1e21 wei-TRAC
    expect(DEFAULT_REPLENISH_TARGET_ALLOWANCE).toBe(10n ** 21n);
    expect(DEFAULT_REFILL_BELOW_FRACTION).toBe(0.1);
  });

  it('approves the default 1000 TRAC ceiling on a fresh wallet', () => {
    const policy: ApprovalPolicy = { mode: 'replenishing' };
    const action = computeApprovalAction(policy, 1n, 0n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(10n ** 21n);
  });

  it('skips approve when current is comfortably above the refill threshold', () => {
    const policy: ApprovalPolicy = { mode: 'replenishing' };
    // Default target 1000 TRAC, refill at 100 TRAC. 500 TRAC current → no refill.
    const action = computeApprovalAction(policy, 1n, 500n * (10n ** 18n));
    expect(action.needsApprove).toBe(false);
    expect(action.targetAllowance).toBe(10n ** 21n);
  });

  it('triggers refill when current drops below 10% of target (default fraction)', () => {
    const policy: ApprovalPolicy = { mode: 'replenishing' };
    // 99 TRAC current, threshold is 100 TRAC → refill.
    const action = computeApprovalAction(policy, 1n, 99n * (10n ** 18n));
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(10n ** 21n);
  });

  it('respects a custom targetAllowance + refillBelowFraction', () => {
    const policy: ApprovalPolicy = {
      mode: 'replenishing',
      targetAllowance: 100n * (10n ** 18n), // 100 TRAC ceiling
      refillBelowFraction: 0.5,              // refill at 50 TRAC
    };
    // Current 60 TRAC → above threshold (50 TRAC) → no refill.
    expect(computeApprovalAction(policy, 1n, 60n * (10n ** 18n)).needsApprove).toBe(false);
    // Current 40 TRAC → below threshold → refill to 100 TRAC.
    const action = computeApprovalAction(policy, 1n, 40n * (10n ** 18n));
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(100n * (10n ** 18n));
  });

  it('raises a too-low targetAllowance to at least the publish floor', () => {
    // Operator misconfigured `targetAllowance: 100n` but this publish
    // needs 500n — should approve 500n, not let it brick the publish.
    const policy: ApprovalPolicy = { mode: 'replenishing', targetAllowance: 100n };
    const action = computeApprovalAction(policy, 500n, 0n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(500n);
  });

  it('treats targetAllowance=0n as "use publish floor"', () => {
    const policy: ApprovalPolicy = { mode: 'replenishing', targetAllowance: 0n };
    const action = computeApprovalAction(policy, 0n, 0n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(1n); // publish floor wins
  });

  it('clamps refillBelowFraction to [0, 1]', () => {
    const above: ApprovalPolicy = { mode: 'replenishing', refillBelowFraction: 2 };
    const aboveAction = computeApprovalAction(above, 1n, 10n ** 21n - 1n);
    expect(aboveAction.needsApprove).toBe(true); // fraction clamps to 1 → always refill below full target

    const below: ApprovalPolicy = { mode: 'replenishing', refillBelowFraction: -1 };
    const belowAction = computeApprovalAction(below, 1n, 0n);
    // fraction clamps to 0 → threshold = 0, but publishFloor (1n) wins
    expect(belowAction.needsApprove).toBe(true);
    expect(belowAction.targetAllowance).toBe(10n ** 21n);
  });

  it('handles NaN / non-finite refillBelowFraction by falling back to the default', () => {
    const policy: ApprovalPolicy = {
      mode: 'replenishing',
      refillBelowFraction: Number.NaN,
    };
    // Default 0.1 → threshold = 100 TRAC. 99 TRAC current → refill.
    const action = computeApprovalAction(policy, 1n, 99n * (10n ** 18n));
    expect(action.needsApprove).toBe(true);
  });

  it('refill threshold respects the publish floor even when fraction × target is below it', () => {
    // Tiny target, tiny fraction, but the immediate publish needs 1000n.
    const policy: ApprovalPolicy = {
      mode: 'replenishing',
      targetAllowance: 100n,
      refillBelowFraction: 0.01, // threshold = 1n
    };
    // Current 500n: above the 1n threshold but below the publish floor (1000n).
    const action = computeApprovalAction(policy, 1000n, 500n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(1000n); // target raised to publish floor
  });
});

describe('computeApprovalAction — unlimited (V9 pattern)', () => {
  const policy: ApprovalPolicy = { mode: 'unlimited' };

  it('approves MaxUint256 on a fresh wallet', () => {
    const action = computeApprovalAction(policy, 1n, 0n);
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(ethers.MaxUint256);
  });

  it('never re-approves once the wallet has any usable allowance', () => {
    // currentAllowance of 1n is enough for a 0n-floored publish — skip approve.
    expect(computeApprovalAction(policy, 0n, 1n).needsApprove).toBe(false);
    // currentAllowance of MaxUint256 — definitely skip.
    expect(computeApprovalAction(policy, 10n ** 30n, ethers.MaxUint256).needsApprove).toBe(false);
  });

  it('re-approves if external actor revoked allowance back below the publish floor', () => {
    // Defensive path: if someone called approve(KA, 0) on this wallet, the
    // next publish should refill MaxUint256, not silently revert.
    expect(computeApprovalAction(policy, 1n, 0n).needsApprove).toBe(true);
  });
});

describe('computeApprovalAction — invariants across all modes', () => {
  // Properties that must hold for every policy/tokenAmount/currentAllowance
  // combination — exercised explicitly because they're the structural
  // safety net behind the policy abstraction.

  const allModes: ApprovalPolicy[] = [
    { mode: 'per-publish' },
    { mode: 'replenishing' },
    { mode: 'unlimited' },
  ];

  it('targetAllowance is always >= effectivePublishAllowance(tokenAmount)', () => {
    for (const policy of allModes) {
      for (const tokenAmount of [0n, 1n, 1000n, 10n ** 18n]) {
        for (const currentAllowance of [0n, 1n, 10n ** 21n]) {
          const action = computeApprovalAction(policy, tokenAmount, currentAllowance);
          const floor = effectivePublishAllowance(tokenAmount);
          expect(action.targetAllowance).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });

  it('needsApprove is monotone in currentAllowance (more allowance never flips false → true)', () => {
    for (const policy of allModes) {
      for (const tokenAmount of [0n, 1n, 1000n, 10n ** 18n]) {
        let lastNeedsApprove = true;
        for (const currentAllowance of [
          0n,
          1n,
          10n ** 18n,
          10n ** 21n,
          ethers.MaxUint256,
        ]) {
          const action = computeApprovalAction(policy, tokenAmount, currentAllowance);
          // Once we've seen needsApprove=false for some currentAllowance,
          // any larger currentAllowance must also yield false.
          if (lastNeedsApprove === false) {
            expect(action.needsApprove).toBe(false);
          }
          lastNeedsApprove = action.needsApprove;
        }
      }
    }
  });

  it('unknown mode falls back to per-publish behaviour', () => {
    // Defensive — if a malformed config sneaks through, we should still
    // produce *some* sane action rather than throwing inside the publish
    // hot path.
    const action = computeApprovalAction(
      { mode: 'gibberish' as any },
      1000n,
      0n,
    );
    expect(action.needsApprove).toBe(true);
    expect(action.targetAllowance).toBe(1000n); // per-publish
  });
});

// -----------------------------------------------------------------------------
// Adapter-level integration tests for the V10 approval gate (#720 + Codex
// follow-up on PR #720). The pure-helper tests above prove that
// `computeApprovalAction(policy, tokenAmount, currentAllowance)` produces
// the right `(needsApprove, targetAllowance)`. The tests below exercise the
// real publish/update wiring: that `ensureV10ApproveTrac`
//   1. reads `token.allowance(signerAddr, kaV10Addr)` from the connected
//      token contract,
//   2. forwards `(policy, tokenAmount, currentAllowance)` to the helper,
//   3. issues exactly one `approve(kaV10Addr, targetAllowance)` when
//      `needsApprove === true` (with the correct label so publish vs update
//      stay distinguishable on-chain in tracing),
//   4. is a strict no-op otherwise (the metadata-only update happy path),
//   5. and is a no-op for read-only adapters (`this.contracts.token`
//      absent).
//
// `sendContractTransaction` is stubbed at the adapter so the assertions
// stay on the public call shape without dragging the broadcast / signing
// machinery into scope; that surface is covered by the
// `sendContractTransaction` / `sendSignedTransactionAndWait` tests above.
// -----------------------------------------------------------------------------

const V10_KA_ADDRESS = '0x' + 'aa'.repeat(20);

// The bound token contract is a DI seam: the publish/update gate reads its
// `allowance(...)` and connects it to the signer. `approve` itself goes through
// the (stubbed) `sendContractTransaction`, so the recorder just needs to exist.
function makeStubToken(allowance: bigint) {
  // tokenWithSigner is read via readContract (this.rpcFailover.readContract)
  // after token→signer rebind, so it too must be .connect-able (self no-op rebind).
  const tokenWithSigner = connectable({
    allowance: recorder(async (..._a: unknown[]) => allowance),
    approve: recorder(() => undefined),
  });
  const tokenRoot = {
    connect: recorder((..._a: unknown[]) => tokenWithSigner),
  };
  return { tokenRoot, tokenWithSigner };
}

function makeV10Adapter(approvalPolicy?: ApprovalPolicy, allowance: bigint = 0n) {
  const a = new EVMChainAdapter(minimalConfig({ approvalPolicy }));
  const { tokenRoot, tokenWithSigner } = makeStubToken(allowance);
  (a as any).contracts.token = tokenRoot;
  const sendSpy = recorder(async (..._a: unknown[]) => ({} as unknown));
  (a as any).sendContractTransaction = sendSpy;
  // In-lock publish/update approvals receive the scoped unlocked sender;
  // standalone approval tests call the serialized wrapper. Capture both.
  (a as any).sendContractTransactionUnlocked = sendSpy;
  const signer = new ethers.Wallet(DEPLOYER_PK);
  return { a, signer, tokenRoot, tokenWithSigner, sendSpy };
}

type SendRecorder = { calls: unknown[][] };

function getApproveCallArgs(sendSpy: SendRecorder): {
  contract: unknown;
  method: string;
  args: readonly unknown[];
  signer: unknown;
  label: string;
} {
  expect(sendSpy.calls).toHaveLength(1);
  const [contract, method, args, signerArg, label] = sendSpy.calls[0] as [
    unknown, string, readonly unknown[], unknown, string,
  ];
  return { contract, method, args, signer: signerArg, label };
}

describe('ensureV10ApproveTrac — per-publish (default) approval gate', () => {

  it('zero-cost publish on a fresh wallet → approves the 1n floor (#720 mainnet revert fix)', async () => {
    // The exact scenario that reverted on mainnet pre-#720: a publish with
    // `tokenAmount=0n` against a wallet that has never approved TRAC to the
    // V10 KnowledgeAssets contract. The fix is the 1n floor in
    // `effectivePublishAllowance`; the test asserts that the adapter
    // *actually* observes it on the publish call path.
    const { a, signer, tokenWithSigner, sendSpy } = makeV10Adapter(undefined, 0n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    );

    expect(tokenWithSigner.allowance.calls).toHaveLength(1);
    expect(tokenWithSigner.allowance.calls.at(-1)).toEqual([signer.address, V10_KA_ADDRESS]);

    const call = getApproveCallArgs(sendSpy);
    expect(call.method).toBe('approve');
    expect(call.args).toEqual([V10_KA_ADDRESS, 1n]);
    expect(call.signer).toBe(signer);
    expect(call.label).toBe('approve V10 publish TRAC');
  });

  it('metadata-only update with existing 1n allowance → NO approve (idle reuse, #720)', async () => {
    // After the first publish, the wallet retains a 1n allowance. A
    // subsequent metadata-only update (`newTokenAmount=0n`) must NOT
    // re-send an approve — that would be a pointless on-chain write and
    // a Codex review concern on PR #720.
    const { a, signer, tokenWithSigner, sendSpy } = makeV10Adapter(undefined, 1n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 update TRAC',
    );

    expect(tokenWithSigner.allowance.calls).toHaveLength(1);
    expect(sendSpy.calls).toEqual([]);
  });

  it('zero-cost publish with comfortable leftover allowance → NO approve', async () => {
    // Operator pre-approved a large allowance (e.g. switching from
    // unlimited or replenishing on a previous run). A zero-cost publish
    // must reuse the existing allowance, not refill.
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 10n ** 18n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy.calls).toEqual([]);
  });

  it('positive tokenAmount with empty allowance → approve(tokenAmount)', async () => {
    // The standard per-publish path: fresh wallet, paid publish. Approve
    // exactly `tokenAmount` (bounded-per-publish security property).
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 0n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.method).toBe('approve');
    expect(call.args).toEqual([V10_KA_ADDRESS, 100n]);
  });

  it('positive tokenAmount with partial allowance → approve(tokenAmount) (top-up to exact)', async () => {
    // Per-publish never widens beyond `tokenAmount`. If the wallet has 50n
    // and we need 100n, we approve 100n — not e.g. (100n - 50n) or a
    // larger ceiling.
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 50n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.args).toEqual([V10_KA_ADDRESS, 100n]);
  });

  it('positive tokenAmount with allowance already covering it → NO approve', async () => {
    // Two paid publishes in a row from the same wallet to the same KA
    // contract: the second one must skip the approve.
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 200n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy.calls).toEqual([]);
  });

  it('positive tokenAmount with allowance exactly matching → NO approve (boundary case)', async () => {
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 100n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy.calls).toEqual([]);
  });

  it('read-only adapter (no token contract bound) → no-op, no allowance read, no approve', async () => {
    // Adapters constructed for read-only nodes don't resolve the V10 Token
    // contract. The gate must be a clean no-op there — not throw on
    // `this.contracts.token.connect(...)`.
    const a = new EVMChainAdapter(minimalConfig());
    const sendSpy = recorder(async (..._a: unknown[]) => ({} as unknown));
    (a as any).sendContractTransaction = sendSpy;
    (a as any).sendContractTransactionUnlocked = sendSpy;
    (a as any).contracts.token = undefined;
    const signer = new ethers.Wallet(DEPLOYER_PK);

    await expect((a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    )).resolves.toBeUndefined();

    expect(sendSpy.calls).toEqual([]);
  });

  it('zero-cost publish (#720 floor kicked in) → emits the operator-facing warn', async () => {
    // #871 observability: when `tokenAmount === 0n` and the policy lifts
    // `targetAllowance` to the 1n floor, the adapter logs a single
    // `console.warn` so operators inspecting on-chain allowance can
    // recognise the resulting "1 wei dust" as the documented #720
    // workaround instead of mistaking it for a stuck approval.
    const origWarn = console.warn;
    const warnSpy = recorder((..._a: unknown[]) => undefined);
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      const { a, signer, sendSpy } = makeV10Adapter(undefined, 0n);

      await (a as any).ensureV10ApproveTrac(
        signer,
        V10_KA_ADDRESS,
        0n,
        'approve V10 publish TRAC',
      );

      // Approve still fires (behaviour unchanged).
      expect(sendSpy.calls).toHaveLength(1);
      expect(getApproveCallArgs(sendSpy).args).toEqual([V10_KA_ADDRESS, 1n]);

      // And the diagnostic warn fires exactly once with the expected wording.
      expect(warnSpy.calls).toHaveLength(1);
      const message = warnSpy.calls[0][0] as string;
      expect(message).toContain('V10 per-publish auto-approve floor');
      expect(message).toContain('#720 transferFrom-minimum workaround');
      expect(message).toContain('tokenAmount=0');
    } finally {
      console.warn = origWarn;
    }
  });

  it('legitimate 1-wei publish → approves 1n WITHOUT emitting the #720 warn (Codex on PR #875)', async () => {
    // Negative case for the warn guard. A `tokenAmount === 1n` publish
    // produces `targetAllowance === 1n` under per-publish too, but the
    // 1-wei is the real publish cost — NOT the #720 floor workaround.
    // The warn line would mislead operators if it fired here, so the
    // guard requires `tokenAmount === 0n` in addition to the
    // `targetAllowance === 1n` check.
    const origWarn = console.warn;
    const warnSpy = recorder((..._a: unknown[]) => undefined);
    console.warn = warnSpy as unknown as typeof console.warn;
    try {
      const { a, signer, sendSpy } = makeV10Adapter(undefined, 0n);

      await (a as any).ensureV10ApproveTrac(
        signer,
        V10_KA_ADDRESS,
        1n,
        'approve V10 publish TRAC',
      );

      // Approve still fires for the genuine 1-wei publish.
      expect(sendSpy.calls).toHaveLength(1);
      expect(getApproveCallArgs(sendSpy).args).toEqual([V10_KA_ADDRESS, 1n]);

      // But the floor-workaround warn must NOT fire (it would be a false
      // positive — see PR #875 review thread).
      expect(warnSpy.calls).toEqual([]);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('ensureV10ApproveTrac — replenishing policy (high-volume operator default)', () => {

  it('approves the default 1000 TRAC ceiling on a fresh wallet', async () => {
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'replenishing' },
      0n,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.args).toEqual([V10_KA_ADDRESS, DEFAULT_REPLENISH_TARGET_ALLOWANCE]);
  });

  it('skips approve when allowance is comfortably above the refill threshold', async () => {
    // Default refill fraction is 0.1, so the threshold is 100 TRAC. A
    // wallet with 500 TRAC should NOT trigger a refill on the next
    // publish.
    const allowance = 500n * (10n ** 18n);
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'replenishing' },
      allowance,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy.calls).toEqual([]);
  });

  it('refills back to target when allowance drops below the refill threshold', async () => {
    // Threshold (10% of default target) is 100 TRAC. An allowance of
    // 50 TRAC is *below* threshold → refill to the full 1000 TRAC.
    const allowance = 50n * (10n ** 18n);
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'replenishing' },
      allowance,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.args).toEqual([V10_KA_ADDRESS, DEFAULT_REPLENISH_TARGET_ALLOWANCE]);
  });

  it('honours a custom targetAllowance + refillBelowFraction from operator config', async () => {
    // Operator-configured policy: ceiling 200n, refill below 50%. Below
    // 100n → refill; at/above 100n → skip.
    const policy: ApprovalPolicy = {
      mode: 'replenishing',
      targetAllowance: 200n,
      refillBelowFraction: 0.5,
    };

    {
      const { a, signer, sendSpy } = makeV10Adapter(policy, 99n);
      await (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'approve V10 publish TRAC');
      const call = getApproveCallArgs(sendSpy);
      expect(call.args).toEqual([V10_KA_ADDRESS, 200n]);
    }
    {
      const { a, signer, sendSpy } = makeV10Adapter(policy, 100n);
      await (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'approve V10 publish TRAC');
      expect(sendSpy.calls).toEqual([]);
    }
  });
});

describe('ensureV10ApproveTrac — unlimited policy (V9 pattern)', () => {

  it('approves MaxUint256 once on a fresh wallet', async () => {
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'unlimited' },
      0n,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.args).toEqual([V10_KA_ADDRESS, ethers.MaxUint256]);
  });

  it('never re-approves once the wallet has the unlimited allowance live', async () => {
    // Steady state after the first publish: the wallet has MaxUint256 in
    // allowance. Any reasonable subsequent publish must skip re-approving
    // — that's the whole point of the unlimited policy.
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'unlimited' },
      ethers.MaxUint256,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy.calls).toEqual([]);
  });

  it('skips re-approve once current >= publish floor (defensive — partial residual allowance from another policy)', async () => {
    // If an operator switched into unlimited mode mid-flight and the
    // wallet already has enough for the immediate publish, don't waste
    // an approve — even though the *intended* steady state is MaxUint256,
    // the immediate publish doesn't need it.
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'unlimited' },
      100n,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy.calls).toEqual([]);
  });

  it('still re-approves MaxUint256 if an external actor revoked allowance to 0', async () => {
    // Defensive path: someone called `approve(KA, 0)` on this wallet
    // out-of-band. The next publish must refill, not silently revert in
    // the contract's `transferFrom`.
    const { a, signer, sendSpy } = makeV10Adapter(
      { mode: 'unlimited' },
      0n,
    );

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.args).toEqual([V10_KA_ADDRESS, ethers.MaxUint256]);
  });
});

describe('ensureV10ApproveTrac — call-site invariants (publish vs update)', () => {

  it('passes the publish label through verbatim (so on-chain tracing distinguishes publish from update)', async () => {
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 0n);
    await (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'approve V10 publish TRAC');
    expect(sendSpy.calls[0][4]).toBe('approve V10 publish TRAC');
  });

  it('passes the update label through verbatim', async () => {
    const { a, signer, sendSpy } = makeV10Adapter(undefined, 0n);
    await (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'approve V10 update TRAC');
    expect(sendSpy.calls[0][4]).toBe('approve V10 update TRAC');
  });

  it('connects the bound token contract to the operational signer (not the admin signer)', async () => {
    // The approve must go out from the same signer that the publish/
    // update tx will use, so `tokenAmount` is debited from the right
    // wallet's allowance and not from the admin EOA.
    const { a, signer, tokenRoot } = makeV10Adapter(undefined, 0n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(tokenRoot.connect.calls).toHaveLength(1);
    expect(tokenRoot.connect.calls.at(-1)).toEqual([signer]);
  });

  it('reads allowance against the passed-in KA address (not a globally cached one)', async () => {
    // Defensive against future refactors that try to cache `kaAddress`
    // on the adapter and forget to invalidate after a Hub rotation.
    const otherKa = '0x' + 'bb'.repeat(20);
    const { a, signer, tokenWithSigner } = makeV10Adapter(undefined, 0n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      otherKa,
      0n,
      'approve V10 publish TRAC',
    );

    expect(tokenWithSigner.allowance.calls).toContainEqual([signer.address, otherKa]);
  });

  it('propagates approve failures to the caller (so publish/update aborts cleanly)', async () => {
    // If the approve broadcast fails (RPC outage, insufficient gas, ...),
    // the caller must see the rejection — silently swallowing it would
    // lead to a downstream `publishV10` that reverts deep in the
    // contract's `transferFrom`.
    const a = new EVMChainAdapter(minimalConfig());
    const { tokenRoot } = makeStubToken(0n);
    (a as any).contracts.token = tokenRoot;
    // Standalone approval calls use the serialized public sender; make that
    // path throw so propagation is exercised.
    (a as any).sendContractTransaction = recorder(async () => {
      throw new Error('approve broadcast failed');
    });
    const signer = new ethers.Wallet(DEPLOYER_PK);

    await expect((a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    )).rejects.toThrow('approve broadcast failed');
  });

  it('is invariant to allowance() returning a string-encoded bigint (defensive against ABI quirks)', async () => {
    // ethers v6 returns `bigint` from contract reads, but bonus coverage:
    // the gate must not coerce-via-Number or otherwise lose precision on
    // very large allowances. Use a 2^200 allowance to make any Number
    // coercion immediately wrong.
    const huge = 2n ** 200n;
    const { a, signer, sendSpy } = makeV10Adapter(undefined, huge);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      100n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy.calls).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Regression tests for #870 — per-publish allowance check must target the
// actual publish signer.
//
// Reported scenario: a fresh edge node reverted with
// `TooLowAllowance(TRAC, 0, 1)` on `KnowledgeAssetsLifecycle.publish(...)`
// even though the default `per-publish` policy should have auto-approved.
// One candidate root cause was a wallet mismatch — the approval gate reading
// allowance against signer A while `publishV10` later submitted from a
// different signer B with 0 allowance.
//
// The tests below pin down the invariant end-to-end by driving
// `createKnowledgeAssets` / `updateKnowledgeCollectionV10` with a multi-wallet
// signer pool and asserting the approve sender is the wallet that goes on
// to sign the publish / update tx. They catch any future refactor that
// would reintroduce the mismatch — by reading allowance against `this.signer`
// instead of `txSigner`, by rotating signers between the two steps, etc.
// -----------------------------------------------------------------------------

describe('createKnowledgeAssets / updateKnowledgeCollectionV10 — approval signer parity (#870)', () => {

  const PARITY_KA_ADDRESS = '0x' + 'cd'.repeat(20);

  function makeAllowanceByOwner(): Map<string, bigint> {
    return new Map<string, bigint>();
  }

  const ABUNDANT_WEI = 10n ** 18n;

  // Hardhat account #3 — a third distinct operational key for pool-rotation tests.
  const THIRD_PK = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

  function makeMultiWalletV10Adapter(
    allowanceByOwner: Map<string, bigint>,
    funding?: { native?: Map<string, bigint>; trac?: Map<string, bigint> },
    extraOperationalKeys: string[] = [],
    configOverrides: Partial<EVMAdapterConfig> = {},
  ) {
    const a = new EVMChainAdapter(minimalConfig({
      privateKey: DEPLOYER_PK,
      additionalKeys: [OTHER_PK, ...extraOperationalKeys],
      ...configOverrides,
    }));
    const signerPool = (a as any).signerPool as ethers.Wallet[];
    const [walletA, walletB] = signerPool;

    (a as any).initialized = true;

    // Funding-aware selection reads native (provider.getBalance) + TRAC
    // (token.balanceOf) for each candidate. Stub both deterministically —
    // default ABUNDANT so funding-aware selection is a no-op (round-robin)
    // unless a test sets specific per-wallet balances. Without these stubs the
    // adapter would hit the dead test RPC (slow) and rely on fail-open.
    const nativeByAddr = funding?.native ?? new Map<string, bigint>();
    const tracByAddr = funding?.trac ?? new Map<string, bigint>();
    (a as any).provider.getBalance = recorder(async (addr: string) =>
      nativeByAddr.get(String(addr).toLowerCase()) ?? ABUNDANT_WEI);
    (a as any).provider.send = recorder(async (method: string) => {
      if (method === 'eth_chainId') return '0x7a69';
      throw new Error(`unexpected RPC method ${method}`);
    });

    // R1/#1336: readTracBalance now reads via readContractWith (failOpenFundingRead
    // policy) → rebindContract does `token.connect(p).balanceOf(addr)`, so the
    // CONNECTED contract (what token.connect returns) must expose balanceOf — not
    // just the top-level token. (Native getBalance still works: the helper mutates
    // this.provider.getBalance and this.provider === this.providers[0], so the
    // shared object is what the read facade reads.)
    const balanceOf = recorder(async (addr: string) =>
      tracByAddr.get(String(addr).toLowerCase()) ?? ABUNDANT_WEI);
    const tokenWithSigner = connectable({
      allowance: recorder(async (owner: string, _spender: string) => {
        return allowanceByOwner.get(owner.toLowerCase()) ?? 0n;
      }),
      approve: recorder(() => undefined),
      balanceOf,
    });
    (a as any).contracts.token = {
      connect: recorder(() => tokenWithSigner),
      balanceOf, // kept for any direct (non-connected) top-level reader
    };

    const populateSpy = recorder(async () => ({
      to: PARITY_KA_ADDRESS,
      data: '0xdeadbeef',
    }));
    const kavContract = connectable({
      getAddress: recorder(async () => PARITY_KA_ADDRESS),
      publish: { populateTransaction: populateSpy },
      update: { populateTransaction: populateSpy },
    });
    (a as any).contracts.knowledgeAssetsLifecycle = {
      connect: recorder(() => kavContract),
      getAddress: recorder(async () => PARITY_KA_ADDRESS),
    };

    (a as any).contracts.contextGraphs = connectable({
      isAuthorizedPublisher: recorder(async () => true),
    });

    const sendSpy = recorder(async (..._a: unknown[]) => ({} as unknown));
    (a as any).sendContractTransaction = sendSpy;
    (a as any).sendContractTransactionUnlocked = sendSpy;

    // Stop the publish/update flow right after the approval gate by throwing
    // a sentinel at the signing step. We only need to observe the signer
    // arguments at `ensureV10ApproveTrac` and `signPopulatedTransaction`.
    const signSpy = recorder(async (..._a: unknown[]) => {
      throw new Error('SENTINEL_STOP_AFTER_APPROVE');
    });
    (a as any).signPopulatedTransaction = signSpy;

    return { a, walletA, walletB, wallets: signerPool, tokenWithSigner, sendSpy, signSpy, populateSpy, nativeByAddr, tracByAddr };
  }

  function makeV10PublishParams(publisherAddress?: string): any {
    const authorAddress = publisherAddress ?? ethers.ZeroAddress;
    // OT-RFC-43 Option-1 (variant 1a): the real `createKnowledgeAssets`
    // entrypoint now requires a packed reservedKaId in the author's namespace
    // and fails loud (pre-tx) otherwise. These approval-parity tests drive the
    // real method (with the rest of the adapter stubbed), so supply a valid
    // packed id = (uint160(author) << 96) | number for THIS test's author.
    const reservedKaId = (BigInt(ethers.getAddress(authorAddress)) << 96n) | 1n;
    const params: any = {
      publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
      contextGraphId: 7n,
      merkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('mr'))),
      knowledgeAssetsAmount: 1,
      byteSize: 100,
      epochs: 1,
      tokenAmount: 0n,
      isImmutable: false,
      merkleLeafCount: 1,
      reservedKaId,
      publisherNodeIdentityId: 0n,
      author: {
        address: authorAddress,
        signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
        schemeVersion: 1,
      },
      ackSignatures: [],
    };
    if (publisherAddress) params.publisherAddress = publisherAddress;
    return params;
  }

  it('publish path: approve fires from the wallet matching publisherAddress, NOT a sibling pool wallet with stale allowance', async () => {
    // The exact #870 scenario:
    //   - Pool = [walletA, walletB].
    //   - walletA already has 10 TRAC allowance (e.g. left over from an
    //     earlier op or another publisher in the same daemon).
    //   - walletB has 0 allowance (fresh).
    //   - The publisher binds the tx to walletB via `publisherAddress`.
    //   - `ensureV10ApproveTrac` MUST read allowance(walletB, KA) and send
    //     `approve(KA, 1n)` from walletB — NOT from walletA. The publish tx
    //     that follows MUST also be signed by walletB.
    //
    // A regression that read allowance against `this.signer` (== walletA in
    // this pool ordering) would see 10 TRAC ≥ 1n, skip approve, then submit
    // a publish from walletB that reverts on-chain with
    // `TooLowAllowance(TRAC, 0, 1)` — exactly the symptom in #870.
    const allowanceByOwner = makeAllowanceByOwner();
    const { a, walletA, walletB, tokenWithSigner, sendSpy, signSpy } =
      makeMultiWalletV10Adapter(allowanceByOwner);
    allowanceByOwner.set(walletA.address.toLowerCase(), 10n * 10n ** 18n);
    allowanceByOwner.set(walletB.address.toLowerCase(), 0n);

    await expect(
      a.createKnowledgeAssets(makeV10PublishParams(walletB.address)),
    ).rejects.toThrow('SENTINEL_STOP_AFTER_APPROVE');

    expect(tokenWithSigner.allowance.calls).toContainEqual([
      walletB.address,
      PARITY_KA_ADDRESS,
    ]);
    expect(tokenWithSigner.allowance.calls).not.toContainEqual([
      walletA.address,
      PARITY_KA_ADDRESS,
    ]);

    expect(sendSpy.calls).toHaveLength(1);
    const [, approveMethod, approveArgs, approveSender] = sendSpy.calls[0];
    expect(approveMethod).toBe('approve');
    expect(approveArgs).toEqual([PARITY_KA_ADDRESS, 1n]);
    expect(approveSender).toBe(walletB);

    expect(signSpy.calls).toHaveLength(1);
    // R1/OBS-1: populateAndSignAcrossProviders signs on the per-provider runner
    // (signer.connect(providers[i])) — same key/ADDRESS as walletB, new object.
    // Assert the signer ADDRESS, not object identity (#870 "publish signed by
    // walletB, no mid-flight rotation" invariant is preserved).
    expect((signSpy.calls[0][0] as ethers.Wallet).address).toBe(walletB.address);
  });

  it('publish path: when publisherAddress is omitted, round-robin signer is also the approve signer (no mid-flight rotation)', async () => {
    // Without `publisherAddress`, `txSigner` is picked via
    // `nextAuthorizedSigner` (round-robin among authorized wallets). The
    // approval and the publish MUST target that same wallet — no signer swap
    // between the two steps. A regression that called
    // `nextAuthorizedSigner` again later in the flow would rotate to the
    // next wallet and reintroduce the wallet-mismatch class of bug.
    const allowanceByOwner = makeAllowanceByOwner();
    const { a, walletA, tokenWithSigner, sendSpy, signSpy } =
      makeMultiWalletV10Adapter(allowanceByOwner);

    await expect(
      a.createKnowledgeAssets(makeV10PublishParams()),
    ).rejects.toThrow('SENTINEL_STOP_AFTER_APPROVE');

    expect(tokenWithSigner.allowance.calls).toContainEqual([
      walletA.address,
      PARITY_KA_ADDRESS,
    ]);
    const [, approveMethod, approveArgs, approveSender] = sendSpy.calls[0];
    expect(approveMethod).toBe('approve');
    expect(approveArgs).toEqual([PARITY_KA_ADDRESS, 1n]);
    expect(approveSender).toBe(walletA);
    // R1/OBS-1: signer reconnected per-provider — assert ADDRESS not identity.
    expect((signSpy.calls[0][0] as ethers.Wallet).address).toBe(walletA.address);
  });

  it('update path: approve fires from the on-chain publisher wallet, NOT a round-robin pick from the pool', async () => {
    // `updateKnowledgeCollectionV10` resolves the signer by looking up
    // `getLatestMerkleRootPublisher(kaId)` first; only if that wallet is not
    // in the pool does it fall back to the publisherAddress hint or
    // `nextSigner()` (round-robin). The approval gate MUST target the
    // resolved wallet — otherwise a wallet with stale allowance from any
    // other operation could falsely pass the gate while the actual update
    // tx submits from a different wallet at 0 allowance.
    const allowanceByOwner = makeAllowanceByOwner();
    const { a, walletA, walletB, tokenWithSigner, sendSpy, signSpy } =
      makeMultiWalletV10Adapter(allowanceByOwner);
    // walletA — the default round-robin pick (index 0) — has plenty of
    // allowance. walletB — the on-chain publisher of this KA — has none.
    allowanceByOwner.set(walletA.address.toLowerCase(), 10n * 10n ** 18n);
    allowanceByOwner.set(walletB.address.toLowerCase(), 0n);

    // Injected DI seams the update path needs in addition to the publish ones.
    const kaId = 42n;
    (a as any).contracts.knowledgeAssetStorage = connectable({
      getLatestMerkleRootPublisher: recorder(async () => walletB.address),
      getMerkleRoots: recorder(async () => []),
    });
    (a as any).contracts.contextGraphStorage = connectable({
      kaToContextGraph: recorder(async () => 0n),
    });
    (a as any).resolveCurrentTokenAmount = recorder(async () => 0n);
    (a as any).computeUpdateNewTokenAmount = recorder(async () => 0n);
    (a as any).getIdentityId = recorder(async () => 0n);
    // `getEvmChainId()` validates chainId through this.providers[0]
    // (=== this.provider), so mutate the shared object — replacing
    // this.provider would orphan this.providers[0] and the read would dial the
    // dead placeholder RPC instead.
    (a as any).provider.getNetwork = recorder(async () => ({ chainId: 31337n }));

    const updateParams: any = {
      kaId,
      newMerkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('umr'))),
      newByteSize: 100,
      newMerkleLeafCount: 1,
      newTokenAmount: 0n,
      authorAddress: walletB.address,
      authorR: new Uint8Array(32),
      authorVS: new Uint8Array(32),
      authorSchemeVersion: 1,
      // Provide pre-signed ACKs so the update path skips the in-line
      // `signer.signMessage(ackDigest)` step that would otherwise trip on
      // our minimal mocking surface.
      ackSignatures: [{
        identityId: 1n,
        r: new Uint8Array(32),
        vs: new Uint8Array(32),
      }],
    };

    await expect(
      a.updateKnowledgeCollectionV10(updateParams),
    ).rejects.toThrow('SENTINEL_STOP_AFTER_APPROVE');

    expect(tokenWithSigner.allowance.calls).toContainEqual([
      walletB.address,
      PARITY_KA_ADDRESS,
    ]);
    expect(tokenWithSigner.allowance.calls).not.toContainEqual([
      walletA.address,
      PARITY_KA_ADDRESS,
    ]);

    expect(sendSpy.calls).toHaveLength(1);
    const [, approveMethod, approveArgs, approveSender, approveLabel] =
      sendSpy.calls[0];
    expect(approveMethod).toBe('approve');
    expect(approveArgs).toEqual([PARITY_KA_ADDRESS, 1n]);
    expect(approveSender).toBe(walletB);
    expect(approveLabel).toBe('approve V10 update TRAC');

    expect(signSpy.calls).toHaveLength(1);
    // R1/OBS-1: populateAndSignAcrossProviders signs on the per-provider runner
    // (signer.connect(providers[i])) — same key/ADDRESS as walletB, new object.
    // Assert the signer ADDRESS, not object identity (#870 "publish signed by
    // walletB, no mid-flight rotation" invariant is preserved).
    expect((signSpy.calls[0][0] as ethers.Wallet).address).toBe(walletB.address);
  });

  it('update path: validates live chain id before approval/signing on static-network providers', async () => {
    const allowanceByOwner = makeAllowanceByOwner();
    const { a, walletB, sendSpy, signSpy, tokenWithSigner } =
      makeMultiWalletV10Adapter(allowanceByOwner, undefined, [], { staticNetwork: true });

    const kaId = 42n;
    (a as any).contracts.knowledgeAssetStorage = connectable({
      getLatestMerkleRootPublisher: recorder(async () => walletB.address),
      getMerkleRoots: recorder(async () => []),
    });
    (a as any).provider.getNetwork = recorder(async () => ({ chainId: 31337n }));
    (a as any).provider.send = recorder(async (method: string) => {
      if (method === 'eth_chainId') return '0x14a34';
      throw new Error(`unexpected RPC method ${method}`);
    });

    const updateParams: any = {
      kaId,
      newMerkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('umr'))),
      newByteSize: 100,
      newMerkleLeafCount: 1,
      newTokenAmount: 0n,
      authorAddress: walletB.address,
      authorR: new Uint8Array(32),
      authorVS: new Uint8Array(32),
      authorSchemeVersion: 1,
      ackSignatures: [{
        identityId: 1n,
        r: new Uint8Array(32),
        vs: new Uint8Array(32),
      }],
    };

    await expect(
      a.updateKnowledgeCollectionV10(updateParams),
    ).rejects.toThrow(/Configured chainId 31337 does not match RPC chainId 84532/);

    expect(tokenWithSigner.allowance.calls).toHaveLength(0);
    expect(sendSpy.calls).toHaveLength(0);
    expect(signSpy.calls).toHaveLength(0);
  });

// -----------------------------------------------------------------------------
// Funding-aware publish wallet selection. `nextAuthorizedSigner` must PREFER an
// authorized wallet that holds native gas AND TRAC, so a publish is never
// routed to an authorized-but-empty wallet (the unfunded-wallet publish
// failure). Selection only PREFERS — when none is fundable it falls back to the
// best-funded wallet, and the publish then surfaces an actionable
// InsufficientPublisherFundsError instead of a raw "insufficient funds" string.
// -----------------------------------------------------------------------------
describe('createKnowledgeAssets — funding-aware wallet selection', () => {
  const CG = 7n;
  const lc = (addr: string) => addr.toLowerCase();
  const ONE = 10n ** 18n;

  it('prefers a funded authorized wallet over an unfunded one (skips the empty round-robin head)', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // walletA (round-robin head) has gas but ZERO TRAC; walletB is funded.
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), ONE);
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletB.address);
  });

  it('rotates among multiple funded wallets (preserves cross-wallet nonce concurrency)', async () => {
    const { a, walletA, walletB } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // Both abundantly funded (helper default) → behaves like plain round-robin.
    const first = await (a as any).nextAuthorizedSigner(CG);
    const second = await (a as any).nextAuthorizedSigner(CG);
    expect(first.address).toBe(walletA.address);
    expect(second.address).toBe(walletB.address);
    expect(first.address).not.toBe(second.address);
  });

  it('falls back to the best-funded authorized wallet when none is fundable', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // Neither fundable (both have 0 gas); walletB holds more TRAC → best-funded.
    nativeByAddr.set(lc(walletA.address), 0n); nativeByAddr.set(lc(walletB.address), 0n);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 5n);
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletB.address);
  });

  it('fails open: a balance-read error never blocks selection (returns the round-robin head)', async () => {
    const { a, walletA } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    (a as any).provider.getBalance = recorder(async () => { throw new Error('rpc down'); });
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletA.address);
  });

  it('no token contract: only native gas gates selection', async () => {
    const { a, walletA, walletB, nativeByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), 0n); nativeByAddr.set(lc(walletB.address), ONE);
    (a as any).contracts.token = undefined; // read-only / no-token adapter
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    // walletA has 0 gas → skipped; walletB has gas → chosen (TRAC not gating).
    expect(chosen.address).toBe(walletB.address);
  });

  it('treats a covering PCA agent wallet (zero own-TRAC) as fundable, preferring it over the unfundable round-robin head', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // walletA (head): gas, ZERO own-TRAC, NOT a PCA agent → unfundable.
    // walletB: gas, ZERO own-TRAC, but a registered+covering PCA agent → its
    // publish is paid from the conviction account, so it IS fundable.
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 0n);
    (a as any).contracts.dkgPublishingConvictionNFT = {}; // PCA NFT deployed
    (a as any).getConvictionAgentAccountId = recorder(async (addr: string) =>
      addr.toLowerCase() === lc(walletB.address) ? 7n : 0n);
    (a as any).convictionAccountCanCover = recorder(async () => true);
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletB.address); // chosen ONLY via the PCA fallback
  });

  it('does NOT treat a non-covering (squat) PCA agent wallet as fundable', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // walletA (head): gas, ZERO own-TRAC, registered PCA but CANNOT cover (squat).
    // walletB: gas + own-TRAC → genuinely fundable.
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), ONE);
    (a as any).contracts.dkgPublishingConvictionNFT = {};
    (a as any).getConvictionAgentAccountId = recorder(async () => 9n); // registered
    (a as any).convictionAccountCanCover = recorder(async () => false); // but can't cover
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletB.address); // squat PCA head skipped for the funded wallet
  });

  it('still throws "no authorized publisher" when no wallet is authorized (unchanged)', async () => {
    const { a } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    (a as any).contracts.contextGraphs = connectable({ isAuthorizedPublisher: recorder(async () => false) });
    await expect((a as any).nextAuthorizedSigner(CG)).rejects.toThrow(/No authorized publisher wallet/);
  });

  it('wraps an insufficient-funds publish failure into an actionable InsufficientPublisherFundsError listing per-wallet balances', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), 0n); nativeByAddr.set(lc(walletB.address), 0n);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 0n);
    // The signing step throws an ethers-style INSUFFICIENT_FUNDS error.
    (a as any).signPopulatedTransaction = recorder(async () => {
      const e: any = new Error('insufficient funds for gas * price + value');
      e.code = 'INSUFFICIENT_FUNDS';
      throw e;
    });

    let caught: any;
    try {
      await a.createKnowledgeAssets(makeV10PublishParams());
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InsufficientPublisherFundsError);
    expect(caught.code).toBe('NO_FUNDED_PUBLISHER_WALLET');
    expect(caught.message).toContain(walletA.address);
    expect(caught.message).toContain(walletB.address);
    expect(caught.message).toMatch(/Fund one of these wallets/i);
    expect(caught.cause).toBeDefined(); // original error preserved
  });

  it('kill-switch keeps legacy routing balance-blind but cannot bypass strict publish planning', async () => {
    const prev = process.env.DKG_DISABLE_FUNDED_WALLET_SELECTION;
    process.env.DKG_DISABLE_FUNDED_WALLET_SELECTION = '1';
    try {
      // Kill-switch is read in the constructor, so it must be set BEFORE the
      // adapter is built (inside the helper).
      const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      nativeByAddr.set(lc(walletA.address), 0n); nativeByAddr.set(lc(walletB.address), 0n);
      tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 0n);
      const chosen = await (a as any).nextAuthorizedSigner(CG);
      expect(chosen.address).toBe(walletA.address); // round-robin head, balance-blind
      expect((a as any).provider.getBalance.calls.length).toBe(0); // no balance reads

      (a as any).quoteRequiredPublishTokenAmount = recorder(async () => 1_000n);
      await expect(a.resolvePublisherPublishPlan({
        contextGraphId: CG,
        effectiveByteSize: 100n,
        explicitPublishEpochs: 12,
        defaultPublishEpochs: 12,
      })).rejects.toMatchObject({ code: 'NO_FUNDED_PUBLISHER_WALLET' });
      expect((a as any).provider.getBalance.calls.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.DKG_DISABLE_FUNDED_WALLET_SELECTION;
      else process.env.DKG_DISABLE_FUNDED_WALLET_SELECTION = prev;
    }
  });

  it('no-contextGraphs adapter: funding-aware selection over the whole pool', async () => {
    const { a, walletA, walletB, nativeByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    (a as any).contracts.contextGraphs = undefined; // no on-chain publish-authority surface
    nativeByAddr.set(lc(walletA.address), 0n); nativeByAddr.set(lc(walletB.address), ONE);
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletB.address); // skips the unfunded round-robin head
  });

  it('caches funding within the TTL (one balance read per wallet across selections; forceRefresh bypasses)', async () => {
    const { a } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    await (a as any).nextAuthorizedSigner(CG);
    const afterFirst = (a as any).provider.getBalance.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    await (a as any).nextAuthorizedSigner(CG);
    expect((a as any).provider.getBalance.calls.length).toBe(afterFirst); // cache hit, no new reads
    await (a as any).getWalletFunding((a as any).signer.address, { forceRefresh: true });
    expect((a as any).provider.getBalance.calls.length).toBeGreaterThan(afterFirst); // forceRefresh re-reads
  });

  it('rotates among the FUNDED subset when a middle wallet is unfunded (preserves #953 concurrency)', async () => {
    const { a, wallets, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner(), undefined, [THIRD_PK]);
    expect(wallets.length).toBe(3);
    const [w0, w1, w2] = wallets;
    nativeByAddr.set(lc(w1.address), 0n); tracByAddr.set(lc(w1.address), 0n); // middle wallet unfunded
    const first = await (a as any).nextAuthorizedSigner(CG);
    const second = await (a as any).nextAuthorizedSigner(CG);
    const picked = [first.address, second.address];
    expect(picked).not.toContain(w1.address);       // never the unfunded one
    expect(new Set(picked).size).toBe(2);            // distinct → cross-wallet concurrency preserved
    expect(picked.slice().sort()).toEqual([w0.address, w2.address].slice().sort());
  });

  it('does NOT wrap a non-funds contract revert on a funded wallet (no masking)', async () => {
    const { a } = makeMultiWalletV10Adapter(makeAllowanceByOwner()); // both abundantly funded
    (a as any).signPopulatedTransaction = recorder(async () => {
      const e: any = new Error('execution reverted: InvalidAuthorAttestation');
      e.code = 'CALL_EXCEPTION';
      throw e;
    });
    let caught: any;
    try { await a.createKnowledgeAssets(makeV10PublishParams()); } catch (e) { caught = e; }
    expect(caught).not.toBeInstanceOf(InsufficientPublisherFundsError);
    expect(caught.message).toContain('InvalidAuthorAttestation');
  });

  it('does NOT wrap a non-revert error (nonce) even on a zero-TRAC wallet', async () => {
    const { a, walletA, walletB, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 0n);
    (a as any).signPopulatedTransaction = recorder(async () => {
      const e: any = new Error('nonce has already been used');
      e.code = 'NONCE_EXPIRED';
      throw e;
    });
    let caught: any;
    try { await a.createKnowledgeAssets(makeV10PublishParams()); } catch (e) { caught = e; }
    expect(caught).not.toBeInstanceOf(InsufficientPublisherFundsError);
    expect(caught.code).toBe('NONCE_EXPIRED');
  });

  it('emits NO_FUNDED when the only funded wallet is NOT authorized for the context graph (cannot be routed to)', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // walletA (selected/pinned): authorized, gas, ZERO TRAC. walletB: funded but UNAUTHORIZED.
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), ONE);
    (a as any).contracts.contextGraphs.isAuthorizedPublisher = recorder(async (_cg: bigint, addr: string) =>
      addr.toLowerCase() === walletA.address.toLowerCase());
    const params = makeV10PublishParams(walletA.address);
    params.tokenAmount = 1000n;
    (a as any).signPopulatedTransaction = recorder(async () => {
      const e: any = new Error('execution reverted: ERC20: transfer amount exceeds balance');
      e.code = 'CALL_EXCEPTION';
      throw e;
    });
    let caught: any;
    try { await a.createKnowledgeAssets(params); } catch (e) { caught = e; }
    // The funded wallet is unauthorized → not a viable reroute → terminal NO_FUNDED.
    expect(caught).toBeInstanceOf(InsufficientPublisherFundsError);
    expect(caught.code).toBe('NO_FUNDED_PUBLISHER_WALLET');
  });

  it('does NOT wrap a non-funds contract revert on a zero-TRAC signer (no funds marker, not masked)', async () => {
    const { a, walletA, walletB, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 0n);
    // A generic contract revert (CALL_EXCEPTION) on a short wallet must surface
    // unchanged — NOT be converted to NO_FUNDED_PUBLISHER_WALLET.
    (a as any).signPopulatedTransaction = recorder(async () => {
      const e: any = new Error('execution reverted: InvalidAuthorAttestation');
      e.code = 'CALL_EXCEPTION';
      throw e;
    });
    let caught: any;
    try { await a.createKnowledgeAssets(makeV10PublishParams()); } catch (e) { caught = e; }
    expect(caught).not.toBeInstanceOf(InsufficientPublisherFundsError);
    expect(caught.message).toContain('InvalidAuthorAttestation');
  });

  it('does NOT claim NO_FUNDED when the SELECTED wallet is short but another authorized wallet can cover the cost', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // Pin walletA (gas + ZERO TRAC); walletB is funded for the cost.
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), ONE);
    const params = makeV10PublishParams(walletA.address);
    params.tokenAmount = 1000n;
    (a as any).signPopulatedTransaction = recorder(async () => {
      const e: any = new Error('execution reverted: ERC20: transfer amount exceeds balance');
      e.code = 'CALL_EXCEPTION';
      throw e;
    });
    let caught: any;
    try { await a.createKnowledgeAssets(params); } catch (e) { caught = e; }
    // Pool has a funded wallet → preserve the original error (retry can reroute),
    // do NOT mislabel as "no operational wallet has funds".
    expect(caught).not.toBeInstanceOf(InsufficientPublisherFundsError);
    expect(caught.message).toContain('transfer amount exceeds balance');
  });

  it('wraps a TRAC transferFrom revert on a zero-TRAC wallet that holds gas', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 0n);
    (a as any).signPopulatedTransaction = recorder(async () => {
      const e: any = new Error('execution reverted: ERC20: transfer amount exceeds balance');
      e.code = 'CALL_EXCEPTION';
      throw e;
    });
    let caught: any;
    try { await a.createKnowledgeAssets(makeV10PublishParams()); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InsufficientPublisherFundsError);
    expect(caught.code).toBe('NO_FUNDED_PUBLISHER_WALLET');
  });

  it('classifies the V10 TooLowBalance custom error as insufficient funds', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 0n);
    (a as any).signPopulatedTransaction = recorder(async () => {
      const error: any = new Error('execution reverted: TooLowBalance(0xabc, 1000, 2000)');
      error.code = 'CALL_EXCEPTION';
      throw error;
    });
    await expect(a.createKnowledgeAssets(makeV10PublishParams())).rejects.toMatchObject({
      code: 'NO_FUNDED_PUBLISHER_WALLET',
    });
  });

  it('fails a priced publisher reservation before transaction work when no wallet can cover it', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 1n); tracByAddr.set(lc(walletB.address), 2n);
    (a as any).quoteRequiredPublishTokenAmount = recorder(async () => 1_000n);
    await expect(a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      explicitPublishEpochs: 2,
      defaultPublishEpochs: 12,
    })).rejects.toMatchObject({
      code: 'NO_FUNDED_PUBLISHER_WALLET',
    });
  });

  it('force-refreshes cached balances before a terminal no-funded-wallet decision', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 0n);
    // Warm the advisory cache with the wallet still empty.
    await (a as any).nextAuthorizedSigner(CG);
    tracByAddr.set(lc(walletA.address), 2_000n);
    (a as any).quoteRequiredPublishTokenAmount = recorder(async () => 1_000n);

    await expect(a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      explicitPublishEpochs: 2,
      defaultPublishEpochs: 12,
    })).resolves.toMatchObject({ publisherAddress: walletA.address, publishEpochs: 2, tokenAmount: 1_000n });
  });

  it('selects a later signer inside one exact adapter-owned publish plan', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 1n); tracByAddr.set(lc(walletB.address), 2_000n);
    (a as any).quoteRequiredPublishTokenAmount = recorder(async () => 1_000n);

    const plan = await a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      explicitPublishEpochs: 2,
      defaultPublishEpochs: 12,
    });
    expect(plan).toEqual({ publisherAddress: walletB.address, publishEpochs: 2, tokenAmount: 1_000n });
    expect((plan as { signer?: unknown }).signer).toBeUndefined();
  });

  it('never rotates away from an explicitly pinned publisher during strict reservation', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 2_000n);
    (a as any).quoteRequiredPublishTokenAmount = recorder(async () => 1_000n);

    await expect(a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      explicitPublishEpochs: 2,
      defaultPublishEpochs: 12,
      publisherAddress: walletA.address,
    })).rejects.toMatchObject({ code: 'NO_FUNDED_PUBLISHER_WALLET' });

    tracByAddr.set(lc(walletA.address), 2_000n);
    await expect(a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      explicitPublishEpochs: 2,
      defaultPublishEpochs: 12,
      publisherAddress: walletA.address,
    })).resolves.toMatchObject({ publisherAddress: walletA.address, publishEpochs: 2, tokenAmount: 1_000n });
  });

  it('rejects a funded but unauthorized explicitly pinned publisher', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 2_000n); tracByAddr.set(lc(walletB.address), 2_000n);
    (a as any).contracts.contextGraphs.isAuthorizedPublisher = recorder(async (_cg: bigint, addr: string) =>
      addr.toLowerCase() !== walletA.address.toLowerCase());
    (a as any).quoteRequiredPublishTokenAmount = recorder(async () => 1_000n);

    await expect(a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      explicitPublishEpochs: 2,
      defaultPublishEpochs: 12,
      publisherAddress: walletA.address,
    })).rejects.toThrow(/publisherAddress .* is not authorized.*context graph/i);
  });

  it('expires the funding cache past the TTL: a newly funded wallet is re-read and selected', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // walletA (head) unfunded (0 TRAC); walletB funded → B chosen first.
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), ONE);
    const first = await (a as any).nextAuthorizedSigner(CG);
    expect(first.address).toBe(walletB.address);
    // walletA is funded, but its zero balance is still cached. Backdate every
    // cache entry past the TTL so the next selection must re-read.
    tracByAddr.set(lc(walletA.address), ONE);
    for (const entry of ((a as any).fundingCache as Map<string, { nativeTs: number; tracTs: number }>).values()) {
      entry.nativeTs = 0;
      entry.tracTs = 0;
    }
    const second = await (a as any).nextAuthorizedSigner(CG);
    expect(second.address).toBe(walletA.address); // re-read picks up the now-funded head
  });

  it('honors a non-zero minPublisherTracWei floor (strict > boundary)', async () => {
    const FLOOR = 100n;
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    (a as any).minPublisherTracWei = FLOOR;
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), FLOOR); tracByAddr.set(lc(walletB.address), FLOOR + 1n);
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletB.address); // A at exactly the floor is NOT fundable (strict >)
  });

  it('honors a non-zero minPublisherNativeWei floor (strict > boundary)', async () => {
    const FLOOR = 100n;
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    (a as any).minPublisherNativeWei = FLOOR;
    nativeByAddr.set(lc(walletA.address), FLOOR); nativeByAddr.set(lc(walletB.address), FLOOR + 1n);
    tracByAddr.set(lc(walletA.address), ONE); tracByAddr.set(lc(walletB.address), ONE);
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletB.address); // A at exactly the native floor is NOT fundable
  });

  // The two tests above mutate the instance field AFTER construction, so they
  // would pass even if the constructor stopped reading the config. These pin the
  // CONSTRUCTOR path: the floor is injected via the adapter config and must be
  // both stored on the instance and honored by selection.
  it('reads minPublisherTracWei from the CONSTRUCTOR config (not a post-construction mutation)', async () => {
    const FLOOR = 100n;
    const { a, walletA, walletB, nativeByAddr, tracByAddr } =
      makeMultiWalletV10Adapter(makeAllowanceByOwner(), undefined, [], { minPublisherTracWei: FLOOR });
    expect((a as any).minPublisherTracWei).toBe(FLOOR); // constructor consumed config.minPublisherTracWei
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), FLOOR); tracByAddr.set(lc(walletB.address), FLOOR + 1n);
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletB.address); // A at exactly the floor is skipped (strict >)
  });

  it('reads minPublisherNativeWei from the CONSTRUCTOR config (not a post-construction mutation)', async () => {
    const FLOOR = 100n;
    const { a, walletA, walletB, nativeByAddr, tracByAddr } =
      makeMultiWalletV10Adapter(makeAllowanceByOwner(), undefined, [], { minPublisherNativeWei: FLOOR });
    expect((a as any).minPublisherNativeWei).toBe(FLOOR); // constructor consumed config.minPublisherNativeWei
    nativeByAddr.set(lc(walletA.address), FLOOR); nativeByAddr.set(lc(walletB.address), FLOOR + 1n);
    tracByAddr.set(lc(walletA.address), ONE); tracByAddr.set(lc(walletB.address), ONE);
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletB.address);
  });

  it('cost-aware fallback selection: skips a dust-TRAC wallet that cannot cover the publish cost', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // walletA (head): gas + 1 wei TRAC (dust — above the 0n floor but below the
    // publish cost). walletB: covers. createKnowledgeAssets (no publisherAddress)
    // selects cost-aware against floorPublishTokenAmount(params.tokenAmount).
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 1n); tracByAddr.set(lc(walletB.address), ONE);
    const params = makeV10PublishParams();
    params.tokenAmount = 1000n; // publish costs 1000 wei TRAC
    let chosenSigner: any;
    (a as any).signPopulatedTransaction = recorder(async (signer: any) => { chosenSigner = signer; throw new Error('SENTINEL'); });
    await expect(a.createKnowledgeAssets(params)).rejects.toThrow('SENTINEL');
    expect(chosenSigner.address).toBe(walletB.address); // dust-TRAC head skipped for the covering wallet
  });

  it('skips a funded round-robin HEAD that is NOT authorized and selects a later authorized+funded wallet', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // Mixed case: both wallets abundantly funded, but walletA (the round-robin
    // head) is UNAUTHORIZED for the CG and walletB is authorized. Authorization
    // must gate selection so the funded-but-unauthorized head is never picked.
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), ONE); tracByAddr.set(lc(walletB.address), ONE);
    (a as any).contracts.contextGraphs.isAuthorizedPublisher = recorder(async (_cg: bigint, addr: string) =>
      addr.toLowerCase() === lc(walletB.address));
    const chosen = await (a as any).nextAuthorizedSigner(CG);
    expect(chosen.address).toBe(walletB.address); // funded-but-unauthorized head filtered out
  });

  it('cost-aware PCA: prices convictionAccountCanCover at the publish cost and skips a PCA that covers only the 1-wei probe', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    // walletA (head): gas, ZERO own-TRAC, a registered PCA agent whose conviction
    // account covers the 1-wei liveness probe but NOT a real publish cost.
    // walletB: own-TRAC covers the cost. createKnowledgeAssets must price the PCA
    // coverage check at floorPublishTokenAmount(tokenAmount) (NOT the 1-wei probe),
    // so walletA is rejected and walletB is chosen.
    const params = makeV10PublishParams();
    params.tokenAmount = 1000n;
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), ONE);
    (a as any).contracts.dkgPublishingConvictionNFT = {};
    (a as any).getConvictionAgentAccountId = recorder(async (addr: string) =>
      addr.toLowerCase() === lc(walletA.address) ? 42n : 0n);
    (a as any).getConvictionAccountLockDurationEpochs = recorder(async () => params.epochs);
    const coverCalls: bigint[] = [];
    (a as any).convictionAccountCanCover = recorder(async (_id: bigint, cost: bigint) => {
      coverCalls.push(cost);
      return cost <= 1n; // covers the 1-wei liveness probe only, NOT a real publish cost
    });
    let chosenSigner: any;
    (a as any).signPopulatedTransaction = recorder(async (signer: any) => { chosenSigner = signer; throw new Error('SENTINEL'); });
    await expect(a.createKnowledgeAssets(params)).rejects.toThrow('SENTINEL');
    expect(chosenSigner.address).toBe(walletB.address); // PCA head can't cover the REAL cost → skipped
    expect(coverCalls.length).toBe(1); // only walletA's PCA was probed (walletB fundable via own-TRAC)
    expect(coverCalls[0] > 1n).toBe(true); // priced at the REAL publish cost, not the 1-wei liveness probe
  });

  it('does not count PCA coverage when its lock differs from the submitted publish lifetime', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), ONE);
    (a as any).contracts.dkgPublishingConvictionNFT = {};
    (a as any).getConvictionAgentAccountId = recorder(async (addr: string) =>
      addr.toLowerCase() === lc(walletA.address) ? 42n : 0n);
    (a as any).getConvictionAccountLockDurationEpochs = recorder(async () => 24);
    (a as any).convictionAccountCanCover = recorder(async () => true);
    (a as any).quoteRequiredPublishTokenAmount = recorder(async () => 1_000n);

    await expect(a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      explicitPublishEpochs: 5,
      defaultPublishEpochs: 12,
    })).resolves.toMatchObject({ publisherAddress: walletB.address, publishEpochs: 5, tokenAmount: 1_000n });
  });

  it('applies exact PCA lock matching on the public createKnowledgeAssets path', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), ONE);
    (a as any).contracts.dkgPublishingConvictionNFT = {};
    (a as any).getConvictionAgentAccountId = recorder(async (addr: string) =>
      addr.toLowerCase() === lc(walletA.address) ? 42n : 0n);
    (a as any).getConvictionAccountLockDurationEpochs = recorder(async () => 24);
    (a as any).convictionAccountCanCover = recorder(async () => true);

    const params = makeV10PublishParams();
    params.epochs = 5;
    params.tokenAmount = 1_000n;
    let chosenSigner: ethers.Wallet | undefined;
    (a as any).signPopulatedTransaction = recorder(async (signer: ethers.Wallet) => {
      chosenSigner = signer;
      throw new Error('SENTINEL');
    });

    await expect(a.createKnowledgeAssets(params)).rejects.toThrow('SENTINEL');
    expect(chosenSigner?.address).toBe(walletB.address);
  });

  it('discovers a shorter-lock PCA from its own quote without probing the default lifetime first', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } =
      makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE);
    nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n);
    tracByAddr.set(lc(walletB.address), 0n);
    (a as any).contracts.dkgPublishingConvictionNFT = {};
    (a as any).getConvictionAgentAccountId = recorder(async (address: string) =>
      address.toLowerCase() === lc(walletA.address) ? 42n : 0n);
    (a as any).getConvictionAccountLockDurationEpochs = recorder(async () => 6);
    const coverageCosts: bigint[] = [];
    (a as any).convictionAccountCanCover = recorder(async (_accountId: bigint, cost: bigint) => {
      coverageCosts.push(cost);
      return cost <= 6n;
    });
    const quotedEpochs: number[] = [];
    (a as any).quoteRequiredPublishTokenAmount = recorder(async (_bytes: bigint, epochs: number) => {
      quotedEpochs.push(epochs);
      return BigInt(epochs);
    });

    await expect(a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      defaultPublishEpochs: 12,
    })).resolves.toMatchObject({
      publisherAddress: walletA.address,
      publishEpochs: 6,
      tokenAmount: 6n,
    });
    expect(coverageCosts.length).toBeGreaterThan(0);
    expect(coverageCosts.every((cost) => cost === 6n)).toBe(true);
    expect(quotedEpochs).toContain(6);
  });

  it('resolves weak-candidate retry and a non-default PCA lock inside one publish-plan operation', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 0n); tracByAddr.set(lc(walletB.address), 0n);
    (a as any).contracts.dkgPublishingConvictionNFT = {};
    (a as any).getConvictionAgentAccountId = recorder(async (addr: string) =>
      addr.toLowerCase() === lc(walletA.address) ? 41n : 42n);
    (a as any).getConvictionAccountLockDurationEpochs = recorder(async (accountId: bigint) =>
      accountId === 41n ? 12 : 24);
    const coverCalls: Array<{ accountId: bigint; cost: bigint }> = [];
    (a as any).convictionAccountCanCover = recorder(async (accountId: bigint, cost: bigint) => {
      coverCalls.push({ accountId, cost });
      return accountId === 42n && cost <= 24n;
    });
    (a as any).quoteRequiredPublishTokenAmount = recorder(async (_bytes: bigint, epochs: number) => BigInt(epochs));

    await expect(a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      defaultPublishEpochs: 12,
    })).resolves.toMatchObject({ publisherAddress: walletB.address, publishEpochs: 24, tokenAmount: 24n });
    expect(coverCalls.some((call) => call.accountId === 41n && call.cost === 12n)).toBe(true);
    expect(coverCalls.some((call) => call.accountId === 42n && call.cost === 24n)).toBe(true);
  });

  it('retries a transient PCA quote failure for the same direct-spend lifetime', async () => {
    const { a, walletA, walletB, nativeByAddr, tracByAddr } =
      makeMultiWalletV10Adapter(makeAllowanceByOwner());
    nativeByAddr.set(lc(walletA.address), ONE); nativeByAddr.set(lc(walletB.address), ONE);
    tracByAddr.set(lc(walletA.address), 2_000n); tracByAddr.set(lc(walletB.address), 2_000n);
    (a as any).contracts.dkgPublishingConvictionNFT = {};
    (a as any).getConvictionAgentAccountId = recorder(async (addr: string) =>
      addr.toLowerCase() === lc(walletA.address) ? 42n : 0n);
    (a as any).getConvictionAccountLockDurationEpochs = recorder(async () => 12);
    (a as any).convictionAccountCanCover = recorder(async () => true);
    let quoteCalls = 0;
    (a as any).quoteRequiredPublishTokenAmount = recorder(async (_bytes: bigint, epochs: number) => {
      quoteCalls += 1;
      if (quoteCalls === 1) throw new Error('transient AskStorage failure');
      expect(epochs).toBe(12);
      return 1_000n;
    });

    await expect(a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      defaultPublishEpochs: 12,
    })).resolves.toMatchObject({
      publisherAddress: walletA.address,
      publishEpochs: 12,
      tokenAmount: 1_000n,
    });
    expect(quoteCalls).toBe(2);
  });

  // ── dispatcher Phase 3: the generalized selectSigner seam (RS/relay/update
  // route through this later). Publish behaviour above is proven byte-identical
  // through the nextAuthorizedSigner wrapper; these cover the NEW capabilities.
  describe('selectSigner — generalized funding modes + idle preference', () => {
    const nativeOnly = { kind: 'native-only' as const, nativeFloorWei: 0n };
    // rotatable-free eligibility fails CLOSED to REGISTERED operational wallets
    // (Phase 4). These tests exercise the funding/idle logic, so mark the whole
    // pool registered; the fail-closed gate itself is covered separately below.
    const registerPool = (a: any) => {
      for (const w of (a.signerPool as ethers.Wallet[])) {
        a.registeredOperationalAddresses.add(w.address.toLowerCase());
      }
    };
    const nativeAndTrac = {
      kind: 'native+trac' as const,
      nativeFloorWei: 0n,
      tracFloorWei: 0n,
      requiredTracWei: 0n,
      pca: { kind: 'provisional-publish' as const },
    };

    it('native-only funding gates on GAS ALONE — a gas-funded zero-TRAC wallet stays fundable', async () => {
      const { a, walletA, nativeByAddr, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      registerPool(a);
      // Head walletA: gas but ZERO own-TRAC. Under publish (native+trac) it would
      // be skipped; under native-only it is fundable, so the head is chosen.
      nativeByAddr.set(lc(walletA.address), ONE);
      tracByAddr.set(lc(walletA.address), 0n);
      const chosen = await (a as any).selectSigner({ txClass: 'rotatable-free', funding: nativeOnly });
      expect(chosen.address).toBe(walletA.address);
    });

    it('native-only still skips a gas-EMPTY wallet', async () => {
      const { a, walletA, walletB, nativeByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      registerPool(a);
      nativeByAddr.set(lc(walletA.address), 0n); nativeByAddr.set(lc(walletB.address), ONE);
      const chosen = await (a as any).selectSigner({ txClass: 'rotatable-free', funding: nativeOnly });
      expect(chosen.address).toBe(walletB.address);
    });

    it('rotatable-free ignores the authorized-publisher filter (registered pool, not auth-gated)', async () => {
      const { a, walletA } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      registerPool(a);
      // No wallet is an authorized publisher → publish (rotatable-policy) throws…
      (a as any).contracts.contextGraphs = connectable({ isAuthorizedPublisher: recorder(async () => false) });
      await expect((a as any).selectSigner({ txClass: 'rotatable-policy', contextGraphId: CG, funding: nativeAndTrac }))
        .rejects.toThrow(/No authorized publisher wallet/);
      // …but rotatable-free never consults that surface — it picks from the
      // registered pool regardless of publish authority.
      const chosen = await (a as any).selectSigner({ txClass: 'rotatable-free', funding: nativeOnly });
      expect(chosen.address).toBe(walletA.address);
    });

    it('rotatable-free FAILS CLOSED: an UNREGISTERED funded+idle wallet is never selected', async () => {
      const { a, walletA, walletB, nativeByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      // Only pool[0] (walletA) is registered (constructor seed); walletB is NOT.
      // Make walletA gas-poor AND busy, walletB abundantly funded AND idle — yet
      // walletB must NOT be picked (unregistered → identity 0 → on-chain revert).
      nativeByAddr.set(lc(walletA.address), 0n); nativeByAddr.set(lc(walletB.address), ONE);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      void (a as any).signerTxSerializer.run(walletA.address, () => gate);
      try {
        const chosen = await (a as any).selectSigner({ txClass: 'rotatable-free', funding: nativeOnly, preferIdle: true });
        expect(chosen.address).toBe(walletA.address); // registered pool[0], despite gas-poor + busy
        expect(chosen.address).not.toBe(walletB.address);
      } finally { release(); }
    });

    it('preferIdle biases toward a funded wallet whose per-wallet lock is free', async () => {
      const { a, walletA, walletB } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      registerPool(a);
      // Both funded (helper default). Hold walletA (the round-robin head) busy.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      void (a as any).signerTxSerializer.run(walletA.address, () => gate);
      try {
        const chosen = await (a as any).selectSigner({ txClass: 'rotatable-free', funding: nativeOnly, preferIdle: true });
        expect(chosen.address).toBe(walletB.address); // idle wallet preferred over the busy head
      } finally { release(); }
    });

    it('preferIdle is fail-open: when NO funded wallet is idle it returns the first funded (never excludes)', async () => {
      const { a, walletA, walletB } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      registerPool(a);
      let releaseA!: () => void; let releaseB!: () => void;
      const gA = new Promise<void>((r) => { releaseA = r; });
      const gB = new Promise<void>((r) => { releaseB = r; });
      void (a as any).signerTxSerializer.run(walletA.address, () => gA);
      void (a as any).signerTxSerializer.run(walletB.address, () => gB);
      try {
        const chosen = await (a as any).selectSigner({ txClass: 'rotatable-free', funding: nativeOnly, preferIdle: true });
        expect(chosen.address).toBe(walletA.address); // both busy → first funded (head), not excluded
      } finally { releaseA(); releaseB(); }
    });

    it('native-only (RS) probes never poison the cached TRAC balance a publish relies on', async () => {
      const { a, walletA, walletB, tracByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      registerPool(a);
      // walletA own-TRAC funded, walletB not — a publish must pick A.
      tracByAddr.set(lc(walletA.address), ONE);
      tracByAddr.set(lc(walletB.address), 0n);
      // Prime both cache slots with a full (native+trac) read.
      await (a as any).getWalletFunding(walletA.address);
      await (a as any).getWalletFunding(walletB.address);
      // TRAC reads start failing (store/RPC blip) while natives stay readable,
      // and the native slots expire — the exact per-prover-tick RS shape.
      (a as any).readTracBalance = async () => null;
      for (const entry of ((a as any).fundingCache as Map<string, { nativeTs: number }>).values()) {
        entry.nativeTs = 0;
      }
      // RS probe (native-only) re-reads natives; it must NOT touch TRAC slots.
      await (a as any).selectSigner({ txClass: 'rotatable-free', funding: nativeOnly });
      const cachedA = ((a as any).fundingCache as Map<string, { trac: bigint | null }>).get(lc(walletA.address));
      expect(cachedA?.trac).toBe(ONE); // not clobbered to the failed-read null
      // A publish inside the TTL still sees walletA as own-TRAC funded.
      const chosen = await (a as any).nextAuthorizedSigner(CG);
      expect(chosen.address).toBe(walletA.address);
    });

    it('nextRandomSamplingSigner requests exactly the RS spec (rotatable-free / native-only / preferIdle)', async () => {
      // Pins the wrapper itself — every other test stubs it or calls
      // selectSigner directly, so a wrong txClass/funding/preferIdle here
      // would otherwise only surface on a live devnet.
      const { a } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      const specs: any[] = [];
      (a as any).selectSigner = async (spec: any) => { specs.push(spec); return (a as any).signer; };
      await (a as any).nextRandomSamplingSigner();
      expect(specs).toEqual([{
        txClass: 'rotatable-free',
        funding: { kind: 'native-only', nativeFloorWei: 0n },
        preferIdle: true,
      }]);
    });

    it('RS selection revalidates the chosen wallet on-chain: an out-of-band re-registration is evicted', async () => {
      // Out-of-band removal race: walletB was removed from THIS identity and
      // re-registered to ANOTHER (identity 99) by a second node instance — the
      // same-process set never saw it. The selection must detect the mismatch
      // on the fresh chain read, evict B, and fall back to the primary.
      const { a, walletA, walletB, nativeByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      registerPool(a);
      nativeByAddr.set(lc(walletA.address), 0n); // primary gas-empty → B preferred first
      nativeByAddr.set(lc(walletB.address), ONE);
      (a as any).getIdentityId = async () => 5n;
      const refreshed: string[] = [];
      (a as any).refreshIdentityIdForAddress = async (addr: string) => {
        refreshed.push(lc(addr));
        return lc(addr) === lc(walletB.address) ? 99n : 5n;
      };
      const chosen = await (a as any).nextRandomSamplingSigner();
      expect(refreshed).toContain(lc(walletB.address));
      expect(chosen.address).toBe(walletA.address); // fell back to the primary anchor
      expect((a as any).registeredOperationalAddresses.has(lc(walletB.address))).toBe(false); // evicted
    });

    it('RS revalidation FAILS OPEN on a chain-read error (an RPC blip must not stall proofs)', async () => {
      const { a, walletA, walletB, nativeByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      registerPool(a);
      nativeByAddr.set(lc(walletA.address), 0n);
      nativeByAddr.set(lc(walletB.address), ONE);
      (a as any).getIdentityId = async () => 5n;
      (a as any).refreshIdentityIdForAddress = async () => { throw new Error('rpc down'); };
      const chosen = await (a as any).nextRandomSamplingSigner();
      expect(chosen.address).toBe(walletB.address); // kept despite the failed read
      expect((a as any).registeredOperationalAddresses.has(lc(walletB.address))).toBe(true);
    });

    it('RS revalidation keeps a wallet that still resolves to our identity', async () => {
      const { a, walletA, walletB, nativeByAddr } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
      registerPool(a);
      nativeByAddr.set(lc(walletA.address), 0n);
      nativeByAddr.set(lc(walletB.address), ONE);
      (a as any).getIdentityId = async () => 5n;
      (a as any).refreshIdentityIdForAddress = async () => 5n;
      const chosen = await (a as any).nextRandomSamplingSigner();
      expect(chosen.address).toBe(walletB.address);
      expect((a as any).registeredOperationalAddresses.has(lc(walletB.address))).toBe(true);
    });

    it('DKG_DISABLE_IDLE_AWARE_SELECTION ignores preferIdle (read in the constructor)', async () => {
      const prev = process.env.DKG_DISABLE_IDLE_AWARE_SELECTION;
      process.env.DKG_DISABLE_IDLE_AWARE_SELECTION = '1';
      try {
        const { a, walletA } = makeMultiWalletV10Adapter(makeAllowanceByOwner());
        registerPool(a);
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        void (a as any).signerTxSerializer.run(walletA.address, () => gate);
        try {
          const chosen = await (a as any).selectSigner({ txClass: 'rotatable-free', funding: nativeOnly, preferIdle: true });
          expect(chosen.address).toBe(walletA.address); // idle bias disabled → busy head still chosen
        } finally { release(); }
      } finally {
        if (prev === undefined) delete process.env.DKG_DISABLE_IDLE_AWARE_SELECTION;
        else process.env.DKG_DISABLE_IDLE_AWARE_SELECTION = prev;
      }
    });
  });
});
});

// -----------------------------------------------------------------------------
// #888 — intermittent `TooLowAllowance(TRAC, 0, 1)` on consecutive zero-cost
// publishes. The on-chain allowance read that gates the auto-approve and the
// `estimateGas` ethers runs while populating the publish tx can observe a
// STALE allowance on an internally load-balanced RPC: either a just-consumed
// per-publish 1-wei floor still reads as `1` (so the re-approve is skipped) or
// a freshly-sent approve hasn't propagated to the read replica yet. The fix:
//   1. `isTooLowAllowanceError` classifies the revert,
//   2. `createKnowledgeAssets` retries populate+sign once on that revert with a
//      forced re-approve (the revert is strictly pre-broadcast, so it's safe),
//   3. the forced re-approve approves up to the publish floor regardless of the
//      gating read and confirms the new allowance is visible before returning.
// -----------------------------------------------------------------------------

describe('isTooLowAllowanceError (#888)', () => {
  it('matches the ethers v6 decoded custom-error shape (revert.name)', () => {
    expect(isTooLowAllowanceError({ revert: { name: 'TooLowAllowance' }, message: 'execution reverted' })).toBe(true);
  });

  it('matches a stringified revert in message / shortMessage / reason', () => {
    expect(isTooLowAllowanceError(new Error('execution reverted: TooLowAllowance(0xTRAC, 0, 1)'))).toBe(true);
    expect(isTooLowAllowanceError({ shortMessage: 'execution reverted (TooLowAllowance)' })).toBe(true);
    expect(isTooLowAllowanceError({ reason: 'TooLowAllowance' })).toBe(true);
  });

  it('matches a nested cause.message', () => {
    expect(isTooLowAllowanceError({ message: 'wrapped', cause: new Error('inner: TooLowAllowance(...)') })).toBe(true);
  });

  it('does not match unrelated reverts / errors', () => {
    expect(isTooLowAllowanceError(new Error('TooLowStake(node, 0, 50000)'))).toBe(false);
    expect(isTooLowAllowanceError({ revert: { name: 'NotBatchPublisher' }, message: 'execution reverted' })).toBe(false);
    expect(isTooLowAllowanceError(new Error('insufficient funds for gas'))).toBe(false);
  });

  it('handles non-object / null / numeric / string inputs safely', () => {
    expect(isTooLowAllowanceError(null)).toBe(false);
    expect(isTooLowAllowanceError(undefined)).toBe(false);
    expect(isTooLowAllowanceError('TooLowAllowance')).toBe(false);
    expect(isTooLowAllowanceError(42)).toBe(false);
  });
});

function makeV10AdapterWithAllowanceSequence(values: bigint[]) {
  const a = new EVMChainAdapter(minimalConfig());
  let i = 0;
  const tokenWithSigner = connectable({
    allowance: recorder(async () => values[Math.min(i++, values.length - 1)]),
    approve: recorder(() => undefined),
  });
  const tokenRoot = { connect: recorder(() => tokenWithSigner) };
  (a as any).contracts.token = tokenRoot;
  const sendSpy = recorder(async (..._a: unknown[]) => ({} as unknown));
  (a as any).sendContractTransaction = sendSpy;
  // In-lock publish/update approvals receive the scoped unlocked sender;
  // standalone approval tests call the serialized wrapper. Capture both.
  (a as any).sendContractTransactionUnlocked = sendSpy;
  const signer = new ethers.Wallet(DEPLOYER_PK);
  return { a, signer, tokenWithSigner, sendSpy };
}

describe('ensureV10ApproveTrac — forced re-approve + visibility poll (#888)', () => {

  it('force=true re-approves even when the gating read says the allowance is already sufficient (stale-high skip)', async () => {
    // The "stale-high" sub-race: the per-publish 1-wei floor consumed by
    // the previous publish still reads as `1`, so `needsApprove` is false
    // and the un-forced path would skip the approve — but the real
    // on-chain allowance is 0 and the publish would revert. Forcing the
    // re-approve corrects this.
    const { a, signer, tokenWithSigner, sendSpy } = makeV10Adapter(undefined, 1n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC (forced re-approve, #888)',
      true,
    );

    const call = getApproveCallArgs(sendSpy);
    expect(call.method).toBe('approve');
    expect(call.args).toEqual([V10_KA_ADDRESS, 1n]);
    // gating read (1n) + one visibility-poll read (1n ≥ target → confirmed).
    expect(tokenWithSigner.allowance.calls).toHaveLength(2);
  });

  it('force=false with a sufficient allowance issues NO approve and NO visibility poll (steady-state unchanged)', async () => {
    const { a, signer, tokenWithSigner, sendSpy } = makeV10Adapter(undefined, 1n);

    await (a as any).ensureV10ApproveTrac(
      signer,
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC',
    );

    expect(sendSpy.calls).toEqual([]);
    // Only the single gating read — the poll is gated on `force`.
    expect(tokenWithSigner.allowance.calls).toHaveLength(1);
  });

  it('forced re-approve polls until the fresh approve becomes visible on the RPC read path', async () => {
    const { a, signer, tokenWithSigner, sendSpy } = makeV10AdapterWithAllowanceSequence([
      0n, // gating read → needsApprove
      0n, // poll read 1 → approve not yet propagated to the read replica
      1n, // poll read 2 → now visible
    ]);

    await (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'forced', true);

    expect(sendSpy.calls).toHaveLength(1); // exactly one approve
    expect(tokenWithSigner.allowance.calls).toHaveLength(3); // gating + 2 polls
  });

  it('forced re-approve is best-effort: gives up after the bounded poll budget without throwing', async () => {
    const { a, signer, tokenWithSigner, sendSpy } = makeV10AdapterWithAllowanceSequence([0n]); // never visible

    await expect(
      (a as any).ensureV10ApproveTrac(signer, V10_KA_ADDRESS, 0n, 'forced', true),
    ).resolves.toBeUndefined();

    expect(sendSpy.calls).toHaveLength(1);
    // gating read + 6 bounded poll attempts. Proves the poll is bounded
    // (no hang); the caller's gas-estimation then surfaces a definitive
    // revert if the allowance genuinely never propagates.
    expect(tokenWithSigner.allowance.calls).toHaveLength(7);
  }, 15_000);

  // PR #896 review (🔴): each visibility-poll read must be bounded by a
  // timeout. A raw `token.allowance()` on a hung / read-stalled RPC never
  // rejects, so without `withTimeout` the supposedly-bounded recovery poll
  // could block publish/update indefinitely. Drive the whole loop under fake
  // timers and assert it resolves (does not hang) even when every read stalls
  // forever.
  it('bounds each visibility poll with a timeout so a hung RPC read cannot block the recovery (#896)', async () => {
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      // allowance() returns a promise that never settles — a hung RPC read.
      const token = connectable({ allowance: recorder(() => new Promise<bigint>(() => {})) });
      const done = recorder(() => undefined);
      const poll = (a as any)
        .confirmAllowanceVisible(token, '0xowner', V10_KA_ADDRESS, 1n)
        .then(done);
      // Advance past 6 × (4s read timeout) + the capped backoff sleeps.
      await vi.advanceTimersByTimeAsync(60_000);
      await poll;
      // Resolved rather than hanging, and each of the 6 bounded reads was
      // attempted (and timed out) instead of blocking on the first one.
      expect(done.calls).toHaveLength(1);
      expect(token.allowance.calls).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

// PR #896 review (🔴): the forced-re-approve recovery was inlined in the
// publish path only, leaving `updateV10` exposed to the same stale-allowance
// race on metadata-only updates. The recovery now lives in a shared helper
// (`populateAndSignV10WithAllowanceRecovery`) used by BOTH V10 write paths.
// These tests pin that shared behaviour directly.
function makeRecoveryAdapter() {
  const a = new EVMChainAdapter(minimalConfig());
  const ensureSpy = recorder(async (..._a: unknown[]) => {});
  const signSpy = recorder(async (..._a: unknown[]) => ({ signedTx: '0xsigned', txHash: '0xhash' }));
  (a as any).ensureV10ApproveTrac = ensureSpy;
  (a as any).signPopulatedTransaction = signSpy;
  return { a, ensureSpy, signSpy, signer: new ethers.Wallet(DEPLOYER_PK) };
}

const tooLowAllowanceRevert = () =>
  new Error('execution reverted: TooLowAllowance(0xTRAC, 0, 1)');

const rawTooLowAllowanceRevert = () => {
  const iface = new Interface([
    'error TooLowAllowance(address tokenAddress, uint256 allowance, uint256 expected)',
  ]);
  const err = new Error('execution reverted (unknown custom error)');
  (err as any).data = iface.encodeErrorResult('TooLowAllowance', [
    V10_KA_ADDRESS,
    0n,
    1n,
  ]);
  return err;
};

describe('populateAndSignV10WithAllowanceRecovery — shared publish/update recovery (#888/#896)', () => {

  it('applies 25% gas headroom to every concurrent V10 publish preparation', async () => {
    const { a } = makeRecoveryAdapter();
    const signerA = new ethers.Wallet(DEPLOYER_PK);
    const signerB = new ethers.Wallet(OTHER_PK);
    let inFlight = 0;
    let maxInFlight = 0;
    const populateAndSign = recorder(async (..._args: unknown[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { signedTx: '0xsigned', txHash: '0xhash' };
    });
    (a as any).populateAndSignAcrossProviders = populateAndSign;

    await Promise.all([
      (a as any).populateAndSignV10WithAllowanceRecovery(
        signerA, {}, 'publish', {}, V10_KA_ADDRESS, 1n, 'label A',
      ),
      (a as any).populateAndSignV10WithAllowanceRecovery(
        signerB, {}, 'publish', {}, V10_KA_ADDRESS, 1n, 'label B',
      ),
    ]);

    expect(populateAndSign.calls).toHaveLength(2);
    expect(maxInFlight).toBe(2);
    for (const call of populateAndSign.calls) {
      expect(call[4]).toBe('V10 publish');
      expect(call[5]).toEqual({ gasLimitBufferBps: 2_500 });
    }
  });

  it('applies the same 25% gas headroom to V10 update preparation', async () => {
    const { a, signer } = makeRecoveryAdapter();
    const populateAndSign = recorder(async (..._args: unknown[]) => (
      { signedTx: '0xsigned', txHash: '0xhash' }
    ));
    (a as any).populateAndSignAcrossProviders = populateAndSign;

    await (a as any).populateAndSignV10WithAllowanceRecovery(
      signer, {}, 'update', {}, V10_KA_ADDRESS, 1n, 'label',
    );

    expect(populateAndSign.calls).toHaveLength(1);
    expect(populateAndSign.calls[0][4]).toBe('V10 update');
    expect(populateAndSign.calls[0][5]).toEqual({ gasLimitBufferBps: 2_500 });
  });

  // The 🔴 fix: BOTH write paths recover from a pre-broadcast
  // `TooLowAllowance` revert, not just publish.
  it.each(['publish', 'update'] as const)(
    'forces a fresh approve and retries populate+sign exactly once on a stale TooLowAllowance (%s)',
    async (method) => {
      const { a, ensureSpy, signSpy, signer } = makeRecoveryAdapter();
      // mockRejectedValueOnce → mockResolvedValueOnce chain as a shift()ed queue
      // (rejection modelled by throwing).
      const populateQueue: Array<() => Promise<{ to: string; data: string }>> = [
        async () => { throw tooLowAllowanceRevert(); },
        async () => ({ to: V10_KA_ADDRESS, data: '0xabcd' }),
      ];
      const populate = recorder(async () => (
        populateQueue.shift() ?? (async () => ({ to: V10_KA_ADDRESS, data: '0xabcd' }))
      )());
      const kaContract = connectable({ [method]: { populateTransaction: populate } });

      const result = await (a as any).populateAndSignV10WithAllowanceRecovery(
        signer,
        kaContract,
        method,
        { some: 'params' },
        V10_KA_ADDRESS,
        0n,
        `approve V10 ${method} TRAC (forced re-approve, #888)`,
      );

      expect(result).toEqual({ signedTx: '0xsigned', txHash: '0xhash' });
      expect(populate.calls).toHaveLength(2); // initial revert + one retry
      expect(signSpy.calls).toHaveLength(1);  // signed only after the retry
      // forced re-approve fired once, against the right KA + with force=true.
      expect(ensureSpy.calls).toHaveLength(1);
      expect(ensureSpy.calls[0][0]).toBe(signer);
      expect(ensureSpy.calls[0][1]).toBe(V10_KA_ADDRESS);
      expect(ensureSpy.calls[0][4]).toBe(true);
    },
  );

  it('enriches raw unknown-custom-error data before deciding whether to force re-approve', async () => {
    const { a, ensureSpy, signSpy, signer } = makeRecoveryAdapter();
    const populateQueue: Array<() => Promise<{ to: string; data: string }>> = [
      async () => { throw rawTooLowAllowanceRevert(); },
      async () => ({ to: V10_KA_ADDRESS, data: '0xabcd' }),
    ];
    const populate = recorder(async () => (
      populateQueue.shift() ?? (async () => ({ to: V10_KA_ADDRESS, data: '0xabcd' }))
    )());
    const kaContract = connectable({ publish: { populateTransaction: populate } });

    const result = await (a as any).populateAndSignV10WithAllowanceRecovery(
      signer,
      kaContract,
      'publish',
      {},
      V10_KA_ADDRESS,
      0n,
      'approve V10 publish TRAC (forced re-approve, #888)',
    );

    expect(result).toEqual({ signedTx: '0xsigned', txHash: '0xhash' });
    expect(populate.calls).toHaveLength(2);
    expect(signSpy.calls).toHaveLength(1);
    expect(ensureSpy.calls).toHaveLength(1);
    expect(ensureSpy.calls[0][4]).toBe(true);
  });

  it('propagates a SECOND consecutive TooLowAllowance (recovery is one-shot, no infinite loop)', async () => {
    const { a, ensureSpy, signSpy, signer } = makeRecoveryAdapter();
    const populate = recorder(async () => { throw tooLowAllowanceRevert(); });
    const kaContract = connectable({ publish: { populateTransaction: populate } });

    await expect(
      (a as any).populateAndSignV10WithAllowanceRecovery(
        signer, kaContract, 'publish', {}, V10_KA_ADDRESS, 0n, 'label',
      ),
    ).rejects.toThrow('TooLowAllowance');

    expect(populate.calls).toHaveLength(2); // initial + one forced retry, then give up
    expect(ensureSpy.calls).toHaveLength(1);
    expect(signSpy.calls).toEqual([]);
  });

  it('C6 (G-OBS1b): forces EXACTLY ONE approve across a provider-failover × TooLowAllowance interleaving (shared OUTER latch, not per-provider)', async () => {
    // The case a PER-PROVIDER latch would double-fire: the inner per-provider
    // populate loop fails over on provider #1's RETRYABLE 429, then provider #2
    // reverts TooLowAllowance (non-retryable → propagates to the OUTER recovery),
    // which fires ONE forced approve and re-runs the WHOLE inner loop (now
    // succeeds). The forcedReapprove latch lives at the recovery OUTER scope, so
    // it fires exactly once no matter how many endpoints the inner loop tried —
    // immediate failover introduces ZERO extra approve txs (INV-1 + G-OBS1b).
    const { a, ensureSpy, signSpy, signer } = makeRecoveryAdapter();
    (a as any).providers = [{}, {}]; // two endpoints so the inner loop fails over
    const r429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };
    let call = 0;
    const populate = recorder(async () => {
      call += 1;
      if (call === 1) throw r429();                   // provider[0], pass 1 → retryable → fail over
      if (call === 2) throw tooLowAllowanceRevert();  // provider[1], pass 1 → non-retryable → propagate
      return { to: V10_KA_ADDRESS, data: '0xabcd' };  // provider[0], pass 2 (post-approve) → succeeds
    });
    const kaContract = connectable({ publish: { populateTransaction: populate } });

    const result = await (a as any).populateAndSignV10WithAllowanceRecovery(
      signer, kaContract, 'publish', {}, V10_KA_ADDRESS, 0n, 'label',
    );

    expect(result).toEqual({ signedTx: '0xsigned', txHash: '0xhash' });
    expect(ensureSpy.calls).toHaveLength(1);  // EXACTLY ONE forced approve across the failover
    expect(ensureSpy.calls[0][4]).toBe(true); // force=true
    expect(signSpy.calls).toHaveLength(1);    // publish signed exactly once (INV-1)
    expect(populate.calls).toHaveLength(3);   // p0(429) → p1(TooLow) → [approve] → p0(ok)
  });

  it('OBS-1: a RETRYABLE populate failure fails over to the next provider and signs exactly once (no double-sign)', async () => {
    // Plain OBS-1 populate failover (no allowance recovery): provider #1's
    // populate is rate-limited, provider #2 populates fine → signed once on #2.
    const { a, ensureSpy, signSpy, signer } = makeRecoveryAdapter();
    (a as any).providers = [{}, {}];
    const r429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };
    let call = 0;
    const populate = recorder(async () => {
      call += 1;
      if (call === 1) throw r429();                  // provider[0] → fail over
      return { to: V10_KA_ADDRESS, data: '0xabcd' }; // provider[1] → populates
    });
    const kaContract = connectable({ publish: { populateTransaction: populate } });

    const result = await (a as any).populateAndSignV10WithAllowanceRecovery(
      signer, kaContract, 'publish', {}, V10_KA_ADDRESS, 0n, 'label',
    );

    expect(result).toEqual({ signedTx: '0xsigned', txHash: '0xhash' });
    expect(populate.calls).toHaveLength(2); // p0(429) → p1(ok)
    expect(signSpy.calls).toHaveLength(1);  // signed once, on the healthy provider
    expect(ensureSpy.calls).toEqual([]);    // no TooLowAllowance → no forced approve
  });

  it('waits and retries the full provider set when V10 preparation is temporarily rate limited', async () => {
    vi.useFakeTimers();
    try {
      const { a, ensureSpy, signer } = makeRecoveryAdapter();
      const r429 = () => {
        const error = new Error('all configured RPC endpoints returned 429');
        (error as any).status = 429;
        return error;
      };
      let call = 0;
      const populateAndSign = recorder(async () => {
        call += 1;
        if (call <= 2) throw r429();
        return { signedTx: '0xsigned', txHash: '0xhash' };
      });
      (a as any).populateAndSignAcrossProviders = populateAndSign;

      const pending = (a as any).populateAndSignV10WithAllowanceRecovery(
        signer, {}, 'publish', {}, V10_KA_ADDRESS, 1n, 'label',
      );
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual({ signedTx: '0xsigned', txHash: '0xhash' });
      expect(populateAndSign.calls).toHaveLength(3);
      expect(ensureSpy.calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enriches the SECOND raw TooLowAllowance before throwing the one-shot failure', async () => {
    const { a, ensureSpy, signSpy, signer } = makeRecoveryAdapter();
    const populate = recorder(async () => { throw rawTooLowAllowanceRevert(); });
    const kaContract = connectable({ publish: { populateTransaction: populate } });

    let thrown: any;
    try {
      await (a as any).populateAndSignV10WithAllowanceRecovery(
        signer, kaContract, 'publish', {}, V10_KA_ADDRESS, 0n, 'label',
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain('TooLowAllowance');
    expect(thrown.message).not.toContain('unknown custom error');
    expect(thrown.revert?.name).toBe('TooLowAllowance');
    expect(populate.calls).toHaveLength(2);
    expect(ensureSpy.calls).toHaveLength(1);
    expect(signSpy.calls).toEqual([]);
  });

  it('propagates an unrelated revert immediately without forcing a re-approve', async () => {
    const { a, ensureSpy, signSpy, signer } = makeRecoveryAdapter();
    const populate = recorder(async () => { throw new Error('execution reverted: NotBatchPublisher()'); });
    const kaContract = connectable({ update: { populateTransaction: populate } });

    await expect(
      (a as any).populateAndSignV10WithAllowanceRecovery(
        signer, kaContract, 'update', {}, V10_KA_ADDRESS, 0n, 'label',
      ),
    ).rejects.toThrow('NotBatchPublisher');

    expect(populate.calls).toHaveLength(1); // no retry on a non-allowance error
    expect(ensureSpy.calls).toEqual([]);
    expect(signSpy.calls).toEqual([]);
  });
});

// PR #2300 r1 — the granular `getFinalizedAccountNonce` was deleted; the finalized-tag pinning
// its rows proved now lives in `readFinalizedChainProofSnapshot`, whose rows
// (finalized-chain-proof-snapshot.unit.test.ts) pin both reads to the finalized block NUMBER.

/**
 * GH#2270 PR-3 r2 — the pre-broadcast signal must come from the REAL signing path.
 *
 * The recovery lane releases a held job for a re-run when its recorded nonce is proven consumed,
 * so a nonce that was never the one actually signed is worse than no nonce at all. Every other row
 * in this chain hands the recorder a signal it made up; these two sign a real transaction with a
 * known nonce and assert that production code extracts that exact `{txHash, nonce}` and hands it
 * to `onBeforeBroadcast` before anything is sent.
 */
describe('pre-broadcast signal comes from the signed transaction [GH#2270]', () => {
  const SIGNER_PK = '0x' + '7'.repeat(63) + '1';
  const KNOWN_NONCE = 27;

  it('delivers the signed tx hash AND its nonce, extracted by production code', async () => {
    const a: any = new EVMChainAdapter(minimalConfig());
    a.initialized = true;
    a.init = async () => {};
    const wallet = new ethers.Wallet(SIGNER_PK);

    // Drive the PRODUCTION signer. `signPopulatedTransaction` is where the one decode of the
    // signed bytes happens, so the hash and the nonce this row asserts on are both produced by
    // the code under test — nothing is handed in. A stub provider is enough because every field
    // is prefilled; ethers only needs it to exist.
    const signed = await a.signPopulatedTransaction(wallet.connect({
      getNetwork: async () => ({ chainId: 31337n, name: 'stub' }),
      estimateGas: async () => 21_000n,
      getTransactionCount: async () => KNOWN_NONCE,
      getFeeData: async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
      resolveName: async (n: string) => n,
      _isProvider: true,
    } as never), {
      to: '0x0000000000000000000000000000000000000002',
      value: 0n,
      nonce: KNOWN_NONCE,
      gasLimit: 21_000n,
      chainId: 31337,
      type: 2,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const { signedTx, txHash } = signed;
    // Independent decode of the same bytes, so the row cannot pass on values the adapter merely
    // echoed back to itself.
    const decoded = ethers.Transaction.from(signedTx);
    expect(decoded.nonce).toBe(KNOWN_NONCE);
    expect(txHash).toBe(decoded.hash);
    expect(signed.nonce).toBe(KNOWN_NONCE);

    const received: any[] = [];
    let sentAfterSignal = false;
    a.broadcastSignedTransactionWithRetries = async () => {
      sentAfterSignal = received.length === 1;
    };
    a.waitForReceiptWithFailover = async () => ({
      hash: txHash, blockNumber: 1, status: 1, logs: [],
    });

    await a.dispatchSerializedV10Write(
      wallet,
      'publish',
      async (signal: any) => { received.push(signal); },
      async () => signed,
      () => { throw new Error('unreachable'); },
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ txHash, nonce: KNOWN_NONCE });
    // ...and it arrived BEFORE the send, which is what makes it a write-ahead.
    expect(sentAfterSignal).toBe(true);
  });

  it('aborts the send when the signal handler throws', async () => {
    // Fail-closed: a caller that could not persist the signal must not end up with a transaction
    // on the wire it does not know about.
    const a: any = new EVMChainAdapter(minimalConfig());
    a.initialized = true;
    a.init = async () => {};
    const wallet = new ethers.Wallet(SIGNER_PK);
    const signedTx = await wallet.signTransaction({
      to: '0x0000000000000000000000000000000000000002',
      value: 0n,
      nonce: KNOWN_NONCE,
      gasLimit: 21_000n,
      chainId: 31337,
      type: 2,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const txHash = ethers.Transaction.from(signedTx).hash!;

    let sent = false;
    a.broadcastSignedTransactionWithRetries = async () => { sent = true; };
    a.waitForReceiptWithFailover = async () => ({ hash: txHash });

    await expect(a.dispatchSerializedV10Write(
      wallet,
      'publish',
      async () => { throw new Error('could not persist the write-ahead'); },
      async () => ({ signedTx, txHash }),
      () => { throw new Error('unreachable'); },
    )).rejects.toThrow(/chain:writeahead hook failed before publish broadcast/);

    expect(sent).toBe(false);
  });
});

// PR #2300 r1 — the public `isKnowledgeAssetMinted` was deleted; its classifier matrix (the one
// place allowed to answer `false`, with every ambiguity shape pinned to `null`) moved to
// finalized-chain-proof-snapshot.unit.test.ts, where it now classifies the snapshot's `kaMinted`
// half at the pinned block — with the one deliberate change that TRANSPORT shapes no longer
// classify at all: they fail the whole pinned snapshot over to the next endpoint.
