import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet } from 'ethers';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from './evm-test-context.js';
import {
  mintTokens,
  signMerkleRoot,
  buildReceiverSignatures,
} from './hardhat-harness.js';

let snapshotId: string;

describe('Permanent Publishing (EVMChainAdapter)', () => {
  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const pubAddr = new Wallet(HARDHAT_KEYS.PUBLISHER).address;
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, pubAddr, ethers.parseEther('5000000'));
  });

  afterAll(async () => {
    await revertSnapshot(snapshotId);
  });

  it('publishes knowledge assets permanently', async () => {
    const { hubAddress, coreProfileId } = getSharedContext();
    const provider = createProvider();
    const adapter = createEVMAdapter(HARDHAT_KEYS.PUBLISHER);

    const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('permanent-test')));
    const publicByteSize = 1024n;
    const requiredAmount = await adapter.getRequiredPublishTokenAmount!(publicByteSize, 100);
    const tokenAmount = requiredAmount * 2n;

    const coreOp = new Wallet(HARDHAT_KEYS.CORE_OP, provider);
    const publisherSig = await signMerkleRoot(coreOp, coreProfileId, ethers.hexlify(merkleRoot));
    const receiverSigs = await buildReceiverSignatures(provider, hubAddress, ethers.hexlify(merkleRoot), publicByteSize);

    const result = await adapter.publishKnowledgeAssetsPermanent!({
      kaCount: 3,
      publisherNodeIdentityId: BigInt(coreProfileId),
      merkleRoot,
      publicByteSize,
      tokenAmount,
      publisherSignature: publisherSig,
      receiverSignatures: receiverSigs,
    });

    expect(result.batchId).toBeGreaterThan(0n);
    expect(result.startKAId).toBeDefined();
    expect(result.endKAId).toBeDefined();
    expect(result.publisherAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('permanent and regular publishes coexist', async () => {
    const { hubAddress, coreProfileId } = getSharedContext();
    const provider = createProvider();
    const adapter = createEVMAdapter(HARDHAT_KEYS.PUBLISHER);

    const regularRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('regular-publish')));
    const permRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('permanent-publish')));
    const publicByteSize = 256n;

    const regularAmount = await adapter.getRequiredPublishTokenAmount!(publicByteSize, 2);
    const permAmount = (await adapter.getRequiredPublishTokenAmount!(publicByteSize, 100)) * 2n;

    const coreOp = new Wallet(HARDHAT_KEYS.CORE_OP, provider);

    const regSig = await signMerkleRoot(coreOp, coreProfileId, ethers.hexlify(regularRoot));
    const regRecSigs = await buildReceiverSignatures(provider, hubAddress, ethers.hexlify(regularRoot), publicByteSize);

    const regular = await adapter.publishKnowledgeAssets({
      kaCount: 2,
      publisherNodeIdentityId: BigInt(coreProfileId),
      merkleRoot: regularRoot,
      publicByteSize,
      epochs: 2,
      tokenAmount: regularAmount,
      publisherSignature: regSig,
      receiverSignatures: regRecSigs,
    });

    const permSig = await signMerkleRoot(coreOp, coreProfileId, ethers.hexlify(permRoot));
    const permRecSigs = await buildReceiverSignatures(provider, hubAddress, ethers.hexlify(permRoot), publicByteSize);

    const permanent = await adapter.publishKnowledgeAssetsPermanent!({
      kaCount: 2,
      publisherNodeIdentityId: BigInt(coreProfileId),
      merkleRoot: permRoot,
      publicByteSize,
      tokenAmount: permAmount,
      publisherSignature: permSig,
      receiverSignatures: permRecSigs,
    });

    expect(regular.batchId).not.toBe(permanent.batchId);
  });
});
