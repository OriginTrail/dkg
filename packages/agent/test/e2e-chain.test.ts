import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { ethers, JsonRpcProvider, Wallet, Contract } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { EVMChainAdapter, type EVMAdapterConfig } from '@origintrail-official/dkg-chain';
import path from 'node:path';

const EVM_MODULE_DIR = path.resolve(import.meta.dirname, '../../evm-module');
const RPC_URL = 'http://127.0.0.1:8547';
const HARDHAT_CHAIN_ID = 31337;

// Hardhat default accounts (operational/admin pairs must use distinct addresses)
const DEPLOYER_OP_KEY  = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // account[0]
const DEPLOYER_ADMIN_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // account[1]
const NODE_A_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // account[2]
const NODE_B_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'; // account[3]

let hardhatProcess: ChildProcess | null = null;
let hubAddress: string;
let provider: JsonRpcProvider;
let skipSuite = false;

const agents: DKGAgent[] = [];

/** Returns true if node is ready, false if timeout (so caller can skip the suite). */
async function waitForNode(url: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const p = new JsonRpcProvider(url);
      await p.getBlockNumber();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
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
          if (match) {
            resolve(match[1]);
            return;
          }
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

function makeChainConfig(privateKey: string): { rpcUrl: string; hubAddress: string; privateKey: string; chainId: string } {
  return {
    rpcUrl: RPC_URL,
    privateKey,
    hubAddress,
    chainId: `evm:${HARDHAT_CHAIN_ID}`,
  };
}

async function createProfileForKeys(operationalKey: string, adminKey: string): Promise<number> {
  const operational = new Wallet(operationalKey, provider);
  const admin = new Wallet(adminKey, provider);
  const hub = new Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
  const profileAddr = await hub.getContractAddress('Profile');

  const profile = new Contract(profileAddr, [
    'function createProfile(address, address[], string, bytes, uint16) external',
  ], operational);

  const nodeId = ethers.hexlify(ethers.randomBytes(32));
  const name = `Node-${operational.address.slice(2, 8)}`;
  const tx = await profile.createProfile(admin.address, [], name, nodeId, 0);
  const receipt = await tx.wait();

  const identityId = Number(receipt.logs[0].topics[1]);
  if (!identityId) throw new Error('No IdentityCreated event');
  return identityId;
}

describe('E2E: DKGAgent with real blockchain', () => {
  beforeAll(async () => {
    hardhatProcess = spawn(
      'npx',
      ['hardhat', 'node', '--port', '8547', '--config', 'hardhat.node.config.ts'],
      {
        cwd: EVM_MODULE_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );

    const ready = await waitForNode(RPC_URL, 15_000);
    if (!ready) {
      skipSuite = true;
      if (hardhatProcess) {
        hardhatProcess.kill('SIGTERM');
        hardhatProcess = null;
      }
      return;
    }
    provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
    hubAddress = await deployContracts();

    const coreProfileId = await createProfileForKeys(DEPLOYER_OP_KEY, DEPLOYER_ADMIN_KEY);

    const hub = new Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
    const tokenAddr = await hub.getContractAddress('Token');
    const stakingAddr = await hub.getContractAddress('Staking');
    const profileAddr = await hub.getContractAddress('Profile');
    const deployerWallet = new Wallet(DEPLOYER_OP_KEY, provider);
    const token = new Contract(tokenAddr, [
      'function mint(address, uint256)',
      'function approve(address, uint256) returns (bool)',
    ], deployerWallet);
    const staking = new Contract(stakingAddr, ['function stake(uint72 identityId, uint96 amount)'], deployerWallet);
    const profile = new Contract(profileAddr, ['function updateAsk(uint72 identityId, uint96 ask)'], deployerWallet);
    const stakeAmount = ethers.parseEther('50000');
    await (await token.mint(deployerWallet.address, stakeAmount)).wait();
    await (await token.connect(deployerWallet).approve(stakingAddr, stakeAmount)).wait();
    await (await staking.stake(coreProfileId, stakeAmount)).wait();
    await (await profile.updateAsk(coreProfileId, ethers.parseEther('1'))).wait();

    const nodeA = new Wallet(NODE_A_KEY, provider);
    await (await token.mint(nodeA.address, ethers.parseEther('100000'))).wait();
  }, 90_000);

  afterAll(async () => {
    for (const agent of agents) {
      try {
        await agent.stop();
      } catch (err) {
        console.warn('Teardown: agent.stop() failed', err);
      }
    }
    if (hardhatProcess) {
      hardhatProcess.kill('SIGTERM');
      hardhatProcess = null;
    }
  });

  it('creates agents with real EVMChainAdapter (no mocks)', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const agentA = await DKGAgent.create({
      name: 'ChainNodeA',
      listenPort: 0,
      skills: [],
      chainConfig: makeChainConfig(NODE_A_KEY),
    });
    agents.push(agentA);

    const agentB = await DKGAgent.create({
      name: 'ChainNodeB',
      listenPort: 0,
      skills: [],
      chainConfig: makeChainConfig(NODE_B_KEY),
    });
    agents.push(agentB);

    expect(agentA.wallet).toBeDefined();
    expect(agentB.wallet).toBeDefined();
  }, 60_000);

  it('starts agents and connects them', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    await agents[0].start();
    await agents[1].start();

    const addrA = agents[0].multiaddrs[0];
    await agents[1].connectTo(addrA);

    await new Promise((r) => setTimeout(r, 2000));

    const peersA = agents[0].node.libp2p.getPeers();
    const peersB = agents[1].node.libp2p.getPeers();

    expect(peersA.length).toBeGreaterThanOrEqual(1);
    expect(peersB.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('publishes knowledge through agent (on-chain finality)', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const paranetId = 'test-chain-paranet';
    await agents[0].createParanet({
      id: paranetId,
      name: 'Chain Test Paranet',
      description: 'E2E test with real blockchain',
    });

    agents[0].subscribeToParanet(paranetId);
    agents[1].subscribeToParanet(paranetId);

    await new Promise((r) => setTimeout(r, 1000));

    const quads = [
      {
        subject: 'did:dkg:test:Alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
        graph: `did:dkg:context-graph:${paranetId}`,
      },
      {
        subject: 'did:dkg:test:Alice',
        predicate: 'http://schema.org/knows',
        object: 'did:dkg:test:Bob',
        graph: `did:dkg:context-graph:${paranetId}`,
      },
    ];

    const result = await agents[0].publish(paranetId, quads);
    expect(result).toBeDefined();
    expect(result.kaManifest).toBeDefined();
    expect(result.kaManifest.length).toBeGreaterThan(0);
  }, 60_000);

  it('queries published knowledge', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    const result = await agents[0].query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10',
    );

    expect(result).toBeDefined();
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('second agent receives published knowledge via gossipsub', async (ctx) => {
    if (skipSuite) { ctx.skip(); return; }
    await new Promise((r) => setTimeout(r, 3000));

    const result = await agents[1].query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
    );

    expect(result).toBeDefined();
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBeGreaterThan(0);
    }
  }, 30_000);
});
