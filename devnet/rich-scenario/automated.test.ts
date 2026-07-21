/**
 * ~10 minute devnet rich scenario — edge CG matrix, 20 KAs, updates, stake, RS.
 *
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *   pnpm test:devnet:rich-scenario
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ethers, Wallet } from 'ethers';
import { buildUpdateSeal } from '../../packages/publisher/test/_helpers/seal.js';

const REPO_ROOT = resolve(__dirname, '../..');
const RPC = 'http://127.0.0.1:8545';
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
/** Bulk WM/SWM/VM publishes (cores have this CG synced from devnet.sh). */
const BULK_CG = process.env.DEVNET_CONTEXT_GRAPH ?? 'devnet-isolation';

const WM_COUNT = Number(process.env.RICH_WM_COUNT ?? 6);
const SWM_COUNT = Number(process.env.RICH_SWM_COUNT ?? 6);
const VM_COUNT = Number(process.env.RICH_VM_COUNT ?? 8);
const UPDATE_COUNT = Number(process.env.RICH_UPDATE_COUNT ?? 4);
const RS_TIMEOUT_S = Number(process.env.RS_TIMEOUT ?? 90);
const MINE_BLOCKS = Number(process.env.MINE_BLOCKS ?? 120);
const SKIP_STAKE = process.env.SKIP_STAKE === '1';
const PUBLISH_PACE_MS = Number(process.env.PUBLISH_PACE_MS ?? 800);

const TOTAL_PUBLISHES = WM_COUNT + SWM_COUNT + VM_COUNT;

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
  nodes: Record<number, DevnetNode>;
}

interface AgentRef {
  nodeNum: number;
  agentAddress: string;
  authToken: string;
}

interface CgRef {
  key: string;
  localId: string;
  edgeNode: number;
  accessPolicy?: number;
  publishPolicy: number;
}

interface VmPublishRecord {
  kaId: bigint;
  nodeNum: number;
  cgId: string;
  rootSubject: string;
}

const state: { v: DevnetState | null } = { v: null };
const run: {
  stamp: number;
  edgeAgents: Record<number, AgentRef>;
  cgs: CgRef[];
  vmPublishes: VmPublishRecord[];
  updatesDone: number;
} = {
  stamp: Date.now(),
  edgeAgents: {},
  cgs: [],
  vmPublishes: [],
  updatesDone: 0,
};

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
    apiPort: config.apiPort as number,
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

async function apiFetch(
  node: DevnetNode,
  path: string,
  init: RequestInit & { bearer?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };
  const bearer = init.bearer ?? node.authToken;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const { bearer: _b, ...rest } = init;
  return fetch(`http://127.0.0.1:${node.apiPort}${path}`, {
    ...rest,
    headers,
  });
}

async function registerAgent(node: DevnetNode, label: string): Promise<AgentRef> {
  const name = `rich-${label}-${run.stamp}`;
  const res = await apiFetch(node, '/api/agent/register', {
    method: 'POST',
    body: JSON.stringify({ name, framework: 'rich-scenario' }),
  });
  if (!res.ok) {
    throw new Error(
      `register agent on node${node.num}: ${res.status} ${await res.text()}`,
    );
  }
  const j = (await res.json()) as { agentAddress: string; authToken: string };
  return {
    nodeNum: node.num,
    agentAddress: j.agentAddress,
    authToken: j.authToken,
  };
}

async function createCg(
  edge: DevnetNode,
  agent: AgentRef,
  spec: {
    key: string;
    accessPolicy?: number;
    publishPolicy: number;
    allowedAgents?: string[];
  },
): Promise<CgRef> {
  const slug = `rich-${spec.key}-${run.stamp}`;
  const localId = `${agent.agentAddress}/${slug}`;
  const body: Record<string, unknown> = {
    id: localId,
    name: `Rich ${spec.key} ${run.stamp}`,
    description: 'devnet rich-scenario CG',
    publishPolicy: spec.publishPolicy,
    register: true,
  };
  if (spec.accessPolicy !== undefined) {
    body.accessPolicy = spec.accessPolicy;
  }
  if (spec.allowedAgents?.length) {
    body.allowedAgents = spec.allowedAgents;
  }
  const res = await apiFetch(edge, '/api/context-graph/create', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `create CG ${spec.key} on node${edge.num}: ${res.status} ${await res.text()}`,
    );
  }
  const j = (await res.json()) as {
    registered?: boolean;
    onChainId?: string;
    created?: string;
  };
  if (!j.registered) {
    throw new Error(`CG ${spec.key} not registered: ${JSON.stringify(j)}`);
  }
  const canonicalId = j.created ?? localId;
  return {
    key: spec.key,
    localId: canonicalId,
    edgeNode: edge.num,
    accessPolicy: spec.accessPolicy,
    publishPolicy: spec.publishPolicy,
  };
}

