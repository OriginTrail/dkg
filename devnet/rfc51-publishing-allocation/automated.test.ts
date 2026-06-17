/**
 * Automated devnet validation for OT-RFC-51 "Publishing Allocation".
 *
 * Companion to the contract-level Hardhat suite
 * `packages/evm-module/test/v10-rfc-51-publishing-allocation.test.ts` (which
 * proves the seeding math + scoring byte-exact in isolation) and the mock-based
 * route tests `packages/cli/test/daemon-pca-routes.test.ts` (which prove the
 * daemon's request handling with a stubbed facade). This file covers what
 * NEITHER can: the full RFC-51 *creation path* — daemon `POST /api/pca`
 * (parsePrimaryNode + classifyPcaRevert) → agent registry → chain adapter →
 * live `DKGPublishingConvictionNFT.createAccount` → `EpochStorage` seeding — and
 * verifies the on-chain side-effects against a real multi-node devnet.
 *
 * **How to run**:
 *
 *   # 1. Bring up a devnet (two core nodes is enough; this suite does not
 *   #    publish, so it doesn't need the 4-core ACK quorum):
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 2
 *
 *   # 2. Run the suite from repo root:
 *   pnpm test:devnet:rfc51-publishing-allocation
 *
 * Like every devnet suite this is operator-run, NOT part of CI's default
 * fan-out — `devnet.sh start` boots Hardhat + daemons + oxigraph/blazegraph,
 * which is too heavy/brittle for the shared CI runners.
 *
 * The two `it()` blocks assert:
 *   (1) Attribution-follows-param: a PCA created through node1's daemon but
 *       designating node2 seeds node2's committed allocation (summed over the
 *       lock == committedTRAC, exactly) and leaves node1's untouched.
 *   (2) A bad `primaryNode` produces a real ethers-wrapped
 *       `PrimaryNodeNotInShardingTable` revert that the daemon classifies to
 *       HTTP 400 (not 500).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';

const REPO_ROOT = resolve(__dirname, '../..');
const RPC = 'http://127.0.0.1:8545';
const DEVNET_DIR = join(REPO_ROOT, '.devnet');

interface DevnetNode {
  num: number;
  apiPort: number;
  home: string;
  authToken: string;
  /** identityId on chain (0 means daemon hasn't joined yet). */
  identityId: bigint;
  /**
   * Operational wallets. The daemon's conviction signer is `opWallets[0]`
   * (chain adapter `this.signer = new Wallet(operationalKeys[0])`), so that's
   * the EOA that owns — and pays for — a PCA created via `POST /api/pca`.
   */
  opWallets: Array<{ privateKey: string; address: string }>;
  admin: { privateKey: string; address: string };
}

interface DevnetState {
  provider: ethers.JsonRpcProvider;
  hub: ethers.Contract;
  token: ethers.Contract;
  eps: ethers.Contract;
  chronos: ethers.Contract;
  params: ethers.Contract;
  nodes: Record<number, DevnetNode>;
}

const state: { v: DevnetState | null } = { v: null };

// ---- harness helpers (copied from devnet/agent-provenance; no shared module) -

