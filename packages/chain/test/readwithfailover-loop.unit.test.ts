// SPDX-License-Identifier: Apache-2.0
/**
 * Read-failover LOOP LOGIC for R1's `readWithFailover` — the read-side mirror of
 * the write-loop unit tests in evm-adapter.unit.test.ts. Drives the loop with
 * bare-object `(a as any).providers = [...]` mocks (the same style the write
 * loops use): cheap, fast, no HTTP server, exercises advance-on-retryable /
 * exhaustion / single-RPC / non-retryable-throws / host-only logging.
 *
 * SCOPE NOTE (deliberate): bare-object mocks prove the loop CONTROL FLOW but NOT
 * the "immediate / no per-endpoint backoff" property — they reject synchronously,
 * bypassing boundedRetryFetchRequest / FetchRequest, so they pass identically
 * whether per-endpoint retries is 0 or 5. The retries=0 IMMEDIACY guarantee is
 * proven separately with REAL providers in multi-rpc-read-failover.test.ts. This
 * file is necessary-but-not-sufficient on its own; the two together are the net.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { isChainRpcTransportError } from '../src/chain-rpc-transport-error.js';
import { getRpcFailoverStats, _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';
import { RPC_LOG_SCAN_TIMEOUT_MS, RPC_READ_STALL_TIMEOUT_MS } from '../src/evm-adapter-constants.js';

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
    ...overrides,
  };
}

// The constructor builds REAL JsonRpcProviders over the (fake) URLs + wires
// error-listener network detection; destroy() them immediately so no socket /
// detection promise lingers ("Vite server not exiting" → flaky CI exit 1), THEN
// override `this.providers` with the bare-object mocks below.
function freshAdapter(cfg: EVMAdapterConfig): EVMChainAdapter {
  const a = new EVMChainAdapter(cfg);
  try { a.destroy(); } catch { /* idempotent; never dialled */ }
  return a;
}

const retryable429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };
const callExceptionErr = () => { const e = new Error('execution reverted'); (e as any).code = 'CALL_EXCEPTION'; return e; };

// readWithFailover is protected; reach it via the same `as any` convention the
// rest of the chain suite uses. `fn` receives the bare provider; we give each
// mock provider a single `read()` method.
function readWithFailover<T>(a: EVMChainAdapter, fn: (p: any) => Promise<T>, label = 'unit read'): Promise<T> {
  return (a as any).readWithFailover(label, fn);
}