function cgIsCurated(cg: CgRef): boolean {
  return cg.publishPolicy === 0;
}

function buildQuads(
  cgId: string,
  name: string,
  ts: number,
): { quads: Array<Record<string, string>>; rootSubject: string } {
  const subject = `urn:devnet:rich:${name}:${ts}`;
  const graph = `did:dkg:context-graph:${cgId}`;
  return {
    rootSubject: subject,
    quads: [
      {
        subject,
        predicate: 'https://schema.org/name',
        object: `"${name}-${ts}"`,
        graph,
      },
      {
        subject,
        predicate: 'https://schema.org/description',
        object: '"rich-scenario publish"',
        graph,
      },
    ],
  };
}

function buildBulkQuads(
  name: string,
  ts: number,
): { quads: Array<Record<string, string>>; rootSubject: string } {
  const subject = `urn:devnet:rich:bulk:${name}:${ts}`;
  const graph = `did:dkg:context-graph:${BULK_CG}`;
  return {
    rootSubject: subject,
    quads: [
      {
        subject,
        predicate: 'https://schema.org/name',
        object: `"${name}"`,
        graph,
      },
      {
        subject,
        predicate: 'https://schema.org/description',
        object: '"rich-scenario bulk publish"',
        graph,
      },
    ],
  };
}

