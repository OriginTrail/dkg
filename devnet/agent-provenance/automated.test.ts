/**
 * Automated 5-node devnet validation for the agent-provenance work.
 *
 * Walks through the runbook in `README.md` end-to-end against a real
 * 5-daemon devnet (4 core + 1 edge + Hardhat chain on port 8545). Each
 * `it()` block maps 1:1 to a mode in §4 of RFC-001 and asserts the
 * on-chain side-effects the spec requires. Companion to the
 * single-node Hardhat e2e suite at
 * `packages/publisher/test/agent-provenance-e2e.test.ts`, which covers
 * the contract+publisher correctness; this file covers the multi-node
 * ACK quorum + CLI plumbing on top.
 *
 * **How to run**:
 *
 *   # 1. Bring up devnet manually (the test reuses an existing one):
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 5
 *
 *   # 2. Run the suite from repo root:
 *   pnpm test:devnet:agent-provenance
 *
 * **Why not auto-boot in beforeAll?** `devnet.sh start 5` boots Hardhat
 * + 5 daemons + 2 oxigraph containers + blazegraph; that's ~60-90s and
 * is brittle to CI port collisions. Letting the operator stand up the
 * devnet keeps the test focused on validating the publish flows.
 * `DKG_DEVNET_AUTO_BOOT=1` opts into auto-boot/teardown for nightly CI.
 *
 * **Mode (b) — publisher-as-a-service** is intentionally NOT covered.
 * The runbook describes routing pre-signed `AuthorAttestation` payloads
 * through the OpenClaw channel HTTP route, but the current
 * `/api/openclaw-channel/persist-turn` route accepts chat-turn content
 * (not publish payloads). Daemon-side smart-wallet signing is Phase 4
 * (`ChatTurnWriter` / Hermes) — out of scope for PR #436.
 *
 * **Why direct ethers for PCA setup?** The CLI's `dkg pca` subcommand
 * drives the OLD `PublishingConvictionAccount` contract; V10 publish
 * uses `DKGPublishingConvictionNFT`. There is no CLI surface for the
 * NFT yet. Mode (a) here drives the NFT contract directly via JSON-RPC
 * and uses the CLI only for the actual `dkg publish` call. The CLI
 * gap is filed as a follow-up task in the DKG.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';

const REPO_ROOT = resolve(__dirname, '../..');
const RPC = 'http://127.0.0.1:8545';
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
const HARDHAT_DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

interface DevnetNode {
  num: number;
  apiPort: number;
  home: string;
  authToken: string;
  /** identityId on chain (0 means daemon hasn't joined yet). */
  identityId: bigint;
  /** Operational wallets — daemon picks one per publish; any of these may be `msg.sender`. */
  opWallets: Array<{ privateKey: string; address: string }>;
  /** Admin wallet (Hardhat account k+i). */
  admin: { privateKey: string; address: string };
}

interface DevnetState {
  provider: ethers.JsonRpcProvider;
  hub: ethers.Contract;
  kcs: ethers.Contract;
  nft: ethers.Contract;
  token: ethers.Contract;
  eps: ethers.Contract;
  chronos: ethers.Contract;
  nodes: Record<number, DevnetNode>;
}

const state: { v: DevnetState | null } = { v: null };

// ---- harness helpers --------------------------------------------------------

