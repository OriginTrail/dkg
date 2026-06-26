// SPDX-License-Identifier: Apache-2.0
/**
 * `RpcFailoverClient` — direct unit coverage of the pure per-endpoint transport
 * mechanism extracted from `EVMChainAdapterBase` (#1336). Constructs the module
 * DIRECTLY (PLAN §0 D1: three injected capability thunks — `getProviders` /
 * `getRpcUrls` / `signPopulated`) with hand-made provider/contract/signer doubles
 * — no `as any` reach through protected adapter seams (the testability win the
 * issue asks for).
 *
 * This file is the PLAN §0 D9 assertion-PORT checklist. Its load-bearing focus is
 * the WRITE transport (`broadcast` / `getReceipt` / `populateAndSign`), whose
 * unit coverage has no other home once the loops leave the base, plus the
 * `resolveCapMs` policy matrix:
 *
 *   - resolveCapMs → the three policies × {single,multi} cap matrix (exhaustive).
 *   - read / readContract → the matrix APPLIED (multi caps + fails over, single
 *     uncapped) + the view BAD_DATA classifier (non-retryable, surfaces directly)
 *     + a custom-classifier override. (The detailed control-flow + observability
 *     scenarios live in readwithfailover-loop.unit.test.ts; here we pin the
 *     matrix application for both read and readContract.)
 *   - broadcast → the `isKnownTransactionError` idempotent short-circuit, the
 *     `RPC_ENDPOINTS_EXHAUSTED` code-stamp (#1329) with a HOST-ONLY message (never
 *     a full URL), and a non-retryable error propagating at once.
 *   - getReceipt → the `sawNonErrorResponse` / null path, and
 *     `RPC_RECEIPT_LOOKUP_FAILED` kept DISTINCT from `RPC_ENDPOINTS_EXHAUSTED`.
 *   - populateAndSign → the #870 signer-address propagation through the
 *     `signPopulated` callback, the retryable-estimate rethrow ONLY when more
 *     providers remain, and a decoded-revert (non-retryable) propagating at once.
 *
 * Bare-object doubles reject synchronously, so (like the sibling loop test) they
 * prove CONTROL FLOW, not the no-backoff immediacy property — that is covered
 * over REAL providers in multi-rpc-{read,write}-failover.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  RpcFailoverClient,
  resolveCapMs,
  type SignPopulatedFn,
} from '../src/rpc-failover-client.js';
import {
  RPC_READ_STALL_TIMEOUT_MS,
  RPC_LOG_SCAN_TIMEOUT_MS,
} from '../src/evm-adapter-constants.js';
import { _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

const retryable429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };
const callExceptionErr = (msg = 'execution reverted: TooLowAllowance') => {
  const e = new Error(msg); (e as any).code = 'CALL_EXCEPTION'; return e;
};
const badDataError = () => {
  const e: any = new Error('could not decode result data (value="0x", code=BAD_DATA)');
  e.code = 'BAD_DATA';
  return e;
};
const knownTxError = () => new Error('already known');

// A `signPopulated` stub the read/broadcast/receipt families never reach — wired
// to fail loudly if a non-signing path ever tried to sign.
const NEVER_SIGN: SignPopulatedFn = async () => {
  throw new Error('signPopulated must not be reached by this path');
};

/** Construct the module under test over bare doubles (PLAN §0 D1 thunks). */
function makeClient(
  providers: unknown[],
  rpcUrls: string[],
  signPopulated: SignPopulatedFn = NEVER_SIGN,
): RpcFailoverClient {
  return new RpcFailoverClient(() => providers as any, () => rpcUrls, signPopulated);
}

const URLS = ['https://primary.example', 'https://backup.example'];

afterEach(() => { _resetRpcFailoverStatsForTest(); });

