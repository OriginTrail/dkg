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
 *   - resolveCapMs → the named policies × {single,multi} cap matrix (exhaustive).
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
  createRpcReadDescriptor,
  resolveCapMs,
  type SignPopulatedFn,
} from '../src/rpc-failover-client.js';
import {
  RPC_READ_STALL_TIMEOUT_MS,
  RPC_SECURITY_GATE_ATTEMPT_TIMEOUT_MS,
  RPC_LOG_SCAN_TIMEOUT_MS,
  RPC_BROADCAST_ATTEMPT_TIMEOUT_MS,
  RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
  RPC_TRANSACTION_POPULATION_ATTEMPT_TIMEOUT_MS,
} from '../src/evm-adapter-constants.js';
import { _resetRpcFailoverStatsForTest, getRpcFailoverStats } from '../src/rpc-failover-log.js';
import {
  classifyRpcRetryDisposition,
  isRpcEndpointFailoverEligible,
  isRetryableRpcError,
} from '../src/evm-adapter-rpc.js';
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';
import { ContextGraphAuthorityIndexBootstrapUnavailableError } from '../src/context-graph-authority-index-snapshot.js';
import { recorder, retryable429, NEVER_SIGN, makeClient } from './rpc-failover-test-helpers.js';

const callExceptionErr = (msg = 'execution reverted: TooLowAllowance') => {
  const e = new Error(msg); (e as any).code = 'CALL_EXCEPTION'; return e;
};
const badDataError = () => {
  const e: any = new Error('could not decode result data (value="0x", code=BAD_DATA)');
  e.code = 'BAD_DATA';
  return e;
};
const knownTxError = () => new Error('already known');
const abortedRpcError = () => {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
};
const abortedRpcCodeError = () => Object.assign(
  new Error('request aborted'),
  { code: 'ABORT_ERR' },
);

const URLS = ['https://primary.example', 'https://backup.example'];

afterEach(() => { _resetRpcFailoverStatsForTest(); });

describe('RPC retry disposition', () => {
  it('keeps core bootstrap failures retry-later even when causes mention network timeouts and 503', () => {
    const error = new ContextGraphAuthorityIndexBootstrapUnavailableError(new Error('network timeout 503'));
    expect(classifyRpcRetryDisposition(error)).toBe('retry-later');
    expect(isRetryableRpcError(error)).toBe(true);
    expect(isRpcEndpointFailoverEligible(error)).toBe(false);
  });
  it('keeps local saturation caller-retryable but excludes it from endpoint failover', () => {
    const queueFull = new RpcRequestGovernorQueueFullError(1);
    expect(classifyRpcRetryDisposition(queueFull)).toBe('retry-later');
    expect(isRetryableRpcError(queueFull)).toBe(true);
    expect(isRpcEndpointFailoverEligible(queueFull)).toBe(false);
    expect(classifyRpcRetryDisposition(retryable429())).toBe('failover');
    expect(classifyRpcRetryDisposition(callExceptionErr())).toBe('fail');
  });
});

// ── resolveCapMs — the named timeout-policy matrix ───────────────────────────
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

  it('durablePagedLogScan: aggregate provider attempts are uncapped', () => {
    expect(resolveCapMs('durablePagedLogScan', 1)).toBeUndefined();
    expect(resolveCapMs('durablePagedLogScan', 2)).toBeUndefined();
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

  it('securityGatePointRead: caps multi-RPC attempts below the outer gate but leaves single-RPC to it', () => {
    expect(resolveCapMs('securityGatePointRead', 2)).toBe(RPC_SECURITY_GATE_ATTEMPT_TIMEOUT_MS);
    expect(resolveCapMs('securityGatePointRead', 4)).toBe(RPC_SECURITY_GATE_ATTEMPT_TIMEOUT_MS);
    expect(resolveCapMs('securityGatePointRead', 1)).toBeUndefined();
  });
});

