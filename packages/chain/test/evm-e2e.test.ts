import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet, Contract } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  spawnHardhatEnv,
  killHardhat,
  makeAdapterConfig,
  mintTokens,
  signMerkleRoot,
  buildReceiverSignatures,
  HARDHAT_KEYS,
  type HardhatContext,
} from './hardhat-harness.js';

let ctx: HardhatContext | null = null;
let deployerProfileId: number;

describe('EVM E2E: Full on-chain publishing lifecycle', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8546);
    if (ctx) {
      deployerProfileId = ctx.coreProfileId;
    }
  }, 90_000);

  afterAll(() => {
    killHardhat(ctx);
  });

  it('deploys V8 + V9 contracts and registers them in Hub', async (test) => {
    if (!ctx) { test.skip(); return; }
    const hub = new Contract(ctx.hubAddress, [
      'function getContractAddress(string) view returns (address)',
      'function getAssetStorageAddress(string) view returns (address)',
    ], ctx.provider);

    const kaAddr = await hub.getContractAddress('KnowledgeAssets');
    const kasAddr = await hub.getAssetStorageAddress('KnowledgeAssetsStorage');
    const kcAddr = await hub.getContractAddress('KnowledgeCollection');

    expect(kaAddr).not.toBe(ethers.ZeroAddress);
    expect(kasAddr).not.toBe(ethers.ZeroAddress);
    expect(kcAddr).not.toBe(ethers.ZeroAddress);

    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const kc = await adapter.getContract('KnowledgeCollection');
    expect(await kc.name()).toBe('KnowledgeCollection');
  }, 30_000);

  it('reserves a UAL range (no identity needed)', async (test) => {
    if (!ctx) { test.skip(); return; }
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.PUBLISHER));
    const result = await adapter.reserveUALRange(50);
    expect(result.startId).toBe(1n);
    expect(result.endId).toBe(50n);
  }, 30_000);

  it('publishes KAs in a single transaction (publishKnowledgeAssets)', async (test) => {
    if (!ctx) { test.skip(); return; }
    const pubAdapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.PUBLISHER2));
    const publicByteSize = 1000n;
    const epochs = 2;

    const requiredTokenAmount = await pubAdapter.getRequiredPublishTokenAmount(publicByteSize, epochs);
    expect(requiredTokenAmount).toBeGreaterThan(0n);

    const publisher2 = new Wallet(HARDHAT_KEYS.PUBLISHER2, ctx.provider);
    await mintTokens(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, publisher2.address, requiredTokenAmount * 2n);

    const coreOp = new Wallet(HARDHAT_KEYS.CORE_OP, ctx.provider);
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e2e-single-tx'));
    const pubSig = await signMerkleRoot(coreOp, deployerProfileId, merkleRoot);
    const receiverSignatures = await buildReceiverSignatures(ctx.provider, ctx.hubAddress, merkleRoot, publicByteSize);

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
    expect(result.publisherAddress.toLowerCase()).toBe(publisher2.address.toLowerCase());
  }, 60_000);

  it('minted ERC1155 NFTs for each KA (publisher owns one per token id in batch)', async (test) => {
    if (!ctx) { test.skip(); return; }
    const hub = new Contract(ctx.hubAddress, [
      'function getContractAddress(string) view returns (address)',
      'function getAssetStorageAddress(string) view returns (address)',
    ], ctx.provider);
    const kasAddr = await hub.getAssetStorageAddress('KnowledgeAssetsStorage');
    const publisher2 = new Wallet(HARDHAT_KEYS.PUBLISHER2, ctx.provider).address;

    const kas = new Contract(kasAddr, [
      'function getKnowledgeAssetsRange(uint256 batchId) view returns (uint256 startTokenId, uint256 endTokenId)',
      'function balanceOf(address owner, uint256 id) view returns (uint256)',
      'function balanceOf(address owner) view returns (uint256)',
    ], ctx.provider);

    const batchId = 1n;
    const [startTokenId, endTokenId] = await kas.getKnowledgeAssetsRange(batchId);
    expect(startTokenId).toBeGreaterThan(0n);
    expect(endTokenId).toBeGreaterThanOrEqual(startTokenId);

    const totalBalance = await kas['balanceOf(address)'](publisher2);
    expect(totalBalance).toBe(5n);

    for (let tokenId = startTokenId; tokenId <= endTokenId; tokenId++) {
      const balance = await kas['balanceOf(address,uint256)'](publisher2, tokenId);
      expect(balance).toBe(1n);
    }
  }, 30_000);

  it('updates knowledge assets (new merkle root)', async (test) => {
    if (!ctx) { test.skip(); return; }
    const pubAdapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.PUBLISHER2));

    const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e2e-updated-root'));
    const result = await pubAdapter.updateKnowledgeAssets({
      batchId: 1n,
      newMerkleRoot: ethers.getBytes(newMerkleRoot),
      newPublicByteSize: 2048n,
    });

    expect(result.success).toBe(true);
  }, 30_000);

  it('extends storage duration (adapter auto-approves TRAC)', async (test) => {
    if (!ctx) { test.skip(); return; }
    const pubAdapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.PUBLISHER2));
    const extensionCost = await pubAdapter.getRequiredPublishTokenAmount(2048n, 5);
    expect(extensionCost).toBeGreaterThan(0n);

    const publisher2 = new Wallet(HARDHAT_KEYS.PUBLISHER2, ctx.provider);
    await mintTokens(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, publisher2.address, extensionCost);

    const result = await pubAdapter.extendStorage({
      batchId: 1n,
      additionalEpochs: 5,
      tokenAmount: extensionCost,
    });
    expect(result.success).toBe(true);
  }, 30_000);

  it('transfers namespace to a fresh address', async (test) => {
    if (!ctx) { test.skip(); return; }
    const publisherAdapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.PUBLISHER));
    const freshAddress = new Wallet(HARDHAT_KEYS.EXTRA1).address;

    const result = await publisherAdapter.transferNamespace(freshAddress);
    expect(result.success).toBe(true);
  }, 30_000);

  it('retrieves KnowledgeBatchCreated events', async (test) => {
    if (!ctx) { test.skip(); return; }
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));

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
