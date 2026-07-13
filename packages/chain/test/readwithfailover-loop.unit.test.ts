// SPDX-License-Identifier: Apache-2.0
/**
 * Read-failover LOOP LOGIC for the `RpcFailoverClient` read family (#1336) — the
 * read-side mirror of the write-loop unit tests in evm-adapter.unit.test.ts.
 *
 * #1336 extracted the per-endpoint read loop out of `EVMChainAdapterBase` (the
 * old protected `readWithFailover` / `contractReadWithFailover` seams) into the
 * pure `RpcFailoverClient`. These tests now construct that module DIRECTLY with
 * hand-made provider doubles + a never-called `signPopulated` stub and call
 * `.read` / `.readContract` — no more reaching through `as any` protected seams
 * (the testability win the issue asks for). They drive the loop with bare-object
 * provider doubles (the same style the write loops use): cheap, fast, no HTTP
 * server, exercising advance-on-retryable / exhaustion / single-RPC /
 * non-retryable-throws / named-policy per-attempt cap / view classifier /
 * host-only logging.
 *
 * SCOPE NOTE (deliberate): bare-object mocks prove the loop CONTROL FLOW but NOT
 * the "immediate / no per-endpoint backoff" property — they reject synchronously,
 * bypassing boundedRetryFetchRequest / FetchRequest, so they pass identically
 * whether per-endpoint retries is 0 or 5. The retries=0 IMMEDIACY guarantee is
 * proven separately with REAL providers in multi-rpc-read-failover.test.ts. This
 * file is necessary-but-not-sufficient on its own; the two together are the net.
 *
 * The last two describe blocks (#894 retry-budget wiring + B-6 wide getLogs) stay
 * on the REAL `EVMChainAdapter` ON PURPOSE: they assert constructor / events-path
 * wiring (the provider retryFunc budget; queryFilterWithFailover baking in the
 * `wideLogScan` policy) that does NOT live in the extracted module.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { RpcFailoverClient, type RpcFailoverClientOptions, type SignPopulatedFn } from '../src/rpc-failover-client.js';
import { isChainRpcTransportError } from '../src/chain-rpc-transport-error.js';
import { getRpcFailoverStats, _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';
import { RPC_READ_STALL_TIMEOUT_MS } from '../src/evm-adapter-constants.js';

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
    privateKey: PK,
    hubAddress: HUB,
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    staticNetwork: false,
    ...overrides,
  };
}

// The constructor builds REAL JsonRpcProviders over the (fake) URLs + wires
// error-listener network detection; destroy() them immediately so no socket /
// detection promise lingers ("Vite server not exiting" → flaky CI exit 1). Used
// only by the two adapter-construction blocks at the bottom.
function freshAdapter(cfg: EVMAdapterConfig): EVMChainAdapter {
  const a = new EVMChainAdapter(cfg);
  try { a.destroy(); } catch { /* idempotent; never dialled */ }
  return a;
}

const retryable429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };
const callExceptionErr = () => { const e = new Error('execution reverted'); (e as any).code = 'CALL_EXCEPTION'; return e; };

// A `signPopulated` stub the read family never reaches — wired so that if a read
// path ever tried to sign (it must not), the test fails loudly.
const NEVER_SIGN: SignPopulatedFn = async () => {
  throw new Error('signPopulated must never be reached by a read-family test');
};

/**
 * Construct the module under test directly (PLAN §0 D1): LIVE thunks over the
 * bare provider doubles + their host URLs, and the never-signing callback. This
 * is the exact shape the adapter constructs it with, minus the adapter — so a
 * read failover regression is caught without a god-object back-reference.
 */
function makeClient(providers: unknown[], rpcUrls: string[], signPopulated: SignPopulatedFn = NEVER_SIGN, options?: RpcFailoverClientOptions): RpcFailoverClient {
  return new RpcFailoverClient(
    () => providers.map((p, i) => ({ provider: p as any, rpcUrl: rpcUrls[i] })),
    signPopulated,
    () => 'evm:31337',
    options,
  );
}