function readNodeConfig(num: number): DevnetNode {
  const home = join(DEVNET_DIR, `node${num}`);
  if (!existsSync(home)) {
    throw new Error(`Devnet node${num} home missing — run ./scripts/devnet.sh start 2 first`);
  }
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const wallets = JSON.parse(readFileSync(join(home, 'wallets.json'), 'utf8'));
  const opWallets: Array<{ privateKey: string; address: string }> = wallets.wallets ?? [];
  if (opWallets.length === 0) {
    throw new Error(`Devnet node${num} has no operational wallet`);
  }
  let authToken = '';
  if (existsSync(join(home, 'auth.token'))) {
    authToken = readFileSync(join(home, 'auth.token'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
  }
  return {
    num,
    apiPort: config.apiPort,
    home,
    authToken,
    identityId: 0n,
    opWallets,
    admin: wallets.adminWallet,
  };
}

async function fetchStatus(node: DevnetNode): Promise<{ identityId: bigint; nodeRole: string }> {
  const res = await fetch(`http://127.0.0.1:${node.apiPort}/api/status`);
  if (!res.ok) throw new Error(`node${node.num} /api/status failed: ${res.status}`);
  const json = (await res.json()) as { identityId: string; nodeRole: string };
  return { identityId: BigInt(json.identityId), nodeRole: json.nodeRole };
}

async function ensureIdentity(node: DevnetNode): Promise<bigint> {
  const status = await fetchStatus(node);
  if (status.identityId > 0n) return status.identityId;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (node.authToken) headers.Authorization = `Bearer ${node.authToken}`;
  const res = await fetch(`http://127.0.0.1:${node.apiPort}/api/identity/ensure`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) {
    throw new Error(`node${node.num} /api/identity/ensure failed: ${res.status} ${await res.text()}`);
  }
  for (let i = 0; i < 30; i++) {
    const st = await fetchStatus(node);
    if (st.identityId > 0n) return st.identityId;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`node${node.num} did not register identity within 30s`);
}

async function loadContractAddresses(provider: ethers.JsonRpcProvider, hubAddress: string) {
  const hub = new ethers.Contract(
    hubAddress,
    ['function getContractAddress(string) view returns (address)'],
    provider,
  );
  return {
    hub,
    tokenAddress: await hub.getContractAddress('Token'),
    // EpochStorage is registered in the Hub under the legacy key 'EpochStorageV8'
    // (deploy/active/010_deploy_epoch_storage.ts: newContractNameInHub).
    epsAddress: await hub.getContractAddress('EpochStorageV8'),
    chronosAddress: await hub.getContractAddress('Chronos'),
    paramsAddress: await hub.getContractAddress('ParametersStorage'),
  };
}

/**
 * Detect a running devnet with at least nodes 1 and 2. Returns null (tests then
 * fail with a clear instruction) if Hardhat or the node homes aren't present.
 */
async function detectDevnet(): Promise<DevnetState | null> {
  if (!existsSync(DEVNET_DIR)) {
    console.error(`detectDevnet: ${DEVNET_DIR} does not exist`);
    return null;
  }
  try {
    const probe = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    if (!probe.ok) {
      console.error(`detectDevnet: hardhat probe failed (${probe.status})`);
      return null;
    }
  } catch (err) {
    console.error(`detectDevnet: hardhat probe threw: ${(err as Error).message}`);
    return null;
  }

  const contractsPath = join(REPO_ROOT, 'packages/evm-module/deployments/localhost_contracts.json');
  if (!existsSync(contractsPath)) {
    console.error(`detectDevnet: ${contractsPath} missing`);
    return null;
  }
  const contractsJson = JSON.parse(readFileSync(contractsPath, 'utf8'));
  const hubAddress: string = contractsJson.contracts?.Hub?.evmAddress ?? contractsJson.Hub;
  if (!hubAddress) {
    console.error('detectDevnet: Hub address missing from localhost_contracts.json');
    return null;
  }

  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 31337, name: 'localhost' });
  const addrs = await loadContractAddresses(provider, hubAddress);

  const token = new ethers.Contract(
    addrs.tokenAddress,
    ['function balanceOf(address) view returns (uint256)'],
    provider,
  );
  const eps = new ethers.Contract(
    addrs.epsAddress,
    [
      'function getNodeEpochPublishingAllocation(uint72, uint256) view returns (uint96)',
      'function getEpochPublishingAllocation(uint256) view returns (uint96)',
    ],
    provider,
  );
  const chronos = new ethers.Contract(
    addrs.chronosAddress,
    ['function getCurrentEpoch() view returns (uint256)'],
    provider,
  );
  const params = new ethers.Contract(
    addrs.paramsAddress,
    ['function publishingConvictionEpochs() view returns (uint256)'],
    provider,
  );

  const nodes: Record<number, DevnetNode> = {};
  for (let i = 1; i <= 2; i++) {
    try {
      nodes[i] = readNodeConfig(i);
    } catch (err) {
      console.error(`detectDevnet: readNodeConfig(${i}) failed: ${(err as Error).message}`);
      return null;
    }
  }
  return { provider, hub: addrs.hub as ethers.Contract, token, eps, chronos, params, nodes };
}

