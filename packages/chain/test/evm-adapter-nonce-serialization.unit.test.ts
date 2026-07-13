/**
 * Per-wallet nonce serialization for the two V10 write paths
 * (`publishToContextGraph`, `updateKnowledgeCollectionV10`) — both route
 * through the private `dispatchSerializedV10Write` seam.
 *
 * Regression guard for OriginTrail/dkg#953: the round-robin signer pool can
 * hand the SAME operational wallet to two concurrent writes; without
 * serialization both read the same `pending` nonce before either broadcasts,
 * so the second reverts "Nonce too low" and the publish degrades to a
 * tentative kaId:0. These tests drive the actual seam (private methods reached
 * via `as any`, the same convention the rest of evm-adapter.unit.test.ts uses)
 * so deleting the `signerTxSerializer.run(...)` wrap turns the suite red.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import {
  rpcBoundedPointReadExecutionBudgetMs,
  rpcBroadcastPassExecutionBudgetMs,
  rpcPopulateAndSignExecutionBudgetMs,
  rpcReceiptLookupPassExecutionBudgetMs,
} from '../src/rpc-failover-client.js';
import {
  RPC_ENDPOINT_SET_RETRIES,
  RPC_ENDPOINT_SET_RETRY_BACKOFF_MS,
  RPC_RECEIPT_POLL_INTERVAL_MS,
  RPC_RECEIPT_TIMEOUT_MS,
} from '../src/evm-adapter-constants.js';
import { connectable } from './connectable.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b63b91100';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    ...overrides,
  };
}

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const neverNull = (): never => {
  throw new Error('unexpected null receipt');
};
const fakeReceipt = (hash: string) =>
  ({ hash, blockNumber: 1, index: 0, status: 1, logs: [] }) as unknown as ethers.TransactionReceipt;
const V10_KA_ADDRESS = '0x' + 'aa'.repeat(20);

// Minimal V10 publish params that survive `createKnowledgeAssets`'s struct
// building so execution reaches the allowance-approve step.
function minimalPublishParams(): any {
  const author = '0x1111111111111111111111111111111111111111';
  // OT-RFC-43 Option-1 (variant 1a): the real `createKnowledgeAssets`
  // entrypoint requires a packed reservedKaId = (uint160(author) << 96) | number
  // in the author's namespace and throws (pre-tx) otherwise. The #953 wiring
  // test drives the real method, so supply a valid packed id so execution
  // reaches the allowance-approve step under test.
  const reservedKaId = (BigInt(ethers.getAddress(author)) << 96n) | 1n;
  return {
    publishOperationId: 'op-953-wiring',
    contextGraphId: 1n,
    merkleRoot: new Uint8Array(32),
    knowledgeAssetsAmount: 1,
    byteSize: 1n,
    epochs: 1,
    tokenAmount: 1n,
    isImmutable: false,
    merkleLeafCount: 1,
    reservedKaId,
    publisherNodeIdentityId: 1n,
    author: {
      address: author,
      signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      schemeVersion: 1,
    },
    ackSignatures: [],
  };
}

describe('dispatchSerializedV10Write — per-wallet nonce serialization (#953)', () => {
  it('keeps a queued adapter write alive through valid two-endpoint failover latency', async () => {
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig({
        rpcUrls: ['http://127.0.0.1:59998', 'http://127.0.0.1:59997'],
      }));
      const signer = new ethers.Wallet(DEPLOYER_PK);
      const operationBudgetMs = (a as any)
        .signerWriteExecutionBudgetMs('single-transaction') as number;
      const endpointCount = 2;
      const expectedOperationBudgetMs =
        rpcPopulateAndSignExecutionBudgetMs(endpointCount)
        + (RPC_ENDPOINT_SET_RETRIES + 1) * rpcBroadcastPassExecutionBudgetMs(endpointCount)
        + RPC_ENDPOINT_SET_RETRIES * RPC_ENDPOINT_SET_RETRY_BACKOFF_MS
        + RPC_RECEIPT_TIMEOUT_MS
        + rpcReceiptLookupPassExecutionBudgetMs(endpointCount)
        + RPC_RECEIPT_POLL_INTERVAL_MS;
      expect(operationBudgetMs).toBe(expectedOperationBudgetMs);

      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const first = (a as any).withSerializedSignerWrite(signer, async () => blocked);
      let secondStarted = false;
      let secondSettled = false;
      const second = (a as any).withSerializedSignerWrite(signer, async () => {
        secondStarted = true;
        return 'second';
      }).then(
        (value: string) => { secondSettled = true; return value; },
        (error: unknown) => { secondSettled = true; throw error; },
      );

      // Exercise the complete production budget, including the second
      // broadcast pass, its backoff, and the final receipt-lookup overrun. A
      // formula that omits the retry pass both fails the exact assertion above
      // and rejects this successor before this checkpoint.
      await vi.advanceTimersByTimeAsync(operationBudgetMs - 1);
      expect(secondStarted).toBe(false);
      expect(secondSettled).toBe(false);

      release();
      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBe('second');
      expect(secondStarted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives queued signer-lane budgets from the live RPC endpoint set', async () => {
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const signer = new ethers.Wallet(DEPLOYER_PK);
      const oneEndpointBudgetMs = (a as any)
        .signerWriteExecutionBudgetMs('single-transaction') as number;

      // RpcFailoverClient intentionally reads this pair through a live thunk.
      // Rebind to two endpoints after construction and prove admission uses the
      // same current width instead of the old constructor-time snapshot.
      (a as any).providers = [(a as any).providers[0], (a as any).providers[0]];
      (a as any).rpcUrls = [
        'http://127.0.0.1:59998',
        'http://127.0.0.1:59997',
      ];
      const twoEndpointBudgetMs = (a as any)
        .signerWriteExecutionBudgetMs('single-transaction') as number;
      expect(twoEndpointBudgetMs).toBeGreaterThan(oneEndpointBudgetMs);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = (a as any).withSerializedSignerWrite(signer, async () => gate);
      let secondStarted = false;
      let secondSettled = false;
      const second = (a as any).withSerializedSignerWrite(signer, async () => {
        secondStarted = true;
        return 'second';
      }).then(
        (value: string) => { secondSettled = true; return value; },
        (error: unknown) => { secondSettled = true; throw error; },
      );

      await vi.advanceTimersByTimeAsync(oneEndpointBudgetMs + 1);
      expect(secondStarted).toBe(false);
      expect(secondSettled).toBe(false);

      release();
      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBe('second');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a queued write alive through all bounded V10 allowance-recovery phases', async () => {
    vi.useFakeTimers();
    try {
      const a = new EVMChainAdapter(minimalConfig());
      const signer = new ethers.Wallet(DEPLOYER_PK);
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const transactionBudgetMs = (a as any)
        .signerWriteExecutionBudgetMs('single-transaction') as number;
      const v10BudgetMs = (a as any)
        .signerWriteExecutionBudgetMs('v10-allowance-recovery') as number;
      const failedPopulateBudgetMs = rpcPopulateAndSignExecutionBudgetMs(1);
      const allowanceReadBudgetMs = rpcBoundedPointReadExecutionBudgetMs(1);
      const allowanceVisibilityBudgetMs = 6 * allowanceReadBudgetMs
        + [250, 500, 750, 1000, 1250].reduce((total, value) => total + value, 0);
      const oldBudgetWithoutAllowancePhases = 3 * transactionBudgetMs + failedPopulateBudgetMs;
      expect(v10BudgetMs).toBe(
        oldBudgetWithoutAllowancePhases
        + 2 * allowanceReadBudgetMs
        + allowanceVisibilityBudgetMs,
      );

      const tokenWithSigner = connectable({});
      (a as any).contracts.token = { connect: recorder(() => tokenWithSigner) };
      const allowanceReads = recorder(async () => {
        await delay(allowanceReadBudgetMs);
        return 0n;
      });
      (a as any).readContractWith = allowanceReads;
      const confirmAllowanceVisible = recorder(async () => {
        await delay(allowanceVisibilityBudgetMs - 1);
      });
      (a as any).confirmAllowanceVisible = confirmAllowanceVisible;

      // Initial approve and forced re-approve each legitimately consume one
      // complete transaction envelope while the serializer lane is held.
      const approvalSends = recorder(async () => {
        await delay(transactionBudgetMs);
        return fakeReceipt('approve');
      });
      (a as any).sendContractTransactionUnlocked = approvalSends;

      let populateCalls = 0;
      (a as any).populateAndSignAcrossProviders = recorder(async () => {
        populateCalls += 1;
        if (populateCalls === 1) {
          await delay(failedPopulateBudgetMs);
          throw Object.assign(new Error('execution reverted'), {
            revert: { name: 'TooLowAllowance' },
          });
        }
        return { signedTx: 'first', txHash: '0xfirst' };
      });

      let secondBuilt = false;
      (a as any).sendSignedTransactionAndWait = async (signedTx: string) => {
        if (signedTx === 'first') await delay(transactionBudgetMs);
        return fakeReceipt(signedTx);
      };

      const first = (a as any).dispatchSerializedV10Write(
        signer,
        'publish',
        undefined,
        async (ctx: any) => {
          await (a as any).ensureV10ApproveTrac(
            signer,
            V10_KA_ADDRESS,
            1n,
            'initial V10 approve',
            false,
            ctx.sendContractTransaction,
          );
          return (a as any).populateAndSignV10WithAllowanceRecovery(
            signer,
            {} as any,
            'publish',
            {},
            V10_KA_ADDRESS,
            1n,
            'forced V10 re-approve',
            ctx.sendContractTransaction,
          );
        },
        neverNull,
      );
      let secondSettled = false;
      let secondError: unknown;
      const second = (a as any).dispatchSerializedV10Write(
        signer,
        'publish',
        undefined,
        async () => {
          secondBuilt = true;
          return { signedTx: 'second', txHash: '0xsecond' };
        },
        neverNull,
      ).then(
        (value: ethers.TransactionReceipt) => { secondSettled = true; return value; },
        (error: unknown) => {
          secondSettled = true;
          secondError = error;
          return undefined;
        },
      );

      // One millisecond before the complete bound, the predecessor is still
      // validly finishing its final publish after two allowance reads and the
      // forced visibility poll. The queued write must remain admitted.
      await vi.advanceTimersByTimeAsync(v10BudgetMs - 2);
      expect(secondBuilt).toBe(false);
      expect(secondSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(first).resolves.toMatchObject({ hash: 'first' });
      await second;
      expect(secondError).toBeUndefined();
      expect(secondBuilt).toBe(true);
      expect(populateCalls).toBe(2);
      expect(approvalSends.calls).toHaveLength(2);
      expect(allowanceReads.calls).toHaveLength(2);
      expect(confirmAllowanceVisible.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes concurrent writes routed to the SAME wallet (no overlapping send windows)', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    const events: string[] = [];
    const build = (id: string) => async () => {
      events.push(`build:${id}`);
      await tick(10);
      return { signedTx: `tx-${id}`, txHash: `0x${id}` };
    };
    (a as any).sendSignedTransactionAndWait = recorder(async (signedTx: string) => {
      events.push(`send:${signedTx}`);
      await tick(10);
      events.push(`done:${signedTx}`);
      return fakeReceipt(signedTx);
    });

    await Promise.all([
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build('a'), neverNull),
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build('b'), neverNull),
    ]);

    // The entire build → send → done of 'a' must complete before 'b' starts.
    expect(events).toEqual([
      'build:a', 'send:tx-a', 'done:tx-a',
      'build:b', 'send:tx-b', 'done:tx-b',
    ]);
  });

  it('runs writes to DIFFERENT wallets concurrently', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const s1 = new ethers.Wallet(DEPLOYER_PK);
    const s2 = new ethers.Wallet(OTHER_PK);
    expect(s1.address).not.toBe(s2.address);
    const events: string[] = [];
    const build = (id: string) => async () => {
      events.push(`start:${id}`);
      await tick(20);
      events.push(`end:${id}`);
      return { signedTx: `tx-${id}`, txHash: `0x${id}` };
    };
    (a as any).sendSignedTransactionAndWait = recorder(async (signedTx: string) => fakeReceipt(signedTx));

    await Promise.all([
      (a as any).dispatchSerializedV10Write(s1, 'publish', undefined, build('a'), neverNull),
      (a as any).dispatchSerializedV10Write(s2, 'publish', undefined, build('b'), neverNull),
    ]);

    // Both builds started before EITHER finished → genuinely concurrent. A
    // global (single-key) serializer would produce start,end,start,end and
    // fail here — the end-event assertions are what give this test teeth.
    expect(events.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
    expect(events.slice(2).sort()).toEqual(['end:a', 'end:b']);
  });

  it('keeps the pending nonce monotonic for same-wallet writes (the #953 regression guard)', async () => {
    // Model the real chain: `buildSignedTx` reads the wallet's pending nonce,
    // `sendSignedTransactionAndWait` "broadcasts" it (the nonce must equal the
    // current pending count, then it increments). Without per-wallet
    // serialization, the three concurrent reads all see pending=0 and the
    // later broadcasts throw "Nonce too low" → Promise.all rejects.
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    let pending = 0;
    const build = () => async () => {
      const nonce = pending; // read pending
      await tick(5); // populate / sign gap
      return { signedTx: String(nonce), txHash: `0x${nonce}` };
    };
    (a as any).sendSignedTransactionAndWait = recorder(async (signedTx: string) => {
      const nonce = Number(signedTx);
      await tick(5);
      if (nonce !== pending) {
        throw new Error(`Nonce too low: expected ${pending} but got ${nonce}`);
      }
      pending += 1;
      return fakeReceipt(signedTx);
    });

    const receipts = await Promise.all([
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build(), neverNull),
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build(), neverNull),
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build(), neverNull),
    ]);

    expect(receipts.map((r) => r.hash)).toEqual(['0', '1', '2']);
    expect(pending).toBe(3);
  });

  it('serializes an approve-then-publish build so the approve nonce cannot race (#953, zero-allowance path)', async () => {
    // When allowance is insufficient each write first sends an `approve` tx on
    // the SAME wallet, then the publish tx — both consume nonces. The approve
    // now runs inside `buildSignedTx` (i.e. inside the per-wallet lock), so
    // this models the whole approve→publish sequence going through the seam.
    // Without serialization the two approves both read pending=0 and the
    // second throws "Nonce too low" before any publish happens.
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    let pending = 0;
    const consume = async (kind: string) => {
      const nonce = pending;
      await tick(5);
      if (nonce !== pending) {
        throw new Error(`Nonce too low (${kind}): expected ${pending} but got ${nonce}`);
      }
      pending += 1;
      return nonce;
    };
    const build = () => async () => {
      await consume('approve'); // the allowance approve tx
      const publishNonce = pending; // then read pending for the publish tx
      await tick(5);
      return { signedTx: String(publishNonce), txHash: `0x${publishNonce}` };
    };
    (a as any).sendSignedTransactionAndWait = recorder(async (signedTx: string) => {
      const nonce = Number(signedTx);
      await tick(5);
      if (nonce !== pending) {
        throw new Error(`Nonce too low (publish): expected ${pending} but got ${nonce}`);
      }
      pending += 1;
      return fakeReceipt(signedTx);
    });

    const receipts = await Promise.all([
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build(), neverNull),
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build(), neverNull),
    ]);

    // 2 writes × (approve, publish) → nonces 0,1,2,3; the publish nonces are 1 and 3.
    expect(receipts.map((r) => r.hash)).toEqual(['1', '3']);
    expect(pending).toBe(4);
  });

  it('createKnowledgeAssets runs the allowance approve INSIDE the per-wallet lock (#953 wiring guard)', async () => {
    // If the initial `ensureV10ApproveTrac` ran BEFORE entering the serializer
    // (as it did originally), concurrent same-wallet publishes would race on
    // the approve nonce. Prove the wiring: the serializer lock is entered
    // before the approve fires. If someone moves the approve back outside the
    // lock, `run` is never reached and this turns red.
    const a = new EVMChainAdapter(minimalConfig());
    (a as any).initialized = true;
    (a as any).contracts = {
      knowledgeAssetsLifecycle: {
        connect: () => ({
          getAddress: async () => '0x0000000000000000000000000000000000000005',
        }),
      },
    };
    const serializer = (a as any).signerTxSerializer;
    const origRun = serializer.run.bind(serializer);
    const runSpy = recorder((...args: unknown[]) => origRun(...args));
    serializer.run = runSpy;
    const SENTINEL = 'APPROVE_REACHED_INSIDE_LOCK';
    const ensureV10ApproveTrac = recorder(async () => {
      throw new Error(SENTINEL);
    });
    (a as any).ensureV10ApproveTrac = ensureV10ApproveTrac;

    await expect(a.createKnowledgeAssets(minimalPublishParams())).rejects.toThrow(SENTINEL);

    // The lock was entered (run called) AND the approve was reached from inside it.
    expect(runSpy.calls).toHaveLength(1);
    expect(ensureV10ApproveTrac.calls).toHaveLength(1);
  });

  it('publishToContextGraph (V9→V10 mirror) throws BEFORE any on-chain side effect (Option-1 §F2)', async () => {
    // The legacy mirror is unsupported under Option-1. The guard must fire before
    // acquiring a signer / approving TRAC / sending the publish tx — otherwise a
    // throw after the send leaves a partially-applied publish on-chain.
    const a = new EVMChainAdapter(minimalConfig());
    (a as any).initialized = true;
    (a as any).contracts = {
      knowledgeAssets: { getAddress: async () => '0x0000000000000000000000000000000000000009' },
      knowledgeAssetsStorage: {},
      token: {},
    };
    // Any side effect would have to go through one of these first.
    const signerSpy = recorder(async () => {
      throw new Error('SIGNER_ACQUIRED_BEFORE_GUARD');
    });
    (a as any).nextAuthorizedSigner = signerSpy;

    await expect(a.publishToContextGraph(minimalPublishParams())).rejects.toThrow(
      'not supported under OT-RFC-43 Option-1',
    );
    expect(signerSpy.calls).toEqual([]);
  });

  it('fails closed when the WAL onBroadcast hook throws — never broadcasts', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    const send = recorder(async () => fakeReceipt('0xsent'));
    (a as any).sendSignedTransactionAndWait = send;
    const onBroadcast = recorder(async () => {
      throw new Error('WAL disk full');
    });

    await expect(
      (a as any).dispatchSerializedV10Write(
        signer,
        'publish',
        onBroadcast,
        async () => ({ signedTx: 'tx', txHash: '0xpre' }),
        neverNull,
      ),
    ).rejects.toThrow('chain:writeahead hook failed before publish broadcast: WAL disk full');
    expect(send.calls).toEqual([]);
  });

  it('a failed write does not wedge the wallet — the next same-wallet write still runs', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    (a as any).sendSignedTransactionAndWait = recorder(async (signedTx: string) => {
      if (signedTx === 'boom') throw new Error('broadcast failed');
      return fakeReceipt(signedTx);
    });

    await expect(
      (a as any).dispatchSerializedV10Write(
        signer,
        'publish',
        undefined,
        async () => ({ signedTx: 'boom', txHash: '0x1' }),
        neverNull,
      ),
    ).rejects.toThrow('broadcast failed');

    const r = await (a as any).dispatchSerializedV10Write(
      signer,
      'publish',
      undefined,
      async () => ({ signedTx: 'ok', txHash: '0x2' }),
      neverNull,
    );
    expect(r.hash).toBe('ok');
  });

  it('invokes onNullReceipt with the pre-broadcast tx hash when the receipt is null', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    (a as any).sendSignedTransactionAndWait = recorder(async () => null);

    await expect(
      (a as any).dispatchSerializedV10Write(
        signer,
        'update',
        undefined,
        async () => ({ signedTx: 'tx', txHash: '0xPRE' }),
        (pre: string): never => {
          throw new Error(`null receipt for ${pre}`);
        },
      ),
    ).rejects.toThrow('null receipt for 0xPRE');
  });
});

describe('sendContractTransaction — universal per-wallet serialization (Phase 1: dkg#953 across tx types)', () => {
  it('serializes concurrent SAME-wallet standalone sends (RS/staking/PCA now hold the lock too)', async () => {
    // Before Phase 1 these calls hit `sendContractTransaction` raw — no lock —
    // so two same-wallet sends could read the same pending nonce. Now the
    // public wrapper acquires `signerTxSerializer.run(signer.address, ...)`.
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    const events: string[] = [];
    // Stub the unlocked leaf the wrapper delegates to (inside the lock).
    (a as any).sendContractTransactionUnlocked = recorder(async (_c: unknown, method: string) => {
      events.push(`start:${method}`);
      await tick(10);
      events.push(`end:${method}`);
      return fakeReceipt(method);
    });

    await Promise.all([
      (a as any).sendContractTransaction({}, 'createChallenge', [], signer, 'createChallenge'),
      (a as any).sendContractTransaction({}, 'submitProof', [], signer, 'submitProof'),
    ]);

    // No overlap: the first fully completes before the second starts.
    expect(events).toEqual([
      'start:createChallenge', 'end:createChallenge',
      'start:submitProof', 'end:submitProof',
    ]);
  });

  it('runs standalone sends on DIFFERENT wallets concurrently', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const s1 = new ethers.Wallet(DEPLOYER_PK);
    const s2 = new ethers.Wallet(OTHER_PK);
    expect(s1.address).not.toBe(s2.address);
    const events: string[] = [];
    (a as any).sendContractTransactionUnlocked = recorder(async (_c: unknown, method: string) => {
      events.push(`start:${method}`);
      await tick(20);
      events.push(`end:${method}`);
      return fakeReceipt(method);
    });

    await Promise.all([
      (a as any).sendContractTransaction({}, 'm1', [], s1, 'm1'),
      (a as any).sendContractTransaction({}, 'm2', [], s2, 'm2'),
    ]);

    // Both started before EITHER finished → genuinely concurrent (distinct
    // keys). A single global lock would produce start,end,start,end and fail.
    expect(events.slice(0, 2).sort()).toEqual(['start:m1', 'start:m2']);
    expect(events.slice(2).sort()).toEqual(['end:m1', 'end:m2']);
  });

  it('V10 approval uses the scoped in-lock sender and never re-enters the public serializer', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    const tokenWithSigner = connectable({
      allowance: recorder(async () => 0n),
      approve: recorder(() => undefined),
    });
    (a as any).contracts.token = {
      connect: recorder(() => tokenWithSigner),
    };
    (a as any).readContractWith = recorder(async () => 0n);
    const publicSend = recorder(async () => {
      throw new Error('public serializer re-entered');
    });
    const unlockedSend = recorder(async () => fakeReceipt('approve'));
    (a as any).sendContractTransaction = publicSend;
    (a as any).sendContractTransactionUnlocked = unlockedSend;
    (a as any).sendSignedTransactionAndWait = recorder(async (tx: string) => fakeReceipt(tx));

    await (a as any).dispatchSerializedV10Write(
      signer,
      'publish',
      undefined,
      async (ctx: any) => {
        await (a as any).ensureV10ApproveTrac(
          signer,
          V10_KA_ADDRESS,
          1n,
          'approve V10 publish TRAC',
          false,
          ctx.sendContractTransaction,
        );
        return { signedTx: 'publish', txHash: '0xpublish' };
      },
      neverNull,
    );

    expect(publicSend.calls).toEqual([]);
    expect(unlockedSend.calls).toHaveLength(1);
    expect(unlockedSend.calls[0].slice(1, 5)).toEqual([
      'approve',
      [V10_KA_ADDRESS, 1n],
      signer,
      'approve V10 publish TRAC',
    ]);
  });

  it('forced re-approve (#888) routes through the caller-scoped approvalSender, never the public serializer', async () => {
    // Pins the wiring `populateAndSignV10WithAllowanceRecovery` →
    // `ensureV10ApproveTrac(…, approvalSender)`: if the recovery path ever
    // fell back to the default `this.sendContractTransaction`, the in-lock
    // publish would re-enter the per-wallet serializer and self-deadlock.
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    const tokenWithSigner = connectable({});
    (a as any).contracts.token = { connect: recorder(() => tokenWithSigner) };
    // Stale-zero allowance read triggers the approve; the #888 post-approve
    // confirmation poll sees the target immediately (separate read path).
    (a as any).readContractWith = recorder(async () => 0n);
    (a as any).confirmAllowanceVisible = recorder(async () => undefined);
    const publicSend = recorder(async () => {
      throw new Error('public serializer re-entered');
    });
    (a as any).sendContractTransaction = publicSend;
    const scopedSend = recorder(async () => fakeReceipt('approve'));
    let populateCalls = 0;
    (a as any).populateAndSignAcrossProviders = recorder(async () => {
      populateCalls += 1;
      if (populateCalls === 1) {
        throw Object.assign(new Error('execution reverted'), { revert: { name: 'TooLowAllowance' } });
      }
      return { signedTx: 'pub', txHash: '0xpub' };
    });

    const result = await (a as any).populateAndSignV10WithAllowanceRecovery(
      signer,
      {} as any,
      'publish',
      {},
      V10_KA_ADDRESS,
      1n,
      'approve V10 publish TRAC (forced re-approve, #888)',
      scopedSend,
    );

    expect(result).toEqual({ signedTx: 'pub', txHash: '0xpub' });
    expect(populateCalls).toBe(2);
    expect(publicSend.calls).toEqual([]);
    expect(scopedSend.calls).toHaveLength(1);
    expect(scopedSend.calls[0].slice(1, 2)).toEqual(['approve']);
    expect(scopedSend.calls[0][3]).toBe(signer);
  });

  it('a publish (dispatchSerializedV10Write) and an RS-style send SERIALIZE on the same wallet (cross-type #953)', async () => {
    // The actual Phase-1 win: RS create/submit used to bypass the per-wallet
    // lock, so a publish rotated onto wallet #0 and a concurrent RS tx could
    // read the same pending nonce. Now BOTH funnel through the one
    // `signerTxSerializer` keyed by address → their send windows never interleave.
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    const events: string[] = [];
    (a as any).sendSignedTransactionAndWait = recorder(async (tx: string) => {
      events.push(`send:${tx}`);
      await tick(10);
      events.push(`done:${tx}`);
      return fakeReceipt(tx);
    });
    (a as any).sendContractTransactionUnlocked = recorder(async (_c: unknown, method: string) => {
      events.push(`rs-start:${method}`);
      await tick(10);
      events.push(`rs-end:${method}`);
      return fakeReceipt(method);
    });
    const publishBuild = async () => { await tick(2); return { signedTx: 'pub', txHash: '0xpub' }; };

    await Promise.all([
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, publishBuild, neverNull),
      (a as any).sendContractTransaction({}, 'submitProof', [], signer, 'submitProof'),
    ]);

    // Whichever wins the lock, its whole window completes before the other's
    // begins — no interleaving of the publish window and the RS window.
    const pubBlock = ['send:pub', 'done:pub'];
    const rsBlock = ['rs-start:submitProof', 'rs-end:submitProof'];
    const pubFirst = events[0] === 'send:pub';
    expect(events).toEqual(pubFirst ? [...pubBlock, ...rsBlock] : [...rsBlock, ...pubBlock]);
  });
});
