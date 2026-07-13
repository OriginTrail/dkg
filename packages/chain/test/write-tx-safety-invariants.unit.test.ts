// SPDX-License-Identifier: Apache-2.0
/**
 * Write-path TX-SAFETY invariants (TxSafetyReviewer's contract for the
 * immediate-failover change). The existing ~170 adapter failover tests inject
 * bare-object providers that bypass the real broadcast/receipt path — a FALSE
 * GREEN for tx-safety. These drive the REAL
 * `dispatchSerializedV10Write → sendSignedTransactionAndWait →
 * broadcastSignedTransactionWithFailover / waitForReceiptWithFailover` path
 * (the seam where the S2 set-retry will live), stubbing ONLY the providers'
 * `broadcastTransaction`/`getTransactionReceipt`, so the sign / WAL call-counts
 * are observable. This is the evm-adapter-nonce-serialization seam MINUS its
 * `sendSignedTransactionAndWait` mock, so the failover (and future set-retry) is
 * actually exercised.
 *
 * NOW (current write path): INV-1 single-sign across a broadcast-failover sweep,
 * INV-3 WAL-once + ordering, INV-4 broadcast idempotency, INV-5
 * reverted-receipt-no-resubmit + non-retryable-no-failover.
 *
 * STAGED (describe.skip → un-skip when ChainEngineer's S2 set-retry lands inside
 * sendSignedTransactionAndWait): INV-1/2/3 across the set-retry MULTI-PASS, INV-6
 * nonce/lock under set-retry. STAGED for S3 breaker: INV-8. The set-retry-multi
 * assertions (buildSignedTx==1 / onBroadcast==1 regardless of pass count) are the
 * headline regressions — they have teeth only once the set-retry exists.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import type { V10WriteAheadHookInfo } from '../src/chain-adapter.js';
import { RPC_ENDPOINT_SET_RETRIES, RPC_ENDPOINT_SET_RETRY_BACKOFF_MS } from '../src/evm-adapter-constants.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB = '0x0000000000000000000000000000000000000001';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'https://primary.example',
    rpcUrls: ['https://backup.example'],
    privateKey: PK,
    hubAddress: HUB,
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    staticNetwork: false,
    ...overrides,
  };
}

// The constructor builds REAL JsonRpcProviders over the (fake) URLs and wires
// error-listener network detection on them. We immediately destroy() those so
// no keep-alive socket / detection promise lingers ("Vite server not exiting" →
// intermittent CI exit 1), THEN the test overrides `this.providers` with stubs.
function freshAdapter(cfg: EVMAdapterConfig): EVMChainAdapter {
  const a = new EVMChainAdapter(cfg);
  try { a.destroy(); } catch { /* idempotent; never dialled */ }
  return a;
}

const SIGNED = '0xSIGNEDTX';
const TXHASH = '0x' + '11'.repeat(32);
const fakeReceipt = (status: number) =>
  ({ hash: TXHASH, blockNumber: 1, index: 0, status, logs: [] }) as unknown as ethers.TransactionReceipt;
const retryable429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };
const neverNull = (pre: string): never => { throw new Error(`unexpected null receipt for ${pre}`); };

function preparedOperation(
  buildSignedTx: () => Promise<{ signedTx: string; txHash: string }>,
) {
  return Object.freeze({
    runAllowanceGate: async () => undefined,
    populateAndSign: buildSignedTx,
  });
}

// Drive the REAL dispatch → send → broadcast/receipt path. `buildSignedTx` and
// `onBroadcast` are spied; only the providers are stubbed.
async function runDispatch(a: EVMChainAdapter, opts: {
  onBroadcast?: (info: V10WriteAheadHookInfo) => Promise<void> | void;
  buildSignedTx?: () => Promise<{ signedTx: string; txHash: string }>;
}) {
  const signer = new ethers.Wallet(PK);
  const buildSignedTx = opts.buildSignedTx ?? (async () => ({ signedTx: SIGNED, txHash: TXHASH }));
  return (a as any).dispatchSerializedV10Write(
    signer,
    'publish',
    opts.onBroadcast,
    preparedOperation(buildSignedTx),
    neverNull,
  );
}