/**
 * Mint TRAC to `address` via a direct storage write (no on-chain tx). Token is
 * `Ownable, ERC20, AccessControl` → ERC20 `_balances` is at slot 1 (Ownable's
 * `_owner` is slot 0). Key for `mapping(address=>uint256)`:
 * `keccak256(abi.encode(holder, slot))`.
 */
async function fundTrac(s: DevnetState, address: string, amount: bigint): Promise<void> {
  const tokenAddress = await s.token.getAddress();
  const slotKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [address, 1n]),
  );
  await s.provider.send('hardhat_setStorageAt', [
    tokenAddress,
    slotKey,
    ethers.zeroPadValue(ethers.toBeHex(amount), 32),
  ]);
  const funded: bigint = await s.token.balanceOf(address);
  if (funded !== amount) {
    throw new Error(
      `fundTrac: setStorageAt did not land (expected ${amount}, got ${funded}); ERC20 _balances slot may have moved`,
    );
  }
}

/** POST /api/pca on `node`'s daemon. Returns the HTTP status + parsed body. */
async function postPca(
  node: DevnetNode,
  body: { tokens: string; primaryNode?: string },
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (node.authToken) headers.Authorization = `Bearer ${node.authToken}`;
  const res = await fetch(`http://127.0.0.1:${node.apiPort}/api/pca`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

/** Sum getNodeEpochPublishingAllocation(id, e) for e in [from, to] inclusive. */
async function sumNodeAllocation(
  eps: ethers.Contract,
  identityId: bigint,
  from: bigint,
  to: bigint,
): Promise<bigint> {
  let total = 0n;
  for (let e = from; e <= to; e++) {
    total += (await eps.getNodeEpochPublishingAllocation(identityId, e)) as bigint;
  }
  return total;
}

/** Sum getEpochPublishingAllocation(e) (network-wide) for e in [from, to]. */
async function sumEpochAllocation(
  eps: ethers.Contract,
  from: bigint,
  to: bigint,
): Promise<bigint> {
  let total = 0n;
  for (let e = from; e <= to; e++) {
    total += (await eps.getEpochPublishingAllocation(e)) as bigint;
  }
  return total;
}

// ---- suite ------------------------------------------------------------------

describe('OT-RFC-51 publishing allocation — automated devnet validation', () => {
  beforeAll(async () => {
    state.v = await detectDevnet();
    if (!state.v) {
      throw new Error(
        'Devnet not running. Run `./scripts/devnet.sh clean && ./scripts/devnet.sh start 2` first.',
      );
    }
    // Both cores must have on-chain identities: node2 is the designated
    // primaryNode (must be in the sharding table), node1 is the caller whose
    // own allocation we assert stays untouched.
    for (let i = 1; i <= 2; i++) {
      const node = state.v.nodes[i]!;
      node.identityId = await ensureIdentity(node);
      if (node.identityId === 0n) throw new Error(`node${i} has no identity`);
    }
  }, 120_000);

  // =========================================================================
  // Attribution-follows-param: the heart of RFC-51. A staker (here node1's
  // daemon EOA) commits TRAC and designates a node of their CHOICE (node2),
  // which need not be the node they transact through. The committed allocation
  // must seed node2 — not node1 — across the lock, summing to committedTRAC.
  // =========================================================================
  it('PCA via node1 designating node2 seeds node2 (sum==committed), not node1', async () => {
    const s = state.v!;
    const caller = s.nodes[1]!;   // daemon we POST to (PCA owner = its opWallets[0])
    const target = s.nodes[2]!;   // the designated primaryNode

    // Fund the caller daemon's conviction signer (opWallets[0]); the adapter
    // auto-approves the NFT to pull committedTRAC.
    const committed = ethers.parseEther('100000');
    await fundTrac(s, caller.opWallets[0]!.address, committed + ethers.parseEther('1'));

    // Bound the seed range by the protocol lock duration; buckets are seeded
    // up front for the whole lock, so no time-travel is needed.
    const lock: bigint = await s.params.publishingConvictionEpochs();
    expect(lock).toBeGreaterThan(0n);
    const epoch: bigint = await s.chronos.getCurrentEpoch();
    const from = epoch;
    const to = epoch + lock + 2n; // +2 slack for a mid-test epoch tick / proration tail

    // Snapshot BEFORE (robust to any pre-existing allocation on either node).
    // Sum over the whole lock window so the assertion is independent of where
    // in the current epoch creation lands (proration splits the first epoch).
    const beforeTarget = await sumNodeAllocation(s.eps, target.identityId, from, to);
    const beforeCaller = await sumNodeAllocation(s.eps, caller.identityId, from, to);
    const beforeTotal = await sumEpochAllocation(s.eps, from, to);

    // Create the PCA through node1's daemon, designating node2.
    const { status, json } = await postPca(caller, {
      tokens: '100000',
      primaryNode: target.identityId.toString(),
    });
    expect(status, `POST /api/pca → ${status}: ${JSON.stringify(json)}`).toBe(200);
    expect(BigInt(json.accountId)).toBeGreaterThan(0n);

    // Snapshot AFTER.
    const afterTarget = await sumNodeAllocation(s.eps, target.identityId, from, to);
    const afterCaller = await sumNodeAllocation(s.eps, caller.identityId, from, to);
    const afterTotal = await sumEpochAllocation(s.eps, from, to);

    // THE proof: the designated node's committed allocation grew by EXACTLY
    // committedTRAC (proration distributes committed across the lock with the
    // dust swept into the tail — the per-epoch slices sum to committed exactly).
    expect(afterTarget - beforeTarget).toBe(committed);

    // The caller's own node got NOTHING — attribution followed the param, not
    // the node the PCA was created through.
    expect(afterCaller - beforeCaller).toBe(0n);

    // The network-wide per-epoch totals also reflect the seeding (>= because a
    // busy devnet could seed other nodes concurrently; never less than ours).
    expect(afterTotal - beforeTotal).toBeGreaterThanOrEqual(committed);
  }, 120_000);

  // =========================================================================
  // Bad primaryNode → HTTP 400. The contract reverts PrimaryNodeNotInShardingTable
  // for a node not in the sharding table; on a live chain that arrives
  // ethers-wrapped. This proves the real revert carries the error NAME so the
  // daemon's classifyPcaRevert maps it to a caller-actionable 400, not a 500 —
  // exactly what the mock-based route test (fed a synthetic string) can't show.
  // =========================================================================
  it('non-existent primaryNode → HTTP 400 PrimaryNodeNotInShardingTable (real revert)', async () => {
    const s = state.v!;
    const caller = s.nodes[1]!;

    // Fund so the failure is the node check, not InvalidAmount / no-balance.
    await fundTrac(s, caller.opWallets[0]!.address, ethers.parseEther('100001'));

    // A node id that cannot exist in any devnet's sharding table.
    const bogusNode = '999999999';
    const { status, json } = await postPca(caller, { tokens: '100000', primaryNode: bogusNode });

    expect(status, `expected 400 for bogus node, got ${status}: ${JSON.stringify(json)}`).toBe(400);
    expect(String(json?.error)).toContain('PrimaryNodeNotInShardingTable');
  }, 120_000);
});
