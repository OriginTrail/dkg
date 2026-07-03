// SPDX-License-Identifier: Apache-2.0
/**
 * The REAL publisher-runtime RPC-usage boundary (#1409 review): a runtime
 * constructed through the production entry point (createPublisherRuntimeFromAgent
 * → per-wallet EVMChainAdapter instances) must expose the raw JSON-RPC requests
 * its adapters actually made via drainRpcUsage(). Construction itself performs
 * real RPC (getIdentityId per wallet) against a loopback server whose own
 * per-method hit log is the source of truth — so this dies if the runtime
 * stops retaining its adapters (`chainAdapters.push`) or drainRpcUsage stops
 * mapping them, the exact mutations the review called out as invisible to the
 * fake-runtime composite test.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { rpcUsageWindowTotal } from '@origintrail-official/dkg-chain';
import { createPublisherRuntimeFromAgent, type PublisherRuntime } from '../src/publisher-runner.js';

// Hardhat dev keys #0 and #1 — loopback only, never touch a real network.
// TWO wallets so the merge across ALL per-wallet adapters is what's proven:
// a regression to draining only chainAdapters[0] undercounts and fails the
// server-hit equality below.
const WALLETS = [
  { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
];
const HUB = '0x0000000000000000000000000000000000000001';
// eth_call answer: 32 bytes that decode BOTH as a non-zero address (Hub
// contract resolution during adapter init must not see ZeroAddress) and as a
// non-zero uint (identityId lookup) — 12 zero bytes + 20 bytes of 0x22.
const CALL32 = '0x' + '00'.repeat(12) + '22'.repeat(20);

/** Minimal loopback JSON-RPC server with a per-method hit log (source of truth). */
async function startLoopback(): Promise<{ url: string; hits: (m: string) => number; totalHits: () => number; close: () => Promise<void> }> {
  const hits = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const answer = (e: { id: number; method: string }) => {
        hits.set(e.method, (hits.get(e.method) ?? 0) + 1);
        const result = e.method === 'eth_chainId' ? '0x7a69'
          : e.method === 'net_version' ? '31337'
          : e.method === 'eth_blockNumber' ? '0x10'
          : e.method === 'eth_getCode' ? '0x1234'
          : CALL32;
        return { jsonrpc: '2.0', id: e.id, result };
      };
      const body = Array.isArray(parsed) ? entries.map(answer) : answer(entries[0]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    hits: (m) => hits.get(m) ?? 0,
    totalHits: () => [...hits.values()].reduce((a, b) => a + b, 0),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('publisher runtime drainRpcUsage — REAL runtime, real adapters, loopback as source of truth', () => {
  let runtime: PublisherRuntime | null = null;
  let store: TripleStore | null = null;
  let loopback: Awaited<ReturnType<typeof startLoopback>> | null = null;
  let dataDir: string | null = null;

  afterEach(async () => {
    await runtime?.stop().catch(() => {});
    await store?.close().catch(() => {});
    await loopback?.close().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    runtime = null; store = null; loopback = null; dataDir = null;
  });

  it('merges BOTH per-wallet adapters’ raw request counts (== loopback hits); drain resets', async () => {
    loopback = await startLoopback();
    dataDir = await mkdtemp(join(tmpdir(), 'pub-rpc-usage-'));
    await writeFile(
      join(dataDir, 'publisher-wallets.json'),
      JSON.stringify({ wallets: WALLETS }),
    );
    store = await createTripleStore({ backend: 'oxigraph' });

    runtime = await createPublisherRuntimeFromAgent({
      dataDir,
      store,
      keypair: await generateEd25519Keypair(),
      chainBase: { rpcUrl: loopback.url, hubAddress: HUB, chainId: 'evm:31337' },
    });

    // Constructing the runtime performed real RPC through BOTH per-wallet
    // adapters (identity lookup et al). The drained window must EQUAL what
    // the loopback actually received — total and per method — which only
    // holds if EVERY adapter's tracker is merged (each wallet's identity
    // lookups bill separately).
    expect(runtime.walletIds).toHaveLength(WALLETS.length);
    const usage = runtime.drainRpcUsage();
    expect(usage).toBeDefined();
    expect(rpcUsageWindowTotal(usage!)).toBeGreaterThanOrEqual(2); // non-vacuous: both adapters made calls
    expect(rpcUsageWindowTotal(usage!)).toBe(loopback.totalHits());
    for (const [method, count] of Object.entries(usage!.byMethod)) {
      expect(loopback.hits(method), `method ${method}`).toBe(count);
    }

    // Delta semantics survive the runtime boundary: second drain is empty.
    const drained = runtime.drainRpcUsage();
    expect(rpcUsageWindowTotal(drained)).toBe(0);
  }, 30_000);
});