// ── resolveCapMs — the named timeout-policy matrix (exhaustive 3×2) ──────────
describe('resolveCapMs — the named timeout-policy matrix (PLAN §3.2)', () => {
  it('pointRead: multi-RPC caps at RPC_READ_STALL_TIMEOUT_MS, single-RPC is uncapped (#894)', () => {
    expect(resolveCapMs('pointRead', 2)).toBe(RPC_READ_STALL_TIMEOUT_MS);
    expect(resolveCapMs('pointRead', 4)).toBe(RPC_READ_STALL_TIMEOUT_MS);
    expect(resolveCapMs('pointRead', 1)).toBeUndefined();
  });

  it('wideLogScan: multi-RPC caps at RPC_LOG_SCAN_TIMEOUT_MS, single-RPC is uncapped (#894)', () => {
    expect(resolveCapMs('wideLogScan', 2)).toBe(RPC_LOG_SCAN_TIMEOUT_MS);
    expect(resolveCapMs('wideLogScan', 1)).toBeUndefined();
  });

  it('failOpenFundingRead: caps EVERY attempt incl. single-RPC at RPC_READ_STALL_TIMEOUT_MS', () => {
    expect(resolveCapMs('failOpenFundingRead', 2)).toBe(RPC_READ_STALL_TIMEOUT_MS);
    expect(resolveCapMs('failOpenFundingRead', 1)).toBe(RPC_READ_STALL_TIMEOUT_MS);
  });
});

// ── read / readContract — the matrix APPLIED + view classifier ───────────────
describe('RpcFailoverClient.read / readContract — policy matrix applied + view classifier', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('read MULTI-RPC pointRead: an attempt over the 4s cap aborts and fails over', async () => {
    vi.useFakeTimers();
    const slow = recorder(() => new Promise<string>((r) => { setTimeout(() => r('PRIMARY'), 5_000); }));
    const fast = recorder(async () => 'BACKUP');
    const client = makeClient([{ read: slow }, { read: fast }], URLS);

    const p = client.read('point read', (pr: any) => pr.read()); // default pointRead
    await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS + 1_500);
    expect(await p).toBe('BACKUP');
    expect(slow.calls).toHaveLength(1);
    expect(fast.calls).toHaveLength(1);
  });

  it('readContract SINGLE-RPC pointRead: a >4s healthy read is uncapped and completes (#894)', async () => {
    vi.useFakeTimers();
    const slowView = recorder(() => new Promise<string>((r) => { setTimeout(() => r('ONLY'), 6_000); }));
    const contract = { connect: () => ({ view: slowView }) } as any;
    const client = makeClient([{}], ['https://only.example']);

    const p = client.readContract('view', contract, (c: any) => c.view()); // default pointRead, single → uncapped
    await vi.advanceTimersByTimeAsync(6_500);
    expect(await p).toBe('ONLY');
    expect(slowView.calls).toHaveLength(1);
  });

  it('readContract MULTI-RPC wideLogScan: a 5s read COMPLETES (the 30s cap, not the 4s point cap)', async () => {
    vi.useFakeTimers();
    const slowView = recorder(() => new Promise<string>((r) => { setTimeout(() => r('PRIMARY'), 5_000); }));
    const backupView = recorder(async () => 'BACKUP');
    const p0 = {}; const p1 = {};
    const contract = { connect: (p: unknown) => (p === p0 ? { view: slowView } : { view: backupView }) } as any;
    const client = makeClient([p0, p1], URLS);

    const p = client.readContract('log scan', contract, (c: any) => c.view(), { policy: 'wideLogScan' });
    await vi.advanceTimersByTimeAsync(6_000); // past 5s, under the 30s wideLogScan cap
    expect(await p).toBe('PRIMARY');
    expect(slowView.calls).toHaveLength(1);
    expect(backupView.calls).toEqual([]); // completed on the primary → no failover
  });

  it('readContract: a view BAD_DATA is NON-retryable → surfaces directly, no failover', async () => {
    const bad = badDataError();
    const p0 = {}; const p1 = {};
    const primaryView = recorder(async () => { throw bad; });
    const backupView = recorder(async () => 'BACKUP');
    const contract = { connect: (p: unknown) => (p === p0 ? { view: primaryView } : { view: backupView }) } as any;
    const client = makeClient([p0, p1], URLS);

    await expect(client.readContract('view', contract, (c: any) => c.view())).rejects.toBe(bad);
    expect(backupView.calls).toEqual([]); // deterministic decode → backup never consulted
  });

  it('readContract: a custom opts.isRetryable overrides the default (BAD_DATA → fails over to the backup view)', async () => {
    const p0 = {}; const p1 = {};
    const primaryView = recorder(async () => { throw badDataError(); });
    const backupView = recorder(async () => 'BACKUP');
    const contract = { connect: (p: unknown) => (p === p0 ? { view: primaryView } : { view: backupView }) } as any;
    const client = makeClient([p0, p1], URLS);

    await expect(
      client.readContract('view', contract, (c: any) => c.view(), { isRetryable: () => true }),
    ).resolves.toBe('BACKUP');
    expect(backupView.calls).toHaveLength(1);
  });
});

