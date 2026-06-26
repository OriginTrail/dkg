// SPDX-License-Identifier: Apache-2.0
/**
 * T1 (immediate-RPC-failover): REAL multi-RPC READ failover over loopback
 * JSON-RPC servers — the regression gate the existing suite cannot provide.
 *
 * Why this file exists: the ~170 adapter failover tests inject bare-object
 * provider mocks (`(a as any).providers = [...]`) that bypass JsonRpcProvider /
 * FetchRequest / the read path entirely, AND they only cover WRITES. The READ
 * failover path (was: ethers `FallbackProvider`; after R1/#1336: the explicit
 * `RpcFailoverClient` read loop over the bare providers) has ZERO real coverage.
 * Empirically the current FallbackProvider read path does NOT reliably fail over
 * on a fast 429 (it advances only on a 4s STALL; even at the default retry
 * budget it can surface the primary's error with a healthy backup) — so R1 is a
 * correctness fix, not just a latency win, and it needs a REAL-provider test.
 *
 * Harness: `startLoopbackRpc` (node:http, no Hardhat / native deps). Teardown
 * MUST destroy() each adapter and close() each server (closeAllConnections) — a
 * perpetual 429 keeps ethers retrying on keep-alive sockets after the call
 * rejects, which otherwise hangs afterEach past vitest's hook timeout.
 *
 * The CONTROL tests (healthy endpoints) are GREEN today and prove the harness +
 * the real-provider-over-loopback adapter works. The `describe.skip` TARGET
 * blocks specify the immediate-failover behaviour R1 delivers.
 *
 * ── UN-SKIP PROTOCOL (HARD S1-ACCEPTANCE GATE, lead-mandated 2026-06-25) ──
 * Trigger: the moment ChainEngineer signals reads (getEvmChainId / Hub
 * getContractAddress / resolveContract / contract-views) route through
 * the `RpcFailoverClient` read loop over the bare `this.providers[]` with
 * per-endpoint retries = 0 for multi-RPC, flip ALL `describe.skip` TARGET blocks below to
 * live `describe`. They MUST then be GREEN — S1 is NOT complete until these are
 * live-green (lead + TxSafetyReviewer require it at S1 sign-off; the skip is
 * provably temporary, not optional). Kept skip ONLY while S1 is mid-flight so a
 * transient red from an unrelated in-progress edit can't mask a real regression.
 * VERIFIED 2026-06-25: with the targets un-skipped against ChainEngineer's S1
 * working tree these PASS (read 5/5, write 3/3) — the gate flips RED→GREEN
 * exactly as designed (current code: getEvmChainId rejects SERVER_ERROR in ~64ms
 * with a healthy backup = no failover). Do NOT weaken the assertions.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { JsonRpcProvider } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { RpcFailoverClient } from '../src/rpc-failover-client.js';
import { startLoopbackRpc, type LoopbackRpc } from './loopback-rpc-harness.js';
import { getRpcFailoverStats, _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB = '0x0000000000000000000000000000000000000001';

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    privateKey: DEPLOYER_PK,
    hubAddress: HUB,
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    ...overrides,
  };
}

describe('multi-RPC read failover (real loopback providers)', () => {
  const adapters: EVMChainAdapter[] = [];
  const servers: LoopbackRpc[] = [];
  function track(a: EVMChainAdapter): EVMChainAdapter { adapters.push(a); return a; }
  function trackServer(s: LoopbackRpc): LoopbackRpc { servers.push(s); return s; }

  afterEach(async () => {
    // Stop ethers' background retry loop / idle sockets FIRST, then close the
    // servers, so close() resolves promptly instead of hanging on an in-flight
    // 429 retry (the flaky-CI failure mode).
    for (const a of adapters.splice(0)) {
      try { a.destroy(); } catch { /* destroy() is idempotent */ }
    }
    for (const s of servers.splice(0)) await s.close();
  });

  // ── CONTROL (GREEN today): the harness + real-provider adapter works ──

  it('control: a healthy 2-RPC adapter resolves chainId over real loopback providers', async () => {
    const primary = trackServer(await startLoopbackRpc());
    const backup = trackServer(await startLoopbackRpc());
    const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: primary.url, rpcUrls: [backup.url] })));

    const start = Date.now();
    await expect(a.getEvmChainId()).resolves.toBe(31337n);
    expect(Date.now() - start).toBeLessThan(10_000);
    // Two distinct endpoints really were wired (not deduped to one).
    expect(a.getRpcUrls()).toEqual([primary.url, backup.url]);
  });

  it('control: a single-RPC adapter resolves chainId over a real loopback provider', async () => {
    const only = trackServer(await startLoopbackRpc());
    const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: only.url })));
    await expect(a.getEvmChainId()).resolves.toBe(31337n);
    expect(only.hits('eth_chainId')).toBeGreaterThanOrEqual(1);
  });

  // ── TARGET (immediate failover) ──────────────────────────────────────────
  // UN-SKIP when R1 routes reads through the `RpcFailoverClient` read loop over
  // the bare providers AND multi-RPC sets per-endpoint retries = 0. On the CURRENT code
  // these are RED (the FallbackProvider read path does not immediately fail over
  // a fast 429), which is exactly the regression this gate locks. Verified
  // entrypoint: getEvmChainId() -> this.provider.getNetwork() (a "direct
  // this.provider.*" read in the locked read surface).
  // GATE-HAS-TEETH CHECK (QA, 2026-06-25): with this block un-skipped against the
  // current code, getEvmChainId() REJECTS with SERVER_ERROR in ~64ms while the
  // backup is healthy — i.e. no failover — so the first test fails exactly as a
  // regression gate should. It must flip GREEN once R1 lands; do not weaken it.
  describe('TARGET — immediate read failover (R1)', () => {
    it('primary 429 on the read → served by the healthy backup, primary hit exactly once (no per-endpoint retry)', async () => {
      const primary = trackServer(await startLoopbackRpc({ throttle: ['eth_chainId'] }));
      const backup = trackServer(await startLoopbackRpc());
      const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: primary.url, rpcUrls: [backup.url] })));

      const start = Date.now();
      // The read is served by the backup despite the primary 429ing it.
      await expect(a.getEvmChainId()).resolves.toBe(31337n);
      const elapsed = Date.now() - start;

      // Immediate: the primary's eth_chainId is attempted exactly ONCE (no 5×
      // same-endpoint backoff before failing over) and the whole read is fast.
      expect(primary.hits('eth_chainId')).toBe(1);
      expect(backup.hits('eth_chainId')).toBeGreaterThanOrEqual(1);
      expect(elapsed).toBeLessThan(2_000);
    });

    it('all endpoints 429 → surfaces RPC_ENDPOINTS_EXHAUSTED (retryable), one attempt per endpoint', async () => {
      const primary = trackServer(await startLoopbackRpc({ throttle: ['eth_chainId'] }));
      const backup = trackServer(await startLoopbackRpc({ throttle: ['eth_chainId'] }));
      const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: primary.url, rpcUrls: [backup.url] })));

      const start = Date.now();
      await expect(a.getEvmChainId()).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
      expect(Date.now() - start).toBeLessThan(3_000);
      // Exactly one attempt per endpoint per pass (no 5× per-endpoint retry).
      expect(primary.hits('eth_chainId')).toBe(1);
      expect(backup.hits('eth_chainId')).toBe(1);
    });
  });

  // Direct unit of the extracted read-failover primitive (#1336): the
  // `RpcFailoverClient.read` loop advances on a retryable error and serves from
  // the next provider — the read-side mirror of the write loops. Driven over the
  // adapter's REAL constructed providers + URLs (PLAN §0 D7) so the end-to-end
  // immediacy property (boundedRetryFetchRequest(url,0), no per-endpoint backoff)
  // is still asserted against real JsonRpcProviders.
  describe('TARGET — RpcFailoverClient.read primitive (R1, #1336)', () => {
    it('advances to the next provider on a retryable error and serves its result', async () => {
      const primary = trackServer(await startLoopbackRpc({ throttle: ['eth_getCode'] }));
      const backup = trackServer(await startLoopbackRpc());
      const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: primary.url, rpcUrls: [backup.url] })));

      // Construct the module over the adapter's bare constructed providers (the
      // multi-RPC retries=0 wiring rides along) — exactly the endpoint thunk the
      // adapter uses, mapping its providers↔rpcUrls into RpcEndpoint pairs at call
      // time (liveness). The read family never signs, so the callback throws if
      // ever reached.
      const client = new RpcFailoverClient(
        () => (a as unknown as { providers: JsonRpcProvider[] }).providers.map(
          (provider, i) => ({ provider, rpcUrl: a.getRpcUrls()[i] }),
        ),
        async () => { throw new Error('read path must not sign'); },
      );

      const code = await client.read('getCode', (p) => p.getCode(HUB));
      expect(code).toBe('0x1234');
      // Immediate: the throttled primary's eth_getCode is attempted exactly ONCE
      // (no 5× same-endpoint backoff before failing over), proving the
      // boundedRetryFetchRequest(url, 0) no-backoff wiring end-to-end.
      expect(primary.hits('eth_getCode')).toBe(1);
      expect(backup.hits('eth_getCode')).toBeGreaterThanOrEqual(1);
    });
  });

  // T6: read failover is OBSERVABLE and HOST-ONLY (no key leak) + bumps the
  // process-wide /api/status counters. The rpc-failover-log unit test already
  // proves rpcHost/noteRpcFailover are host-only in isolation; this proves the
  // READ failover path actually routes through that logger end-to-end — the
  // read-side W3 observability the old code lacked (logging was "WRITE failover
  // only"). Part of the same hard S1-acceptance gate (un-skip with the others).
  describe('TARGET — read failover observability is host-only (R1, T6)', () => {
    beforeEach(() => { _resetRpcFailoverStatsForTest(); });
    afterEach(() => { _resetRpcFailoverStatsForTest(); });

    it('a real read failover logs HOST-ONLY (no URL/key) and increments the failover counter', async () => {
      // Primary URL carries a fake API-key path; the host-only logger must never
      // emit it. The loopback server ignores the path and 429s the read.
      const primary = trackServer(await startLoopbackRpc({ throttle: ['eth_chainId'] }));
      const backup = trackServer(await startLoopbackRpc());
      const primaryWithKey = `${primary.url}/v1/SECRET-API-KEY-abc123`;
      const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: primaryWithKey, rpcUrls: [backup.url] })));

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = ((...args: unknown[]) => { warnings.push(String(args[0])); }) as typeof console.warn;
      try {
        await expect(a.getEvmChainId()).resolves.toBe(31337n);
      } finally {
        console.warn = origWarn;
      }

      // A failover line was emitted, host-only: contains the loopback host but
      // NEVER the scheme or the API key embedded in the configured URL.
      const failoverLines = warnings.filter((w) => w.includes('RPC failover'));
      expect(failoverLines.length).toBeGreaterThanOrEqual(1);
      const joined = failoverLines.join('\n');
      expect(joined).toContain('127.0.0.1');
      expect(joined).not.toContain('SECRET-API-KEY');
      expect(joined).not.toContain('://');

      // Process-wide /api/status counters recorded the read failover, host-only.
      const stats = getRpcFailoverStats();
      expect(stats.failovers).toBeGreaterThanOrEqual(1);
      const hosts = Object.keys(stats.byEndpointHost);
      expect(hosts.some((h) => h.startsWith('127.0.0.1'))).toBe(true);
      expect(hosts.every((h) => !h.includes('SECRET-API-KEY') && !h.includes('://'))).toBe(true);
    });
  });
});
