/**
 * ~10 minute devnet gate — publish, greenfield update, staking, random sampling.
 *
 * Exercises the production-shaped path end-to-end against a live 6-node
 * devnet (Hardhat + daemons). Update uses `POST /api/update` with an
 * off-band `precomputedUpdateAttestation` (no publisher auto-sign).
 *
 * **Preconditions**
 *
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * **Run**
 *
 *   pnpm test:devnet:greenfield-10min
 *
 * **Phase order** (≈10 min total budget)
 *
 *   1. Publish one KA from core1 (`devnet-test` CG) — 2 min
 *   2. Update via daemon API + owner seal — 2 min
 *   3. V10 conviction staking create → withdraw — 4 min
 *   4. Random sampling proof + on-chain solved — 2.5 min
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
import { ethers, Wallet } from 'ethers';
import { buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { buildUpdateSeal } from '../../packages/publisher/test/_helpers/seal.js';
import { runKaPublishLifecycle } from '../_bootstrap/harness.js';

const REPO_ROOT = resolve(__dirname, '../..');
const RPC = 'http://127.0.0.1:8545';
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
/** Registered by devnet.sh; use isolation CG when devnet-test publish ACL is tight. */
/** devnet-test is registered open (publishPolicy=1) by devnet.sh; isolation may be curated. */
const CONTEXT_GRAPH = process.env.DEVNET_CONTEXT_GRAPH ?? 'devnet-test';
const RS_TIMEOUT_S = Number(process.env.RS_TIMEOUT ?? 150);
const MINE_BLOCKS = Number(process.env.MINE_BLOCKS ?? 80);
/** Set in phase 1 so re-runs do not collide with prior devnet state. */
let entityUri = `urn:devnet:greenfield-10min:ka:${Date.now()}`;

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
  kas: ethers.Contract;
  token: ethers.Contract;
  rss: ethers.Contract;
  stakingV10: ethers.Contract;
  convictionStakingStorage: ethers.Contract;
  stakingNft: ethers.Contract;
  parametersStorage: ethers.Contract;
  kav10Address: string;
  dkgKaAddress: string;
  chainIdLabel: string;
  nodes: Record<number, DevnetNode>;
}

const state: { v: DevnetState | null } = { v: null };
const run: {
  kaId?: bigint;
  ual?: string;
  publishMerkle?: string;
  updateMerkle?: string;
} = {};

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

