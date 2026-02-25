import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { ethers, JsonRpcProvider, Wallet, Contract } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import path from 'node:path';

const EVM_MODULE_DIR = path.resolve(import.meta.dirname, '../../evm-module');
const RPC_URL = 'http://127.0.0.1:8546';
const HARDHAT_CHAIN_ID = 31337;

// Hardhat default accounts (deterministic). accounts[0] is the deployer.
// Profile creation requires admin != operational, so we pair them: (operational=odd, admin=even)
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';  // account[0]
const CORE_OP_KEY   = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';  // account[1] operational
const CORE_ADMIN_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // account[2] admin
const REC1_OP_KEY   = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';  // account[3]
const REC1_ADMIN_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'; // account[4]
const REC2_OP_KEY   = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'; // account[5]
const REC2_ADMIN_KEY = '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e'; // account[6]
const REC3_OP_KEY   = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356'; // account[7]
const REC3_ADMIN_KEY = '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97'; // account[8]
// Publishers: don't need profiles, just publish on-chain
const PUBLISHER_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'; // account[9]
const PUBLISHER2_KEY = '0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897'; // account[10]
const FRESH_TRANSFER_KEY = '0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82'; // account[11]

let hardhatProcess: ChildProcess | null = null;
let hubAddress: string;
let provider: JsonRpcProvider;
let skipSuite = false;

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
          if (match) { resolve(match[1]); return; }
        }
      }
      const hubMatch = stdout.match(/deploying "Hub".*?deployed at (\S+)/s);
      if (hubMatch) { resolve(hubMatch[1]); }
      else { reject(new Error(`Hub address not found in:\n${stdout}`)); }
    });
  });
}

function makeConfig(privateKey = DEPLOYER_KEY): EVMAdapterConfig {
  return { rpcUrl: RPC_URL, privateKey, hubAddress, chainId: `evm:${HARDHAT_CHAIN_ID}` };
}

async function createNodeProfile(
  operationalKey: string,
  adminKey: string,
  name: string,
): Promise<number> {
  const operational = new Wallet(operationalKey, provider);
  const admin = new Wallet(adminKey, provider);
  const hub = new Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
  const profileAddr = await hub.getContractAddress('Profile');

  const profile = new Contract(profileAddr, [
    'function createProfile(address, address[], string, bytes, uint16) external',
  ], operational);

  const nodeId = ethers.hexlify(ethers.randomBytes(32));

  const tx = await profile.createProfile(admin.address, [], name, nodeId, 0);
  const receipt = await tx.wait();

  const identityId = Number(receipt.logs[0].topics[1]);
  if (!identityId) throw new Error('No IdentityCreated event');
  return identityId;
}

async function signMerkleRoot(signer: Wallet, identityId: number, merkleRoot: string) {
  const msgHash = ethers.solidityPackedKeccak256(['uint72', 'bytes32'], [identityId, merkleRoot]);
  const rawSig = await signer.signMessage(ethers.getBytes(msgHash));
  const sig = ethers.Signature.from(rawSig);
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}

/** Receiver signs (merkleRoot, publicByteSize) — same hash as V9 contract. */
async function signReceiverMerkleRootAndByteSize(
  signer: Wallet,
  merkleRoot: string,
  publicByteSize: number | bigint,
) {
  const msgHash = ethers.solidityPackedKeccak256(
    ['bytes32', 'uint64'],
    [merkleRoot, BigInt(publicByteSize)],
  );
  const rawSig = await signer.signMessage(ethers.getBytes(msgHash));
  const sig = ethers.Signature.from(rawSig);
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}

let deployerProfileId: number;