describe('readWithFailover — read-failover loop logic (bare-mock, R1)', () => {
  beforeEach(() => { _resetRpcFailoverStatsForTest(); });
  afterEach(() => { _resetRpcFailoverStatsForTest(); });

  it('advances to the next provider on a retryable error and serves its result', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://primary.example', rpcUrls: ['https://backup.example'] }));
    const primary = { read: recorder(async () => { throw retryable429(); }) };
    const backup = { read: recorder(async () => 'served-by-backup') };
    (a as any).providers = [primary, backup];

    await expect(readWithFailover(a, (p) => p.read())).resolves.toBe('served-by-backup');
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toHaveLength(1);
  });

  it('exhausts ALL endpoints → ChainRpcTransportError RPC_ENDPOINTS_EXHAUSTED, one attempt each', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://primary.example', rpcUrls: ['https://backup.example'] }));
    const primary = { read: recorder(async () => { throw retryable429(); }) };
    const backup = { read: recorder(async () => { throw retryable429(); }) };
    (a as any).providers = [primary, backup];

    let thrown: any;
    try { await readWithFailover(a, (p) => p.read()); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED', rpcUrls: ['https://primary.example', 'https://backup.example'] });
    expect(isChainRpcTransportError(thrown)).toBe(true);
    // HOST-ONLY aggregate message: names hosts, never the full https:// URL.
    expect(thrown.message).toContain('primary.example');
    expect(thrown.message).not.toContain('https://');
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toHaveLength(1);
  });

  it('single-RPC: a retryable failure still stamps RPC_ENDPOINTS_EXHAUSTED but keeps the original message verbatim', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    const only = { read: recorder(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8545'); }) };
    (a as any).providers = [only];

    let thrown: any;
    try { await readWithFailover(a, (p) => p.read()); } catch (e) { thrown = e; }
    expect(thrown).toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    // No second endpoint → message stays byte-identical (no "all endpoints" aggregate).
    expect(thrown.message).toBe('connect ECONNREFUSED 127.0.0.1:8545');
    expect(thrown.message).not.toContain('all configured RPC endpoints');
    expect(only.read.calls).toHaveLength(1);
  });

  it('does NOT fail over a deterministic non-retryable error (CALL_EXCEPTION) — throws it, backup untouched', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://primary.example', rpcUrls: ['https://backup.example'] }));
    const err = callExceptionErr();
    const primary = { read: recorder(async () => { throw err; }) };
    const backup = { read: recorder(async () => 'should-not-be-reached') };
    (a as any).providers = [primary, backup];

    await expect(readWithFailover(a, (p) => p.read())).rejects.toBe(err);
    expect(backup.read.calls).toEqual([]);
  });

  it('logs each failover hop HOST-ONLY and bumps the process-wide counters', async () => {
    const a = freshAdapter(minimalConfig({
      rpcUrl: 'https://primary.example/v1/SECRET-KEY', rpcUrls: ['https://backup.example'],
    }));
    const primary = { read: recorder(async () => { throw retryable429(); }) };
    const backup = { read: recorder(async () => 'ok') };
    (a as any).providers = [primary, backup];

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => { warnings.push(String(args[0])); }) as typeof console.warn;
    try {
      await expect(readWithFailover(a, (p) => p.read())).resolves.toBe('ok');
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
// publisher poller advanced its cursor → permanent stall. Fix:
// `multiAttemptTimeoutMs` (caps MULTI-RPC attempts only) + RPC_LOG_SCAN_TIMEOUT_MS
// (30s) on the 9 events.ts reads; SINGLE-RPC stays uncapped (#894 — nothing to
// fail over to). Fake timers throughout — no real 5s/30s sleeps.
describe('readWithFailover — per-attempt cap (log-scan stall fix)', () => {
  // A read whose promise resolves after `ms` of (fake) time.
  const delayedRead = (ms: number, value: string) =>
    recorder(() => new Promise<string>((resolve) => { setTimeout(() => resolve(value), ms); }));

  afterEach(() => { vi.useRealTimers(); });

  it('MULTI-RPC: a wide read >4s but <30s COMPLETES on the primary with multiAttemptTimeoutMs (not aborted, no failover)', async () => {
    vi.useFakeTimers();
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://primary.example', rpcUrls: ['https://backup.example'] }));
    const primary = { read: delayedRead(5_000, 'PRIMARY') };
    const backup = { read: recorder(async () => 'BACKUP') };
    (a as any).providers = [primary, backup];

    const p = (a as any).readWithFailover('log scan', (pr: any) => pr.read(), { multiAttemptTimeoutMs: RPC_LOG_SCAN_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(6_000); // past the 5s read, well under the 30s cap
    expect(await p).toBe('PRIMARY');
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toEqual([]); // completed on the primary → backup never consulted
  });

  it('MULTI-RPC: the SAME wide read under the DEFAULT point-read cap aborts at ~4s and fails over (proves the cap matters)', async () => {
    vi.useFakeTimers();
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://primary.example', rpcUrls: ['https://backup.example'] }));
    const primary = { read: delayedRead(5_000, 'PRIMARY') };
    const backup = { read: recorder(async () => 'BACKUP') };
    (a as any).providers = [primary, backup];

    const p = (a as any).readWithFailover('point read', (pr: any) => pr.read()); // no opt → RPC_READ_STALL_TIMEOUT_MS (4s)
    await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS + 1_500); // primary times out at 4s → fail over
    expect(await p).toBe('BACKUP');
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toHaveLength(1);
  });

  it('SINGLE-RPC: multiAttemptTimeoutMs NEVER caps — a >30s healthy read still completes, no abort (#894)', async () => {
    vi.useFakeTimers();
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://only.example' })); // single endpoint
    const only = { read: delayedRead(35_000, 'ONLY') };
    (a as any).providers = [only];

    const p = (a as any).readWithFailover('log scan', (pr: any) => pr.read(), { multiAttemptTimeoutMs: RPC_LOG_SCAN_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(36_000); // would exceed the 30s cap IF it applied to single-RPC
    expect(await p).toBe('ONLY'); // uncapped → completes
    expect(only.read.calls).toHaveLength(1);
  });

  it('precedence: attemptTimeoutMs caps EVEN single-RPC (fail-open funding reads) — an over-budget read aborts → exhausted', async () => {
    vi.useFakeTimers();
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://only.example' }));
    const only = { read: delayedRead(5_000, 'ONLY') };
    (a as any).providers = [only];

    const settled = (a as any).readWithFailover('funding', (pr: any) => pr.read(), { attemptTimeoutMs: 1_000 })
      .then((r: unknown) => r, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_500); // exceeds the 1s hard cap → aborts; single → exhausted
    const outcome: any = await settled;
    expect(outcome.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(only.read.calls).toHaveLength(1);
  });
});

// #2 review fix: contractReadWithFailover DEFAULTS its failover classifier to
// isContractViewRetryable = isRetryableRpcError MINUS BAD_DATA. A contract VIEW's
// BAD_DATA ("could not decode result data") is a DETERMINISTIC client-side decode,
// not an RPC outage — failing over would re-hit the same decode on every endpoint
// and mask it as RPC_ENDPOINTS_EXHAUSTED (the pre-PR FallbackProvider never failed
// over on a post-decode error). So BAD_DATA must surface DIRECTLY (no failover),
// while a real transient (429) still fails over; opts.isRetryable overrides it.
describe('contractReadWithFailover — view classifier (BAD_DATA non-retryable) + opts.isRetryable override', () => {
  const badDataError = () => {
    const e: any = new Error('could not decode result data (value="0x", code=BAD_DATA)');
    e.code = 'BAD_DATA';
    return e;
  };

  it('a BAD_DATA view decode is NON-retryable → surfaces DIRECTLY, NO failover (not masked as RPC_ENDPOINTS_EXHAUSTED)', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://primary.example', rpcUrls: ['https://backup.example'] }));
    (a as any).providers = [{}, {}];
    const bad = badDataError();
    const view = recorder(async () => { throw bad; });
    const contract = { view }; // no .connect → withRunner uses it as-is (same recorder per provider)

    await expect((a as any).contractReadWithFailover('someView', contract, (c: any) => c.view()))
      .rejects.toBe(bad); // the ORIGINAL BAD_DATA, NOT a ChainRpcTransportError/RPC_ENDPOINTS_EXHAUSTED
    expect(view.calls).toHaveLength(1); // deterministic → NO failover, backup never consulted
  });

  it('a real transient (429) on the SAME view path IS retryable → fails over to the next endpoint', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://primary.example', rpcUrls: ['https://backup.example'] }));
    (a as any).providers = [{}, {}];
    let n = 0;
    const view = recorder(async () => {
      n += 1;
      if (n === 1) { const e: any = new Error('429 too many requests'); e.status = 429; throw e; }
      return 'OK';
    });
    const contract = { view };

    await expect((a as any).contractReadWithFailover('someView', contract, (c: any) => c.view())).resolves.toBe('OK');
    expect(view.calls).toHaveLength(2); // 429 is a genuine transient → failed over
  });

  it('an explicit opts.isRetryable OVERRIDES the isContractViewRetryable default (BAD_DATA then treated retryable → fails over)', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://primary.example', rpcUrls: ['https://backup.example'] }));
    (a as any).providers = [{}, {}];
    let n = 0;
    const view = recorder(async () => { n += 1; if (n === 1) throw badDataError(); return 'OK'; });
    const contract = { view };

    await expect(
      (a as any).contractReadWithFailover('someView', contract, (c: any) => c.view(), { isRetryable: () => true }),
    ).resolves.toBe('OK');
    expect(view.calls).toHaveLength(2); // default overridden → BAD_DATA failed over
  });

  it('readWithFailover honours a custom opts.isRetryable that makes a normally-retryable 429 NON-retryable (surfaces it, no failover)', async () => {
    const a = freshAdapter(minimalConfig({ rpcUrl: 'https://primary.example', rpcUrls: ['https://backup.example'] }));
    const err429 = (() => { const e: any = new Error('429 too many requests'); e.status = 429; return e; })();
    const primary = { read: recorder(async () => { throw err429; }) };
    const backup = { read: recorder(async () => 'BACKUP') };
    (a as any).providers = [primary, backup];

    // Custom classifier: nothing is retryable → the 429 surfaces directly, no failover.
    await expect((a as any).readWithFailover('t', (p: any) => p.read(), { isRetryable: () => false }))
      .rejects.toBe(err429);
    expect(primary.read.calls).toHaveLength(1);
    expect(backup.read.calls).toEqual([]);
  });
});