async function assertionCreate(
  node: DevnetNode,
  cgId: string,
  name: string,
  agentToken: string,
  promote: boolean,
  ts: number,
): Promise<string> {
  const { quads, rootSubject } = buildQuads(cgId, name, ts);
  // KA create auto-finalizes when `quads` are supplied; `alsoShareSwm` is the
  // WM→SWM transition that the legacy `promote: true` flag performed.
  const res = await apiFetch(node, '/api/knowledge-assets', {
    method: 'POST',
    bearer: agentToken,
    body: JSON.stringify({
      name,
      contextGraphId: cgId,
      quads,
      ...(promote ? { alsoShareSwm: true } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(
      `assertion create ${name}: ${res.status} ${await res.text()}`,
    );
  }
  return rootSubject;
}

async function publishAssertionVm(
  node: DevnetNode,
  cgId: string,
  name: string,
  agentToken: string,
): Promise<bigint> {
  const doPublish = async () => {
    const res = await apiFetch(node, `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`, {
      method: 'POST',
      bearer: agentToken,
      body: JSON.stringify({
        contextGraphId: cgId,
        // Per-KA /vm/publish clears only this KA's own roots; do NOT pass
        // clearSharedMemoryAfter (it would wipe the whole CG's unpublished SWM).
      }),
    });
    // /vm/publish returns a NON-OK status (e.g. 502) for a TENTATIVE publish
    // (publisher nonce race). Read the body before throwing so a tentative
    // outcome flows to the retry below instead of failing here; only a genuine
    // hard failure throws.
    const j = (await res.json().catch(() => null)) as {
      status?: string;
      kaId?: string;
      txHash?: string;
    } | null;
    const tentative = !!j && (j.status === 'tentative' || j.kaId === '0');
    if (!res.ok && !tentative) {
      throw new Error(`publish ${name}: ${res.status} ${j ? JSON.stringify(j) : ''}`);
    }
    return j ?? {};
  };
  let j = await doPublish();
  if (j.status === 'tentative' || j.kaId === '0') {
    await new Promise((r) => setTimeout(r, 2_000));
    j = await doPublish();
  }
  if (j.status !== 'confirmed' || !j.kaId) {
    throw new Error(`publish ${name} not confirmed: ${JSON.stringify(j)}`);
  }
  return BigInt(j.kaId);
}

async function publishEdgeSwmVm(
  edge: DevnetNode,
  cgId: string,
  stamp: string,
  entity: string,
): Promise<bigint> {
  const subject = `urn:devnet:rich:edge:${stamp}/${entity}`;
  const assertionName = `rich-edge-${stamp}-${entity}`;
  // Stage as a named KA (create → write → seal → share), then publish via the
  // canonical per-KA route. (The legacy loose write + selection-publish bridge
  // was removed; the named-KA lifecycle is the only publish path now.)
  const writeRes = await apiFetch(edge, '/api/knowledge-assets', {
    method: 'POST',
    body: JSON.stringify({
      contextGraphId: cgId,
      name: assertionName,
      quads: [
        {
          subject,
          predicate: 'http://schema.org/name',
          object: `"${entity}"`,
          graph: '',
        },
        {
          subject,
          predicate: 'http://schema.org/description',
          object: '"rich-scenario edge SWM"',
          graph: '',
        },
      ],
      finalize: true,
      alsoShareSwm: true,
    }),
  });
  if (!writeRes.ok) {
    throw new Error(
      `KA create ${entity}: ${writeRes.status} ${await writeRes.text()}`,
    );
  }
  await new Promise((r) => setTimeout(r, 1_500));
  const doEdgePublish = async () => {
    const pubRes = await apiFetch(edge, `/api/knowledge-assets/${encodeURIComponent(assertionName)}/vm/publish`, {
      method: 'POST',
      body: JSON.stringify({
        contextGraphId: cgId,
        // Per-KA /vm/publish clears only this KA's own roots; no CG-wide clear.
      }),
    });
    // /vm/publish returns a NON-OK status (e.g. 502) for a TENTATIVE publish
    // (publisher nonce race). Read the body before throwing so a tentative
    // result flows to the retry below; only a genuine hard failure throws.
    const body = (await pubRes.json().catch(() => null)) as { status?: string; kaId?: string } | null;
    const tentative = !!body && (body.status === 'tentative' || body.kaId === '0');
    if (!pubRes.ok && !tentative) {
      throw new Error(`edge publish ${entity}: ${pubRes.status} ${body ? JSON.stringify(body) : ''}`);
    }
    return body ?? {};
  };
  let j = await doEdgePublish();
  if (j.status === 'tentative' || j.kaId === '0') {
    await new Promise((r) => setTimeout(r, 2_000));
    j = await doEdgePublish();
  }
  if (j.status !== 'confirmed' || !j.kaId || j.kaId === '0') {
    throw new Error(`edge publish failed: ${JSON.stringify(j)}`);
  }
  return BigInt(j.kaId);
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

async function mineBlocks(count: number): Promise<void> {
  await state.v!.provider.send('hardhat_mine', [
    '0x' + count.toString(16),
    '0x0',
  ]);
}

describe('Devnet rich scenario (~10 min)', () => {
  beforeAll(async () => {
    state.v = await detectDevnet();
    if (!state.v) {
      throw new Error(
        'Devnet not running. Run: ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6',
      );
    }
    for (let i = 1; i <= 4; i++) {
      state.v.nodes[i]!.identityId = await ensureIdentity(state.v.nodes[i]!);
    }
    for (let i = 5; i <= 6; i++) {
      try {
        state.v.nodes[i]!.identityId = await ensureIdentity(state.v.nodes[i]!);
      } catch (err) {
        console.warn(
          `node${i} identity skipped: ${(err as Error).message}`,
        );
      }
    }
  }, 180_000);

  it('phase 1: edge agents + four CG policy variants', async () => {
    const s = state.v!;
    const edge5 = s.nodes[5]!;
    const edge6 = s.nodes[6]!;

    run.edgeAgents[5] = await registerAgent(edge5, 'e5');
    run.edgeAgents[6] = await registerAgent(edge6, 'e6');

    const a5 = run.edgeAgents[5]!;
    const a6 = run.edgeAgents[6]!;

    run.cgs.push(
      await createCg(edge5, a5, {
        key: 'pub-open',
        accessPolicy: 0,
        publishPolicy: 1,
      }),
      await createCg(edge5, a5, {
        key: 'priv-open',
        accessPolicy: 1,
        publishPolicy: 1,
      }),
      await createCg(edge6, a6, {
        key: 'priv-cur',
        accessPolicy: 1,
        publishPolicy: 0,
        allowedAgents: [a6.agentAddress, a5.agentAddress],
      }),
      await createCg(edge6, a6, {
        key: 'pub-cur',
        publishPolicy: 0,
        allowedAgents: [a6.agentAddress],
      }),
    );

    expect(run.cgs).toHaveLength(4);
    console.log(
      `phase 1 PASS: 4 CGs — ${run.cgs.map((c) => `${c.key}@${c.edgeNode}`).join(', ')}`,
    );

    const pubOpen = run.cgs.find((c) => c.key === 'pub-open')!;
    const pubCur = run.cgs.find((c) => c.key === 'pub-cur')!;
    const edge5Pub = s.nodes[pubOpen.edgeNode]!;
    const edge6Cur = s.nodes[pubCur.edgeNode]!;
    const smokeName = `smoke-pub-open-${run.stamp}`;
    const smokeSubject = await assertionCreate(
      edge5Pub,
      pubOpen.localId,
      smokeName,
      run.edgeAgents[edge5Pub.num]!.authToken,
      true,
      run.stamp,
    );
    const smokeKa = await publishAssertionVm(
      edge5Pub,
      pubOpen.localId,
      smokeName,
      run.edgeAgents[edge5Pub.num]!.authToken,
    );
    const curKa = await publishEdgeSwmVm(
      edge6Cur,
      pubCur.localId,
      String(run.stamp),
      `smoke-cur-${run.stamp}`,
    );
    console.log(
      `phase 1b: edge smoke KAs pub-open=${smokeKa} pub-cur=${curKa} (subjects ok)`,
    );
    expect(smokeSubject.length).toBeGreaterThan(10);
  }, 120_000);

  it(`phase 2: ${TOTAL_PUBLISHES} KAs on ${BULK_CG} (WM=${WM_COUNT} SWM=${SWM_COUNT} VM=${VM_COUNT})`, async () => {
    const s = state.v!;
    const core1 = s.nodes[1]!;
    // Node admin token → VM publishes attribute to op-wallets (updatable via owner seal).
    const token = core1.authToken;
    expect(run.cgs.length).toBe(4);

    let wmDone = 0;
    let swmDone = 0;
    let vmDone = 0;
    const batchTs = Date.now();

    for (let i = 0; i < WM_COUNT; i++) {
      const name = `bulk-wm-${run.stamp}-${i}`;
      const { quads } = buildBulkQuads(name, batchTs + i);
      // KA create auto-finalizes (seals to WM) when `quads` are supplied.
      const res = await apiFetch(core1, '/api/knowledge-assets', {
        method: 'POST',
        bearer: token,
        body: JSON.stringify({
          name,
          contextGraphId: BULK_CG,
          quads,
        }),
      });
      if (!res.ok) {
        throw new Error(`bulk WM ${name}: ${res.status} ${await res.text()}`);
      }
      wmDone++;
    }
    console.log(`phase 2: WM-only ${wmDone}/${WM_COUNT} on ${BULK_CG}`);

    for (let i = 0; i < SWM_COUNT; i++) {
      const name = `bulk-swm-${run.stamp}-${i}`;
      const { quads } = buildBulkQuads(name, batchTs + 100 + i);
      // KA create auto-finalizes when `quads` are supplied; `alsoShareSwm`
      // performs the WM→SWM transition (legacy `promote: true`).
      const res = await apiFetch(core1, '/api/knowledge-assets', {
        method: 'POST',
        bearer: token,
        body: JSON.stringify({
          name,
          contextGraphId: BULK_CG,
          quads,
          alsoShareSwm: true,
        }),
      });
      if (!res.ok) {
        throw new Error(`bulk SWM ${name}: ${res.status} ${await res.text()}`);
      }
      swmDone++;
    }
    console.log(`phase 2: WM→SWM ${swmDone}/${SWM_COUNT} on ${BULK_CG}`);

    for (let i = 0; i < VM_COUNT; i++) {
      const name = `bulk-vm-${run.stamp}-${i}`;
      const { quads, rootSubject } = buildBulkQuads(name, batchTs + 200 + i);
      // KA create auto-finalizes + `alsoShareSwm` promotes to SWM; the
      // separate per-KA vm/publish below lifts SWM→VM.
      const createRes = await apiFetch(core1, '/api/knowledge-assets', {
        method: 'POST',
        bearer: token,
        body: JSON.stringify({
          name,
          contextGraphId: BULK_CG,
          quads,
          alsoShareSwm: true,
        }),
      });
      if (!createRes.ok) {
        throw new Error(
          `bulk VM create ${name}: ${createRes.status} ${await createRes.text()}`,
        );
      }
      const kaId = await publishAssertionVm(core1, BULK_CG, name, token);
      run.vmPublishes.push({
        kaId,
        nodeNum: 1,
        cgId: BULK_CG,
        rootSubject,
      });
      vmDone++;
      if (vmDone % 2 === 0 || vmDone === VM_COUNT) {
        console.log(`phase 2: VM ${vmDone}/${VM_COUNT} (kaId=${kaId})`);
      }
      if (PUBLISH_PACE_MS > 0) {
        await new Promise((r) => setTimeout(r, PUBLISH_PACE_MS));
      }
    }

    expect(wmDone).toBe(WM_COUNT);
    expect(swmDone).toBe(SWM_COUNT);
    expect(vmDone).toBe(VM_COUNT);
    expect(run.vmPublishes.length).toBe(VM_COUNT);

    if (MINE_BLOCKS > 0) {
      console.log(`phase 2: mining ${MINE_BLOCKS} blocks for RS epoch...`);
      await mineBlocks(MINE_BLOCKS);
    }
    console.log(
      `phase 2 PASS: ${TOTAL_PUBLISHES} ops on ${BULK_CG}, ${VM_COUNT} VM KAs`,
    );
  }, 420_000);

  it(`phase 3: ${UPDATE_COUNT} greenfield updates (owner seal)`, async () => {
    const s = state.v!;
    const targets = run.vmPublishes.slice(0, UPDATE_COUNT);
    if (targets.length < UPDATE_COUNT) {
      throw new Error(
        `need ${UPDATE_COUNT} VM KAs for updates, have ${targets.length}`,
      );
    }

    for (const rec of targets) {
      const node = s.nodes[rec.nodeNum]!;
      const onChainAuthor: string = await s.kas.getLatestMerkleRootAuthor(
        rec.kaId,
      );
      const authorWallet = node.opWallets.find(
        (w) => w.address.toLowerCase() === onChainAuthor.toLowerCase(),
      );
      if (!authorWallet) {
        throw new Error(
          `KA ${rec.kaId} author ${onChainAuthor} not on node${rec.nodeNum} op wallets`,
        );
      }

      const updateQuads = [
        {
          subject: rec.rootSubject,
          predicate: 'https://schema.org/name',
          object: '"updated-by-rich-scenario"',
          graph: `did:dkg:context-graph:${rec.cgId}`,
        },
        {
          subject: rec.rootSubject,
          predicate: 'https://schema.org/version',
          object: '"2"',
          graph: `did:dkg:context-graph:${rec.cgId}`,
        },
      ];

      const author = new Wallet(authorWallet.privateKey, s.provider);
      const seal = await buildUpdateSeal({
        kaId: rec.kaId,
        quads: updateQuads,
        author,
        ctx: { provider: s.provider, kav10Address: s.kav10Address },
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      let res: Response;
      try {
        res = await fetch(
          `http://127.0.0.1:${node.apiPort}/api/update`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(node.authToken
                ? { Authorization: `Bearer ${node.authToken}` }
                : {}),
            },
            signal: controller.signal,
            body: JSON.stringify({
              kaId: String(rec.kaId),
              contextGraphId: rec.cgId,
              quads: updateQuads,
              precomputedUpdateAttestation: sealToApiJson(seal),
            }),
          },
        );
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        throw new Error(
          `update kaId=${rec.kaId}: ${res.status} ${await res.text()}`,
        );
      }
      const j = (await res.json()) as { status?: string; txHash?: string };
      expect(j.status?.toLowerCase()).toBe('confirmed');

      const afterRoot = await s.kas.getLatestMerkleRoot(rec.kaId);
      expect(afterRoot).toBe(
        '0x' + Buffer.from(seal.expectedNewMerkleRoot).toString('hex'),
      );
      run.updatesDone++;
      console.log(
        `phase 3: updated kaId=${rec.kaId} on node${rec.nodeNum} tx=${j.txHash ?? 'n/a'}`,
      );
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(run.updatesDone).toBe(UPDATE_COUNT);
    console.log(`phase 3 PASS: ${run.updatesDone} updates`);
  }, 300_000);

  (SKIP_STAKE ? it.skip : it)(
    'phase 4: conviction staking create → withdraw',
    async () => {
      const s = state.v!;
      const core1 = s.nodes[1]!;
      const delegator = new Wallet(core1.admin.privateKey, s.provider);
      const stakeAmount = ethers.parseEther('100');
      await fundTokenBalance(s, delegator.address, stakeAmount * 2n);

      const stakingV10Address = await s.stakingV10.getAddress();
      let nonce = await s.provider.getTransactionCount(delegator.address);
      const nextNonce = () => nonce++;

      const tokenAsDelegator = s.token.connect(delegator) as ethers.Contract;
      const nftAsDelegator = s.stakingNft.connect(delegator) as ethers.Contract;
      await (
        await tokenAsDelegator.approve(stakingV10Address, stakeAmount, {
          nonce: await nextNonce(),
        })
      ).wait();

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

      const withdrawTx = await nftAsDelegator.withdraw(tokenId, {
        nonce: await nextNonce(),
      });
      const withdrawReceipt = await withdrawTx.wait();
      expect(withdrawReceipt?.status).toBe(1);
      console.log(`phase 4 PASS: stake+withdraw tokenId=${tokenId}`);
    },
    120_000,
  );

  it(
    'phase 5: random sampling — core prover submits proof',
    async () => {
      const s = state.v!;
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
          throw new Error(`node${n} RS status: ${res.status}`);
        }
        const status = (await res.json()) as { enabled?: boolean };
        if (!status.enabled) {
          throw new Error(`node${n} RS prover disabled`);
        }
      }

      const rsBaseline: Record<number, number> = {};
      for (let n = 1; n <= 4; n++) {
        const res = await fetch(
          `http://127.0.0.1:${s.nodes[n]!.apiPort}/api/random-sampling/status`,
          { headers: headers(s.nodes[n]!) },
        );
        const status = res.ok
          ? ((await res.json()) as { loop?: { submittedCount?: number } })
          : {};
        rsBaseline[n] = status.loop?.submittedCount ?? 0;
      }

      if (MINE_BLOCKS > 0) {
        await mineBlocks(Math.min(MINE_BLOCKS, 80));
      }

      let success: {
        node: number;
        identityId: bigint;
        txHash: string;
      } | null = null;

      console.log(
        `phase 5: polling RS (${RS_TIMEOUT_S}s, baselines=${JSON.stringify(rsBaseline)})...`,
      );
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
              };
            };
            const count = status.loop?.submittedCount ?? 0;
            if (count <= rsBaseline[n]!) continue;

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
        if (attempt > 0 && attempt % 20 === 0) {
          console.log(`phase 5 [t+${attempt}s]: waiting for new RS proof + solved...`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!success) {
        throw new Error(
          `no new RS proof with solved=true within ${RS_TIMEOUT_S}s (baselines=${JSON.stringify(rsBaseline)})`,
        );
      }

      console.log(
        `phase 5 PASS: node${success.node} tx=${success.txHash} solved=true`,
      );
    },
    (RS_TIMEOUT_S + 30) * 1000,
  );
});
