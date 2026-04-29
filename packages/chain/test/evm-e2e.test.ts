import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet, Contract } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  spawnHardhatEnv,
  killHardhat,
  makeAdapterConfig,
  mintTokens,
  stakeAndSetAsk,
  setMinimumRequiredSignatures,
  getIdentityIdByAddress,
  signMerkleRoot,
  buildReceiverSignatures,
  HARDHAT_KEYS,
  type HardhatContext,
} from './hardhat-harness.js';

let ctx: HardhatContext;
let deployerProfileId: number;

describe('EVM E2E: Full on-chain publishing lifecycle', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8546);
    deployerProfileId = ctx.coreProfileId;
  }, 90_000);

  afterAll(() => {
    killHardhat(ctx);
  });

  it('deploys V8 + V9 contracts and registers them in Hub', async () => {
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

  it('reserves a UAL range (no identity needed)', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.PUBLISHER));
    const result = await adapter.reserveUALRange(50);
    expect(result.startId).toBe(1n);
    expect(result.endId).toBe(50n);
  }, 30_000);

  it('publishes KAs in a single transaction (publishKnowledgeAssets)', async () => {
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

  it('minted ERC1155 NFTs for each KA (publisher owns one per token id in batch)', async () => {
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

  it('updates knowledge assets (new merkle root)', async () => {
    const pubAdapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.PUBLISHER2));

    const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e2e-updated-root'));
    const result = await pubAdapter.updateKnowledgeAssets({
      batchId: 1n,
      newMerkleRoot: ethers.getBytes(newMerkleRoot),
      newPublicByteSize: 2048n,
    });

    expect(result.success).toBe(true);
  }, 30_000);

  it('extends storage duration (adapter auto-approves TRAC)', async () => {
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

  it('transfers namespace to a fresh address', async () => {
    const publisherAdapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.PUBLISHER));
    const freshAddress = new Wallet(HARDHAT_KEYS.EXTRA1).address;

    const result = await publisherAdapter.transferNamespace(freshAddress);
    expect(result.success).toBe(true);
  }, 30_000);

  it('retrieves KnowledgeBatchCreated events', async () => {
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
    expect(BigInt(events[0].data.batchId as string | bigint)).toBe(1n);
    expect(String(events[0].data.publisherAddress).toLowerCase()).toBe(
      new Wallet(HARDHAT_KEYS.PUBLISHER2).address.toLowerCase(),
    );
    expect(events[0].data.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
  }, 30_000);

  // -------------------------------------------------------------------------
  // V10 Multi-validator ACK publish (minimumRequiredSignatures > 1)
  // -------------------------------------------------------------------------

  it('V10: publishes with 3 ACK signatures (multi-validator)', async () => {

    // Raise minimumRequiredSignatures to 3
    await setMinimumRequiredSignatures(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, 3);

    // Stake all 3 receivers so they are eligible ACK signers
    for (const [opKey, receiverId] of [
      [HARDHAT_KEYS.REC1_OP, ctx.receiverIds[0]] as const,
      [HARDHAT_KEYS.REC2_OP, ctx.receiverIds[1]] as const,
      [HARDHAT_KEYS.REC3_OP, ctx.receiverIds[2]] as const,
    ]) {
      await stakeAndSetAsk(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, opKey, receiverId);
    }

    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.CORE_OP),
    );
    const coreOp = new Wallet(HARDHAT_KEYS.CORE_OP, ctx.provider);
    await mintTokens(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('500000'));

    // Create an on-chain context graph with all 3 receivers as hosting nodes (M/N: 3/3)
    const cgResult = await adapter.createOnChainContextGraph({
      participantIdentityIds: ctx.receiverIds.map((id) => BigInt(id)),
      requiredSignatures: 3,
    });
    expect(cgResult.success).toBe(true);
    const contextGraphId = cgResult.contextGraphId;
    expect(contextGraphId).toBeGreaterThan(0n);

    // Build V10 publish parameters
    const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('multi-ack-test')));
    const kaCount = 2;
    const byteSize = 256n;
    const epochs = 2;
    const tokenAmount = await adapter.getRequiredPublishTokenAmount(byteSize, epochs);

    const publisherIdentityId = BigInt(ctx.coreProfileId);
    const kav10Address = await adapter.getKnowledgeAssetsV10Address();
    const evmChainId = await adapter.getEvmChainId();

    // Publisher digest: keccak256(abi.encodePacked(chainid, address(KAV10), identityId, contextGraphId, merkleRoot))
    const pubDigest = ethers.getBytes(ethers.solidityPackedKeccak256(
      ['uint256', 'address', 'uint72', 'uint256', 'bytes32'],
      [evmChainId, kav10Address, publisherIdentityId, contextGraphId, ethers.hexlify(merkleRoot)],
    ));
    const pubSigRaw = await coreOp.signMessage(pubDigest);
    const pubSig = ethers.Signature.from(pubSigRaw);

    // ACK digest: keccak256(abi.encodePacked(chainid, address(KAV10), contextGraphId, merkleRoot, kaCount, byteSize, epochs, tokenAmount))
    const ackDigest = ethers.getBytes(ethers.solidityPackedKeccak256(
      ['uint256', 'address', 'uint256', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256'],
      [evmChainId, kav10Address, contextGraphId, ethers.hexlify(merkleRoot), kaCount, byteSize, epochs, tokenAmount],
    ));

    // Collect ACK signatures from 3 receivers
    const ackSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> = [];
    for (const opKey of [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP]) {
      const receiverWallet = new Wallet(opKey, ctx.provider);
      const receiverIdentityId = BigInt(
        await getIdentityIdByAddress(ctx.provider, ctx.hubAddress, receiverWallet.address),
      );

      const ackSigRaw = await receiverWallet.signMessage(ackDigest);
      const ackSig = ethers.Signature.from(ackSigRaw);

      ackSignatures.push({
        identityId: receiverIdentityId,
        r: ethers.getBytes(ackSig.r),
        vs: ethers.getBytes(ackSig.yParityAndS),
      });
    }

    expect(ackSignatures.length).toBe(3);

    const result = await adapter.createKnowledgeAssetsV10!({
      publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
      contextGraphId,
      merkleRoot,
      knowledgeAssetsAmount: kaCount,
      byteSize,
      epochs,
      tokenAmount,
      isImmutable: false,
      paymaster: ethers.ZeroAddress,
      convictionAccountId: 0n,
      publisherNodeIdentityId: publisherIdentityId,
      publisherSignature: {
        r: ethers.getBytes(pubSig.r),
        vs: ethers.getBytes(pubSig.yParityAndS),
      },
      ackSignatures,
    });

    expect(result.batchId).toBeGreaterThan(0n);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.blockNumber).toBeGreaterThan(0);

    // Restore to 1 for subsequent tests
    await setMinimumRequiredSignatures(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, 1);
  }, 60_000);

  // The PR
  // introduced `V10KnowledgeBatchEmitted` on KASStorage and
  // documented it as the topic V10-aware consumers should subscribe
  // to, but `listenForEvents()` had no branch for it — any
  // subscriber following the docs got an empty stream. This test
  // pins the adapter-side fix by asserting the event is now reachable
  // through the same API as every other chain event.
  it('listenForEvents exposes V10KnowledgeBatchEmitted after a V10 publish', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const event of adapter.listenForEvents({
      eventTypes: ['V10KnowledgeBatchEmitted'],
      fromBlock: 0,
    })) {
      events.push(event);
    }

    // Prior V10 publishes in this suite MUST have surfaced at least
    // one V10KnowledgeBatchEmitted record.
    expect(events.length).toBeGreaterThanOrEqual(1);
    const e = events[0];
    expect(e.type).toBe('V10KnowledgeBatchEmitted');
    expect(BigInt(e.data.batchId as string | bigint)).toBeGreaterThan(0n);
    expect(e.data.publisherAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(e.data.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
    // Shape pins: these are the normalized fields documented in
    // evm-adapter.ts for the new branch.
    expect(typeof e.data.knowledgeAssetsCount).toBe('string');
    expect(typeof e.data.publicByteSize).toBe('string');
    expect(typeof e.data.startKAId).toBe('string');
    expect(typeof e.data.endKAId).toBe('string');
    expect(typeof e.data.isPermanent).toBe('boolean');
    expect(e.data.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  }, 30_000);
});