function runDkgCli(
  node: DevnetNode,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
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
      rejectResult(new Error(`dkg CLI timeout: ${args.join(' ')}`));
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

let publishSeq = 0;

async function publishViaCli(
  node: DevnetNode,
  filePath: string,
): Promise<{ status: string; kaId?: bigint; txHash?: string }> {
  // #1410 replaced the one-shot `dkg publish <cg> --file` with the two-step KA
  // lifecycle CLI — arg arrays + stdout parsing live in the shared
  // runKaPublishLifecycle helper (devnet/_bootstrap/harness.ts).
  const result = await runKaPublishLifecycle((args) => runDkgCli(node, args), {
    kaName: `gf-pub-${Date.now().toString(36)}-${++publishSeq}`,
    contextGraphId: CONTEXT_GRAPH,
    inputFile: filePath,
  });
  // Greedy publish-outcome gate (mirrors the devnet shell _devnet_publish_status_ok
  // contract): a CLI exit code of 0 is NOT proof of a real publish. Pin the
  // status to a known success value and require a positive on-chain kaId so an
  // 'unknown'/failed status — or a missing id (e.g. a "KC ID:" → "KA ID:" output
  // rename that drifts past this regex after the KC→KA transition) — fails
  // loudly here instead of slipping through every caller as a green publish.
  // (helper returns `status` already lowercased)
  const publishOk = ['confirmed', 'finalized', 'tentative'];
  expect(
    publishOk,
    `ka publish status="${result.status}", expected one of ${publishOk.join('/')}\n${result.raw}`,
  ).toContain(result.status);
  expect(
    result.kaId,
    `ka publish surfaced no positive "KA ID:" (kaId=${result.kaId})\n${result.raw}`,
  ).toBeGreaterThan(0n);
  return { status: result.status, kaId: result.kaId, txHash: result.txHash };
}

function makeNquadsFile(name: string, subject: string, label: string): string {
  const dir = join(__dirname, 'turns');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.nq`);
  const triple =
    `<${subject}> <https://schema.org/name> "${label}" <did:dkg:context-graph:${CONTEXT_GRAPH}> .\n`;
  writeFileSync(path, triple);
  return path;
}

function sealToApiJson(
  seal: Awaited<ReturnType<typeof buildUpdateSeal>>,
): Record<string, unknown> {
  return {
    expectedNewMerkleRoot:
      '0x' + Buffer.from(seal.expectedNewMerkleRoot).toString('hex'),
    authorAddress: seal.authorAddress,
    signature: {
      r: '0x' + Buffer.from(seal.signature.r).toString('hex'),
      vs: '0x' + Buffer.from(seal.signature.vs).toString('hex'),
    },
    schemeVersion: seal.schemeVersion,
  };
}

async function detectDevnet(): Promise<DevnetState | null> {
  if (!existsSync(DEVNET_DIR)) return null;
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
    if (!probe.ok) return null;
  } catch {
    return null;
  }

  const contractsPath = join(
    REPO_ROOT,
    'packages/evm-module/deployments/localhost_contracts.json',
  );
  if (!existsSync(contractsPath)) return null;
  const contractsJson = JSON.parse(readFileSync(contractsPath, 'utf8'));
  const hubAddress: string =
    contractsJson.contracts?.Hub?.evmAddress ?? contractsJson.Hub;
  if (!hubAddress) return null;

  const provider = new ethers.JsonRpcProvider(RPC, {
    chainId: 31337,
    name: 'localhost',
  });
  const hub = new ethers.Contract(
    hubAddress,
    [
      'function getContractAddress(string) view returns (address)',
      'function getAssetStorageAddress(string) view returns (address)',
    ],
    provider,
  );
  const kcsAddress = await hub.getAssetStorageAddress('DKGKnowledgeAssets');
  const kav10Address = await hub.getContractAddress('KnowledgeAssetsLifecycle');
  const dkgKaAddress = kav10Address;
  const tokenAddress = await hub.getContractAddress('Token');
  const rssAddress = await hub.getContractAddress('RandomSamplingStorage');
  const stakingV10Address = await hub.getContractAddress('StakingV10');
  const convictionStorageAddress = await hub.getContractAddress(
    'ConvictionStakingStorage',
  );
  const stakingNftAddress = await hub.getContractAddress(
    'DKGStakingConvictionNFT',
  );
  const parametersAddress = await hub.getContractAddress('ParametersStorage');

  const kas = new ethers.Contract(
    kcsAddress,
    [
      'function getLatestMerkleRootAuthor(uint256) view returns (address)',
      'function getLatestMerkleRoot(uint256) view returns (bytes32)',
    ],
    provider,
  );
  const token = new ethers.Contract(
    tokenAddress,
    [
      'function balanceOf(address) view returns (uint256)',
      'function approve(address,uint256) returns (bool)',
    ],
    provider,
  );
  const rssAbi = JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'packages/evm-module/abi/RandomSamplingStorage.json'),
      'utf8',
    ),
  );
  const rss = new ethers.Contract(rssAddress, rssAbi, provider);
  const stakingV10 = new ethers.Contract(
    stakingV10Address,
    JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'packages/evm-module/abi/StakingV10.json'),
        'utf8',
      ),
    ),
    provider,
  );
  const convictionStakingStorage = new ethers.Contract(
    convictionStorageAddress,
    JSON.parse(
      readFileSync(
        join(
          REPO_ROOT,
          'packages/evm-module/abi/ConvictionStakingStorage.json',
        ),
        'utf8',
      ),
    ),
    provider,
  );
  const stakingNft = new ethers.Contract(
    stakingNftAddress,
    JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'packages/evm-module/abi/DKGStakingConvictionNFT.json'),
        'utf8',
      ),
    ),
    provider,
  );
  const parametersStorage = new ethers.Contract(
    parametersAddress,
    ['function stakeWithdrawalDelay() view returns (uint256)'],
    provider,
  );

  const nodes: Record<number, DevnetNode> = {};
  for (let i = 1; i <= 6; i++) {
    nodes[i] = readNodeConfig(i);
  }

  return {
    provider,
    kas,
    token,
    rss,
    stakingV10,
    convictionStakingStorage,
    stakingNft,
    parametersStorage,
    kav10Address,
    dkgKaAddress,
    chainIdLabel: 'evm:31337',
    nodes,
  };
}

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
}

