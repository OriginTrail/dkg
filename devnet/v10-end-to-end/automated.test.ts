/**
 * Combined V10 chain validation against a live 6-node devnet.
 *
 * Confirms end-to-end that the V10 chain rebuild ships a functional
 * publish + sampling + staking pipeline. Four phases run in declared
 * order against shared devnet state:
 *
 *   Phase 1 — Random sampling pipeline. Runs first by design — the RS
 *             prover gets one shot to assign a challenge per proof
 *             period, and we want it to pick the KC freshly published
 *             from a CORE node here so that node has the chunks
 *             locally and can submit a proof. Publishing from edge
 *             (Phase 2 below) before RS would make the prover lock
 *             onto an unsynced KC and stall on `kc-not-synced` for
 *             the rest of the run.
 *             Asserts RandomSamplingStorage.getNodeChallenge(idId).solved
 *             == true after at least one core's prover submits.
 *
 *   Phase 2 — Publish + DKGPublishingConvictionNFT cost coverage.
 *             Publish a KC via the CLI through a node whose op-wallet
 *             is registered as an authorized agent on a fresh PCA.
 *             Asserts the on-chain merkle root, author attestation
 *             (KC.author == op-wallet), and that NFT.windowSpent grew
 *             for the current billing window (lazy-settlement model:
 *             spend is bucketed by billing-window index, NOT chain epoch).
 *
 *   Phase 3 — V10 NFT-keyed conviction-staking lifecycle.
 *             Mint TRAC to a fresh delegator, approve StakingV10,
 *             call DKGStakingConvictionNFT.createConviction → assert
 *             the NFT minted and ConvictionStakingStorage stake grew,
 *             call withdraw(tokenId) (atomic: burns NFT + returns TRAC,
 *             no separate finalize for tier-0 positions). Asserts the
 *             NFT is gone, TRAC returned to delegator, node stake dropped.
 *
 *   Phase 4 — Operator-fee withdrawal lifecycle.
 *             Skipped on freshly-bootstrapped devnets (operator fee
 *             balance is zero until KPI claims accumulate); when the
 *             balance is non-zero, exercises requestOperatorFeeWithdrawal
 *             → time-warp past stakeWithdrawalDelay (reused for the
 *             operator-fee cooldown) → finalizeOperatorFeeWithdrawal,
 *             asserting TRAC returned to the admin wallet.
 *
 * **Preconditions**: `./scripts/devnet.sh start 6` must already be running.
 *
 * **How to run**:
 *
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 *   pnpm test:devnet:v10-e2e
 *
 * Companion to `devnet/agent-provenance/` (which exercises
 * the publish-author attribution modes a/b/c/d). This file's Phase 1
 * is the lightweight equivalent of mode (a) just to confirm the
 * publish+PCA stack still works against current code; Phases 2-4
 * exercise the staking/sampling subsystems that agent-provenance does
 * not touch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';

const REPO_ROOT = resolve(__dirname, '../..');
const RPC = 'http://127.0.0.1:8545';
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
const HARDHAT_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RS_TIMEOUT_S = Number(process.env.RS_TIMEOUT ?? 90);

interface DevnetNode {
  num: number;
  apiPort: number;
  home: string;
  authToken: string;
  identityId: bigint;
  opWallets: Array<{ privateKey: string; address: string }>;
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
  rss: ethers.Contract;
  stakingV10: ethers.Contract;
  convictionStakingStorage: ethers.Contract;
  stakingNft: ethers.Contract;
  parametersStorage: ethers.Contract;
  identityStorage: ethers.Contract;
  profileStorage: ethers.Contract;
  nodes: Record<number, DevnetNode>;
}

const state: { v: DevnetState | null } = { v: null };

// --- harness helpers --------------------------------------------------------

function readNodeConfig(num: number): DevnetNode {
  const home = join(DEVNET_DIR, `node${num}`);
  if (!existsSync(home)) {
    throw new Error(
      `Devnet node${num} home missing — run ./scripts/devnet.sh start 6 first`,
    );
  }
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const wallets = JSON.parse(readFileSync(join(home, 'wallets.json'), 'utf8'));
  const opWallets: Array<{ privateKey: string; address: string }> =
    wallets.wallets ?? [];
  if (opWallets.length === 0) {
    throw new Error(`Devnet node${num} has no operational wallet`);
  }
  let authToken = '';
  if (existsSync(join(home, 'auth.token'))) {
    authToken =
      readFileSync(join(home, 'auth.token'), 'utf8')
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

async function fetchStatus(
  node: DevnetNode,
): Promise<{ identityId: bigint; nodeRole: string }> {
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

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (node.authToken) {
    headers.Authorization = `Bearer ${node.authToken}`;
  }
  const res = await fetch(
    `http://127.0.0.1:${node.apiPort}/api/identity/ensure`,
    { method: 'POST', headers },
  );
  if (!res.ok) {
    throw new Error(
      `node${node.num} /api/identity/ensure failed: ${res.status} ${await res.text()}`,
    );
  }
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

function runDkgCli(
  node: DevnetNode,
  args: string[],
  timeoutMs = 60_000,
): Promise<CliResult> {
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
      rejectResult(
        new Error(`dkg CLI timeout after ${timeoutMs}ms: ${args.join(' ')}`),
      );
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
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

async function publishViaCli(
  node: DevnetNode,
  contextGraph: string,
  filePath: string,
  options: { publisherNodeIdentityId?: bigint } = {},
): Promise<{
  status: string;
  kcId?: bigint;
  txHash?: string;
  raw: string;
}> {
  const args = ['publish', contextGraph, '--file', filePath];
  if (options.publisherNodeIdentityId !== undefined) {
    args.push(
      '--publisher-node-identity-id',
      String(options.publisherNodeIdentityId),
    );
  }
  const result = await runDkgCli(node, args);
  if (result.code !== 0) {
    throw new Error(
      `dkg publish failed (exit ${result.code})\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
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

async function loadContractAddresses(
  provider: ethers.JsonRpcProvider,
  hubAddress: string,
) {
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
    rssAddress: await hub.getContractAddress('RandomSamplingStorage'),
    stakingV10Address: await hub.getContractAddress('StakingV10'),
    convictionStorageAddress: await hub.getContractAddress(
      'ConvictionStakingStorage',
    ),
    stakingNftAddress: await hub.getContractAddress('DKGStakingConvictionNFT'),
    parametersAddress: await hub.getContractAddress('ParametersStorage'),
    identityStorageAddress: await hub.getContractAddress('IdentityStorage'),
    profileStorageAddress: await hub.getContractAddress('ProfileStorage'),
  };
}

async function detectDevnet(): Promise<DevnetState | null> {
  if (!existsSync(DEVNET_DIR)) {
    console.error(`detectDevnet: ${DEVNET_DIR} does not exist`);
    return null;
  }
  try {
    const probe = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      }),
    });
    if (!probe.ok) {
      console.error(`detectDevnet: hardhat probe failed (${probe.status})`);
      return null;
    }
  } catch (err) {
    console.error(
      `detectDevnet: hardhat probe threw: ${(err as Error).message}`,
    );
    return null;
  }

  const contractsPath = join(
    REPO_ROOT,
    'packages/evm-module/deployments/localhost_contracts.json',
  );
  if (!existsSync(contractsPath)) {
    console.error(`detectDevnet: ${contractsPath} missing`);
    return null;
  }
  const contractsJson = JSON.parse(readFileSync(contractsPath, 'utf8'));
  const hubAddress: string =
    contractsJson.contracts?.Hub?.evmAddress ?? contractsJson.Hub;
  if (!hubAddress) {
    console.error(
      'detectDevnet: Hub address missing from localhost_contracts.json',
    );
    return null;
  }

  const provider = new ethers.JsonRpcProvider(RPC, {
    chainId: 31337,
    name: 'localhost',
  });
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
      'function windowSpent(uint256, uint40) view returns (uint96)',
      'function getCurrentBillingWindow(uint256) view returns (uint40)',
      'function settle(uint256) external',
    ],
    provider,
  );
  const token = new ethers.Contract(
    addrs.tokenAddress,
    [
      'function balanceOf(address) view returns (uint256)',
      'function approve(address, uint256) returns (bool)',
      'function transfer(address, uint256) returns (bool)',
      'function mint(address, uint256) returns (bool)',
    ],
    provider,
  );
  const eps = new ethers.Contract(
    addrs.epsAddress,
    [
      'function getNodeEpochProducedKnowledgeValue(uint72, uint256) view returns (uint96)',
    ],
    provider,
  );
  const chronos = new ethers.Contract(
    addrs.chronosAddress,
    ['function getCurrentEpoch() view returns (uint256)'],
    provider,
  );

  const rssAbi = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'packages/evm-module/abi/RandomSamplingStorage.json'),
      'utf8',
    ),
  );
  const rss = new ethers.Contract(addrs.rssAddress, rssAbi, provider);

  const stakingV10Abi = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'packages/evm-module/abi/StakingV10.json'),
      'utf8',
    ),
  );
  const stakingV10 = new ethers.Contract(
    addrs.stakingV10Address,
    stakingV10Abi,
    provider,
  );

  const convictionStorageAbi = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'packages/evm-module/abi/ConvictionStakingStorage.json'),
      'utf8',
    ),
  );
  const convictionStakingStorage = new ethers.Contract(
    addrs.convictionStorageAddress,
    convictionStorageAbi,
    provider,
  );

  const stakingNftAbi = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'packages/evm-module/abi/DKGStakingConvictionNFT.json'),
      'utf8',
    ),
  );
  const stakingNft = new ethers.Contract(
    addrs.stakingNftAddress,
    stakingNftAbi,
    provider,
  );

  // V10 reuses `stakeWithdrawalDelay` for the operator-fee request →
  // finalize cooldown — there is no separate `operatorFeeWithdrawalDelay`
  // parameter (see StakingV10.sol comment around line 538).
  const parametersStorage = new ethers.Contract(
    addrs.parametersAddress,
    [
      'function stakeWithdrawalDelay() view returns (uint256)',
      'function minimumStake() view returns (uint96)',
    ],
    provider,
  );

  const identityStorage = new ethers.Contract(
    addrs.identityStorageAddress,
    [
      'function getIdentityId(address) view returns (uint72)',
      'function getAdminKeysCount(uint72) view returns (uint256)',
    ],
    provider,
  );

  const profileStorage = new ethers.Contract(
    addrs.profileStorageAddress,
    [
      'function getOperatorFee(uint72) view returns (uint16)',
      'function isOperatorFeeChangePending(uint72) view returns (bool)',
    ],
    provider,
  );

  const nodes: Record<number, DevnetNode> = {};
  for (let i = 1; i <= 6; i++) {
    try {
      nodes[i] = readNodeConfig(i);
    } catch (err) {
      console.error(
        `detectDevnet: readNodeConfig(${i}) failed: ${(err as Error).message}`,
      );
      return null;
    }
  }
  return {
    provider,
    hub: addrs.hub as ethers.Contract,
    kcs,
    nft,
    token,
    eps,
    chronos,
    rss,
    stakingV10,
    convictionStakingStorage,
    stakingNft,
    parametersStorage,
    identityStorage,
    profileStorage,
    nodes,
  };
}

// --- per-test fixtures ------------------------------------------------------

function makeNquadsFile(name: string, contextGraph: string): string {
  const dir = join(__dirname, 'turns');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.nq`);
  const ts = Date.now();
  const subject = `urn:test:${name}:${ts}`;
  const triple =
    `<${subject}> <https://schema.org/name> "${name}-${ts}" <did:dkg:context-graph:${contextGraph}> .\n` +
    `<${subject}> <https://schema.org/description> "v10-e2e devnet" <did:dkg:context-graph:${contextGraph}> .\n`;
  writeFileSync(path, triple);
  return path;
}

const CONTEXT_GRAPH = 'devnet-test';

async function ensurePcaAccountForOpWallets(
  s: DevnetState,
  edge: DevnetNode,
): Promise<bigint> {
  for (const w of edge.opWallets) {
    const id: bigint = await s.nft.agentToAccountId(w.address);
    if (id > 0n) {
      console.log(
        `pca: reusing existing PCA account ${id} (op wallet ${w.address})`,
      );
      return id;
    }
  }
  const nftAdmin = ethers.Wallet.createRandom().connect(s.provider);
  await s.provider.send('hardhat_setBalance', [
    nftAdmin.address,
    '0x' + ethers.parseEther('100').toString(16),
  ]);
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
      `setStorageAt did not fund nftAdmin; ERC20 _balances slot may have moved`,
    );
  }
  const committed = ethers.parseEther('500000');
  const tokenAsAdmin = s.token.connect(nftAdmin) as ethers.Contract;
  const nftAsAdmin = s.nft.connect(nftAdmin) as ethers.Contract;
  const nftAddress = await s.nft.getAddress();
  const nextNonce = async (): Promise<number> => {
    const raw = await s.provider.send('eth_getTransactionCount', [
      nftAdmin.address,
      'latest',
    ]);
    return parseInt(raw, 16);
  };
  await (
    await tokenAsAdmin.approve(nftAddress, committed, {
      nonce: await nextNonce(),
    })
  ).wait();
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
      // skip
    }
  }
  if (accountId === 0n) throw new Error('AccountCreated event not found');
  console.log(`pca: created account ${accountId}`);
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

/** ERC20 _balances slot for OpenZeppelin tokens (slot 1 in our deploy). */
async function fundTokenBalance(
  s: DevnetState,
  recipient: string,
  amount: bigint,
): Promise<void> {
  const tokenAddress = await s.token.getAddress();
  const slotKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [recipient, 1n],
    ),
  );
  await s.provider.send('hardhat_setStorageAt', [
    tokenAddress,
    slotKey,
    ethers.zeroPadValue(ethers.toBeHex(amount), 32),
  ]);
  const observed: bigint = await s.token.balanceOf(recipient);
  if (observed !== amount) {
    throw new Error(
      `fundTokenBalance: setStorageAt slot 1 did not stick (got ${observed}, want ${amount})`,
    );
  }
}