// ── broadcast (write transport) ──────────────────────────────────────────────
describe('RpcFailoverClient.broadcast — idempotent short-circuit + typed exhaustion', () => {
  it('an isKnownTransactionError is treated as SUCCESS (idempotent re-broadcast) — no failover', async () => {
    const primary = { broadcastTransaction: recorder(async () => { throw knownTxError(); }) };
    const backup = { broadcastTransaction: recorder(async () => undefined) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).resolves.toBeUndefined();
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    // "already known" = the byte-identical tx is already in the mempool → success.
    // The set-retry MUST NOT fail over to a second endpoint and re-submit.
    expect(backup.broadcastTransaction.calls).toEqual([]);
  });

  it('all endpoints exhausted → ChainRpcTransportError RPC_ENDPOINTS_EXHAUSTED with a HOST-ONLY message', async () => {
    const primary = { broadcastTransaction: recorder(async () => { throw retryable429(); }) };
    const backup = { broadcastTransaction: recorder(async () => { throw retryable429(); }) };
    const client = makeClient([primary, backup], URLS);

    let thrown: any;
    try { await client.broadcast('0xsigned', '0xDEADBEEF', 'unit write'); } catch (e) { thrown = e; }
    expect(thrown.code).toBe('RPC_ENDPOINTS_EXHAUSTED'); // #1329: maps to a retryable 503, not a code-less 500
    expect(thrown.rpcUrls).toEqual(URLS);
    expect(thrown.message).toContain('0xDEADBEEF'); // names the tx
    expect(thrown.message).not.toContain('https://'); // never a full URL
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    expect(backup.broadcastTransaction.calls).toHaveLength(1);
  });

  it('a non-retryable broadcast error propagates AT ONCE (backup untouched)', async () => {
    const err = callExceptionErr('nonce too high'); // deterministic, not a transient
    const primary = { broadcastTransaction: recorder(async () => { throw err; }) };
    const backup = { broadcastTransaction: recorder(async () => undefined) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).rejects.toBe(err);
    expect(backup.broadcastTransaction.calls).toEqual([]);
  });
});

