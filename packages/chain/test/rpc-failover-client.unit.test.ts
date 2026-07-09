// SPDX-License-Identifier: Apache-2.0
/**
 * `RpcFailoverClient` — direct unit coverage of the pure per-endpoint transport
 * mechanism extracted from `EVMChainAdapterBase` (#1336). Constructs the module
 * DIRECTLY (PLAN §0 D1: two injected capabilities — a `getEndpoints` thunk
 * returning `{ provider, rpcUrl }[]` + a `signPopulated` callback) with
 * hand-made provider/contract/signer doubles
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
  type StickinessOptions,
} from '../src/rpc-failover-client.js';
import {
  RPC_READ_STALL_TIMEOUT_MS,
  RPC_LOG_SCAN_TIMEOUT_MS,
  RPC_BROADCAST_ATTEMPT_TIMEOUT_MS,
  RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
  RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS,
} from '../src/evm-adapter-constants.js';
import { _resetRpcFailoverStatsForTest, getRpcFailoverStats } from '../src/rpc-failover-log.js';

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

/** Construct the module under test over bare doubles (PLAN §0 D1 thunks).
 *  `stickiness` (Mechanism B) is optional — omitted, the client uses production
 *  defaults (stickiness on unless `DKG_DISABLE_RPC_STICKINESS=1`, `Date.now`
 *  clock, 30s TTL); the stickiness suite injects `{ enabled, now, ttlMs }`. */