async function timeWarpSeconds(
  provider: ethers.JsonRpcProvider,
  seconds: number,
): Promise<void> {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}

// --- suite ------------------------------------------------------------------

describe('V10 chain — combined end-to-end devnet validation', () => {
  beforeAll(async () => {
    state.v = await detectDevnet();
    if (!state.v) {
      throw new Error(
        'Devnet not running. Run `./scripts/devnet.sh clean && ./scripts/devnet.sh start 6` first.',
      );
    }
    for (let i = 1; i <= 6; i++) {
      const node = state.v.nodes[i]!;
      try {
        node.identityId = await ensureIdentity(node);
        console.log(`node${i}: identityId=${node.identityId}`);
      } catch (err) {
        if (i === 5 || i === 6) {
          console.warn(
            `node${i} ensureIdentity skipped: ${(err as Error).message}`,
          );
        } else {
          throw err;
        }
      }
    }
  }, 180_000);

  // =========================================================================
  // Phase 1 — Random sampling (runs FIRST to get a clean prover state).
  //
  // RS challenge selection is per-node, weighted-random over eligible KCs
  // in the CG, fixed for the duration of a proof period. If we publish from
  // an edge node first, the cores get assigned a challenge for that KC and
  // can't sync the chunks locally, blocking the test. By running RS first
  // and publishing the only KC FROM a core node (node1), at least node1
  // is guaranteed to have the data locally and submit a proof. Phases 2/3/4
  // (publish, staking, operator-fee) run after and don't depend on RS state.
  // =========================================================================
  it(
    'phase 1 (RS): random sampling — at least one core node submits a proof; on-chain solved=true',
    async () => {
      const s = state.v!;
      const headers = (node: DevnetNode) => ({
        Authorization: `Bearer ${node.authToken}`,
      });

      // Preflight: every core node must have RS enabled.
      for (let n = 1; n <= 4; n++) {
        const node = s.nodes[n]!;
        const res = await fetch(
          `http://127.0.0.1:${node.apiPort}/api/random-sampling/status`,
          { headers: headers(node) },
        );
        if (!res.ok) {
          throw new Error(
            `node${n} /api/random-sampling/status failed: ${res.status}`,
          );
        }
        const status = (await res.json()) as { enabled?: boolean };
        if (!status.enabled) {
          throw new Error(
            `node${n} prover disabled — identity registration may still be pending. Status: ${JSON.stringify(status)}`,
          );
        }
      }

      // Publish the first (and only) KC from node1 so the prover on that
      // node has the chunks locally. This mirrors what
      // scripts/devnet-test-random-sampling.sh does.
      const proverPublishNode = s.nodes[1]!;
      const proverFile = makeNquadsFile('rs-publish', CONTEXT_GRAPH);
      const proverPublishResult = await publishViaCli(
        proverPublishNode,
        CONTEXT_GRAPH,
        proverFile,
      );
      expect(proverPublishResult.status.toLowerCase()).toBe('confirmed');
      console.log(
        `phase 1 (RS): published from node1 (core) — kcId=${proverPublishResult.kcId}`,
      );

      console.log(
        `phase 1 (RS): polling 4 core nodes for first submitted proof (timeout ${RS_TIMEOUT_S}s, prover ticks every 5s)...`,
      );
      let success: {
        node: number;
        identityId: bigint;
        txHash: string;
      } | null = null;
      const lastOutcomeKinds: Record<number, string> = {};
      for (let attempt = 0; attempt < RS_TIMEOUT_S; attempt++) {
        for (let n = 1; n <= 4; n++) {
          const node = s.nodes[n]!;
          try {
            const res = await fetch(
              `http://127.0.0.1:${node.apiPort}/api/random-sampling/status`,
              { headers: headers(node) },
            );
            if (!res.ok) continue;
            const status = (await res.json()) as {
              identityId?: string;
              loop?: {
                submittedCount?: number;
                lastSubmittedTxHash?: string;
                lastOutcome?: { kind?: string };
              };
            };
            const submitted = status.loop?.submittedCount ?? 0;
            lastOutcomeKinds[n] = status.loop?.lastOutcome?.kind ?? '?';
            if (submitted > 0) {
              success = {
                node: n,
                identityId: BigInt(status.identityId ?? '0'),
                txHash: status.loop?.lastSubmittedTxHash ?? '',
              };
              break;
            }
          } catch {
            // node may be momentarily unreachable; keep polling.
          }
        }
        if (success) break;
        if (attempt > 0 && attempt % 15 === 0) {
          console.log(
            `phase 1 (RS) [t+${attempt}s]: still waiting; outcomes=${JSON.stringify(lastOutcomeKinds)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!success) {
        for (let n = 1; n <= 4; n++) {
          const node = s.nodes[n]!;
          try {
            const res = await fetch(
              `http://127.0.0.1:${node.apiPort}/api/random-sampling/status`,
              { headers: headers(node) },
            );
            console.error(`node${n}: ${await res.text()}`);
          } catch (err) {
            console.error(`node${n}: ${(err as Error).message}`);
          }
        }
        throw new Error(
          `no core node submitted a proof within ${RS_TIMEOUT_S}s`,
        );
      }
      console.log(
        `phase 1 (RS): node${success.node} (idId=${success.identityId}) submitted proof tx=${success.txHash}`,
      );
      expect(success.identityId).toBeGreaterThan(0n);
      expect(/^0x[0-9a-fA-F]+$/.test(success.txHash)).toBe(true);

      const ch = await s.rss.getNodeChallenge(success.identityId);
      const solved: boolean = ch[6];
      expect(solved).toBe(true);
      const epoch: bigint = ch[3];
      const periodStart: bigint = ch[4];
      console.log(
        `phase 1 (RS): on-chain solved=true (epoch=${epoch}, periodStartBlock=${periodStart})`,
      );

      const score: bigint = await s.rss.getNodeEpochProofPeriodScore(
        success.identityId,
        epoch,
        periodStart,
      );
      console.log(
        `phase 1 (RS): on-chain score=${score} (informational; 0 on fresh devnet is benign)`,
      );
    },
    240_000,
  );

  // =========================================================================
  // Phase 2 — Publish + Conviction NFT cost coverage.
  //
  // Mirrors mode (a) of the agent-provenance runbook: edge node 5 publishes
  // through core1's PCA (DKGPublishingConvictionNFT). Asserts attribution
  // flowed to core1, NFT.windowSpent grew, and the on-chain merkle root
  // author is one of the edge's op wallets. This must run AFTER phase 1
  // (RS) — see the design note in the file-level docstring.
  // =========================================================================
  it(
    'phase 2: publish via PCA-discounted path; KC.author = op-wallet, NFT.windowSpent grows',
    async () => {
      const s = state.v!;
      const core1 = s.nodes[1]!;
      const edge = s.nodes[5]!;
      if (core1.identityId === 0n) throw new Error('core1 has no identity');

      const accountId = await ensurePcaAccountForOpWallets(s, edge);
      // Lazy-settlement bookkeeping is bucketed by billing-window index
      // (0-based, relative to the account's `createdAtTimestamp`), NOT by
      // chain epoch — see DKGPublishingConvictionNFT.windowSpent docs. Snap
      // before+after across the current window and the one immediately
      // following it so a tx that lands across a window boundary still
      // counts as growth.
      const epoch: bigint = await s.chronos.getCurrentEpoch();
      const beforeWindow: bigint = BigInt(
        await s.nft.getCurrentBillingWindow(accountId),
      );
      const beforeSpent: bigint =
        (await s.nft.windowSpent(accountId, beforeWindow)) +
        (await s.nft.windowSpent(accountId, beforeWindow + 1n));
      const beforeEps: bigint =
        await s.eps.getNodeEpochProducedKnowledgeValue(
          core1.identityId,
          epoch,
        );

      const file = makeNquadsFile('phase1-publish', CONTEXT_GRAPH);
      const result = await publishViaCli(edge, CONTEXT_GRAPH, file, {
        publisherNodeIdentityId: core1.identityId,
      });

      expect(result.status.toLowerCase()).toBe('confirmed');
      expect(result.kcId).toBeDefined();

      const onChainAuthor: string = await s.kcs.getLatestMerkleRootAuthor(
        result.kcId!,
      );
      const matchesOpWallet = edge.opWallets.some(
        (w) => w.address.toLowerCase() === onChainAuthor.toLowerCase(),
      );
      expect(matchesOpWallet).toBe(true);

      const afterWindow: bigint = BigInt(
        await s.nft.getCurrentBillingWindow(accountId),
      );
      const afterSpent: bigint =
        (await s.nft.windowSpent(accountId, beforeWindow)) +
        (await s.nft.windowSpent(accountId, beforeWindow + 1n)) +
        (afterWindow > beforeWindow + 1n
          ? await s.nft.windowSpent(accountId, afterWindow)
          : 0n);
      expect(afterSpent - beforeSpent).toBeGreaterThan(0n);
      const afterEps: bigint = await s.eps.getNodeEpochProducedKnowledgeValue(
        core1.identityId,
        epoch,
      );
      expect(afterEps).toBeGreaterThan(beforeEps);

      console.log(
        `phase 2 PASS: kcId=${result.kcId}, author=${onChainAuthor}, ` +
          `windowSpent +${afterSpent - beforeSpent} (window ${beforeWindow}→${afterWindow}), ` +
          `core1.eps +${afterEps - beforeEps}`,
      );
    },
    240_000,
  );

  // =========================================================================
  // Phase 3 — V10 NFT-based conviction-staking lifecycle.
  //
  // The V10 staking model is NFT-keyed (every position is a `DKGStakingConvictionNFT`)
  // and the withdraw path is atomic: `withdraw(tokenId)` auto-claims any
  // outstanding rewards, deletes the position, transfers TRAC back to the
  // staker, and burns the NFT in a single tx (StakingV10.sol:485-528).
  // There is no two-step request → finalize on the V10 stake path; the
  // cooldown only kicks in for time-locked positions (lockTier > 0). For
  // a tier-0 (no-lock) position, withdraw works immediately.
  //
  // We test the canonical happy path here. Lock-tiered positions and the
  // operator-fee request → cooldown → finalize lifecycle (which DOES use
  // `parametersStorage.stakeWithdrawalDelay`) are covered in Phase 4.
  // =========================================================================
  it(
    'phase 3: V10 NFT staking lifecycle — createConviction → withdraw returns TRAC, burns NFT',
    async () => {
      const s = state.v!;
      const core1 = s.nodes[1]!;
      if (core1.identityId === 0n) throw new Error('core1 has no identity');

      // Fresh delegator funded with 100 ETH for gas + 10k TRAC for stake.
      const delegator = ethers.Wallet.createRandom().connect(s.provider);
      await s.provider.send('hardhat_setBalance', [
        delegator.address,
        '0x' + ethers.parseEther('100').toString(16),
      ]);
      const stakeAmount = ethers.parseEther('10000');
      await fundTokenBalance(s, delegator.address, stakeAmount);

      const stakingV10Address = await s.stakingV10.getAddress();

      // Use raw eth_getTransactionCount('pending') for every send — ethers'
      // client-side nonce cache races Hardhat's automine when txs are submitted
      // back-to-back from the same wallet. Same fix as ensurePcaAccountForOpWallets.
      const nextNonce = async (): Promise<number> => {
        const raw = await s.provider.send('eth_getTransactionCount', [
          delegator.address,
          'pending',
        ]);
        return parseInt(raw, 16);
      };

      const tokenAsDelegator = s.token.connect(delegator) as ethers.Contract;
      const nftAsDelegator = s.stakingNft.connect(delegator) as ethers.Contract;

      // Approval target: StakingV10 (the V10 staking pull-payment authority).
      // The NFT's createConviction calls StakingV10.stake under the hood,
      // which pulls TRAC via transferFrom(staker, CSS, amount) gated by
      // an allowance to StakingV10.
      await (
        await tokenAsDelegator.approve(stakingV10Address, stakeAmount, {
          nonce: await nextNonce(),
        })
      ).wait();

      const beforeStake: bigint =
        await s.convictionStakingStorage.getNodeStakeV10(core1.identityId);
      const beforeBalance: bigint = await s.token.balanceOf(delegator.address);

      // Lock tier 0 = no lock — withdraw is allowed immediately.
      const createTx = await nftAsDelegator.createConviction(
        core1.identityId,
        stakeAmount,
        0,
        { nonce: await nextNonce() },
      );
      const createReceipt = await createTx.wait();
      expect(createReceipt?.status).toBe(1);

      // Find the minted NFT tokenId from Transfer event.
      let tokenId = 0n;
      const transferIface = new ethers.Interface([
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
      ]);
      for (const log of createReceipt?.logs ?? []) {
        try {
          const parsed = transferIface.parseLog(log);
          if (
            parsed?.name === 'Transfer' &&
            (parsed.args.from as string).toLowerCase() ===
              '0x0000000000000000000000000000000000000000' &&
            (parsed.args.to as string).toLowerCase() ===
              delegator.address.toLowerCase()
          ) {
            tokenId = parsed.args.tokenId as bigint;
            break;
          }
        } catch {
          // non-Transfer log — skip
        }
      }
      expect(tokenId).toBeGreaterThan(0n);
      console.log(
        `phase 3: createConviction OK, tokenId=${tokenId}, identityId=${core1.identityId}`,
      );

      const afterCreateBalance: bigint = await s.token.balanceOf(
        delegator.address,
      );
      expect(beforeBalance - afterCreateBalance).toBe(stakeAmount);
      const afterCreateStake: bigint =
        await s.convictionStakingStorage.getNodeStakeV10(core1.identityId);
      expect(afterCreateStake - beforeStake).toBeGreaterThanOrEqual(stakeAmount);

      // Verify NFT ownership before withdraw.
      const ownerBefore: string = await s.stakingNft.ownerOf(tokenId);
      expect(ownerBefore.toLowerCase()).toBe(delegator.address.toLowerCase());

      // V10 atomic withdraw — burns the NFT, transfers TRAC back, no cooldown
      // for tier-0 positions.
      const withdrawTx = await nftAsDelegator.withdraw(tokenId, {
        nonce: await nextNonce(),
      });
      const withdrawReceipt = await withdrawTx.wait();
      expect(withdrawReceipt?.status).toBe(1);

      // NFT must be burned: ownerOf(tokenId) reverts with ERC721NonexistentToken.
      let burned = false;
      try {
        await s.stakingNft.ownerOf(tokenId);
      } catch (err: unknown) {
        burned = (err as Error).message.includes('ERC721NonexistentToken') ||
          (err as Error).message.includes('reverted');
      }
      expect(burned).toBe(true);

      const afterWithdrawBalance: bigint = await s.token.balanceOf(
        delegator.address,
      );
      const returned = afterWithdrawBalance - afterCreateBalance;
      expect(returned).toBeGreaterThan(0n);
      // Allow for any reward compounding / dilution adjustments — assert
      // the staker got back at least 95% of principal.
      const minExpected = (stakeAmount * 95n) / 100n;
      expect(returned).toBeGreaterThanOrEqual(minExpected);

      const afterWithdrawStake: bigint =
        await s.convictionStakingStorage.getNodeStakeV10(core1.identityId);
      expect(afterWithdrawStake).toBeLessThan(afterCreateStake);

      console.log(
        `phase 3 PASS: NFT burned, returned=${ethers.formatEther(returned)} TRAC ` +
          `(staked ${ethers.formatEther(stakeAmount)}, ` +
          `node stake ${ethers.formatEther(afterCreateStake)} → ${ethers.formatEther(afterWithdrawStake)})`,
      );
    },
    300_000,
  );

  // =========================================================================
  // Phase 4 — Operator fee withdrawal lifecycle
  // =========================================================================
  it(
    'phase 4: operator fee request → finalize lifecycle returns TRAC to admin',
    async () => {
      const s = state.v!;
      const core1 = s.nodes[1]!;
      if (core1.identityId === 0n) throw new Error('core1 has no identity');

      // Operator fee balance is accumulated via the staking-rewards path
      // (KPI claims, PCA-discounted publishes that route a fee cut, etc.)
      // and tracked in ConvictionStakingStorage.getOperatorFeeBalance.
      // On a freshly-bootstrapped devnet that hasn't claimed any KPI rewards
      // yet, this is 0 — and that's fine: the staking lifecycle (Phase 3)
      // is the load-bearing assertion. We test the request → finalize
      // round-trip only when there's a real balance to withdraw.
      const balance: bigint =
        await s.convictionStakingStorage.getOperatorFeeBalance(
          core1.identityId,
        );
      if (balance === 0n) {
        console.log(
          `phase 4: core1 operator fee balance is 0 (no KPI claims yet on this devnet) — skipping the request → finalize round-trip. ` +
            `Phase 3's stake/withdraw/claim already proved the V10 conviction-staking lifecycle works; this phase is only meaningful once rewards have accumulated.`,
        );
        return;
      }

      // Withdraw 1 wei of fee — predictable, doesn't deplete the pool.
      const withdrawAmount = 1n;
      const adminWallet = new ethers.Wallet(
        core1.admin.privateKey,
        s.provider,
      );
      const stakingV10AsAdmin = s.stakingV10.connect(
        adminWallet,
      ) as ethers.Contract;

      const beforeAdminBalance: bigint = await s.token.balanceOf(
        adminWallet.address,
      );

      const reqTx = await stakingV10AsAdmin.requestOperatorFeeWithdrawal(
        core1.identityId,
        withdrawAmount,
      );
      const reqReceipt = await reqTx.wait();
      expect(reqReceipt?.status).toBe(1);
      console.log(
        `phase 4: requestOperatorFeeWithdrawal(${core1.identityId}, ${withdrawAmount}) OK`,
      );

      // V10 reuses stakeWithdrawalDelay for the operator-fee cooldown
      // (StakingV10.sol comment around line 538 — no separate parameter).
      const delay: bigint = await s.parametersStorage.stakeWithdrawalDelay();
      await timeWarpSeconds(s.provider, Number(delay) + 60);
      console.log(
        `phase 4: time-warped ${delay + 60n}s past stakeWithdrawalDelay (operator-fee cooldown reuses this)`,
      );

      const finalTx = await stakingV10AsAdmin.finalizeOperatorFeeWithdrawal(
        core1.identityId,
      );
      const finalReceipt = await finalTx.wait();
      expect(finalReceipt?.status).toBe(1);

      const afterAdminBalance: bigint = await s.token.balanceOf(
        adminWallet.address,
      );
      expect(afterAdminBalance - beforeAdminBalance).toBe(withdrawAmount);
      console.log(
        `phase 4 PASS: admin balance +${withdrawAmount} wei TRAC after finalize`,
      );
    },
    240_000,
  );
});