// ── getReceipt (write transport) ─────────────────────────────────────────────
describe('RpcFailoverClient.getReceipt — sawNonErrorResponse/null vs RPC_RECEIPT_LOOKUP_FAILED', () => {
  it('returns the first non-null receipt a provider responds with', async () => {
    const receipt = { status: 1, hash: '0xhash' };
    const primary = { getTransactionReceipt: recorder(async () => receipt) };
    const backup = { getTransactionReceipt: recorder(async () => null) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.getReceipt('0xhash')).resolves.toBe(receipt);
    expect(backup.getTransactionReceipt.calls).toEqual([]); // found on the primary
  });

  it('a backend that RESPONDS with null (not yet mined) yields null — NOT an exhaustion — even after an earlier error', async () => {
    // primary errors (retryable), backup responds null. Because a provider
    // RESPONDED, sawNonErrorResponse suppresses RPC_RECEIPT_LOOKUP_FAILED: the
    // poll learns "no receipt yet", not "transport down".
    const primary = { getTransactionReceipt: recorder(async () => { throw retryable429(); }) };
    const backup = { getTransactionReceipt: recorder(async () => null) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.getReceipt('0xhash')).resolves.toBeNull();
    expect(primary.getTransactionReceipt.calls).toHaveLength(1);
    expect(backup.getTransactionReceipt.calls).toHaveLength(1);
  });

  it('all endpoints ERRORED → RPC_RECEIPT_LOOKUP_FAILED, DISTINCT from RPC_ENDPOINTS_EXHAUSTED', async () => {
    const primary = { getTransactionReceipt: recorder(async () => { throw retryable429(); }) };
    const backup = { getTransactionReceipt: recorder(async () => { throw retryable429(); }) };
    const client = makeClient([primary, backup], URLS);

    let thrown: any;
    try { await client.getReceipt('0xCAFE'); } catch (e) { thrown = e; }
    expect(thrown.code).toBe('RPC_RECEIPT_LOOKUP_FAILED');
    expect(thrown.code).not.toBe('RPC_ENDPOINTS_EXHAUSTED'); // the receipt poll must tell these apart
    expect(thrown.txHash).toBe('0xCAFE');
    expect(thrown.message).toContain('0xCAFE');
  });

  it('a non-retryable receipt error propagates AT ONCE (backup untouched)', async () => {
    const err = callExceptionErr('bad txhash');
    const primary = { getTransactionReceipt: recorder(async () => { throw err; }) };
    const backup = { getTransactionReceipt: recorder(async () => null) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.getReceipt('0xhash')).rejects.toBe(err);
    expect(backup.getTransactionReceipt.calls).toEqual([]);
  });
});