function makeClient(
  providers: unknown[],
  rpcUrls: string[],
  signPopulated: SignPopulatedFn = NEVER_SIGN,
  stickiness?: StickinessOptions,
): RpcFailoverClient {
  return new RpcFailoverClient(
    () => providers.map((p, i) => ({ provider: p as any, rpcUrl: rpcUrls[i] })),
    signPopulated,
    () => 'evm:31337',
    undefined,
    stickiness,
  );
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

  it('watchdog policies cap single-RPC attempts with the matching point/log deadline', () => {
    expect(resolveCapMs('watchdogPointRead', 1)).toBe(RPC_READ_STALL_TIMEOUT_MS);
    expect(resolveCapMs('watchdogPointRead', 2)).toBe(RPC_READ_STALL_TIMEOUT_MS);
    expect(resolveCapMs('watchdogWideLogScan', 1)).toBe(RPC_LOG_SCAN_TIMEOUT_MS);
    expect(resolveCapMs('watchdogWideLogScan', 2)).toBe(RPC_LOG_SCAN_TIMEOUT_MS);
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

  it('read SINGLE-RPC watchdogPointRead caps background watcher reads', async () => {
    vi.useFakeTimers();
    const slow = recorder(() => new Promise<string>((r) => { setTimeout(() => r('ONLY'), 5_000); }));
    const client = makeClient([{ read: slow }], ['https://only.example']);

    const settled = client.read('watcher point read', (pr: any) => pr.read(), { policy: 'watchdogPointRead' })
      .then((r: unknown) => r, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS + 1_500);

    const outcome: any = await settled;
    expect(outcome.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(slow.calls).toHaveLength(1);
  });

  it('readContract SINGLE-RPC watchdogPointRead caps background watcher views', async () => {
    vi.useFakeTimers();
    const slowView = recorder(() => new Promise<string>((r) => { setTimeout(() => r('ONLY'), 5_000); }));
    const contract = { connect: () => ({ view: slowView }) } as any;
    const client = makeClient([{}], ['https://only.example']);

    const settled = client.readContract(
      'watcher view',
      contract,
      (c: any) => c.view(),
      { policy: 'watchdogPointRead' },
    ).then((r: unknown) => r, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS + 1_500);

    const outcome: any = await settled;
    expect(outcome.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
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
    expect(thrown.message).not.toContain('https://'); // host-only, symmetric with broadcast/populateAndSign
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

// ── write-path per-attempt timeout (C6 regression: HUNG provider) ─────────────
// The write loops cap each attempt with a FIXED-constant `withTimeout` (NOT the
// policy-driven read matrix; these caps apply on BOTH single- and multi-RPC): a
// HUNG backend must ABORT at the cap (→ a retryable RPC_TIMEOUT) and fail over /
// exhaust, never hang the publish path. The other write tests above only drive
// IMMEDIATE rejections (429), so without these a regression that dropped or
// miswired a write deadline would stall against a stalled RPC while the suite
// stayed green. Fake timers throughout — no real 10s/5s sleeps; the hung provider
// is a never-settling promise.
describe('RpcFailoverClient — write-path per-attempt timeout (hung provider, fixed caps, C6)', () => {
  afterEach(() => { vi.useRealTimers(); });

  const hung = <T>() => recorder(() => new Promise<T>(() => {})); // never settles
  // Minimal signer double: `.connect(p)` yields a per-provider signer carrying the
  // same address (a reconnected Wallet) — enough for populateAndSign to sign.
  const SIGNER_ADDR = '0x' + 'ef'.repeat(20);
  const makeSigner = () => ({ address: SIGNER_ADDR, connect: () => ({ address: SIGNER_ADDR }) }) as any;

  it('broadcast: a HUNG primary aborts at RPC_BROADCAST_ATTEMPT_TIMEOUT_MS and fails over to a healthy backup', async () => {
    vi.useFakeTimers();
    const primary = { broadcastTransaction: hung<void>() };
    const backup = { broadcastTransaction: recorder(async () => undefined) };
    const client = makeClient([primary, backup], URLS);

    const p = client.broadcast('0xsigned', '0xhash', 'unit write');
    await vi.advanceTimersByTimeAsync(RPC_BROADCAST_ATTEMPT_TIMEOUT_MS + 1_000);
    await expect(p).resolves.toBeUndefined(); // backup broadcast succeeded after the primary aborted
    expect(primary.broadcastTransaction.calls).toHaveLength(1); // attempted once, then aborted at the cap
    expect(backup.broadcastTransaction.calls).toHaveLength(1); // failover happened
  });

  it('broadcast: a HUNG single-RPC aborts at the cap → RPC_ENDPOINTS_EXHAUSTED (does NOT hang)', async () => {
    vi.useFakeTimers();
    const only = { broadcastTransaction: hung<void>() };
    const client = makeClient([only], ['https://only.example']);

    const settled = client.broadcast('0xsigned', '0xhash', 'unit write').then(() => 'OK', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RPC_BROADCAST_ATTEMPT_TIMEOUT_MS + 1_000);
    const outcome: any = await settled;
    expect(outcome.code).toBe('RPC_ENDPOINTS_EXHAUSTED'); // the fixed cap fires even with one endpoint
    expect(only.broadcastTransaction.calls).toHaveLength(1);
  });

  it('getReceipt: a HUNG primary aborts at RPC_RECEIPT_ATTEMPT_TIMEOUT_MS and fails over, returning the backup receipt', async () => {
    vi.useFakeTimers();
    const receipt = { status: 1, hash: '0xhash' };
    const primary = { getTransactionReceipt: hung<unknown>() };
    const backup = { getTransactionReceipt: recorder(async () => receipt) };
    const client = makeClient([primary, backup], URLS);

    const p = client.getReceipt('0xhash');
    await vi.advanceTimersByTimeAsync(RPC_RECEIPT_ATTEMPT_TIMEOUT_MS + 1_000);
    await expect(p).resolves.toBe(receipt);
    expect(primary.getTransactionReceipt.calls).toHaveLength(1);
    expect(backup.getTransactionReceipt.calls).toHaveLength(1);
  });

  it('getReceipt: a HUNG single-RPC aborts at the cap → RPC_RECEIPT_LOOKUP_FAILED (distinct from exhaustion, does NOT hang)', async () => {
    vi.useFakeTimers();
    const only = { getTransactionReceipt: hung<unknown>() };
    const client = makeClient([only], ['https://only.example']);

    const settled = client.getReceipt('0xCAFE').then((r) => r, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RPC_RECEIPT_ATTEMPT_TIMEOUT_MS + 1_000);
    const outcome: any = await settled;
    expect(outcome.code).toBe('RPC_RECEIPT_LOOKUP_FAILED'); // a timed-out lookup is "transport down", not exhaustion
    expect(outcome.txHash).toBe('0xCAFE');
    expect(only.getTransactionReceipt.calls).toHaveLength(1);
  });

  it('populateAndSign: a HUNG populateTransaction aborts at RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS and fails over to sign on the backup', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const populateTransaction = recorder(() => {
      attempt += 1;
      return attempt === 1
        ? new Promise<any>(() => {})                    // primary hangs forever
        : Promise.resolve({ to: '0xTO', data: '0x' });  // backup populates
    });
    const contract = { connect: () => ({ doWrite: { populateTransaction } }) } as any;
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const client = makeClient([{}, {}], URLS, signPopulated as SignPopulatedFn);

    const p = client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'V10 publish');
    await vi.advanceTimersByTimeAsync(RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS + 1_000);
    await expect(p).resolves.toEqual({ signedTx: '0xS', txHash: '0xH' });
    expect(populateTransaction.calls).toHaveLength(2); // primary hung → timed out → backup populated
    expect(signPopulated.calls).toHaveLength(1); // signed exactly once, on the backup (single-sign invariant holds)
  });
});

// ── endpoint stickiness (Mechanism B, #1340 retry residual + #1337 fail-close) ─
// Prefer the last-good backend after a failover; re-probe the configured primary
// at most once per TTL; stay fully transparent on `skipPreferred` tip reads;
// clear on a primary success. The kill-switch (`enabled:false`) reproduces the
// pre-Mechanism-B index-0 behavior — the RED baseline these assertions are
// written against (AC-4 pins that equivalence). Deterministic: injected `now`
// (no fake timers) + bare recorder doubles, so we assert TRY-ORDER via call
// counts, not wall-clock.
describe('RpcFailoverClient — endpoint stickiness (Mechanism B)', () => {
  const STICKY_URLS = ['https://primary.example', 'https://backup.example'];

  // A read double: for call N, `fn(N)` returns a value to resolve, or an Error to throw.
  const readSeq = (fn: (n: number) => unknown) => {
    let n = 0;
    return recorder(async () => {
      n += 1;
      const out = fn(n);
      if (out instanceof Error) throw out;
      return out;
    });
  };

  it('AC-1: after a failover the NEXT read tries the last-good backend FIRST (primary not re-probed)', async () => {
    const primary = { read: readSeq(() => retryable429()) }; // always 429
    const backup = { read: readSeq(() => 'BACKUP') };        // always ok
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // op1: fail over → establish preferred=backup
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toHaveLength(1);

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // op2: backup FIRST
    expect(primary.read.calls).toHaveLength(1); // NOT re-probed (index-0 would make this 2)
    expect(backup.read.calls).toHaveLength(2);
  });

  it('AC-4: kill-switch (enabled:false) reproduces index-0 — op2 re-probes the primary every call', async () => {
    const primary = { read: readSeq(() => retryable429()) };
    const backup = { read: readSeq(() => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: false });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');
    expect(primary.read.calls).toHaveLength(2); // index-0: primary re-probed on BOTH ops (the pre-change baseline)
    expect(backup.read.calls).toHaveLength(2);
  });

  it('AC-2: a write that fails over primes the preferred → the following receipt lookup targets that backend', async () => {
    const receipt = { status: 1, hash: '0xhash' };
    const primary = {
      broadcastTransaction: recorder(async () => { throw retryable429(); }), // primary 429s
      getTransactionReceipt: recorder(async () => receipt),                   // primary WOULD answer...
    };
    const backup = {
      broadcastTransaction: recorder(async () => undefined),                  // backup broadcasts ok
      getTransactionReceipt: recorder(async () => receipt),                   // ...but backup is preferred first
    };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    await client.broadcast('0xsigned', '0xhash', 'w'); // primary 429 → backup ok → preferred := backup
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    expect(backup.broadcastTransaction.calls).toHaveLength(1);

    await expect(client.getReceipt('0xhash')).resolves.toBe(receipt);
    expect(backup.getTransactionReceipt.calls).toHaveLength(1);  // receipt looked up on the backup FIRST
    expect(primary.getTransactionReceipt.calls).toHaveLength(0); // primary not polled — read-your-write on ONE backend
  });

  it('AC-3: under a persistently degraded primary, the primary is re-probed at most ONCE per TTL (not every call)', async () => {
    let clock = 0;
    const primary = { read: readSeq(() => retryable429()) }; // stays down the whole test
    const backup = { read: readSeq(() => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true, ttlMs: 30_000, now: () => clock });

    clock = 0;      await client.read('r', (p: any) => p.read()); // op1: establish, arm due=30_000
    clock = 10_000; await client.read('r', (p: any) => p.read()); // within TTL → backup first
    clock = 20_000; await client.read('r', (p: any) => p.read()); // within TTL → backup first
    expect(primary.read.calls).toHaveLength(1); // only the op1 establish probe so far

    clock = 35_000; await client.read('r', (p: any) => p.read()); // past TTL → RE-PROBE primary, re-arm due=65_000
    expect(primary.read.calls).toHaveLength(2); // exactly one re-probe

    clock = 40_000; await client.read('r', (p: any) => p.read()); // within the new window → backup first
    clock = 50_000; await client.read('r', (p: any) => p.read()); // within the new window → backup first
    expect(primary.read.calls).toHaveLength(2); // STILL 2 — NOT re-probed every call (Finding-1 regression guard)

    clock = 66_000; await client.read('r', (p: any) => p.read()); // past the 2nd window → re-probe again
    expect(primary.read.calls).toHaveLength(3);
  });

  it('AC-3b: a primary re-probe that SUCCEEDS clears the preference (primary resumes)', async () => {
    let clock = 0;
    // primary: 429 on call 1 (establish), healthy from call 2 (the re-probe onward)
    const primary = { read: readSeq((n) => (n === 1 ? retryable429() : 'PRIMARY')) };
    const backup = { read: readSeq(() => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true, ttlMs: 30_000, now: () => clock });

    clock = 0;      expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');  // establish preferred=backup
    clock = 35_000; expect(await client.read('r', (p: any) => p.read())).toBe('PRIMARY'); // re-probe → primary ok → CLEAR
    clock = 36_000; expect(await client.read('r', (p: any) => p.read())).toBe('PRIMARY'); // preference cleared → canonical
    expect(primary.read.calls).toHaveLength(3); // op1 429 + re-probe + canonical-after-clear
    expect(backup.read.calls).toHaveLength(1);  // only the initial failover
  });

  it('AC-5: a single-RPC client never establishes a preferred (nothing to fail over to)', async () => {
    const only = { read: readSeq(() => 'ONLY') };
    const client = makeClient([only], ['https://only.example'], NEVER_SIGN, { enabled: true });

    await client.read('r', (p: any) => p.read());
    await client.read('r', (p: any) => p.read());
    expect(only.read.calls).toHaveLength(2);
    expect(getRpcFailoverStats().preferredEstablishments).toBe(0); // lone endpoint == primary → never sticks
  });

  it('AC-7: a skipPreferred read uses canonical order AND leaves the preference intact (transparent)', async () => {
    // primary: 429 on call 1 (establish backup), healthy afterwards
    const primary = { read: readSeq((n) => (n === 1 ? retryable429() : 'PRIMARY')) };
    const backup = { read: readSeq(() => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // op1: establish preferred=backup

    // op2 skipPreferred → canonical (primary first) AND must NOT clear the preference
    expect(await client.read('r', (p: any) => p.read(), { skipPreferred: true })).toBe('PRIMARY');

    // op3 (normal) → preference SURVIVED op2 → backup first
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');
    expect(primary.read.calls).toHaveLength(2); // op1 (429) + op2 (skipPreferred canonical). If op2 had CLEARED, op3 → 3.
    expect(backup.read.calls).toHaveLength(2);  // op1 + op3
  });

  it('AC-6: with a primed preferred, the reorder DOES happen yet the exhaustion error still reports rpcUrls in CANONICAL order', async () => {
    // A shared try-order log proves the reorder actually occurred (so the
    // canonical-rpcUrls assertion isn't vacuously true against a no-op reorder).
    const order: string[] = [];
    const primary = { read: recorder(async () => { order.push('primary'); throw retryable429(); }) };
    let backupN = 0;
    const backup = { read: recorder(async () => { order.push('backup'); backupN += 1; if (backupN === 1) return 'BACKUP'; throw retryable429(); }) };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // op1 canonical: primary 429 → backup ok → preferred=backup
    expect(order).toEqual(['primary', 'backup']);

    order.length = 0;
    let thrown: any;
    try { await client.read('r', (p: any) => p.read()); } catch (e) { thrown = e; }
    expect(order).toEqual(['backup', 'primary']); // op2 REORDERED: backup tried FIRST (the reorder genuinely happened)
    expect(thrown.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(thrown.rpcUrls).toEqual(STICKY_URLS); // ...yet rpcUrls stays CANONICAL [primary, backup], not [backup, primary]
  });

  it('AC-9: a primary reached as a FALLBACK (not tried first) does NOT clear the preference (cadence fix)', async () => {
    // primary: 429 on the op1 establish probe, healthy afterward — but only ever reached as a FALLBACK on op2.
    const primary = { read: readSeq((n) => (n === 1 ? retryable429() : 'PRIMARY')) };
    // backup: ok on op1 (establish), FAILS on op2 (forces the op to fall over to the primary), ok again after.
    const backup = { read: readSeq((n) => (n === 2 ? retryable429() : 'BACKUP')) };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');  // op1 canonical: establish preferred=backup

    // op2 preferred-first [backup, primary]: backup 429s → falls over to the primary as a FALLBACK (i=1, not first).
    // The primary answering ONE op must NOT clear the preference (it doesn't prove primary health).
    expect(await client.read('r', (p: any) => p.read())).toBe('PRIMARY');

    // op3: preference SURVIVED op2's fallback-primary success → backup tried FIRST again.
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP');
    expect(primary.read.calls).toHaveLength(2); // op1 establish (429) + op2 fallback. If op2 had CLEARED, op3 canonical → 3.
    expect(backup.read.calls).toHaveLength(3);  // op1 ok, op2 429, op3 ok
  });

  it('AC-10: a populateAndSign failover primes the preferred for the following read (the 4th loop establishes too)', async () => {
    const p0 = { read: recorder(async () => { throw retryable429(); }) };
    const p1 = { read: recorder(async () => 'BACKUP-READ') };
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const makeSigner = () => ({ address: '0x' + 'ab'.repeat(20), connect: (p: unknown) => ({ address: '0x' + 'ab'.repeat(20), boundTo: p }) }) as any;
    // populateTransaction 429s when the signer is bound to p0 (primary), succeeds on p1 (backup).
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => (s.boundTo === p0 ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' })) } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    await expect(client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'))
      .resolves.toEqual({ signedTx: '0xS', txHash: '0xH' }); // primary populate 429 → backup populates+signs → preferred=backup
    expect(getRpcFailoverStats().preferredEstablishments).toBe(1);

    // The subsequent read prefers the backup the write signed on → primary read NOT probed.
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP-READ');
    expect(p0.read.calls).toHaveLength(0);
    expect(p1.read.calls).toHaveLength(1);
  });

  it('AC-11: a null (not-yet-mined) receipt does NOT establish a preference', async () => {
    const primary = { getTransactionReceipt: recorder(async () => { throw retryable429(); }) };
    const backup = { getTransactionReceipt: recorder(async () => null) }; // responds, but no receipt yet
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    await expect(client.getReceipt('0xhash')).resolves.toBeNull();
    // A null tick has no single winning endpoint (both were visited; neither had
    // the receipt), so notePreferredOutcome must not fire → no preference established.
    // (A regression hoisting the note above the `if (receipt)` null-check would
    // establish a preference on whichever backend merely answered "not mined yet".)
    expect(getRpcFailoverStats().preferredEstablishments).toBe(0);
  });

  it('AC-12: if a live pool rebind drops the preferred endpoint, ordering falls back to canonical cleanly (idx<0)', async () => {
    let urls = [...STICKY_URLS];
    let providers: any[] = [{ read: readSeq(() => retryable429()) }, { read: readSeq(() => 'BACKUP') }];
    const client = new RpcFailoverClient(
      () => providers.map((p, i) => ({ provider: p as any, rpcUrl: urls[i] })),
      NEVER_SIGN,
      () => 'evm:31337',
      undefined,
      { enabled: true },
    );
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP'); // establish preferred = backup.example

    // Live pool rebind: a completely different endpoint set (the preferred url is gone).
    urls = ['https://new-primary.example', 'https://new-backup.example'];
    const np = recorder(async () => 'NEW-PRIMARY');
    const nb = recorder(async () => 'NEW-BACKUP');
    providers = [{ read: np }, { read: nb }];

    // preferred no longer present in canonical (idx<0) → clean fall-back to canonical → new-primary first.
    expect(await client.read('r', (p: any) => p.read())).toBe('NEW-PRIMARY');
    expect(np.calls).toHaveLength(1);
    expect(nb.calls).toHaveLength(0);
  });

  it('AC-8: establishing a preferred emits a host-only stickiness log + increments the counter', async () => {
    const primary = { read: readSeq(() => retryable429()) };
    const backup = { read: readSeq(() => 'BACKUP') };
    const client = makeClient([primary, backup], STICKY_URLS, NEVER_SIGN, { enabled: true });

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...a: unknown[]) => { warns.push(String(a[0])); }) as typeof console.warn;
    try {
      await client.read('r', (p: any) => p.read());
    } finally {
      console.warn = origWarn;
    }
    expect(getRpcFailoverStats().preferredEstablishments).toBe(1);
    expect(warns.some((w) => w.includes('stickiness') && w.includes('backup.example'))).toBe(true);
    expect(warns.every((w) => !w.includes('https://'))).toBe(true); // host-only — never a full URL
  });

  // --- nonce-staleness guard: a read-established preference must not steer a
  // nonce-critical populate to a possibly-lagging backend (otReviewAgent 🔴).
  const SIGNER_ADDR = '0x' + 'ab'.repeat(20);
  const makeSigner = () => ({ address: SIGNER_ADDR, connect: (p: unknown) => ({ address: SIGNER_ADDR, boundTo: p }) }) as any;

  it('AC-13: a READ-established preference does NOT steer a write populate (populate stays canonical/primary-first)', async () => {
    const p0 = { read: readSeq(() => retryable429()) };  // primary read 429s → establishes backup as READ preferred
    const p1 = { read: readSeq(() => 'BACKUP') };
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    // Both endpoints can populate; record which the signer was bound to.
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { populateOrder.push(s.boundTo === p0 ? 'primary' : 'backup'); return Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    expect(await client.read('r', (pr: any) => pr.read())).toBe('BACKUP'); // READ establishes preferred=backup (NOT populate-proven)

    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w');
    // The nonce-critical populate STARTED on the canonical primary (the authoritative
    // nonce source), NOT the read-preferred backup — so a lagging read-preferred
    // backend can never sign a stale nonce.
    expect(populateOrder).toEqual(['primary']);
  });

  it('AC-14: once a populate PROVES a backend (primary down for writes), subsequent writes stick to it (#1340, no per-write primary re-probe)', async () => {
    const p0 = {}; const p1 = {};
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    // primary populate always 429s (down for writes); backup populates ok.
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { const which = s.boundTo === p0 ? 'primary' : 'backup'; populateOrder.push(which); return which === 'primary' ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // write #1: canonical → primary 429 → backup → populate-proven
    expect(populateOrder).toEqual(['primary', 'backup']);

    populateOrder.length = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // write #2: populate-proven backend tried FIRST
    expect(populateOrder).toEqual(['backup']); // primary NOT re-probed — write stickiness preserved for #1340
  });

  it('AC-15: a write-proven backend that FAILS a later broadcast (primary takes over as fallback) is downgraded → the next populate re-derives from canonical (#A)', async () => {
    // primary broadcast OK, backup broadcast FAILS (so the tx moves to the primary
    // as a fallback); primary populate 429s, backup populate OK (so populate proves backup).
    const p0 = { broadcastTransaction: recorder(async () => undefined) };
    const p1 = { broadcastTransaction: recorder(async () => { throw retryable429(); }) };
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { const w = s.boundTo === p0 ? 'primary' : 'backup'; populateOrder.push(w); return w === 'primary' ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // populate proves backup (source=write)
    expect(populateOrder).toEqual(['primary', 'backup']);

    // Broadcast tx: preferred=backup → backup FAILS → primary broadcasts as a FALLBACK.
    await client.broadcast('0xsigned', '0xhash', 'w');
    expect(p1.broadcastTransaction.calls).toHaveLength(1); // backup tried first, failed
    expect(p0.broadcastTransaction.calls).toHaveLength(1); // primary took over

    populateOrder.length = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // next populate
    // The backup's nonce view is now suspect (it failed the write; the tx moved to
    // the primary), so the write-preference was downgraded → populate re-derives
    // from canonical (primary-first). Without the #A downgrade this would be ['backup'].
    expect(populateOrder).toEqual(['primary', 'backup']);
  });

  it('AC-16: a write-proven backend SURVIVES an intervening read on it — the next populate still sticks to it (#B)', async () => {
    const p0 = {};
    const p1 = { read: recorder(async () => 'BACKUP-READ') };
    const populateOrder: string[] = [];
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => { const w = s.boundTo === p0 ? 'primary' : 'backup'; populateOrder.push(w); return w === 'primary' ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' }); } } }) } as any;
    const client = makeClient([p0, p1], STICKY_URLS, signPopulated as SignPopulatedFn, { enabled: true });

    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // populate proves backup (source=write)
    expect(populateOrder).toEqual(['primary', 'backup']);

    // Intervening READ served by the same preferred backend — must NOT downgrade the write-proven flag.
    expect(await client.read('r', (p: any) => p.read())).toBe('BACKUP-READ');

    populateOrder.length = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // still write-proven → sticks to backup
    expect(populateOrder).toEqual(['backup']); // the read did NOT reset the write-proven source
  });
});