describe('Devnet greenfield 10min — publish, update, stake, random sampling', () => {
  beforeAll(async () => {
    state.v = await detectDevnet();
    if (!state.v) {
      throw new Error(
        'Devnet not running. Run: ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6',
      );
    }
    for (let i = 1; i <= 4; i++) {
      const node = state.v.nodes[i]!;
      node.identityId = await ensureIdentity(node);
      console.log(`node${i}: identityId=${node.identityId}`);
    }
    for (let i = 5; i <= 6; i++) {
      try {
        state.v.nodes[i]!.identityId = await ensureIdentity(state.v.nodes[i]!);
      } catch (err) {
        console.warn(`node${i} ensureIdentity skipped: ${(err as Error).message}`);
      }
    }
  }, 180_000);

  it('phase 1: publish one KA from core1 (greenfield)', async () => {
    const s = state.v!;
    const core1 = s.nodes[1]!;
    entityUri = `urn:devnet:greenfield-10min:ka:${Date.now()}`;
    const file = makeNquadsFile('gf10-publish', entityUri, 'v1-publish');
    const result = await publishViaCli(core1, file);
    expect(result.status.toLowerCase()).toBe('confirmed');
    expect(result.kaId).toBeDefined();
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]+$/);

    run.kaId = result.kaId;
    run.ual = buildKnowledgeAssetUal(
      s.chainIdLabel,
      s.dkgKaAddress,
      result.kaId!,
    );
    run.publishMerkle = await s.kas.getLatestMerkleRoot(result.kaId!);
    expect(run.publishMerkle).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log(
      `phase 1 PASS: kaId=${run.kaId} ual=${run.ual} merkle=${run.publishMerkle}`,
    );
  }, 120_000);

  it('phase 2: update via /api/update + precomputedUpdateAttestation', async () => {
    const s = state.v!;
    const core1 = s.nodes[1]!;
    expect(run.kaId).toBeDefined();

    const onChainAuthor: string = await s.kas.getLatestMerkleRootAuthor(run.kaId!);
    const authorWallet = core1.opWallets.find(
      (w) => w.address.toLowerCase() === onChainAuthor.toLowerCase(),
    );
    if (!authorWallet) {
      throw new Error(
        `KA author ${onChainAuthor} is not a core1 op wallet — cannot sign update attestation`,
      );
    }
    const author = new Wallet(authorWallet.privateKey, s.provider);
    const updateQuads = [
      {
        subject: entityUri,
        predicate: 'https://schema.org/name',
        object: '"v2-updated"',
        graph: `did:dkg:context-graph:${CONTEXT_GRAPH}`,
      },
      {
        subject: entityUri,
        predicate: 'https://schema.org/version',
        object: '"2"',
        graph: `did:dkg:context-graph:${CONTEXT_GRAPH}`,
      },
    ];

    const seal = await buildUpdateSeal({
      kaId: run.kaId!,
      quads: updateQuads,
      author,
      ctx: { provider: s.provider, kav10Address: s.kav10Address },
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (core1.authToken) {
      headers.Authorization = `Bearer ${core1.authToken}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    let res: Response;
    try {
      res = await fetch(
        `http://127.0.0.1:${core1.apiPort}/api/update`,
        {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            kaId: String(run.kaId),
            contextGraphId: CONTEXT_GRAPH,
            quads: updateQuads,
            precomputedUpdateAttestation: sealToApiJson(seal),
          }),
        },
      );
    } finally {
      clearTimeout(timer);
    }
    const body = (await res.json()) as {
      status?: string;
      txHash?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(
        `POST /api/update failed ${res.status}: ${JSON.stringify(body)}`,
      );
    }
    expect(body.status?.toLowerCase()).toBe('confirmed');
    expect(body.txHash).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(run.ual).toBeDefined();

    run.updateMerkle = await s.kas.getLatestMerkleRoot(run.kaId!);
    const expectedHex =
      '0x' + Buffer.from(seal.expectedNewMerkleRoot).toString('hex');
    expect(run.updateMerkle.toLowerCase()).toBe(expectedHex.toLowerCase());
    expect(run.updateMerkle.toLowerCase()).not.toBe(
      run.publishMerkle!.toLowerCase(),
    );
    console.log(
      `phase 2 PASS: tx=${body.txHash} merkle=${run.updateMerkle} ual unchanged=${run.ual}`,
    );
  }, 180_000);

  it('phase 3: V10 conviction staking createConviction → withdraw', async () => {
    const s = state.v!;
    const core1 = s.nodes[1]!;
    if (core1.identityId === 0n) throw new Error('core1 has no identity');

    const delegator = Wallet.createRandom().connect(s.provider);
    await s.provider.send('hardhat_setBalance', [
      delegator.address,
      '0x' + ethers.parseEther('100').toString(16),
    ]);
    const stakeAmount = ethers.parseEther('10000');
    await fundTokenBalance(s, delegator.address, stakeAmount);

    const stakingV10Address = await s.stakingV10.getAddress();
    const nextNonce = async (): Promise<number> => {
      const raw = await s.provider.send('eth_getTransactionCount', [
        delegator.address,
        'pending',
      ]);
      return parseInt(raw, 16);
    };

    const tokenAsDelegator = s.token.connect(delegator) as ethers.Contract;
    const nftAsDelegator = s.stakingNft.connect(delegator) as ethers.Contract;
    await (
      await tokenAsDelegator.approve(stakingV10Address, stakeAmount, {
        nonce: await nextNonce(),
      })
    ).wait();

    const beforeStake: bigint =
      await s.convictionStakingStorage.getNodeStakeV10(core1.identityId);
    const createTx = await nftAsDelegator.createConviction(
      core1.identityId,
      stakeAmount,
      0,
      { nonce: await nextNonce() },
    );
    const createReceipt = await createTx.wait();
    expect(createReceipt?.status).toBe(1);

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
            ethers.ZeroAddress.toLowerCase()
        ) {
          tokenId = parsed.args.tokenId as bigint;
          break;
        }
      } catch {
        // skip
      }
    }
    expect(tokenId).toBeGreaterThan(0n);

    const afterCreateStake: bigint =
      await s.convictionStakingStorage.getNodeStakeV10(core1.identityId);
    expect(afterCreateStake).toBeGreaterThan(beforeStake);

    const withdrawTx = await nftAsDelegator.withdraw(tokenId, {
      nonce: await nextNonce(),
    });
    const withdrawReceipt = await withdrawTx.wait();
    expect(withdrawReceipt?.status).toBe(1);

    let burned = false;
    try {
      await s.stakingNft.ownerOf(tokenId);
    } catch (err: unknown) {
      burned =
        (err as Error).message.includes('ERC721NonexistentToken') ||
        (err as Error).message.includes('reverted');
    }
    expect(burned).toBe(true);
    console.log(
      `phase 3 PASS: staked ${ethers.formatEther(stakeAmount)} TRAC on core1, withdrew tokenId=${tokenId}`,
    );
  }, 240_000);

  it(
    'phase 4: random sampling — core prover submits proof; on-chain solved=true',
    async () => {
      const s = state.v!;
      expect(run.kaId).toBeDefined();

      const headers = (node: DevnetNode) => ({
        Authorization: `Bearer ${node.authToken}`,
      });

      for (let n = 1; n <= 4; n++) {
        const node = s.nodes[n]!;
        const res = await fetch(
          `http://127.0.0.1:${node.apiPort}/api/random-sampling/status`,
          { headers: headers(node) },
        );
        if (!res.ok) {
          throw new Error(`node${n} RS status failed: ${res.status}`);
        }
        const status = (await res.json()) as { enabled?: boolean };
        if (!status.enabled) {
          throw new Error(`node${n} RS prover disabled`);
        }
      }

      if (MINE_BLOCKS > 0) {
        await s.provider.send('hardhat_mine', [
          '0x' + Math.min(MINE_BLOCKS, 80).toString(16),
          '0x0',
        ]);
        console.log(`phase 4: mined ${Math.min(MINE_BLOCKS, 80)} blocks`);
      }

      // Fresh publish from core1 so the RS prover has local chunks for the
      // challenged KC (mirrors v10-end-to-end phase-1 RS ordering).
      const core1 = s.nodes[1]!;
      const rsSubject = `urn:devnet:greenfield-10min:rs:${Date.now()}`;
      const rsFile = makeNquadsFile('gf10-rs', rsSubject, 'rs-phase4');
      const rsPublish = await publishViaCli(core1, rsFile);
      expect(rsPublish.status.toLowerCase()).toBe('confirmed');
      console.log(
        `phase 4: RS seed publish from node1 kaId=${rsPublish.kaId}`,
      );

      console.log(
        `phase 4: polling RS (timeout ${RS_TIMEOUT_S}s, prover ticks every 5s)...`,
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
            if (submitted <= 0) continue;

            const identityId = BigInt(status.identityId ?? '0');
            const ch = await s.rss.getNodeChallenge(identityId);
            if (ch[6] === true) {
              success = {
                node: n,
                identityId,
                txHash: status.loop?.lastSubmittedTxHash ?? '',
              };
              break;
            }
          } catch {
            // keep polling
          }
        }
        if (success) break;
        if (attempt > 0 && attempt % 30 === 0) {
          console.log(
            `phase 4 [t+${attempt}s]: still waiting; outcomes=${JSON.stringify(lastOutcomeKinds)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!success) {
        for (let n = 1; n <= 4; n++) {
          try {
            const res = await fetch(
              `http://127.0.0.1:${s.nodes[n]!.apiPort}/api/random-sampling/status`,
              { headers: headers(s.nodes[n]!) },
            );
            console.error(`node${n}: ${await res.text()}`);
          } catch (err) {
            console.error(`node${n}: ${(err as Error).message}`);
          }
        }
        throw new Error(
          `no RS proof with solved=true within ${RS_TIMEOUT_S}s (outcomes=${JSON.stringify(lastOutcomeKinds)})`,
        );
      }

      console.log(
        `phase 4 PASS: node${success.node} proof tx=${success.txHash} solved=true`,
      );
    },
    (RS_TIMEOUT_S + 30) * 1000,
  );
});