describe('RpcReadDescriptor — explicit read attribution ownership', () => {
  it('freezes the human label and consumer owner together', () => {
    const descriptor = createRpcReadDescriptor('human read label', 'stable.consumer');

    expect(descriptor).toEqual({ label: 'human read label', consumer: 'stable.consumer' });
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it('supports a deliberate unattributed read', () => {
    const descriptor = createRpcReadDescriptor('health probe', null);
    const provider = { read: recorder(async () => 'OK') };
    const client = makeClient([provider], ['https://health.example']);

    return expect(client.read(descriptor, (p: any) => p.read())).resolves.toBe('OK');
  });

  it('rejects a compatibility option that conflicts with the descriptor owner', () => {
    const descriptor = createRpcReadDescriptor('human read label', 'stable.consumer');
    const provider = { read: recorder(async () => 'OK') };
    const client = makeClient([provider], ['https://health.example']);

    expect(() => client.read(descriptor, (p: any) => p.read(), {
      rpcUsageConsumer: 'different.consumer',
    })).toThrow(/consumer conflict/);
  });
});

// ── read / readContract — the matrix APPLIED + view classifier ───────────────
describe('RpcFailoverClient.read / readContract — policy matrix applied + view classifier', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('successful read records the serving endpoint host', async () => {
    const primary = { read: recorder(async () => 'PRIMARY') };
    const client = makeClient([primary], ['https://served.example/key']);

    await expect(client.read('human read label', (p: any) => p.read())).resolves.toBe('PRIMARY');

    expect(getRpcFailoverStats().servedByEndpointHost).toEqual({ 'served.example': 1 });
  });

  it('read success logging is bucketed by chain, read policy, and preference mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const primary = { read: recorder(async () => 'PRIMARY') };
      const client = makeClient([primary], ['https://served.example/key']);

      await client.read('token.allowance', (p: any) => p.read());
      await client.read('hub.version', (p: any) => p.read());

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(getRpcFailoverStats().servedByEndpointHost).toEqual({ 'served.example': 2 });
    } finally {
      logSpy.mockRestore();
    }
  });

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

  it('readContract security gate fails over before its aborting 2.5s caller deadline', async () => {
    vi.useFakeTimers();
    const stalled = recorder(() => new Promise<string>(() => {}));
    const fast = recorder(async () => 'BACKUP');
    const p0 = {}; const p1 = {};
    const contract = {
      connect: (provider: unknown) => ({ view: provider === p0 ? stalled : fast }),
    } as any;
    const client = makeClient([p0, p1], URLS);
    const caller = new AbortController();
    setTimeout(() => caller.abort(new Error('security gate deadline')), 2_500);

    const result = client.readContract(
      'live authority gate',
      contract,
      (c: any) => c.view(),
      { policy: 'securityGatePointRead', signal: caller.signal },
    );
    await vi.advanceTimersByTimeAsync(RPC_SECURITY_GATE_ATTEMPT_TIMEOUT_MS + 10);

    await expect(result).resolves.toBe('BACKUP');
    expect(caller.signal.aborted).toBe(false);
    expect(stalled.calls).toHaveLength(1);
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

  it('read: an AbortError is a retryable transport interruption and fails over', async () => {
    const primary = { read: recorder(async () => { throw abortedRpcError(); }) };
    const backup = { read: recorder(async () => 'BACKUP') };
    const client = makeClient([primary, backup], URLS);

    await expect(client.read('aborted point read', (p: any) => p.read())).resolves.toBe('BACKUP');
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toHaveLength(1);
  });
});

// ── broadcast (write transport) ──────────────────────────────────────────────
describe('RpcFailoverClient.broadcast — idempotent short-circuit + typed exhaustion', () => {
  it('propagates local queue saturation without touching a backup endpoint', async () => {
    const queueFull = new RpcRequestGovernorQueueFullError(1);
    const primary = { broadcastTransaction: recorder(async () => { throw queueFull; }) };
    const backup = { broadcastTransaction: recorder(async () => undefined) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).rejects.toMatchObject({
      code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
      txHash: '0xhash',
      cause: queueFull,
    });
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    expect(backup.broadcastTransaction.calls).toEqual([]);
  });

  it('preserves the signed hash when fallback admission fills after an indeterminate submit', async () => {
    const queueFull = new RpcRequestGovernorQueueFullError(1);
    const primary = { broadcastTransaction: recorder(async () => { throw retryable429(); }) };
    const backup = { broadcastTransaction: recorder(async () => { throw queueFull; }) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).rejects.toMatchObject({
      code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
      txHash: '0xhash',
      cause: queueFull,
    });
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    expect(backup.broadcastTransaction.calls).toHaveLength(1);
  });

  it('successful broadcast records the broadcast endpoint host', async () => {
    const primary = { broadcastTransaction: recorder(async () => undefined) };
    const client = makeClient([primary], ['https://broadcast.example/key']);

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).resolves.toBeUndefined();

    expect(getRpcFailoverStats().servedByEndpointHost).toEqual({ 'broadcast.example': 1 });
  });

  it('an isKnownTransactionError is treated as SUCCESS (idempotent re-broadcast) — no failover', async () => {
    const primary = { broadcastTransaction: recorder(async () => { throw knownTxError(); }) };
    const backup = { broadcastTransaction: recorder(async () => undefined) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).resolves.toBeUndefined();
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    expect(getRpcFailoverStats().servedByEndpointHost).toEqual({ 'primary.example': 1 });
    // "already known" = the byte-identical tx is already in the mempool → success.
    // The set-retry MUST NOT fail over to a second endpoint and re-submit.
    expect(backup.broadcastTransaction.calls).toEqual([]);
  });

  it('a generic nonce-too-low error is not accepted as proof of the exact signed transaction', async () => {
    const error = Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' });
    const primary = { broadcastTransaction: recorder(async () => { throw error; }) };
    const backup = { broadcastTransaction: recorder(async () => undefined) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).rejects.toBe(error);
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
    expect(thrown.txHash).toBe('0xDEADBEEF');
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

  it('an AbortError after submit is ambiguous, so the byte-identical signed tx fails over', async () => {
    const primary = { broadcastTransaction: recorder(async () => { throw abortedRpcError(); }) };
    const backup = { broadcastTransaction: recorder(async () => undefined) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).resolves.toBeUndefined();
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    expect(backup.broadcastTransaction.calls).toHaveLength(1);
    expect(primary.broadcastTransaction.calls[0][0]).toBe('0xsigned');
    expect(backup.broadcastTransaction.calls[0][0]).toBe('0xsigned');
  });

  it('a code-only ABORT_ERR after submit also fails over with the byte-identical signed tx', async () => {
    const primary = { broadcastTransaction: recorder(async () => { throw abortedRpcCodeError(); }) };
    const backup = { broadcastTransaction: recorder(async () => undefined) };
    const client = makeClient([primary, backup], URLS);

    await expect(client.broadcast('0xsigned', '0xhash', 'unit write')).resolves.toBeUndefined();
    expect(primary.broadcastTransaction.calls).toHaveLength(1);
    expect(backup.broadcastTransaction.calls).toHaveLength(1);
    expect(primary.broadcastTransaction.calls[0][0]).toBe('0xsigned');
    expect(backup.broadcastTransaction.calls[0][0]).toBe('0xsigned');
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
    expect(getRpcFailoverStats().servedByEndpointHost).toEqual({ 'primary.example': 1 });
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
    expect(getRpcFailoverStats().servedByEndpointHost).toEqual({});
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

  it('propagates local queue saturation during preparation without touching a backup', async () => {
    const queueFull = new RpcRequestGovernorQueueFullError(1);
    const primary = {};
    const backup = {};
    const primaryPopulate = recorder(async () => { throw queueFull; });
    const backupPopulate = recorder(async () => ({ to: '0xTO', data: '0x' }));
    const contract = {
      connect: (rpcSigner: unknown) => ({
        doWrite: {
          populateTransaction: (rpcSigner as { boundTo?: unknown }).boundTo === primary
            ? primaryPopulate
            : backupPopulate,
        },
      }),
    } as any;
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const client = makeClient([primary, backup], URLS, signPopulated as SignPopulatedFn);

    await expect(client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'V10 publish'))
      .rejects.toBe(queueFull);
    expect(primaryPopulate.calls).toHaveLength(1);
    expect(backupPopulate.calls).toEqual([]);
    expect(signPopulated.calls).toEqual([]);
  });

  it('propagates local queue saturation during buffered estimation without signing or failing over', async () => {
    const queueFull = new RpcRequestGovernorQueueFullError(1);
    const primary = {};
    const backup = {};
    const primaryEstimate = recorder(async () => { throw queueFull; });
    const backupEstimate = recorder(async () => 21_000n);
    const populateTransaction = recorder(async () => ({ to: '0xTO', data: '0x' }));
    const contract = {
      connect: (rpcSigner: unknown) => ({
        doWrite: {
          populateTransaction,
          estimateGas: (rpcSigner as { boundTo?: unknown }).boundTo === primary
            ? primaryEstimate
            : backupEstimate,
        },
      }),
    } as any;
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const client = makeClient([primary, backup], URLS, signPopulated as SignPopulatedFn);

    await expect(client.populateAndSign(
      contract,
      'doWrite',
      [],
      makeSigner(),
      'V10 publish',
      { gasLimitBufferBps: 1_000 },
    )).rejects.toBe(queueFull);
    expect(populateTransaction.calls).toHaveLength(1);
    expect(primaryEstimate.calls).toHaveLength(1);
    expect(backupEstimate.calls).toEqual([]);
    expect(signPopulated.calls).toEqual([]);
  });

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
    expect(getRpcFailoverStats().servedByEndpointHost).toEqual({ 'only.example': 1 });
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

  it('a deterministic CALL_EXCEPTION from the buffered estimate is final — no duplicate estimate/nonce population', async () => {
    // RandomSampling surfaces the expected idle outcome as this exact shape. The buffered
    // estimate has already executed the call and received a deterministic contract answer;
    // signing an unbuffered request would make ethers issue the same estimate plus a nonce read.
    const noEligible = callExceptionErr(
      'execution reverted: NoEligibleContextGraph()',
    );
    const primary = {};
    const backup = {};
    const primaryPopulate = recorder(async () => ({ to: '0xTO', data: '0x' }));
    const backupPopulate = recorder(async () => ({ to: '0xTO', data: '0x' }));
    const primaryEstimate = recorder(async () => { throw noEligible; });
    const backupEstimate = recorder(async () => 21_000n);
    const contract = {
      connect: (rpcSigner: unknown) => ({
        createChallenge: {
          populateTransaction: (rpcSigner as { boundTo?: unknown }).boundTo === primary
            ? primaryPopulate
            : backupPopulate,
          estimateGas: (rpcSigner as { boundTo?: unknown }).boundTo === primary
            ? primaryEstimate
            : backupEstimate,
        },
      }),
    } as any;
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const client = makeClient([primary, backup], URLS, signPopulated as SignPopulatedFn);
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => { warns.push(String(args[0])); }) as typeof console.warn;
    try {
      await expect(client.populateAndSign(
        contract,
        'createChallenge',
        [],
        makeSigner(),
        'create random-sampling challenge',
        { gasLimitBufferBps: 5_000 },
      )).rejects.toBe(noEligible);
    } finally {
      console.warn = origWarn;
    }

    expect(primaryPopulate.calls).toHaveLength(1);
    expect(primaryEstimate.calls).toHaveLength(1);
    expect(backupPopulate.calls).toEqual([]); // deterministic result never fails over
    expect(backupEstimate.calls).toEqual([]);
    expect(signPopulated.calls).toEqual([]); // therefore no signer estimate or nonce read
    expect(warns).toEqual([]); // not mislabeled as a degraded unbuffered send
  });

  it.each([
    ['plain deterministic application error', new Error('estimate policy rejected')],
    ['UNPREDICTABLE_GAS_LIMIT compatibility error', Object.assign(
      new Error('cannot estimate gas'),
      { code: 'UNPREDICTABLE_GAS_LIMIT' },
    )],
  ])('preserves the unbuffered fallback for %s', async (_label, estimateError) => {
    // The short-circuit is intentionally code-exact. Other non-failover errors retain the
    // compatibility behavior: signPopulated owns ethers' one unbuffered estimate+nonce attempt.
    const populateTransaction = recorder(async () => ({ to: '0xTO', data: '0x' }));
    const estimateGas = recorder(async () => { throw estimateError; });
    const contract = {
      connect: () => ({ doWrite: { populateTransaction, estimateGas } }),
    } as any;
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const client = makeClient([{}], ['https://only.example'], signPopulated as SignPopulatedFn);
    const origWarn = console.warn;
    console.warn = (() => undefined) as typeof console.warn;
    try {
      await expect(client.populateAndSign(
        contract,
        'doWrite',
        [],
        makeSigner(),
        'V10 publish',
        { gasLimitBufferBps: 1_000 },
      )).resolves.toEqual({ signedTx: '0xS', txHash: '0xH' });
    } finally {
      console.warn = origWarn;
    }
    expect(estimateGas.calls).toHaveLength(1);
    expect(signPopulated.calls).toHaveLength(1);
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