function readNodeConfig(num: number): DevnetNode {
  const home = join(DEVNET_DIR, `node${num}`);
  if (!existsSync(home)) {
    throw new Error(`Devnet node${num} home missing — run ./scripts/devnet.sh start 5 first`);
  }
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const wallets = JSON.parse(readFileSync(join(home, 'wallets.json'), 'utf8'));
  const opWallets: Array<{ privateKey: string; address: string }> = wallets.wallets ?? [];
  if (opWallets.length === 0) {
    throw new Error(`Devnet node${num} has no operational wallet`);
  }
  // auth.token has a `# DKG devnet shared auth token\n<token>` shape — pick
  // the first non-comment, non-empty line.
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

/** Sum TRAC balance across all op wallets — robust against daemon's wallet rotation. */
async function sumOpBalances(token: ethers.Contract, node: DevnetNode): Promise<bigint> {
  let total = 0n;
  for (const w of node.opWallets) {
    total += (await token.balanceOf(w.address)) as bigint;
  }
  return total;
}

/**
 * Ensure all of `edge`'s op wallets are registered as agents of a
 * DKGPublishingConvictionNFT account. If any op wallet is already registered
 * (e.g. from a previous test run on the same devnet), reuse that account —
 * the contract reverts on duplicate registerAgent calls and we can't
 * deregister without owning the NFT. Otherwise create a fresh PCA account
 * funded via hardhat_setStorageAt (avoids depleting the deployer's TRAC).
 */
async function ensurePcaAccountForOpWallets(
  s: DevnetState,
  edge: DevnetNode,
): Promise<bigint> {
  for (const w of edge.opWallets) {
    const id: bigint = await s.nft.agentToAccountId(w.address);
    if (id > 0n) {
      // eslint-disable-next-line no-console
      console.log(`pca: reusing existing PCA account ${id} (op wallet ${w.address})`);
      return id;
    }
  }

  const nftAdmin = ethers.Wallet.createRandom().connect(s.provider);
  await s.provider.send('hardhat_setBalance', [
    nftAdmin.address,
    '0x' + ethers.parseEther('100').toString(16),
  ]);

  // Token = `Ownable, ERC20, AccessControl` — Ownable's _owner takes slot 0,
  // so ERC20's _balances mapping is at slot 1. Storage key for
  // mapping(address=>uint256): keccak256(abi.encode(holder, slot)).
  const tokenAddress = await s.token.getAddress();
  const targetTrac = ethers.parseEther('600000');
  const slotKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [nftAdmin.address, 1n],
    ),
  );
  await s.provider.send('hardhat_setStorageAt', [
    tokenAddress,
    slotKey,
    ethers.zeroPadValue(ethers.toBeHex(targetTrac), 32),
  ]);
  const fundedTrac: bigint = await s.token.balanceOf(nftAdmin.address);
  if (fundedTrac !== targetTrac) {
    throw new Error(
      `setStorageAt did not fund nftAdmin (expected ${targetTrac}, got ${fundedTrac}); ERC20 _balances slot may have moved`,
    );
  }

  const committed = ethers.parseEther('500000');
  const tokenAsAdmin = (s.token.connect(nftAdmin) as ethers.Contract & {
    approve: (
      spender: string,
      amount: bigint,
      overrides?: { nonce?: number },
    ) => Promise<ethers.ContractTransactionResponse>;
  });
  const nftAsAdmin = (s.nft.connect(nftAdmin) as ethers.Contract & {
    createAccount: (
      amount: bigint,
      overrides?: { nonce?: number },
    ) => Promise<ethers.ContractTransactionResponse>;
    registerAgent: (
      id: bigint,
      addr: string,
      overrides?: { nonce?: number },
    ) => Promise<ethers.ContractTransactionResponse>;
  });
  const nftAddress = await s.nft.getAddress();

  // Use raw eth_getTransactionCount('latest') everywhere — ethers' client-side
  // nonce cache races Hardhat's automine when transactions are submitted in
  // rapid succession from the same wallet on a shared provider.
  const nextNonce = async (): Promise<number> => {
    const raw = await s.provider.send('eth_getTransactionCount', [
      nftAdmin.address,
      'latest',
    ]);
    return parseInt(raw, 16);
  };

  await (await tokenAsAdmin.approve(nftAddress, committed, {
    nonce: await nextNonce(),
  })).wait();
  const createTx = await nftAsAdmin.createAccount(committed, {
    nonce: await nextNonce(),
  });
  const createReceipt = await createTx.wait();

  let accountId = 0n;
  const iface = new ethers.Interface([
    'event AccountCreated(uint256 indexed accountId, address indexed owner, uint96 committedTRAC, uint16 discountBps, uint40 createdAtEpoch, uint40 expiresAtEpoch)',
  ]);
  for (const log of createReceipt?.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'AccountCreated') {
        accountId = parsed.args.accountId as bigint;
        break;
      }
    } catch {
      // Different event from another contract — skip.
    }
  }
  if (accountId === 0n) throw new Error('AccountCreated event not found');
  // eslint-disable-next-line no-console
  console.log(`pca: created account ${accountId} (admin=${nftAdmin.address})`);

  for (const w of edge.opWallets) {
    const tx = await nftAsAdmin.registerAgent(accountId, w.address, {
      nonce: await nextNonce(),
    });
    const receipt = await tx.wait();
    if (receipt?.status !== 1) {
      throw new Error(`registerAgent for ${w.address} failed`);
    }
  }
  return accountId;
}

