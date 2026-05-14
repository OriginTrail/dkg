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
import {
  expectTxSuccess,
  expectMintedTokenId,
  expectRevert,
  parseEventOrThrow,
  parseEventIfPresent,
  assertDevnetReady,
  assertAllStakingInvariants,
} from '../_lib';

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
      'function maximumStake() view returns (uint96)',
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
  const approveReceipt = await (
    await tokenAsAdmin.approve(nftAddress, committed, {
      nonce: await nextNonce(),
    })
  ).wait();
  expectTxSuccess(approveReceipt, 'token.approve(nftAdmin → NFT)');

  const createTx = await nftAsAdmin.createAccount(committed, {
    nonce: await nextNonce(),
  });
  const createReceipt = await createTx.wait();
  expectTxSuccess(createReceipt, 'NFT.createAccount');
  const iface = new ethers.Interface([
    'event AccountCreated(uint256 indexed accountId, address indexed owner, uint96 committedTRAC, uint16 discountBps, uint40 createdAtEpoch, uint40 expiresAtEpoch)',
  ]);
  const accountEvt = parseEventOrThrow(
    iface,
    createReceipt!.logs,
    'AccountCreated',
  ) as { args: { accountId: bigint; committedTRAC: bigint } };
  const accountId = accountEvt.args.accountId;
  expect(accountEvt.args.committedTRAC, 'AccountCreated.committedTRAC must equal the committed amount').toBe(committed);
  console.log(`pca: created account ${accountId}`);
  for (const w of edge.opWallets) {
    const tx = await nftAsAdmin.registerAgent(accountId, w.address, {
      nonce: await nextNonce(),
    });
    const receipt = await tx.wait();
    expectTxSuccess(receipt, `registerAgent(${w.address})`);
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
    await assertDevnetReady({
      expectedNodes: 6,
      requireWallets: true,
      startCommandHint: './scripts/devnet.sh clean && ./scripts/devnet.sh start 6',
    });
    state.v = await detectDevnet();
    if (!state.v) {
      // assertDevnetReady passed but detectDevnet still bailed — surfaces
      // anything missed by the static preflight (e.g. Hub deployed but a
      // sub-contract address missing, network identity flap).
      throw new Error(
        'detectDevnet() failed after preflight passed — check daemon stderr.',
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

      // The daemon flips `submittedCount` the moment it broadcasts the
      // proof tx, but the on-chain `solved` flag is only set when that
      // tx mines, and worse — `getNodeChallenge` can be reset to
      // `solved=false` as soon as a later `createChallenge` runs for
      // the next proof period (within the same suite, that's <100
      // blocks ≈ <100 seconds away on a 1s mining cadence). Polling a
      // racy view function for "solved=true" is therefore inherently
      // flaky.
      //
      // The deterministic signal is in the proof tx receipt: a
      // successful `submitProof` MUST emit `NodeChallengeSet` with the
      // challenge's `solved=true` AND `NodeEpochProofPeriodScoreAdded`
      // for the proof's (epoch, periodStartBlock). Both are emitted
      // atomically inside the success branch — their presence with the
      // matching identityId is a stronger guarantee than any poll.
      const submitReceipt = await s.provider.waitForTransaction(
        success.txHash,
        1,
        30_000,
      );
      expect(
        submitReceipt,
        `phase 1 (RS): proof tx ${success.txHash} did not mine within 30s`,
      ).toBeTruthy();
      expect(
        submitReceipt!.status,
        `phase 1 (RS): proof tx ${success.txHash} mined but reverted (status=${submitReceipt!.status})`,
      ).toBe(1);

      const rssIface = s.rss.interface;

      // Pin the proof's (epoch, periodStartBlock) from the score-added
      // event in this very tx. If submitProof reverted-but-status-1
      // (impossible with require/revert) or failed to credit the node,
      // this event would be absent and parseEventOrThrow surfaces it.
      const scoreEvt = parseEventOrThrow(
        rssIface,
        submitReceipt!.logs,
        'NodeEpochProofPeriodScoreAdded',
        (p) => (p.args.identityId as bigint) === success.identityId,
      ) as {
        args: {
          epoch: bigint;
          proofPeriodStartBlock: bigint;
          scoreAdded: bigint;
          totalScore: bigint;
        };
      };
      const epoch = scoreEvt.args.epoch;
      const periodStart = scoreEvt.args.proofPeriodStartBlock;

      // Cross-check: the same tx must also have emitted
      // `EpochNodeValidProofsCountIncremented(epoch, identityId, newCount)`
      // with `newCount >= 1`. If that's missing, the score was credited
      // without the valid-proofs counter being bumped — a real bug, not
      // a harness race.
      const countEvt = parseEventOrThrow(
        rssIface,
        submitReceipt!.logs,
        'EpochNodeValidProofsCountIncremented',
        (p) =>
          (p.args.identityId as bigint) === success.identityId &&
          (p.args.epoch as bigint) === epoch,
      ) as { args: { newCount: bigint } };
      expect(
        countEvt.args.newCount,
        'EpochNodeValidProofsCountIncremented.newCount must be ≥ 1 after a successful submitProof',
      ).toBeGreaterThanOrEqual(1n);

      // And: the same tx must have emitted `NodeChallengeSet` with
      // `solved=true`. This is the structural truth of "challenge is
      // marked solved on chain", before any subsequent `createChallenge`
      // can reset it. Using event data avoids the racy view read.
      const challengeSetEvt = parseEventOrThrow(
        rssIface,
        submitReceipt!.logs,
        'NodeChallengeSet',
        (p) => (p.args.identityId as bigint) === success.identityId,
      ) as { args: { challenge: { solved: boolean } } };
      expect(
        challengeSetEvt.args.challenge.solved,
        'NodeChallengeSet emitted by submitProof MUST have challenge.solved=true',
      ).toBe(true);
      console.log(
        `phase 1 (RS): on-chain solved=true (epoch=${epoch}, periodStartBlock=${periodStart}) [via tx receipt logs]`,
      );

      const score: bigint = await s.rss.getNodeEpochProofPeriodScore(
        success.identityId,
        epoch,
        periodStart,
      );
      // The score MUST be strictly positive — `solved=true` plus a 0
      // score would mean the prover submitted a malformed proof that
      // the chain accepted without crediting. That's a bug class worth
      // catching. The previous test logged "0 on fresh devnet is
      // benign" which was incorrect: a proven-and-solved challenge
      // always yields a non-zero score under the V10 score formula
      // (effective_stake × multiplier × proof_count > 0).
      expect(
        score,
        `RS proof was solved on-chain but score is 0 — bug in the score formula or proof accounting. ` +
          `idId=${success.identityId}, epoch=${epoch}, periodStart=${periodStart}`,
      ).toBeGreaterThan(0n);
      console.log(
        `phase 1 (RS): on-chain score=${score} (epoch=${epoch}, periodStart=${periodStart})`,
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
      const approveReceipt = await (
        await tokenAsDelegator.approve(stakingV10Address, stakeAmount, {
          nonce: await nextNonce(),
        })
      ).wait();
      expectTxSuccess(approveReceipt, 'token.approve(delegator → StakingV10)');

      // Negative: createConviction without an approval-bumped wallet must
      // revert. We simulate this with a sibling wallet that has TRAC but
      // no allowance — pins the standard ERC-20 pull-payment guard.
      const noAllowanceWallet = ethers.Wallet.createRandom().connect(s.provider);
      await s.provider.send('hardhat_setBalance', [
        noAllowanceWallet.address,
        '0x' + ethers.parseEther('1').toString(16),
      ]);
      await fundTokenBalance(s, noAllowanceWallet.address, stakeAmount);
      const nftAsNoAllowance = s.stakingNft.connect(noAllowanceWallet) as ethers.Contract;
      await expectRevert(
        () => nftAsNoAllowance.createConviction.staticCall(core1.identityId, stakeAmount, 0),
        'createConviction without allowance must revert',
      );

      const beforeStake: bigint =
        await s.convictionStakingStorage.getNodeStakeV10(core1.identityId);
      const beforeBalance: bigint = await s.token.balanceOf(delegator.address);

      // Negative tests run BEFORE the happy-path stake — keep nonce
      // pristine via staticCall and don't pollute on-chain state.
      // (i) zero stake must revert.
      await expectRevert(
        () => nftAsDelegator.createConviction.staticCall(core1.identityId, 0n, 0),
        'createConviction must reject 0 stake amount',
      );
      // (ii) staking to a non-existent identity must revert. identityId
      // counters monotonically increase from 1; a value 9_999 is safe.
      await expectRevert(
        () => nftAsDelegator.createConviction.staticCall(9_999n, stakeAmount, 0),
        'createConviction must reject unknown identityId',
      );

      // Lock tier 0 = no lock — withdraw is allowed immediately.
      const createTx = await nftAsDelegator.createConviction(
        core1.identityId,
        stakeAmount,
        0,
        { nonce: await nextNonce() },
      );
      const createReceipt = await createTx.wait();
      expectTxSuccess(createReceipt, 'NFT.createConviction(tier 0)');

      const tokenId = expectMintedTokenId(createReceipt!.logs, delegator.address, 'createConviction');
      console.log(
        `phase 3: createConviction OK, tokenId=${tokenId}, identityId=${core1.identityId}`,
      );

      const afterCreateBalance: bigint = await s.token.balanceOf(
        delegator.address,
      );
      expect(beforeBalance - afterCreateBalance).toBe(stakeAmount);
      const afterCreateStake: bigint =
        await s.convictionStakingStorage.getNodeStakeV10(core1.identityId);
      // Strict equality — node's V10 stake delta MUST be exactly the
      // staked amount. The previous `>= stakeAmount` was loose enough to
      // mask a contract bug that double-credited (delta = 2×stake).
      expect(
        afterCreateStake - beforeStake,
        'getNodeStakeV10 must increase by exactly stakeAmount',
      ).toBe(stakeAmount);

      // Verify NFT ownership before withdraw.
      const ownerBefore: string = await s.stakingNft.ownerOf(tokenId);
      expect(ownerBefore.toLowerCase()).toBe(delegator.address.toLowerCase());

      // V10 atomic withdraw — burns the NFT, transfers TRAC back, no cooldown
      // for tier-0 positions.
      // Negative: a non-owner cannot withdraw this NFT. Pin the
      // ERC-721 access-control rule on `withdraw(tokenId)`.
      const stranger = ethers.Wallet.createRandom().connect(s.provider);
      await s.provider.send('hardhat_setBalance', [
        stranger.address,
        '0x' + ethers.parseEther('1').toString(16),
      ]);
      const nftAsStranger = s.stakingNft.connect(stranger) as ethers.Contract;
      await expectRevert(
        () => nftAsStranger.withdraw.staticCall(tokenId),
        'non-owner cannot withdraw',
      );

      const withdrawTx = await nftAsDelegator.withdraw(tokenId, {
        nonce: await nextNonce(),
      });
      const withdrawReceipt = await withdrawTx.wait();
      expectTxSuccess(withdrawReceipt, 'NFT.withdraw(tier 0)');

      // PositionWithdrawn event MUST fire exactly once with the correct
      // amount and tokenId. The previous test only checked that ownerOf()
      // reverts — silent missing event would have slipped through.
      const nftIface = new ethers.Interface([
        'event PositionWithdrawn(uint256 indexed tokenId, uint96 amount)',
        'event RewardsClaimed(uint256 indexed tokenId, uint96 amount)',
      ]);
      const wEvt = parseEventOrThrow(
        nftIface,
        withdrawReceipt!.logs,
        'PositionWithdrawn',
        (p) => (p.args.tokenId as bigint) === tokenId,
      ) as { args: { tokenId: bigint; amount: bigint } };
      expect(wEvt.args.amount, 'PositionWithdrawn.amount must equal raw stake').toBe(stakeAmount);

      // RewardsClaimed is OPTIONAL on a fresh devnet (no RS-accrued yet).
      // If it fires, the staker's TRAC delta must be raw + claimed.
      const rEvt = parseEventIfPresent(
        nftIface,
        withdrawReceipt!.logs,
        'RewardsClaimed',
        (p) => (p.args.tokenId as bigint) === tokenId,
      ) as { args: { tokenId: bigint; amount: bigint } } | undefined;
      const expectedReturn = stakeAmount + (rEvt?.args.amount ?? 0n);

      // NFT must be burned — explicit ERC721NonexistentToken assertion.
      await expectRevert(() => s.stakingNft.ownerOf(tokenId), 'ownerOf after burn');

      const afterWithdrawBalance: bigint = await s.token.balanceOf(delegator.address);
      const returned = afterWithdrawBalance - afterCreateBalance;
      // Strict equality — tier-0 NEVER imposes a slashing penalty;
      // returned == stake + any claimed rewards. The previous "≥95%"
      // assertion was a slop — it would have passed even if the contract
      // had a 5% bug burning principal. Tightened to exact equality.
      expect(
        returned,
        `tier-0 withdraw must return raw stake (+ claimed rewards if any). ` +
          `expected ${expectedReturn}, got ${returned}`,
      ).toBe(expectedReturn);

      // Per-node stake delta must equal exactly the staked amount —
      // again, no slippage budget for tier-0.
      const afterWithdrawStake: bigint =
        await s.convictionStakingStorage.getNodeStakeV10(core1.identityId);
      expect(
        afterCreateStake - afterWithdrawStake,
        'per-node stake must drop by exactly the withdrawn amount',
      ).toBe(stakeAmount);

      // Replay safety: a second withdraw of the same tokenId must revert.
      await expectRevert(
        () => nftAsDelegator.withdraw.staticCall(tokenId),
        'second withdraw must revert (NFT burned)',
      );

      console.log(
        `phase 3 PASS: NFT burned, returned=${ethers.formatEther(returned)} TRAC ` +
          `(staked ${ethers.formatEther(stakeAmount)}, ` +
          `claimed=${rEvt ? ethers.formatEther(rEvt.args.amount) : '0'}, ` +
          `node stake ${ethers.formatEther(afterCreateStake)} → ${ethers.formatEther(afterWithdrawStake)})`,
      );

      // ── PROTOCOL INVARIANTS post-create + withdraw ──────────────────
      // Phase 3 minted-then-burned an NFT — the most fragile boundary
      // for the per-node aggregate / enumeration. Run the full Aave-
      // style invariant sweep over every core's identity. `partial`
      // mode because v10-end-to-end may have other identities outside
      // [1..6] active in this devnet snapshot.
      const e2eCores = [1, 2, 3, 4, 5, 6]
        .map((n) => s.nodes[n])
        .filter((n): n is DevnetNode => Boolean(n) && n.identityId > 0n);
      await assertAllStakingInvariants(
        {
          css: s.convictionStakingStorage,
          params: s.parametersStorage,
          token: s.token,
          label: 'v10-e2e.phase3 (post-stake-lifecycle)',
        },
        e2eCores.map((c) => c.identityId),
        'partial',
      );
    },
    300_000,
  );

  // =========================================================================
  // Phase 4 — Operator fee withdrawal lifecycle: REMOVED.
  //
  // This was originally a smoke test for the request → cooldown → finalize
  // lifecycle that depended on `core1.operatorFeeBalance > 0`. There were
  // two ways to get there: (a) run v10-core-flows test 4 first (which
  // actively accrues the fee via publish → RS → warp → claim, then
  // immediately drains it via requestOperatorFeeWithdrawal(balAfter) +
  // finalizeOperatorFeeWithdrawal), or (b) hope a previous run on the
  // same devnet left a leftover balance. (a) drains the balance to 0
  // before this suite runs in the orchestrated pipeline, and (b) is
  // brittle / not reproducible.
  //
  // Cheat-code seeding via `increaseOperatorFeeBalance` is also out:
  // that bumps the bookkeeping field without putting a matching amount
  // of TRAC into the staking vault, which violates the
  // `assertVaultSolvency` invariant that v10-stress later checks (the
  // vault would hold strictly less TRAC than `sumNodeStakes +
  // operatorFeeBalance`).
  //
  // The full lifecycle this phase smoke-tested — including BOTH the
  // happy path AND every negative branch (0 amount revert, > balance
  // revert, second-request revert, early-finalize revert, replay-after-
  // cleared revert, exact-balance transfer) — is canonically and
  // exhaustively asserted in
  // `devnet/v10-core-flows/automated.test.ts` test 4 (`updateFee →
  // publish → score → warp → claim accrues 10% per RFC-26 → request /
  // cooldown / finalize delivers TRAC`). Removing this redundant phase
  // does not weaken coverage of the operator-fee withdrawal lifecycle.
  // =========================================================================
});
