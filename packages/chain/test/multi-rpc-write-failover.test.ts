// SPDX-License-Identifier: Apache-2.0
/**
 * INV-7 (writes): REAL multi-RPC WRITE failover over loopback JSON-RPC servers
 * — the write-side mirror of T1, closing the same false-green.
 *
 * The ~170 existing write-failover tests inject bare-object providers
 * (`(a as any).providers = [primary, backup]`) whose `broadcastTransaction`
 * throws synchronously, so they prove the failover LOOP advances but can NEVER
 * prove "no per-endpoint backoff": they bypass `boundedRetryFetchRequest` /
 * `FetchRequest` entirely, so they pass identically whether the multi-RPC
 * per-endpoint retry budget is 0 or 5. This drives a REAL `JsonRpcProvider`'s
 * `broadcastTransaction` against loopback servers, so the failed primary's
 * `eth_sendRawTransaction` is counted and "exactly once" actually means
 * immediate failover.
 *
 * Note: ethers' `broadcastTransaction` re-parses the signed tx and asserts the
 * node's returned hash equals the tx hash — so the accepting server must return
 * the REAL hash of the signed tx (computed below), not a dummy.
 *
 * CONTROL (healthy primary) is GREEN today. The `describe.skip` TARGET is part of
 * the HARD S1-acceptance gate (see multi-rpc-read-failover.test.ts header):
 * UN-SKIP it the moment ChainEngineer wires multi-RPC provider construction to
 * `boundedRetryFetchRequest(url, 0)`; it MUST then be GREEN (S1 not complete
 * until live-green). On the current code (retry budget 5) the failed primary's
 * broadcast is retried ~6× over ~7.5s before failover, so the "hit exactly once
 * / bounded" assertions are RED today — exactly the immediate-failover
 * regression this gate locks. VERIFIED 2026-06-25: un-skipped against S1 these
 * PASS (3/3). Kept skip only while S1 is mid-flight.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { startLoopbackRpc, type LoopbackRpc } from './loopback-rpc-harness.js';

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

/** A real, offline-signed legacy tx + its canonical hash (no RPC contact). */
async function signTx(): Promise<{ signedTx: string; txHash: string }> {
  const wallet = new ethers.Wallet(DEPLOYER_PK);
  const signedTx = await wallet.signTransaction({
    to: HUB,
    nonce: 0,
    gasLimit: 21_000,
    gasPrice: 1_000_000_000,
    value: 0,
    chainId: 31337,
  });
  return { signedTx, txHash: ethers.Transaction.from(signedTx).hash! };
}

describe('multi-RPC write failover (real loopback providers)', () => {
  const adapters: EVMChainAdapter[] = [];
  const servers: LoopbackRpc[] = [];
  function track(a: EVMChainAdapter): EVMChainAdapter { adapters.push(a); return a; }
  function trackServer(s: LoopbackRpc): LoopbackRpc { servers.push(s); return s; }

  afterEach(async () => {
    for (const a of adapters.splice(0)) {
      try { a.destroy(); } catch { /* idempotent */ }
    }
    for (const s of servers.splice(0)) await s.close();
  });

  // These tests drive the real adapter via the retained D3 delegator
  // `broadcastSignedTransactionWithFailover` (#1336) to prove the broadcast loop
  // over REAL loopback providers. The module-level broadcast assertion-port
  // checklist (isKnownTransactionError short-circuit, exhaustion code-stamp,
  // host-only message) lives in rpc-failover-client.unit.test.ts.
  // ── CONTROL (GREEN today): real broadcast over a healthy loopback provider ──
  it('control: broadcasts a real signed tx to a healthy primary (no failover)', async () => {
    const { signedTx, txHash } = await signTx();
    const primary = trackServer(await startLoopbackRpc({ results: { eth_sendRawTransaction: txHash } }));
    const backup = trackServer(await startLoopbackRpc({ results: { eth_sendRawTransaction: txHash } }));
    const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: primary.url, rpcUrls: [backup.url] })));

    await expect(
      (a as any).broadcastSignedTransactionWithFailover(signedTx, txHash, 'unit write'),
    ).resolves.toBeUndefined();
    expect(primary.hits('eth_sendRawTransaction')).toBe(1);
    expect(backup.hits('eth_sendRawTransaction')).toBe(0); // healthy primary → never reached
  });

  // ── TARGET (immediate failover): un-skip after retries=0 on write providers ──
  // RED today (retry budget 5 → primary broadcast retried ~6× over ~7.5s before
  // failover); GREEN once multi-RPC providers are built with
  // boundedRetryFetchRequest(url, 0). The SAME signed tx is re-broadcast to the
  // backup (idempotent, INV-4); the failed primary is hit exactly once (INV-7).
  describe('TARGET — immediate write failover (retries=0, R1)', () => {
    it('primary 429 on broadcast → SAME tx accepted by backup, primary hit exactly once, bounded', async () => {
      const { signedTx, txHash } = await signTx();
      const primary = trackServer(await startLoopbackRpc({ throttle: ['eth_sendRawTransaction'] }));
      const backup = trackServer(await startLoopbackRpc({ results: { eth_sendRawTransaction: txHash } }));
      const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: primary.url, rpcUrls: [backup.url] })));

      const start = Date.now();
      await expect(
        (a as any).broadcastSignedTransactionWithFailover(signedTx, txHash, 'unit write'),
      ).resolves.toBeUndefined();
      const elapsed = Date.now() - start;

      // Immediate: the 429ing primary's eth_sendRawTransaction is attempted
      // EXACTLY once (no 5× same-endpoint backoff) and the SAME raw tx is
      // accepted by the backup. Bounded well under the 10s broadcast timeout.
      expect(primary.hits('eth_sendRawTransaction')).toBe(1);
      expect(backup.hits('eth_sendRawTransaction')).toBe(1);
      expect(elapsed).toBeLessThan(2_000);
    });

    it('all endpoints 429 on broadcast → RPC_ENDPOINTS_EXHAUSTED, one attempt per endpoint', async () => {
      const { signedTx, txHash } = await signTx();
      const primary = trackServer(await startLoopbackRpc({ throttle: ['eth_sendRawTransaction'] }));
      const backup = trackServer(await startLoopbackRpc({ throttle: ['eth_sendRawTransaction'] }));
      const a = track(new EVMChainAdapter(minimalConfig({ rpcUrl: primary.url, rpcUrls: [backup.url] })));

      await expect(
        (a as any).broadcastSignedTransactionWithFailover(signedTx, txHash, 'unit write'),
      ).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
      expect(primary.hits('eth_sendRawTransaction')).toBe(1);
      expect(backup.hits('eth_sendRawTransaction')).toBe(1);
    });
  });
});