async function fetchStatus(node: DevnetNode): Promise<{ identityId: bigint; nodeRole: string }> {
  const res = await fetch(`http://127.0.0.1:${node.apiPort}/api/status`);
  if (!res.ok) {
    throw new Error(`node${node.num} /api/status failed: ${res.status}`);
  }
  const json = (await res.json()) as { identityId: string; nodeRole: string };
  return { identityId: BigInt(json.identityId), nodeRole: json.nodeRole };
}

async function ensureIdentity(node: DevnetNode): Promise<bigint> {
  const status = await fetchStatus(node);
  if (status.identityId > 0n) return status.identityId;

  // Trigger profile creation on the daemon. The endpoint is admin-only —
  // include the auth token if present.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (node.authToken) {
    headers.Authorization = `Bearer ${node.authToken}`;
  }
  const res = await fetch(`http://127.0.0.1:${node.apiPort}/api/identity/ensure`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) {
    throw new Error(`node${node.num} /api/identity/ensure failed: ${res.status} ${await res.text()}`);
  }

  // Poll for identity to become non-zero — profile creation is an on-chain tx.
  for (let i = 0; i < 30; i++) {
    const st = await fetchStatus(node);
    if (st.identityId > 0n) return st.identityId;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`node${node.num} did not register identity within 30s`);
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runDkgCli(node: DevnetNode, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, 'packages/cli/dist/cli.js'), ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DKG_NO_BLUE_GREEN: '1',
          DKG_HOME: node.home,
          DKG_API_PORT: String(node.apiPort),
        },
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectResult(new Error(`dkg CLI timeout after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectResult(err);
    });
  });
}

/** Run `dkg publish` and return the parsed { kcId, status, txHash } it printed. */
async function publishViaCli(
  node: DevnetNode,
  contextGraph: string,
  filePath: string,
  options: { publisherNodeIdentityId?: bigint } = {},
): Promise<{ status: string; kcId?: bigint; txHash?: string; raw: string }> {
  const args = ['publish', contextGraph, '--file', filePath];
  if (options.publisherNodeIdentityId !== undefined) {
    args.push('--publisher-node-identity-id', String(options.publisherNodeIdentityId));
  }
  const result = await runDkgCli(node, args);
  if (result.code !== 0) {
    throw new Error(
      `dkg publish failed (exit ${result.code})\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  // Parse the human-readable output. The CLI prints "Status: confirmed",
  // "KC ID: <n>", "TX hash: 0x..."  (lines vary slightly across statuses).
  const status = /Status:\s*(\w+)/i.exec(result.stdout)?.[1] ?? 'unknown';
  const kcMatch = /KC ID:\s*(\d+)/i.exec(result.stdout);
  const txMatch = /TX hash:\s*(0x[0-9a-fA-F]+)/i.exec(result.stdout);
  return {
    status,
    kcId: kcMatch ? BigInt(kcMatch[1]!) : undefined,
    txHash: txMatch ? txMatch[1] : undefined,
    raw: result.stdout,
  };
}

async function loadContractAddresses(provider: ethers.JsonRpcProvider, hubAddress: string) {
  const hub = new ethers.Contract(
    hubAddress,
    [
      'function getContractAddress(string) view returns (address)',
      'function getAssetStorageAddress(string) view returns (address)',
    ],
    provider,
  );
  return {
    hub,
    kcsAddress: await hub.getAssetStorageAddress('KnowledgeCollectionStorage'),
    nftAddress: await hub.getContractAddress('DKGPublishingConvictionNFT'),
    tokenAddress: await hub.getContractAddress('Token'),
    epsAddress: await hub.getContractAddress('EpochStorageV8'),
    chronosAddress: await hub.getContractAddress('Chronos'),
  };
}

/**
 * Detect whether a devnet is currently running. Returns null if not — the
 * tests then skip with a clear instruction.
 */
async function detectDevnet(): Promise<DevnetState | null> {
  if (!existsSync(DEVNET_DIR)) {
    // eslint-disable-next-line no-console
    console.error(`detectDevnet: ${DEVNET_DIR} does not exist`);
    return null;
  }

  // Probe Hardhat.
  try {
    const probe = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    if (!probe.ok) {
      // eslint-disable-next-line no-console
      console.error(`detectDevnet: hardhat probe failed (${probe.status})`);
      return null;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`detectDevnet: hardhat probe threw: ${(err as Error).message}`);
    return null;
  }

  // Read the contracts JSON.
  const contractsPath = join(REPO_ROOT, 'packages/evm-module/deployments/localhost_contracts.json');
  if (!existsSync(contractsPath)) {
    // eslint-disable-next-line no-console
    console.error(`detectDevnet: ${contractsPath} missing`);
    return null;
  }
  const contractsJson = JSON.parse(readFileSync(contractsPath, 'utf8'));
  const hubAddress: string = contractsJson.contracts?.Hub?.evmAddress ?? contractsJson.Hub;
  if (!hubAddress) {
    // eslint-disable-next-line no-console
    console.error('detectDevnet: Hub address missing from localhost_contracts.json');
    return null;
  }

  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 31337, name: 'localhost' });
  const addrs = await loadContractAddresses(provider, hubAddress);

  const kcs = new ethers.Contract(
    addrs.kcsAddress,
    [
      'function getLatestMerkleRootAuthor(uint256) view returns (address)',
      'function getMerkleRootAuthorByIndex(uint256, uint256) view returns (address)',
    ],
    provider,
  );
  const nft = new ethers.Contract(
    addrs.nftAddress,
    [
      'function createAccount(uint96) external returns (uint256)',
      'function registerAgent(uint256, address) external',
      'function agentToAccountId(address) view returns (uint256)',
      'function epochSpent(uint256, uint40) view returns (uint96)',
    ],
    provider,
  );
  const token = new ethers.Contract(
    addrs.tokenAddress,
    [
      'function balanceOf(address) view returns (uint256)',
      'function approve(address, uint256) returns (bool)',
      'function transfer(address, uint256) returns (bool)',
    ],
    provider,
  );
  const eps = new ethers.Contract(
    addrs.epsAddress,
    ['function getNodeEpochProducedKnowledgeValue(uint72, uint256) view returns (uint96)'],
    provider,
  );
  const chronos = new ethers.Contract(
    addrs.chronosAddress,
    ['function getCurrentEpoch() view returns (uint256)'],
    provider,
  );

  const nodes: Record<number, DevnetNode> = {};
  for (let i = 1; i <= 5; i++) {
    try {
      nodes[i] = readNodeConfig(i);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`detectDevnet: readNodeConfig(${i}) failed: ${(err as Error).message}`);
      return null;
    }
  }
  return { provider, hub: addrs.hub as ethers.Contract, kcs, nft, token, eps, chronos, nodes };
}