// ── populateAndSign (write transport) ────────────────────────────────────────
describe('RpcFailoverClient.populateAndSign — #870 signer propagation + estimate failover', () => {
  const SIGNER_ADDR = '0x' + 'cd'.repeat(20);
  // A signer double whose `.connect(provider)` returns a NEW object carrying the
  // SAME address (mirrors a Wallet reconnected to a provider, same key) + the
  // provider it was bound to — so we can prove BOTH propagations.
  const makeSigner = () => ({
    address: SIGNER_ADDR,
    connect: recorder((p: unknown) => ({ address: SIGNER_ADDR, boundTo: p })),
  }) as any;

  it('#870: the per-provider-reconnected signer (same address, bound to the active provider) is what signs', async () => {
    const populateTransaction = recorder(async () => ({ to: '0xTO', data: '0x' }));
    const contract = { connect: () => ({ doWrite: { populateTransaction } }) } as any;
    const signPopulated = recorder(async (_s: unknown, _pop: unknown) => ({ signedTx: '0xS', txHash: '0xH' }));
    const signer = makeSigner();
    const providerObj = {};
    const client = makeClient([providerObj], ['https://only.example'], signPopulated as SignPopulatedFn);

    await expect(client.populateAndSign(contract, 'doWrite', [42n], signer, 'V10 publish'))
      .resolves.toEqual({ signedTx: '0xS', txHash: '0xH' });
    expect(signer.connect.calls[0][0]).toBe(providerObj); // reconnected to providers[i]
    const passedSigner: any = signPopulated.calls[0][0];
    expect(passedSigner.address).toBe(SIGNER_ADDR); // signed by the right wallet (no mid-flight rotation)
    expect(passedSigner.boundTo).toBe(providerObj);  // bound to the active provider
  });

  it('a RETRYABLE gas-estimate error rethrows and FAILS OVER when another provider remains (buffer applied on the backup)', async () => {
    const populateTransaction = recorder(async () => ({ to: '0xTO', data: '0x' })); // no gasLimit → estimate runs
    let estAttempt = 0;
    const estimateGas = recorder(async () => {
      estAttempt += 1;
      if (estAttempt === 1) throw retryable429();
      return 21_000n;
    });
    const contract = { connect: () => ({ doWrite: { populateTransaction, estimateGas } }) } as any;
    const signPopulated = recorder(async (_s: unknown, pop: any) => ({ signedTx: '0xS', txHash: '0xH', g: pop.gasLimit }));
    const client = makeClient([{}, {}], URLS, signPopulated as SignPopulatedFn);

    const res = await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'V10 publish', { gasLimitBufferBps: 1_000 });
    expect(res).toMatchObject({ signedTx: '0xS', txHash: '0xH' });
    expect(estimateGas.calls).toHaveLength(2); // primary threw 429 → failed over → backup estimated
    expect(signPopulated.calls).toHaveLength(1); // signed exactly once (on the backup)
    const [, populated] = signPopulated.calls[0] as [unknown, any];
    expect(populated.gasLimit).toBe(23_100n); // 21000 * (10000+1000) / 10000 — buffer applied
  });

  it('on the LAST provider a retryable estimate error does NOT rethrow — falls back to an unbuffered sign (rethrow only if more providers)', async () => {
    const populateTransaction = recorder(async () => ({ to: '0xTO', data: '0x' }));
    const estimateGas = recorder(async () => { throw retryable429(); });
    const contract = { connect: () => ({ doWrite: { populateTransaction, estimateGas } }) } as any;
    const signPopulated = recorder(async (_s: unknown, _pop: unknown) => ({ signedTx: '0xS', txHash: '0xH' }));
    const client = makeClient([{}], ['https://only.example'], signPopulated as SignPopulatedFn); // SINGLE provider

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...a: unknown[]) => { warns.push(String(a[0])); }) as typeof console.warn;
    let res: any;
    try {
      res = await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'V10 publish', { gasLimitBufferBps: 1_000 });
    } finally {
      console.warn = origWarn;
    }
    expect(res).toEqual({ signedTx: '0xS', txHash: '0xH' }); // STILL signed (fell back, no rethrow)
    expect(estimateGas.calls).toHaveLength(1); // tried once on the only provider
    const [, populated] = signPopulated.calls[0] as [unknown, any];
    expect(populated.gasLimit).toBeUndefined(); // no buffer (fell back to ethers' own estimate at sign time)
    expect(warns.some((w) => w.includes('buffered gas estimation failed'))).toBe(true); // left a breadcrumb
  });

  it('a decoded revert (non-retryable) propagates AT ONCE — never signs, backup never prepared', async () => {
    const revert = callExceptionErr('execution reverted: TooLowAllowance');
    const populateTransaction = recorder(async () => { throw revert; });
    const contract = { connect: () => ({ doWrite: { populateTransaction } }) } as any;
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const client = makeClient([{}, {}], URLS, signPopulated as SignPopulatedFn);

    await expect(client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'V10 publish'))
      .rejects.toBe(revert); // the ORIGINAL revert, propagated to the latch owner — not masked as exhaustion
    expect(populateTransaction.calls).toHaveLength(1); // only the primary attempt; no failover
    expect(signPopulated.calls).toEqual([]); // never signed
  });

  it('all endpoints retryable-exhausted on preparation → RPC_ENDPOINTS_EXHAUSTED with a HOST-ONLY aggregate message', async () => {
    const populateTransaction = recorder(async () => { throw retryable429(); });
    const contract = { connect: () => ({ doWrite: { populateTransaction } }) } as any;
    const client = makeClient([{}, {}], URLS, NEVER_SIGN);

    let thrown: any;
    try { await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'V10 publish'); } catch (e) { thrown = e; }
    expect(thrown.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(thrown.rpcUrls).toEqual(URLS);
    expect(thrown.message).toContain('primary.example'); // host-only aggregate
    expect(thrown.message).not.toContain('https://');
  });
});
