/**
 * E2E tests for the workspace-first publish flow using a real Hardhat chain:
 *
 * 1. Finalization promotion: A writes to workspace → B receives → A enshrines
 *    (real on-chain tx) → B receives FinalizationMessage → B verifies on-chain
 *    → B promotes workspace snapshot to canonical.
 * 2. Workspace enshrine cycle: write entity 1, enshrine, write entity 2, enshrine.
 * 3. Workspace cleanup after enshrine with clearSharedMemoryAfter flag.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { ethers, JsonRpcProvider, Wallet, Contract } from 'ethers';
import { DKGAgent } from '../src/index.js';
import path from 'node:path';

const EVM_MODULE_DIR = path.resolve(import.meta.dirname, '../../evm-module');
const RPC_PORT = 8548;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const HARDHAT_CHAIN_ID = 31337;

// Hardhat default accounts — using accounts 4-7 to avoid conflicts with e2e-chain.test.ts
const DEPLOYER_OP_KEY   = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // account[0] (deployer)
const DEPLOYER_ADMIN_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // account[1]
const NODE_A_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'; // account[4]
const NODE_B_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'; // account[5]

const PARANET = 'finalization-chain-e2e';
const ENTITY_1 = 'urn:finalization-chain:entity:1';
const ENTITY_2 = 'urn:finalization-chain:entity:2';
const ENTITY_3 = 'urn:finalization-chain:entity:3';

let hardhatProcess: ChildProcess | null = null;
let hubAddress: string;
let provider: JsonRpcProvider;
let skipSuite = false;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitForNode(url: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const p = new JsonRpcProvider(url);
      await p.getBlockNumber();
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function deployContracts(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'npx',
      ['hardhat', 'deploy', '--network', 'localhost', '--config', 'hardhat.node.config.ts'],
      {
        cwd: EVM_MODULE_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RPC_LOCALHOST: RPC_URL },
      },
    );

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Deploy failed (code ${code}):\n${stderr}\n${stdout}`));
        return;
      }
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes('"Hub"') && line.includes('deployed at')) {
          const match = line.match(/deployed at (0x[0-9a-fA-F]+)/);
          if (match) { resolve(match[1]); return; }
        }
      }
      const hubMatch = stdout.match(/deploying "Hub".*?deployed at (\S+)/s);
      if (hubMatch) {
        resolve(hubMatch[1]);
      } else {
        reject(new Error(`Could not find Hub address in deploy output:\n${stdout}`));
      }
    });
  });
}

function makeChainConfig(privateKey: string) {
  return {
    rpcUrl: RPC_URL,
    hubAddress,
    operationalKeys: [privateKey],
    chainId: `evm:${HARDHAT_CHAIN_ID}`,
  };
}

async function createProfileForKey(operationalKey: string, adminKey: string): Promise<number> {
  const operational = new Wallet(operationalKey, provider);
  const admin = new Wallet(adminKey, provider);
  const hub = new Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
  const profileAddr = await hub.getContractAddress('Profile');

  const profile = new Contract(profileAddr, [
    'function createProfile(address, address[], string, bytes, uint16) external',
  ], operational);

  const nodeId = ethers.hexlify(ethers.randomBytes(32));
  const name = `Fin-${operational.address.slice(2, 8)}`;
  const tx = await profile.createProfile(admin.address, [], name, nodeId, 0);
  const receipt = await tx.wait();

  const identityId = Number(receipt.logs[0].topics[1]);
  if (!identityId) throw new Error('No IdentityCreated event');
  return identityId;
}

describe('E2E: workspace-first publish with real blockchain', () => {
  const agents: DKGAgent[] = [];

  beforeAll(async () => {
    hardhatProcess = spawn(
      'npx',
      ['hardhat', 'node', '--port', String(RPC_PORT), '--config', 'hardhat.node.config.ts'],
      {
        cwd: EVM_MODULE_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );

    // Drain stdout/stderr to prevent buffer blocking
    hardhatProcess.stdout?.resume();
    hardhatProcess.stderr?.resume();

    const ready = await waitForNode(RPC_URL, 30_000);
    if (!ready) {
      // Vitest's `beforeAll` callback has no suite-level skip helper — the
      // previous `ctx.skip()` here was a ReferenceError bug that masked the
      // "hardhat never booted" path as a ReferenceError crash instead of a
      // clean skip. Set the module-level flag and return; every `it()` in
      // this suite already checks `skipSuite` first and does its own
      // `ctx.skip()` with the per-test context that actually has that API.
      skipSuite = true;
      if (hardhatProcess) { hardhatProcess.kill('SIGTERM'); hardhatProcess = null; }
      return;
    }
    provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
    hubAddress = await deployContracts();

    // Create deployer profile + stake (needed for the network)
    const deployerProfileId = await createProfileForKey(DEPLOYER_OP_KEY, DEPLOYER_ADMIN_KEY);

    const hub = new Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
    const tokenAddr = await hub.getContractAddress('Token');
    const stakingAddr = await hub.getContractAddress('Staking');
    const profileAddr = await hub.getContractAddress('Profile');
    const parametersAddr = await hub.getContractAddress('ParametersStorage');
    const deployerWallet = new Wallet(DEPLOYER_OP_KEY, provider);

    // Lower min signatures from 3→1 so single-node publishes succeed in tests
    const parameters = new Contract(parametersAddr, [
      'function setMinimumRequiredSignatures(uint256)',
    ], deployerWallet);
    await (await parameters.setMinimumRequiredSignatures(1)).wait();
    const token = new Contract(tokenAddr, [
      'function mint(address, uint256)',
      'function approve(address, uint256) returns (bool)',
    ], deployerWallet);
    const staking = new Contract(stakingAddr, ['function stake(uint72 identityId, uint96 amount)'], deployerWallet);
    const profile = new Contract(profileAddr, ['function updateAsk(uint72 identityId, uint96 ask)'], deployerWallet);

    const stakeAmount = ethers.parseEther('50000');
    await (await token.mint(deployerWallet.address, stakeAmount)).wait();
    await (await token.connect(deployerWallet).approve(stakingAddr, stakeAmount)).wait();
    await (await staking.stake(deployerProfileId, stakeAmount)).wait();
    await (await profile.updateAsk(deployerProfileId, ethers.parseEther('1'))).wait();

    // Create profiles, stake, and set ask for both node wallets
    for (const nodeKey of [NODE_A_KEY, NODE_B_KEY]) {
      const nodeWallet = new Wallet(nodeKey, provider);
      await (await token.mint(nodeWallet.address, ethers.parseEther('200000'))).wait();

      const nodeProfileId = await createProfileForKey(nodeKey, DEPLOYER_ADMIN_KEY);

      const nodeToken = new Contract(tokenAddr, [
        'function approve(address, uint256) returns (bool)',
      ], nodeWallet);
      const nodeStaking = new Contract(stakingAddr, [
        'function stake(uint72 identityId, uint96 amount)',
      ], nodeWallet);
      const nodeProfile = new Contract(profileAddr, [
        'function updateAsk(uint72 identityId, uint96 ask)',
      ], nodeWallet);

      await (await nodeToken.approve(stakingAddr, ethers.parseEther('100000'))).wait();
      await (await nodeStaking.stake(nodeProfileId, ethers.parseEther('50000'))).wait();
      await (await nodeProfile.updateAsk(nodeProfileId, ethers.parseEther('1'))).wait();
    }
  }, 120_000);

  afterAll(async () => {
    for (const agent of agents) {
      try { await agent.stop(); } catch {}
    }
    if (hardhatProcess) {
      hardhatProcess.kill('SIGTERM');
      hardhatProcess = null;
    }
  });

  // ── Finalization promotion (2 nodes) ───────────────────────────────────

  it('creates two agents with real EVM chain adapters', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }

    const nodeA = await DKGAgent.create({
      name: 'FinChainA',
      listenPort: 0,
      skills: [],
      chainConfig: makeChainConfig(NODE_A_KEY),
    });
    agents.push(nodeA);

    const nodeB = await DKGAgent.create({
      name: 'FinChainB',
      listenPort: 0,
      skills: [],
      chainConfig: makeChainConfig(NODE_B_KEY),
    });
    agents.push(nodeB);

    expect(nodeA.wallet).toBeDefined();
    expect(nodeB.wallet).toBeDefined();
  }, 60_000);

  it('starts agents, connects them, and both subscribe to paranet', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const [nodeA, nodeB] = agents;

    await nodeA.start();
    await nodeB.start();

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(2000);

    expect(nodeA.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(1);
    expect(nodeB.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(1);

    await nodeA.createContextGraph({ id: PARANET, name: 'Finalization Chain Test', description: '' });
    await nodeA.registerContextGraph(PARANET);
    // V10 Verified Memory publish requires explicit on-chain registration.
    // B only needs to join the gossip topic; A is already subscribed via create().
    nodeB.subscribeToContextGraph(PARANET);
    await sleep(1000);
  }, 30_000);

  it('A writes to workspace; B receives via GossipSub', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const [nodeA, nodeB] = agents;

    const quads = [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Finalization Chain Draft"', graph: '' as const },
      { subject: ENTITY_1, predicate: 'http://schema.org/version', object: '"1"', graph: '' as const },
    ];

    const wsResult = await nodeA.share(PARANET, quads);
    expect(wsResult.shareOperationId).toBeDefined();

    // Poll until B has the workspace data
    const deadline = Date.now() + 15000;
    let bWorkspace: any;
    while (Date.now() < deadline) {
      bWorkspace = await nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
        { contextGraphId: PARANET, graphSuffix: '_shared_memory' },
      );
      if (bWorkspace.bindings.length > 0) break;
      await sleep(500);
    }
    expect(bWorkspace.bindings.length).toBe(1);
    expect(bWorkspace.bindings[0]['name']).toBe('"Finalization Chain Draft"');
  }, 25000);

  it('A enshrines on-chain; B receives finalization and promotes to canonical', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const [nodeA, nodeB] = agents;

    const enshrineResult = await nodeA.publishFromSharedMemory(PARANET, {
      rootEntities: [ENTITY_1],
    });

    expect(enshrineResult.status).toBe('confirmed');
    expect(enshrineResult.ual).toBeDefined();
    expect(enshrineResult.onChainResult).toBeDefined();
    expect(enshrineResult.onChainResult!.txHash).toBeTruthy();
    expect(enshrineResult.onChainResult!.blockNumber).toBeGreaterThan(0);

    // A's data graph should have the enshrined data
    const aData = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
      PARANET,
    );
    expect(aData.bindings.length).toBe(1);
    expect(aData.bindings[0]['name']).toBe('"Finalization Chain Draft"');

    // Poll until B promotes the data to its canonical graph
    const deadline = Date.now() + 15000;
    let bData: any;
    while (Date.now() < deadline) {
      bData = await nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
        PARANET,
      );
      if (bData.bindings.length > 0) break;
      await sleep(500);
    }

    expect(bData.bindings.length).toBe(1);
    expect(bData.bindings[0]['name']).toBe('"Finalization Chain Draft"');
  }, 60_000);

  it('B has confirmed KC metadata with real chain provenance', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const nodeB = agents[1];

    const metaResult = await nodeB.query(
      `SELECT ?status WHERE {
        GRAPH ?g { ?kc <http://dkg.io/ontology/status> ?status }
      }`,
    );

    const statuses = metaResult.bindings.map((b: any) => String(b['status']));
    expect(statuses.some(s => s.includes('confirmed'))).toBe(true);

    // Verify chain provenance (transactionHash) is present in metadata
    const provenanceResult = await nodeB.query(
      `SELECT ?txHash WHERE {
        GRAPH ?g { ?kc <http://dkg.io/ontology/transactionHash> ?txHash }
      }`,
    );
    expect(provenanceResult.bindings.length).toBeGreaterThanOrEqual(1);
    expect(String(provenanceResult.bindings[0]['txHash'])).toMatch(/0x/);
  }, 10_000);

  it('B workspace data is cleaned up after promotion', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const nodeB = agents[1];

    const wsResult = await nodeB.query(
      `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
      { contextGraphId: PARANET, graphSuffix: '_shared_memory' },
    );
    expect(wsResult.bindings.length).toBe(0);
  }, 5000);

  // ── Enshrine cycle: write → enshrine → write new entity → enshrine ────

  it('enshrines two separate entities across successive workspace cycles', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const nodeA = agents[0];

    // Write entity 2 to workspace
    await nodeA.share(PARANET, [
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Entity Two"', graph: '' },
    ]);

    const ws2 = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_2}> <http://schema.org/name> ?name }`,
      { contextGraphId: PARANET, graphSuffix: '_shared_memory' },
    );
    expect(ws2.bindings.length).toBe(1);

    // Enshrine entity 2
    const result2 = await nodeA.publishFromSharedMemory(PARANET, { rootEntities: [ENTITY_2] });
    expect(result2.status).toBe('confirmed');
    expect(result2.onChainResult).toBeDefined();

    // Both entities should now be in the data graph
    const dataAll = await nodeA.query(
      `SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }`,
      PARANET,
    );
    const names = dataAll.bindings.map((b: any) => String(b['name']));
    expect(names.some((n: string) => n.includes('Finalization Chain Draft'))).toBe(true);
    expect(names.some((n: string) => n.includes('Entity Two'))).toBe(true);
  }, 60_000);

  // ── Workspace cleanup: clearSharedMemoryAfter flag ────────────────────────

  it('enshrineFromWorkspace with clearWorkspaceAfter removes workspace data', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const nodeA = agents[0];

    await nodeA.share(PARANET, [
      { subject: ENTITY_3, predicate: 'http://schema.org/name', object: '"Cleanup Entity"', graph: '' },
    ]);

    const wsBefore = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_3}> <http://schema.org/name> ?name }`,
      { contextGraphId: PARANET, graphSuffix: '_shared_memory' },
    );
    expect(wsBefore.bindings.length).toBe(1);

    const result = await nodeA.publishFromSharedMemory(PARANET, { rootEntities: [ENTITY_3] }, {
      clearSharedMemoryAfter: true,
    });
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();

    // Workspace should be cleaned
    const wsAfter = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_3}> <http://schema.org/name> ?name }`,
      { contextGraphId: PARANET, graphSuffix: '_shared_memory' },
    );
    expect(wsAfter.bindings.length).toBe(0);

    // Data graph should have the data
    const data = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_3}> <http://schema.org/name> ?name }`,
      PARANET,
    );
    expect(data.bindings.length).toBe(1);
    expect(data.bindings[0]['name']).toBe('"Cleanup Entity"');
  }, 60_000);
});