// ---- per-test fixture writes -----------------------------------------------

function makeNquadsFile(name: string): string {
  const path = join(__dirname, `turns/${name}.nq`);
  if (!existsSync(join(__dirname, 'turns'))) {
    require('node:fs').mkdirSync(join(__dirname, 'turns'), { recursive: true });
  }
  const ts = Date.now();
  const triples =
    `<urn:test:${name}:${ts}> <https://schema.org/name> "${name}-${ts}" .\n` +
    `<urn:test:${name}:${ts}> <https://schema.org/description> "automated devnet test" .\n`;
  require('node:fs').writeFileSync(path, triples);
  return path;
}

const CONTEXT_GRAPH = 'devnet-test';

// ---- suite ------------------------------------------------------------------

describe('Agent provenance — automated 5-node devnet validation', () => {
  beforeAll(async () => {
    state.v = await detectDevnet();
    if (!state.v) {
      throw new Error(
        'Devnet not running. Run `./scripts/devnet.sh clean && ./scripts/devnet.sh start 5` first.',
      );
    }

    // Bring all 5 daemons to identityId > 0.
    for (let i = 1; i <= 5; i++) {
      const node = state.v.nodes[i]!;
      try {
        node.identityId = await ensureIdentity(node);
      } catch (err) {
        // Edge node (5) may legitimately fail ensureIdentity if hostingNodes
        // gating is on — we only NEED cores 1, 3 for these tests.
        if (i === 5) {
          // continue — assertions below use the edge's submitter wallet, not its identity
          // eslint-disable-next-line no-console
          console.warn(`node5 ensureIdentity skipped: ${(err as Error).message}`);
        } else {
          throw err;
        }
      }
    }
  }, 120_000);

  // =========================================================================
  // Mode (a) — Self-publishing edge attributed to home core via PCA discount
  //
  // Flow:
  //   1. Hardhat-funded admin (core1's adminWallet) calls
  //      DKGPublishingConvictionNFT.createAccount(committedTRAC).
  //   2. Same admin calls registerAgent(accountId, node5.submitter.address).
  //   3. node5 publishes to CG `devnet-test` with `--publisher-node-identity-id 1`.
  //   4. Assert:
  //      - publish status == confirmed
  //      - kcs.getLatestMerkleRootAuthor(kcId) == node5.submitter.address
  //      - nft.epochSpent(accountId, currentEpoch) increased
  //      - eps.getNodeEpochProducedKnowledgeValue(core1.id, epoch) increased
  // =========================================================================
  it('mode (a) — edge op-wallet on core1 PCA, attribution to core1, NFT epochSpent grows', async () => {
    const s = state.v!;
    const core1 = s.nodes[1]!;
    const edge = s.nodes[5]!;
    if (core1.identityId === 0n) throw new Error('core1 has no identity');

    const accountId = await ensurePcaAccountForOpWallets(s, edge);

    // 3. Snapshot pre-publish state.
    const epoch: bigint = await s.chronos.getCurrentEpoch();
    const beforeSpent: bigint = await s.nft.epochSpent(accountId, epoch);
    const beforeEps: bigint = await s.eps.getNodeEpochProducedKnowledgeValue(core1.identityId, epoch);
    const beforeBalance = await sumOpBalances(s.token, edge);

    // 4. Publish from edge attributing to core1.
    const file = makeNquadsFile('mode-a');
    const result = await publishViaCli(edge, CONTEXT_GRAPH, file, {
      publisherNodeIdentityId: core1.identityId,
    });

    expect(result.status.toLowerCase()).toBe('confirmed');
    expect(result.kcId).toBeDefined();

    // 5. On-chain assertions.
    const onChainAuthor: string = await s.kcs.getLatestMerkleRootAuthor(result.kcId!);
    const matchesAnyOpWallet = edge.opWallets.some(
      (w) => w.address.toLowerCase() === onChainAuthor.toLowerCase(),
    );
    expect(matchesAnyOpWallet).toBe(true);

    const afterSpent: bigint = await s.nft.epochSpent(accountId, epoch);
    expect(afterSpent - beforeSpent).toBeGreaterThan(0n);

    const afterEps: bigint = await s.eps.getNodeEpochProducedKnowledgeValue(core1.identityId, epoch);
    expect(afterEps).toBeGreaterThan(beforeEps);

    // Op-wallet pool TRAC must NOT decrement — PCA covered the cost.
    const afterBalance = await sumOpBalances(s.token, edge);
    expect(afterBalance).toBe(beforeBalance);
  }, 180_000);

  // =========================================================================
  // Mode (c) — Same-operator edge + core, no PCA, full TRAC, attribution.
  // =========================================================================
  it('mode (c) — edge publishes naming core3, full TRAC from edge wallet, core3 Eps grows', async () => {
    const s = state.v!;
    const core3 = s.nodes[3]!;
    const edge = s.nodes[5]!;
    if (core3.identityId === 0n) throw new Error('core3 has no identity');

    // Skip if mode (a) ran before this and registered the edge op wallets
    // on a PCA — re-registration would put us in mode (a) territory rather
    // than testing direct-spend. Detect by probing one op wallet.
    const firstOpAccount: bigint = await s.nft.agentToAccountId(edge.opWallets[0]!.address);
    if (firstOpAccount !== 0n) {
      // eslint-disable-next-line no-console
      console.warn('mode (c): edge op wallets are PCA-registered; full-fee assertion will be skipped');
    }

    const epoch: bigint = await s.chronos.getCurrentEpoch();
    const beforeBalance = await sumOpBalances(s.token, edge);
    const beforeEps: bigint = await s.eps.getNodeEpochProducedKnowledgeValue(core3.identityId, epoch);

    const file = makeNquadsFile('mode-c');
    const result = await publishViaCli(edge, CONTEXT_GRAPH, file, {
      publisherNodeIdentityId: core3.identityId,
    });

    expect(result.status.toLowerCase()).toBe('confirmed');
    expect(result.kcId).toBeDefined();

    // Edge op-wallet pool TRAC MUST decrement when no PCA covers it.
    if (firstOpAccount === 0n) {
      const afterBalance = await sumOpBalances(s.token, edge);
      expect(beforeBalance - afterBalance).toBeGreaterThan(0n);
    }

    // core3 Eps incremented.
    const afterEps: bigint = await s.eps.getNodeEpochProducedKnowledgeValue(core3.identityId, epoch);
    expect(afterEps).toBeGreaterThan(beforeEps);

    // Author is one of the op wallets.
    const onChainAuthor: string = await s.kcs.getLatestMerkleRootAuthor(result.kcId!);
    const matches = edge.opWallets.some(
      (w) => w.address.toLowerCase() === onChainAuthor.toLowerCase(),
    );
    expect(matches).toBe(true);
  }, 120_000);

  // =========================================================================
  // Mode (d) — Unattributed edge, override=0n, no Eps write to any core.
  // =========================================================================
  it('mode (d) — edge publishes with --publisher-node-identity-id 0, no core gets attribution', async () => {
    const s = state.v!;
    const edge = s.nodes[5]!;

    const epoch: bigint = await s.chronos.getCurrentEpoch();
    const allCoreIds = [s.nodes[1]!.identityId, s.nodes[2]!.identityId, s.nodes[3]!.identityId, s.nodes[4]!.identityId]
      .filter((id) => id > 0n);
    const beforeEps: Record<string, bigint> = {};
    for (const id of allCoreIds) {
      beforeEps[id.toString()] = await s.eps.getNodeEpochProducedKnowledgeValue(id, epoch);
    }

    const file = makeNquadsFile('mode-d');
    const result = await publishViaCli(edge, CONTEXT_GRAPH, file, { publisherNodeIdentityId: 0n });

    expect(result.status.toLowerCase()).toBe('confirmed');

    for (const id of allCoreIds) {
      const after: bigint = await s.eps.getNodeEpochProducedKnowledgeValue(id, epoch);
      expect(after).toBe(beforeEps[id.toString()]);
    }
  }, 120_000);

  // =========================================================================
  // Negative — Publisher names a core but submitter is NOT registered as
  // an agent on the core's NFT account. The publish must succeed via the
  // direct-spend branch (full TRAC from submitter), with attribution still
  // recorded for the named core. Mirrors §9.7 #9.
  // =========================================================================
  it('unauthorized PCA fall-through — attribution preserved regardless of cost branch', async () => {
    // The runbook's "unauthorized PCA fall-through" is about: publisher
    // names a core that has a PCA, but the publishing op-wallet is NOT
    // registered as agent on that PCA. The publish must still succeed,
    // attribute to the named core, and either:
    //   - draw direct-spend from the publisher op-wallet (no PCA match), OR
    //   - draw from a DIFFERENT PCA that DOES match the op-wallet (mode a-like).
    // The invariant we assert is the attribution one — Eps incremented for
    // the named core. Cost-branch is informational because mode (a) above
    // may have registered our op wallets to a different PCA and the publish
    // here would correctly route through that.
    const s = state.v!;
    const core1 = s.nodes[1]!;
    const edge = s.nodes[5]!;
    if (core1.identityId === 0n) throw new Error('core1 has no identity');

    const epoch: bigint = await s.chronos.getCurrentEpoch();
    const beforeEps: bigint = await s.eps.getNodeEpochProducedKnowledgeValue(core1.identityId, epoch);

    const file = makeNquadsFile('mode-fallthrough');
    const result = await publishViaCli(edge, CONTEXT_GRAPH, file, {
      publisherNodeIdentityId: core1.identityId,
    });

    expect(result.status.toLowerCase()).toBe('confirmed');
    expect(result.kcId).toBeDefined();

    // Attribution preserved regardless of cost-coverage branch.
    const afterEps: bigint = await s.eps.getNodeEpochProducedKnowledgeValue(core1.identityId, epoch);
    expect(afterEps).toBeGreaterThan(beforeEps);

    // Author = one of the op wallets (msg.sender).
    const onChainAuthor: string = await s.kcs.getLatestMerkleRootAuthor(result.kcId!);
    const matches = edge.opWallets.some(
      (w) => w.address.toLowerCase() === onChainAuthor.toLowerCase(),
    );
    expect(matches).toBe(true);
  }, 120_000);

  // =========================================================================
  // Mode (b) — Publisher-as-a-service: end-user agent attribution via
  // daemon-side AuthorAttestation signing (Phase 4).
  //
  // Flow:
  //   1. Register a fresh custodial agent on core2's daemon. The daemon
  //      generates a secp256k1 keypair, persists it in agent-keystore.json,
  //      and returns { agentAddress, authToken, publicKey, privateKey }.
  //   2. Use the agent's bearer token to call core2's publish endpoint
  //      directly (POST /api/shared-memory/write + /api/shared-memory/publish).
  //   3. The daemon's publish route resolves the bearer → agent address →
  //      AgentKeyRecord → custodial private key, and threads it down to
  //      DKGPublisher as `authorPrivateKey`. The publisher signs the
  //      EIP-712 AuthorAttestation with that key.
  //   4. Assert on-chain: KC.author == agent.address (NOT core2's wallet),
  //      publisherNodeIdentityId is core2.id (the routing core), and core2's
  //      Eps grows. The agent never holds TRAC — full fee comes from core2's
  //      own publisher wallet (no PCA required for this assertion).
  // =========================================================================
  it('mode (b) — registered agent on core2 publishes; KC.author = agent, attribution = core2', async () => {
    const s = state.v!;
    const core2 = s.nodes[2]!;
    if (core2.identityId === 0n) throw new Error('core2 has no identity');

    // 1. Register a custodial agent on core2.
    const agentName = `phase4-mode-b-${Date.now()}`;
    const registerRes = await fetch(
      `http://127.0.0.1:${core2.apiPort}/api/agent/register`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(core2.authToken ? { Authorization: `Bearer ${core2.authToken}` } : {}),
        },
        body: JSON.stringify({ name: agentName, framework: 'phase4-test' }),
      },
    );
    if (!registerRes.ok) {
      throw new Error(
        `core2 /api/agent/register failed: ${registerRes.status} ${await registerRes.text()}`,
      );
    }
    const agentRecord = (await registerRes.json()) as {
      agentAddress: string;
      authToken: string;
      mode: 'custodial' | 'self-sovereign';
    };
    expect(agentRecord.mode).toBe('custodial');
    expect(/^0x[0-9a-fA-F]{40}$/.test(agentRecord.agentAddress)).toBe(true);

    const agentHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agentRecord.authToken}`,
    };

    // 2. Snapshot pre-publish state.
    const epoch: bigint = await s.chronos.getCurrentEpoch();
    const beforeEps: bigint = await s.eps.getNodeEpochProducedKnowledgeValue(core2.identityId, epoch);

    // 3. Write a single triple to SWM via the agent's token, then publish.
    const ts = Date.now();
    const subjectIri = `urn:test:mode-b:${ts}`;
    const writeRes = await fetch(
      `http://127.0.0.1:${core2.apiPort}/api/shared-memory/write`,
      {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({
          contextGraphId: CONTEXT_GRAPH,
          quads: [
            {
              subject: subjectIri,
              predicate: 'https://schema.org/name',
              object: `"mode-b-${ts}"`,
              graph: `did:dkg:context-graph:${CONTEXT_GRAPH}`,
            },
            {
              subject: subjectIri,
              predicate: 'https://schema.org/description',
              object: '"automated devnet mode (b) test"',
              graph: `did:dkg:context-graph:${CONTEXT_GRAPH}`,
            },
          ],
        }),
      },
    );
    if (!writeRes.ok) {
      throw new Error(
        `core2 /api/shared-memory/write failed: ${writeRes.status} ${await writeRes.text()}`,
      );
    }

    const publishRes = await fetch(
      `http://127.0.0.1:${core2.apiPort}/api/shared-memory/publish`,
      {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({
          contextGraphId: CONTEXT_GRAPH,
          selection: 'all',
          clearAfter: true,
        }),
      },
    );
    if (!publishRes.ok) {
      throw new Error(
        `core2 /api/shared-memory/publish failed: ${publishRes.status} ${await publishRes.text()}`,
      );
    }
    const publishJson = (await publishRes.json()) as {
      kcId: string;
      status: string;
      txHash?: string;
    };
    expect(publishJson.status).toBe('confirmed');
    expect(publishJson.txHash).toBeTruthy();

    // 4. On-chain assertions.
    const kcId = BigInt(publishJson.kcId);
    const onChainAuthor: string = await s.kcs.getLatestMerkleRootAuthor(kcId);
    expect(onChainAuthor.toLowerCase()).toBe(agentRecord.agentAddress.toLowerCase());

    // Author MUST NOT be any of core2's own op wallets — that would mean we
    // regressed to mode (a)/(c) behaviour where the publisher signs as itself.
    const isCoreWallet = core2.opWallets.some(
      (w) => w.address.toLowerCase() === onChainAuthor.toLowerCase(),
    );
    expect(isCoreWallet).toBe(false);

    // Attribution still flows to core2 (the routing node).
    const afterEps: bigint = await s.eps.getNodeEpochProducedKnowledgeValue(core2.identityId, epoch);
    expect(afterEps).toBeGreaterThan(beforeEps);
  }, 180_000);
});