describe('RpcFailoverClient.read — read-failover loop logic (bare-mock, #1336)', () => {
  beforeEach(() => { _resetRpcFailoverStatsForTest(); });
  afterEach(() => { _resetRpcFailoverStatsForTest(); });

  it('advances to the next provider on a retryable error and serves its result', async () => {
    const primary = { read: recorder(async () => { throw retryable429(); }) };
    const backup = { read: recorder(async () => 'served-by-backup') };
    const client = makeClient([primary, backup], ['https://primary.example', 'https://backup.example']);

    await expect(client.read('unit read', (p: any) => p.read())).resolves.toBe('served-by-backup');
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toHaveLength(1);
  });

  it('exhausts ALL endpoints → ChainRpcTransportError RPC_ENDPOINTS_EXHAUSTED, one attempt each', async () => {
    const primary = { read: recorder(async () => { throw retryable429(); }) };
    const backup = { read: recorder(async () => { throw retryable429(); }) };
    const client = makeClient([primary, backup], ['https://primary.example', 'https://backup.example'], NEVER_SIGN, {
      readThrottleRetries: 0,
    });

    let thrown: any;
    try { await client.read('unit read', (p: any) => p.read()); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED', rpcUrls: ['https://primary.example', 'https://backup.example'] });
    expect(isChainRpcTransportError(thrown)).toBe(true);
    // HOST-ONLY aggregate message: names hosts, never the full https:// URL.
    expect(thrown.message).toContain('primary.example');
    expect(thrown.message).not.toContain('https://');
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toHaveLength(1);
  });

  it('backs off and retries the full pool when every endpoint returns 429', async () => {
    let round = 0;
    const primary = { read: recorder(async () => { throw retryable429(); }) };
    const backup = { read: recorder(async () => {
      round += 1;
      if (round === 1) throw retryable429();
      return 'recovered';
    }) };
    const client = makeClient([primary, backup], ['https://primary.example', 'https://backup.example'], NEVER_SIGN, {
      readThrottleRetries: 2,
      readThrottleBackoffMs: 1,
    });

    await expect(client.read('getBlock', (provider: any) => provider.read(), {
      endpointSetRetry: 'all-throttled',
    }))
      .resolves.toBe('recovered');
    expect(primary.read.calls).toHaveLength(2);
    expect(backup.read.calls).toHaveLength(2);
  });

  it('does not retry a mixed timeout plus 429 endpoint exhaustion', async () => {
    const primary = { read: recorder(async () => { const error: any = new Error('timed out'); error.code = 'TIMEOUT'; throw error; }) };
    const backup = { read: recorder(async () => { throw retryable429(); }) };
    const client = makeClient([primary, backup], ['https://primary.example', 'https://backup.example'], NEVER_SIGN, {
      readThrottleRetries: 2,
      readThrottleBackoffMs: 1,
    });

    await expect(client.read('getBlock', (provider: any) => provider.read(), {
      endpointSetRetry: 'all-throttled',
    })).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toHaveLength(1);
  });

  it('single-RPC: a retryable failure still stamps RPC_ENDPOINTS_EXHAUSTED but keeps the original message verbatim', async () => {
    const only = { read: recorder(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8545'); }) };
    const client = makeClient([only], ['https://only.example']);

    let thrown: any;
    try { await client.read('unit read', (p: any) => p.read()); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    // No second endpoint → message stays byte-identical (no "all endpoints" aggregate).
    expect(thrown.message).toBe('connect ECONNREFUSED 127.0.0.1:8545');
    expect(thrown.message).not.toContain('all configured RPC endpoints');
    expect(only.read.calls).toHaveLength(1);
  });

  it('does NOT fail over a deterministic non-retryable error (CALL_EXCEPTION) — throws it, backup untouched', async () => {
    const err = callExceptionErr();
    const primary = { read: recorder(async () => { throw err; }) };
    const backup = { read: recorder(async () => 'should-not-be-reached') };
    const client = makeClient([primary, backup], ['https://primary.example', 'https://backup.example']);

    await expect(client.read('unit read', (p: any) => p.read())).rejects.toBe(err);
    expect(backup.read.calls).toEqual([]);
  });

  it('logs each failover hop HOST-ONLY and bumps the process-wide counters', async () => {
    const primary = { read: recorder(async () => { throw retryable429(); }) };
    const backup = { read: recorder(async () => 'ok') };
    // Primary URL carries a fake API key in its path: the host-only logger must
    // never leak it (nor the scheme).
    const client = makeClient([primary, backup], ['https://primary.example/v1/SECRET-KEY', 'https://backup.example']);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => { warnings.push(String(args[0])); }) as typeof console.warn;
    try {
      await expect(client.read('unit read', (p: any) => p.read())).resolves.toBe('ok');
    } finally {
      console.warn = origWarn;
    }

    const failoverLines = warnings.filter((w) => w.includes('RPC failover'));
    expect(failoverLines.length).toBeGreaterThanOrEqual(1);
    const joined = failoverLines.join('\n');
    expect(joined).toContain('primary.example');
    expect(joined).not.toContain('SECRET-KEY');
    expect(joined).not.toContain('://');

    const stats = getRpcFailoverStats();
    expect(stats.failovers).toBeGreaterThanOrEqual(1);
    expect(Object.keys(stats.byEndpointHost).every((h) => !h.includes('SECRET-KEY') && !h.includes('://'))).toBe(true);
  });
});

// Regression for the log-scan cap fix (adversarial-review find): the 4s
// point-read cap was aborting WIDE events.ts queryFilter/getLogs reads (9000-block
// poller ranges legitimately >4s) → threw RPC_ENDPOINTS_EXHAUSTED before the
// publisher poller advanced its cursor → permanent stall. Fix: the named
// `wideLogScan` policy (RPC_LOG_SCAN_TIMEOUT_MS = 30s) caps MULTI-RPC attempts
// only; SINGLE-RPC stays uncapped (#894 — nothing to fail over to). Background
// watchers that must clear a one-RPC scheduler gate use explicit watchdog
// policies rather than changing the default read intent. The raw
// `attemptTimeoutMs` / `multiAttemptTimeoutMs` knobs are gone — callers pick a
// named ReadPolicy and the module owns the matrix (resolveCapMs). Fake timers
// throughout — no real 5s/30s sleeps.
describe('RpcFailoverClient.read — per-attempt cap (named policies, log-scan stall fix)', () => {
  // A read whose promise resolves after `ms` of (fake) time.
  const delayedRead = (ms: number, value: string) =>
    recorder(() => new Promise<string>((resolve) => { setTimeout(() => resolve(value), ms); }));

  afterEach(() => { vi.useRealTimers(); });

  it('MULTI-RPC: a wide read >4s but <30s COMPLETES on the primary under wideLogScan (not aborted, no failover)', async () => {
    vi.useFakeTimers();
    const primary = { read: delayedRead(5_000, 'PRIMARY') };
    const backup = { read: recorder(async () => 'BACKUP') };
    const client = makeClient([primary, backup], ['https://primary.example', 'https://backup.example']);

    const p = client.read('log scan', (pr: any) => pr.read(), { policy: 'wideLogScan' });
    await vi.advanceTimersByTimeAsync(6_000); // past the 5s read, well under the 30s cap
    expect(await p).toBe('PRIMARY');
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toEqual([]); // completed on the primary → backup never consulted
  });

  it('MULTI-RPC: the SAME wide read under the DEFAULT pointRead cap aborts at ~4s and fails over (proves the cap matters)', async () => {
    vi.useFakeTimers();
    const primary = { read: delayedRead(5_000, 'PRIMARY') };
    const backup = { read: recorder(async () => 'BACKUP') };
    const client = makeClient([primary, backup], ['https://primary.example', 'https://backup.example']);

    const p = client.read('point read', (pr: any) => pr.read()); // no opt → pointRead → RPC_READ_STALL_TIMEOUT_MS (4s)
    await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS + 1_500); // primary times out at 4s → fail over
    expect(await p).toBe('BACKUP');
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toHaveLength(1);
  });

  it('SINGLE-RPC: wideLogScan NEVER caps — a >30s healthy read still completes, no abort (#894)', async () => {
    vi.useFakeTimers();
    const only = { read: delayedRead(35_000, 'ONLY') };
    const client = makeClient([only], ['https://only.example']); // single endpoint

    const p = client.read('log scan', (pr: any) => pr.read(), { policy: 'wideLogScan' });
    await vi.advanceTimersByTimeAsync(36_000); // would exceed the 30s cap IF it applied to single-RPC
    expect(await p).toBe('ONLY'); // uncapped → completes
    expect(only.read.calls).toHaveLength(1);
  });

  it('failOpenFundingRead caps EVEN single-RPC — an over-budget read aborts → exhausted', async () => {
    vi.useFakeTimers();
    const only = { read: delayedRead(5_000, 'ONLY') };
    const client = makeClient([only], ['https://only.example']);

    const settled = client.read('funding', (pr: any) => pr.read(), { policy: 'failOpenFundingRead' })
      .then((r: unknown) => r, (e: unknown) => e);
    // failOpenFundingRead caps every attempt incl. single-RPC at
    // RPC_READ_STALL_TIMEOUT_MS; advance past it so the 5s read aborts → single →
    // exhausted.
    await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS + 1_500);
    const outcome: any = await settled;
    expect(outcome.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(only.read.calls).toHaveLength(1);
  });
});

// #2 review fix: readContract DEFAULTS its failover classifier to
// isContractViewRetryable = isRetryableRpcError MINUS BAD_DATA. A contract VIEW's
// BAD_DATA ("could not decode result data") is a DETERMINISTIC client-side decode,
// not an RPC outage — failing over would re-hit the same decode on every endpoint
// and mask it as RPC_ENDPOINTS_EXHAUSTED (the pre-PR FallbackProvider never failed
// over on a post-decode error). So BAD_DATA must surface DIRECTLY (no failover),
// while a real transient (429) still fails over; opts.isRetryable overrides it.
describe('RpcFailoverClient.readContract — per-provider rebinding + view classifier (B-2, #2/#3)', () => {
  const badDataError = () => {
    const e: any = new Error('could not decode result data (value="0x", code=BAD_DATA)');
    e.code = 'BAD_DATA';
    return e;
  };
  // A contract whose `.connect(provider)` returns a PROVIDER-SPECIFIC view double
  // (rebindContract = contract.connect(p), no fallback). This PROVES the failover
  // loop rebinds to the BACKUP provider's contract — a regression that re-ran the
  // primary-bound contract would call primaryView twice, never backupView.
  const perProviderContract = (byProvider: (p: unknown) => { view: ReturnType<typeof recorder> }) =>
    ({ connect: (p: unknown) => byProvider(p) }) as any;

  it('a BAD_DATA view decode is NON-retryable → surfaces DIRECTLY, NO failover (backup-connected view never called)', async () => {
    const p0 = {}; const p1 = {};
    const bad = badDataError();
    const primaryView = recorder(async () => { throw bad; });
    const backupView = recorder(async () => 'BACKUP-RESULT');
    const contract = perProviderContract((p) => (p === p0 ? { view: primaryView } : { view: backupView }));
    const client = makeClient([p0, p1], ['https://primary.example', 'https://backup.example']);

    await expect(client.readContract('someView', contract, (c: any) => c.view()))
      .rejects.toBe(bad); // the ORIGINAL BAD_DATA, NOT a ChainRpcTransportError/RPC_ENDPOINTS_EXHAUSTED
    expect(primaryView.calls).toHaveLength(1); // primary-connected view called once
    expect(backupView.calls).toEqual([]);      // deterministic → backup-connected view NEVER consulted
  });

  it('a real transient (429) IS retryable → REBINDS to and is served by the BACKUP provider\'s view', async () => {
    const p0 = {}; const p1 = {};
    const primaryView = recorder(async () => { const e: any = new Error('429 too many requests'); e.status = 429; throw e; });
    const backupView = recorder(async () => 'BACKUP-RESULT');
    const contract = perProviderContract((p) => (p === p0 ? { view: primaryView } : { view: backupView }));
    const client = makeClient([p0, p1], ['https://primary.example', 'https://backup.example']);

    await expect(client.readContract('someView', contract, (c: any) => c.view())).resolves.toBe('BACKUP-RESULT');
    // B-2: the loop rebound to the BACKUP provider's contract — proven by the
    // result coming from backupView, and primaryView hit exactly once (not twice).
    expect(primaryView.calls).toHaveLength(1);
    expect(backupView.calls).toHaveLength(1);
  });

  it('an explicit opts.isRetryable OVERRIDES the isContractViewRetryable default (BAD_DATA → rebinds to the BACKUP view)', async () => {
    const p0 = {}; const p1 = {};
    const primaryView = recorder(async () => { throw badDataError(); });
    const backupView = recorder(async () => 'BACKUP-RESULT');
    const contract = perProviderContract((p) => (p === p0 ? { view: primaryView } : { view: backupView }));
    const client = makeClient([p0, p1], ['https://primary.example', 'https://backup.example']);

    await expect(
      client.readContract('someView', contract, (c: any) => c.view(), { isRetryable: () => true }),
    ).resolves.toBe('BACKUP-RESULT');
    expect(primaryView.calls).toHaveLength(1);
    expect(backupView.calls).toHaveLength(1); // default overridden → BAD_DATA failed over to the backup view
  });

  it('read honours a custom opts.isRetryable that makes a normally-retryable 429 NON-retryable (surfaces it, no failover)', async () => {
    const err429 = (() => { const e: any = new Error('429 too many requests'); e.status = 429; return e; })();
    const primary = { read: recorder(async () => { throw err429; }) };
    const backup = { read: recorder(async () => 'BACKUP') };
    const client = makeClient([primary, backup], ['https://primary.example', 'https://backup.example']);

    // Custom classifier: nothing is retryable → the 429 surfaces directly, no failover.
    await expect(client.read('t', (p: any) => p.read(), { isRetryable: () => false }))
      .rejects.toBe(err429);
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toEqual([]);
  });
});

// B-5 (#894 guard): the CONSTRUCTOR wires the per-endpoint FetchRequest retry
// budget from the endpoint count — SINGLE-RPC keeps the bounded retry (its only
// resilience; nothing to fail over to), MULTI-RPC uses 0 (the explicit adapter
// failover advances on the first error). A regression to perEndpointRetries=0
// for a single endpoint would surface RPC_ENDPOINTS_EXHAUSTED on the first 429.
// We inspect the constructed provider's real retryFunc directly (deterministic +
// fast) rather than driving ~7.5s of real loopback backoff — the behavioural
// real-429 path is already covered by evm-adapter.unit.test.ts's perpetual-429
// block; this pins the wiring robustly. This stays on the REAL adapter: the
// retry budget is a constructor concern, not part of the extracted module.
describe('constructor RPC-retry budget wiring (#894 single-RPC vs multi-RPC, B-5)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const retryFuncOf = (a: EVMChainAdapter) =>
    (a.getProvider() as unknown as {
      _getConnection: () => { retryFunc?: (r: unknown, x: unknown, n: number) => Promise<boolean> };
    })._getConnection().retryFunc!;

  it('SINGLE-RPC: the one provider keeps the bounded retry budget (retries, NOT 0)', async () => {
    const a = new EVMChainAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    try {
      const retry = retryFuncOf(a);
      expect(typeof retry).toBe('function');
      vi.useFakeTimers();
      const p0 = retry({}, {}, 0); await vi.advanceTimersByTimeAsync(2_000); expect(await p0).toBe(true);  // retries
      const p4 = retry({}, {}, 4); await vi.advanceTimersByTimeAsync(2_000); expect(await p4).toBe(true);  // ...through the budget
      expect(await retry({}, {}, 5)).toBe(false); // bounded → eventually RPC_ENDPOINTS_EXHAUSTED (#894)
    } finally {
      a.destroy();
    }
  });

  it('MULTI-RPC: each provider gives up at attempt 0 (retries=0) so the explicit failover advances at once', async () => {
    const a = new EVMChainAdapter(minimalConfig({ rpcUrl: 'https://a.example', rpcUrls: ['https://b.example'] }));
    try {
      expect(await retryFuncOf(a)({}, {}, 0)).toBe(false);
    } finally {
      a.destroy();
    }
  });
});

// B-6: listenForEvents' wide eth_getLogs reads go through queryFilterWithFailover,
// which bakes in the `wideLogScan` policy (RPC_LOG_SCAN_TIMEOUT_MS, 30s) so a
// slow-but-healthy getLogs (a 9000-block poller range) isn't aborted by the 4s
// point-read cap. Exercises the REAL events.ts path (not the module directly) so
// dropping the policy from a branch would re-introduce the stall.
describe('listenForEvents — wide getLogs honours the 30s LOG_SCAN cap (B-6)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a queryFilter that resolves at >4s but <30s COMPLETES (not aborted at the 4s point-read cap)', async () => {
    vi.useFakeTimers();
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://primary.example', rpcUrls: ['https://backup.example'] }));
    (a as any).initialized = true; // listenForEvents awaits init() first
    (a as any).providers = [{}, {}]; // MULTI-RPC → the per-attempt cap applies
    const log = {
      topics: ['0x' + '00'.repeat(32)], data: '0x', blockNumber: 1,
      transactionHash: '0x' + '11'.repeat(32), transactionIndex: 0,
    };
    const parsed = { args: { batchId: 1n, publisher: '0x' + '22'.repeat(20), merkleRoot: '0x' + '33'.repeat(32), startKAId: 1n, endKAId: 1n } };
    // A wide getLogs that takes 5s (>4s point-read cap, <30s LOG_SCAN cap).
    const queryFilter = recorder(() => new Promise((resolve) => { setTimeout(() => resolve([log]), 5_000); }));
    const storage: any = {
      connect: () => storage, // rebindContract(storage, p) = storage.connect(p)
      filters: { KnowledgeBatchCreated: () => 'F' },
      interface: { parseLog: () => parsed },
      queryFilter,
    };
    (a as any).contracts.knowledgeAssetsStorage = storage;

    const collected: Array<{ type: string }> = [];
    const done = (async () => {
      for await (const ev of a.listenForEvents({ eventTypes: ['KnowledgeBatchCreated'], fromBlock: 0 } as any)) {
        collected.push(ev as { type: string });
      }
    })();
    await vi.advanceTimersByTimeAsync(6_000); // past the 5s getLogs, under the 30s LOG_SCAN cap
    await done;

    expect(queryFilter.calls).toHaveLength(1); // completed on the first endpoint, NOT aborted+failed-over
    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('KnowledgeBatchCreated');
  });
});