describe('write-path tx-safety invariants (real dispatch/broadcast/receipt path)', () => {
  it('INV-1: signs EXACTLY once across a broadcast-failover sweep (#1 429 → #2 accepts)', async () => {
    const a = freshAdapter(minimalConfig());
    const buildSignedTx = recorder(async () => ({ signedTx: SIGNED, txHash: TXHASH }));
    const onBroadcast = recorder(async () => undefined);
    const primary = {
      broadcastTransaction: recorder(async () => { throw retryable429(); }),
      getTransactionReceipt: recorder(async () => null),
    };
    const backup = {
      broadcastTransaction: recorder(async () => ({ hash: TXHASH })),
      getTransactionReceipt: recorder(async () => fakeReceipt(1)),
    };
    (a as any).providers = [primary, backup];

    const receipt = await runDispatch(a, { onBroadcast, buildSignedTx });
    expect(receipt.status).toBe(1);
    // The signed tx is built ONCE even though broadcast failed over to #2.
    expect(buildSignedTx.calls).toHaveLength(1);
    expect(onBroadcast.calls).toHaveLength(1);
    // The SAME signed raw tx was handed to both endpoints (no re-sign).
    expect(primary.broadcastTransaction.calls).toEqual([[SIGNED]]);
    expect(backup.broadcastTransaction.calls).toEqual([[SIGNED]]);
  });

  it('INV-3: WAL onBroadcast fires exactly once and STRICTLY before any broadcast', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrls: [] })); // single endpoint, happy path
    const timeline: string[] = [];
    const onBroadcast = recorder(async () => { timeline.push('wal'); });
    const only = {
      broadcastTransaction: recorder(async () => { timeline.push('broadcast'); return { hash: TXHASH }; }),
      getTransactionReceipt: recorder(async () => fakeReceipt(1)),
    };
    (a as any).providers = [only];

    await runDispatch(a, { onBroadcast });
    expect(onBroadcast.calls).toHaveLength(1);
    expect(timeline[0]).toBe('wal');
    expect(timeline.indexOf('wal')).toBeLessThan(timeline.indexOf('broadcast'));
  });

  it('INV-4: broadcast idempotency — #1 transient error → #2 "already known" → success, single signed tx', async () => {
    const a = freshAdapter(minimalConfig());
    const buildSignedTx = recorder(async () => ({ signedTx: SIGNED, txHash: TXHASH }));
    const primary = {
      broadcastTransaction: recorder(async () => { throw retryable429(); }),
      getTransactionReceipt: recorder(async () => fakeReceipt(1)),
    };
    const backup = {
      broadcastTransaction: recorder(async () => { throw new Error('already known'); }),
      getTransactionReceipt: recorder(async () => fakeReceipt(1)),
    };
    (a as any).providers = [primary, backup];

    const receipt = await runDispatch(a, { buildSignedTx });
    expect(receipt.status).toBe(1);
    // "already known" on #2 is treated as accepted — no error surfaced.
    // Exactly one signed tx; the SAME raw tx hit both endpoints (no 2nd distinct tx).
    expect(buildSignedTx.calls).toHaveLength(1);
    expect(primary.broadcastTransaction.calls).toEqual([[SIGNED]]);
    expect(backup.broadcastTransaction.calls).toEqual([[SIGNED]]);
  });

  it('INV-5a: a mined REVERTED receipt (status=0) throws CALL_EXCEPTION with NO resubmit', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrls: [] }));
    const only = {
      broadcastTransaction: recorder(async () => ({ hash: TXHASH })),
      getTransactionReceipt: recorder(async () => fakeReceipt(0)), // mined, reverted
    };
    (a as any).providers = [only];

    await expect(runDispatch(a, {})).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
    // Broadcast happened once; the revert must NOT trigger a resubmit.
    expect(only.broadcastTransaction.calls).toHaveLength(1);
  });

  it('INV-5b: a non-retryable build/sign error throws BEFORE any broadcast or WAL checkpoint', async () => {
    const a = freshAdapter(minimalConfig());
    const onBroadcast = recorder(async () => undefined);
    const buildSignedTx = recorder(async () => {
      const e = new Error('insufficient funds for gas'); (e as any).code = 'INSUFFICIENT_FUNDS'; throw e;
    });
    const primary = {
      broadcastTransaction: recorder(async () => ({ hash: TXHASH })),
      getTransactionReceipt: recorder(async () => fakeReceipt(1)),
    };
    (a as any).providers = [primary];

    await expect(runDispatch(a, { onBroadcast, buildSignedTx })).rejects.toThrow(/insufficient funds/i);
    // Fails closed: no WAL checkpoint, no broadcast.
    expect(onBroadcast.calls).toEqual([]);
    expect(primary.broadcastTransaction.calls).toEqual([]);
  });
});