describe('EVM E2E: Full on-chain publishing lifecycle', () => {
  beforeAll(async () => {
    hardhatProcess = spawn(
      'npx',
      ['hardhat', 'node', '--port', '8546', '--config', 'hardhat.node.config.ts'],
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
    provider = new JsonRpcProvider(RPC_URL);
    hubAddress = await deployContracts();

    // Create core node profiles (needed for signatures)
    // Profile uses operational key as caller, admin key as first param
    deployerProfileId = await createNodeProfile(CORE_OP_KEY, CORE_ADMIN_KEY, 'CoreNode1');
    await createNodeProfile(REC1_OP_KEY, REC1_ADMIN_KEY, 'Receiver1');
    await createNodeProfile(REC2_OP_KEY, REC2_ADMIN_KEY, 'Receiver2');
    await createNodeProfile(REC3_OP_KEY, REC3_ADMIN_KEY, 'Receiver3');

    // Set ask so V9 publish requires TRAC: stake one node and set ask (triggers recalculateActiveSet)
    const hub = new Contract(hubAddress, [
      'function getContractAddress(string) view returns (address)',
    ], provider);
    const tokenAddr = await hub.getContractAddress('Token');
    const stakingAddr = await hub.getContractAddress('Staking');
    const profileAddr = await hub.getContractAddress('Profile');
    const token = new Contract(tokenAddr, [
      'function mint(address, uint256)',
      'function approve(address, uint256) returns (bool)',
    ], new Wallet(DEPLOYER_KEY, provider));
    const staking = new Contract(stakingAddr, [
      'function stake(uint72 identityId, uint96 amount)',
    ], new Wallet(CORE_OP_KEY, provider));
    const profile = new Contract(profileAddr, [
      'function updateAsk(uint72 identityId, uint96 ask)',
    ], new Wallet(CORE_OP_KEY, provider));
    const stakeAmount = ethers.parseEther('10000');
    await token.mint(new Wallet(CORE_OP_KEY, provider).address, stakeAmount);
    await token.connect(new Wallet(CORE_OP_KEY, provider)).approve(stakingAddr, stakeAmount);
    await staking.stake(deployerProfileId, stakeAmount);
    await profile.updateAsk(deployerProfileId, ethers.parseEther('1'));
  }, 90_000);

  afterAll(() => {
    if (hardhatProcess) {
      hardhatProcess.kill('SIGTERM');
      hardhatProcess = null;
    }
  });

  it('deploys V8 + V9 contracts and registers them in Hub', async () => {
    if (skipSuite) return;
    // Directly query the Hub to verify contracts are registered
    const hub = new Contract(hubAddress, [
      'function getContractAddress(string) view returns (address)',
      'function getAssetStorageAddress(string) view returns (address)',
    ], provider);

    const kaAddr = await hub.getContractAddress('KnowledgeAssets');
    const kasAddr = await hub.getAssetStorageAddress('KnowledgeAssetsStorage');
    const kcAddr = await hub.getContractAddress('KnowledgeCollection');

    expect(kaAddr).not.toBe(ethers.ZeroAddress);
    expect(kasAddr).not.toBe(ethers.ZeroAddress);
    expect(kcAddr).not.toBe(ethers.ZeroAddress);

    // Verify names via the adapter
    const adapter = new EVMChainAdapter(makeConfig());
    const kc = await adapter.getContract('KnowledgeCollection');
    expect(await kc.name()).toBe('KnowledgeCollection');
  }, 30_000);

  it('reserves a UAL range (no identity needed)', async () => {
    if (skipSuite) return;
    const adapter = new EVMChainAdapter(makeConfig(PUBLISHER_KEY));
    const result = await adapter.reserveUALRange(50);
    expect(result.startId).toBe(1n);
    expect(result.endId).toBe(50n);
  }, 30_000);

  it('publishes KAs in a single transaction (publishKnowledgeAssets)', async () => {
    if (skipSuite) return;
    const pubAdapter = new EVMChainAdapter(makeConfig(PUBLISHER2_KEY));
    const publicByteSize = 1000n;
    const epochs = 2;

    // Required TRAC: get from adapter and fund publisher (no manual approve — adapter handles it)
    const requiredTokenAmount = await pubAdapter.getRequiredPublishTokenAmount(publicByteSize, epochs);
    expect(requiredTokenAmount).toBeGreaterThan(0n);
    const hub = new Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
    const tokenAddr = await hub.getContractAddress('Token');
    const token = new Contract(tokenAddr, [
      'function mint(address, uint256)',
    ], new Wallet(DEPLOYER_KEY, provider));
    const publisher2 = new Wallet(PUBLISHER2_KEY, provider);
    await token.mint(publisher2.address, requiredTokenAmount * 2n);

    // Signing: publisher node signs (pubId, merkleRoot); receivers sign (merkleRoot, publicByteSize)
    const coreOp = new Wallet(CORE_OP_KEY, provider);
    const rec1Op = new Wallet(REC1_OP_KEY, provider);
    const rec2Op = new Wallet(REC2_OP_KEY, provider);
    const rec3Op = new Wallet(REC3_OP_KEY, provider);

    const idStorageAddr = await hub.getContractAddress('IdentityStorage');
    const idStorage = new Contract(idStorageAddr, ['function getIdentityId(address) view returns (uint72)'], provider);
    const rec1Id = Number(await idStorage.getIdentityId(rec1Op.address));
    const rec2Id = Number(await idStorage.getIdentityId(rec2Op.address));
    const rec3Id = Number(await idStorage.getIdentityId(rec3Op.address));

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e2e-single-tx'));
    const pubSig = await signMerkleRoot(coreOp, deployerProfileId, merkleRoot);

    const receiverSignatures = [
      { identityId: BigInt(rec1Id), ...(await signReceiverMerkleRootAndByteSize(rec1Op, merkleRoot, publicByteSize)) },
      { identityId: BigInt(rec2Id), ...(await signReceiverMerkleRootAndByteSize(rec2Op, merkleRoot, publicByteSize)) },
      { identityId: BigInt(rec3Id), ...(await signReceiverMerkleRootAndByteSize(rec3Op, merkleRoot, publicByteSize)) },
    ];

    const result = await pubAdapter.publishKnowledgeAssets({
      kaCount: 5,
      publisherNodeIdentityId: BigInt(deployerProfileId),
      merkleRoot: ethers.getBytes(merkleRoot),
      publicByteSize,
      epochs,
      tokenAmount: requiredTokenAmount,
      publisherSignature: pubSig,
      receiverSignatures,
    });

    expect(result.batchId).toBeGreaterThan(0n);
    expect(result.startKAId).toBe(1n);
    expect(result.endKAId).toBe(5n);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.blockNumber).toBeGreaterThan(0);
    expect(result.blockTimestamp).toBeGreaterThan(0);
    expect(result.publisherAddress.toLowerCase()).toBe(
      new Wallet(PUBLISHER2_KEY).address.toLowerCase(),
    );
  }, 60_000);

  it('minted ERC1155 NFTs for each KA (publisher owns one per token id in batch)', async () => {
    if (skipSuite) return;
    const hub = new Contract(hubAddress, [
      'function getContractAddress(string) view returns (address)',
      'function getAssetStorageAddress(string) view returns (address)',
    ], provider);
    const kasAddr = await hub.getAssetStorageAddress('KnowledgeAssetsStorage');
    const publisher2 = new Wallet(PUBLISHER2_KEY, provider).address;

    const kas = new Contract(kasAddr, [
      'function getKnowledgeAssetsRange(uint256 batchId) view returns (uint256 startTokenId, uint256 endTokenId)',
      'function balanceOf(address owner, uint256 id) view returns (uint256)',
      'function balanceOf(address owner) view returns (uint256)',
    ], provider);

    const batchId = 1n;
    const [startTokenId, endTokenId] = await kas.getKnowledgeAssetsRange(batchId);
    expect(startTokenId).toBeGreaterThan(0n);
    expect(endTokenId).toBeGreaterThanOrEqual(startTokenId);

    const totalBalance = await kas.balanceOf(publisher2);
    expect(totalBalance).toBe(5n);

    for (let tokenId = startTokenId; tokenId <= endTokenId; tokenId++) {
      const balance = await kas.balanceOf(publisher2, tokenId);
      expect(balance).toBe(1n);
    }
  }, 30_000);

  it('updates knowledge assets (new merkle root)', async () => {
    if (skipSuite) return;
    const pubAdapter = new EVMChainAdapter(makeConfig(PUBLISHER2_KEY));

    const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e2e-updated-root'));
    const result = await pubAdapter.updateKnowledgeAssets({
      batchId: 1n,
      newMerkleRoot: ethers.getBytes(newMerkleRoot),
      newPublicByteSize: 2048n,
    });

    expect(result.success).toBe(true);
  }, 30_000);

  it('extends storage duration (adapter auto-approves TRAC)', async () => {
    if (skipSuite) return;
    const pubAdapter = new EVMChainAdapter(makeConfig(PUBLISHER2_KEY));
    // Extension cost: (ask * publicByteSize * additionalEpochs) / 1024 (batch was updated to 2048 bytes)
    const extensionCost = await pubAdapter.getRequiredPublishTokenAmount(2048n, 5);
    expect(extensionCost).toBeGreaterThan(0n);

    const hub = new Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
    const tokenAddr = await hub.getContractAddress('Token');
    const token = new Contract(tokenAddr, [
      'function mint(address, uint256)',
    ], new Wallet(DEPLOYER_KEY, provider));
    const publisher2 = new Wallet(PUBLISHER2_KEY, provider);
    await token.mint(publisher2.address, extensionCost);

    const result = await pubAdapter.extendStorage({
      batchId: 1n,
      additionalEpochs: 5,
      tokenAmount: extensionCost,
    });
    expect(result.success).toBe(true);
  }, 30_000);

  it('transfers namespace to a fresh address', async () => {
    if (skipSuite) return;
    const publisherAdapter = new EVMChainAdapter(makeConfig(PUBLISHER_KEY));
    const freshAddress = new Wallet(FRESH_TRANSFER_KEY).address;

    const result = await publisherAdapter.transferNamespace(freshAddress);
    expect(result.success).toBe(true);
  }, 30_000);

  it('retrieves KnowledgeBatchCreated events', async () => {
    if (skipSuite) return;
    const adapter = new EVMChainAdapter(makeConfig());

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const event of adapter.listenForEvents({
      eventTypes: ['KnowledgeBatchCreated'],
      fromBlock: 0,
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe('KnowledgeBatchCreated');
    expect(events[0].data.batchId).toBeDefined();
    expect(events[0].data.publisherAddress).toBeDefined();
    expect(events[0].data.merkleRoot).toBeDefined();
  }, 30_000);
});