// S2 set-retry lives INSIDE sendSignedTransactionAndWait (base:1073), wrapping
// broadcastSignedTransactionWithFailover ONLY, up to RPC_ENDPOINT_SET_RETRIES
// extra full passes with a fixed RPC_ENDPOINT_SET_RETRY_BACKOFF_MS sleep between
// (a non-injectable const → fake timers). It re-broadcasts the SAME
// {signedTx,txHash}; the seam is signer-free so re-sign is structurally
// impossible (INV-2). These are the headline tx-safety regressions.
describe('write-path tx-safety invariants — set-retry MULTI-PASS (S2)', () => {
  // Spy broadcastSignedTransactionWithFailover (the PASS-count seam, per TxSafety:
  // raw provider.broadcastTransaction is called providers.length× PER pass) while
  // still running the real per-provider broadcast loop underneath.
  function spyBroadcastPasses(a: EVMChainAdapter) {
    const orig = (a as any).broadcastSignedTransactionWithFailover.bind(a);
    const spy = recorder((...args: unknown[]) => orig(...args));
    (a as any).broadcastSignedTransactionWithFailover = spy;
    return spy;
  }

  it('INV-1/2/3 + C3: all-exhaust set-retry — signs once / WAL once / re-broadcasts the SAME tx for setRetries+1 passes', async () => {
    vi.useFakeTimers();
    try {
      const a = freshAdapter(minimalConfig());
      const buildSignedTx = recorder(async () => ({ signedTx: SIGNED, txHash: TXHASH }));
      const onBroadcast = recorder(async () => undefined);
      const throttled = () => ({
        broadcastTransaction: recorder(async (_raw: string) => { throw retryable429(); }),
        getTransactionReceipt: recorder(async () => null),
      });
      const p0 = throttled(); const p1 = throttled();
      (a as any).providers = [p0, p1];
      const broadcastPasses = spyBroadcastPasses(a);

      const settled = runDispatch(a, { onBroadcast, buildSignedTx }).then(() => 'ok', (e) => e);
      await vi.advanceTimersByTimeAsync((RPC_ENDPOINT_SET_RETRIES + 1) * RPC_ENDPOINT_SET_RETRY_BACKOFF_MS + 50);
      const outcome: any = await settled;

      expect(outcome.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
      // PASS count = setRetries + 1 (one initial pass + the bounded retries).
      expect(broadcastPasses.calls).toHaveLength(RPC_ENDPOINT_SET_RETRIES + 1);
      expect(buildSignedTx.calls).toHaveLength(1); // INV-1/2: signed once across all passes
      expect(onBroadcast.calls).toHaveLength(1);   // INV-3: WAL fired once, never re-fired
      // C3 (idempotency root): every broadcast got the byte-identical SIGNED tx.
      const allRaw = [...p0.broadcastTransaction.calls, ...p1.broadcastTransaction.calls];
      expect(allRaw.length).toBeGreaterThan(1);
      expect(allRaw.every((c) => c[0] === SIGNED)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('INV-1/2: a later set-retry pass that succeeds yields the receipt with buildSignedTx still == 1', async () => {
    vi.useFakeTimers();
    try {
      const a = freshAdapter(minimalConfig());
      const buildSignedTx = recorder(async () => ({ signedTx: SIGNED, txHash: TXHASH }));
      const onBroadcast = recorder(async () => undefined);
      let attempt = 0; // shared across both providers: pass 0 = first 2 attempts (429), pass 1 accepts
      const provider = () => ({
        broadcastTransaction: recorder(async (_raw: string) => { attempt += 1; if (attempt <= 2) throw retryable429(); return { hash: TXHASH }; }),
        getTransactionReceipt: recorder(async () => fakeReceipt(1)),
      });
      (a as any).providers = [provider(), provider()];
      const broadcastPasses = spyBroadcastPasses(a);

      const settled = runDispatch(a, { onBroadcast, buildSignedTx }).then((r) => r, (e) => e);
      await vi.advanceTimersByTimeAsync((RPC_ENDPOINT_SET_RETRIES + 1) * RPC_ENDPOINT_SET_RETRY_BACKOFF_MS + 50);
      const receipt: any = await settled;

      expect(receipt.status).toBe(1);
      expect(broadcastPasses.calls).toHaveLength(2); // pass 0 (exhaust) + pass 1 (accept)
      expect(buildSignedTx.calls).toHaveLength(1);
      expect(onBroadcast.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('INV-5/C2: a mined REVERTED receipt does NOT trigger a set-retry re-broadcast (broadcast pass == 1)', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrls: [] }));
    const buildSignedTx = recorder(async () => ({ signedTx: SIGNED, txHash: TXHASH }));
    const only = {
      broadcastTransaction: recorder(async () => ({ hash: TXHASH })), // broadcast SUCCEEDS
      getTransactionReceipt: recorder(async () => fakeReceipt(0)),     // but mined REVERTED
    };
    (a as any).providers = [only];
    const broadcastPasses = spyBroadcastPasses(a);

    await expect(runDispatch(a, { buildSignedTx })).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
    // The set-retry wraps the BROADCAST phase only; the reverted receipt comes
    // from waitForReceiptWithFailover OUTSIDE the loop → broadcast fired ONCE,
    // no resubmit of a tx that already executed-and-reverted on chain.
    expect(broadcastPasses.calls).toHaveLength(1);
    expect(only.broadcastTransaction.calls).toHaveLength(1);
    expect(buildSignedTx.calls).toHaveLength(1);
  });

  it('INV-6: the per-wallet lock is HELD across set-retry passes — a concurrent same-wallet write cannot sign until the first resolves', async () => {
    vi.useFakeTimers();
    try {
      const a = freshAdapter(minimalConfig({ rpcUrls: [] }));
      const signer = new ethers.Wallet(PK);
      const events: string[] = [];
      let attempt = 0;
      const provider = {
        // Write-1: 429 on its first broadcast (forces a set-retry backoff), accepts next.
        broadcastTransaction: recorder(async () => { attempt += 1; if (attempt === 1) throw retryable429(); return { hash: TXHASH }; }),
        getTransactionReceipt: recorder(async () => fakeReceipt(1)),
      };
      (a as any).providers = [provider];
      const w1build = recorder(async () => { events.push('w1:build'); return { signedTx: SIGNED, txHash: TXHASH }; });
      const w2build = recorder(async () => { events.push('w2:build'); return { signedTx: '0xW2', txHash: '0x' + '22'.repeat(32) }; });

      const w1 = (a as any).dispatchSerializedV10Write(
        signer, 'publish', undefined, preparedOperation(w1build), neverNull,
      );
      const w2 = (a as any).dispatchSerializedV10Write(
        signer, 'publish', undefined, preparedOperation(w2build), neverNull,
      );

      // Park write-1 mid-backoff: it has built + 429'd + is sleeping. Write-2 must
      // NOT have started building (the per-wallet lock is held across the set-retry).
      await vi.advanceTimersByTimeAsync(RPC_ENDPOINT_SET_RETRY_BACKOFF_MS / 2);
      expect(w1build.calls).toHaveLength(1);
      expect(w2build.calls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(RPC_ENDPOINT_SET_RETRY_BACKOFF_MS + 50);
      await Promise.all([w1, w2]);
      // Strict end-to-end serialization survives the set-retry.
      expect(events).toEqual(['w1:build', 'w2:build']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skip('write-path tx-safety invariants — circuit breaker (S3, un-skip when breaker lands)', () => {
  it('INV-8: with all hosts cooling-down, a WRITE still broadcasts to ≥1 endpoint (no zero-attempt exhaustion)', async () => {
    // TODO(S3): mark every host cooling-down in the process-wide breaker, then a
    // write must still attempt ≥1 broadcast (eligible-set never empties to a
    // zero-attempt RPC_ENDPOINTS_EXHAUSTED).
    expect(true).toBe(true);
  });
});
