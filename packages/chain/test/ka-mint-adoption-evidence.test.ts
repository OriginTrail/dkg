/**
 * A publish whose transaction mined after the node stopped waiting, on the
 * real contracts: the retry's `KaIdAlreadyMinted` revert decodes from the
 * structured error ethers actually throws, and the mint lookup recovers the
 * original transaction's facts from its receipt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ethers, Wallet } from 'ethers';
import {
  AUTHOR_SCHEME_VERSION_V1,
  buildAuthorAttestationTypedData,
  computePublishACKDigest,
} from '@origintrail-official/dkg-core';
import {
  HARDHAT_KEYS,
  createEVMAdapter,
  createProvider,
  createTestContextGraph,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from './evm-test-context.js';
import { mintTokens } from './hardhat-harness.js';
import type { V10PublishParams } from '../src/chain-adapter.js';
import { kaIdAlreadyMintedFromError } from '../src/ka-id-already-minted.js';

let fileSnapshotId: string;
let testSnapshotId: string;
let nextNumber = 9_000n;

/** Fully signed V10 publish params for one KA, reusable verbatim for the retry. */
async function signedPublish(adapter: ReturnType<typeof createEVMAdapter>): Promise<V10PublishParams> {
  const provider = createProvider();
  const { hubAddress, coreProfileId } = getSharedContext();
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, adapter.getSignerAddress(), ethers.parseEther('500000'));
  const author = new Wallet(HARDHAT_KEYS.CORE_OP, provider);
  const contextGraphId = await createTestContextGraph(adapter, undefined, 0);
  const reservedKaId = (BigInt(author.address) << 96n) | (nextNumber += 1n);
  const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(`late-mint-${reservedKaId}`)));
  const byteSize = 256n;
  const epochs = 2;
  const tokenAmount = await adapter.getRequiredPublishTokenAmount(byteSize, epochs);
  const kav10Address = await adapter.getKnowledgeAssetsLifecycleAddress();
  const evmChainId = await adapter.getEvmChainId();
  const authorTyped = buildAuthorAttestationTypedData({
    chainId: evmChainId, kav10Address, merkleRoot, authorAddress: author.address, reservedKaId,
  });
  const authorSignature = ethers.Signature.from(
    await author.signTypedData(authorTyped.domain, authorTyped.types, authorTyped.message),
  );
  const ackDigest = computePublishACKDigest(
    evmChainId, kav10Address, contextGraphId, merkleRoot, 1n, byteSize, BigInt(epochs), tokenAmount,
    1n, new Uint8Array(32), 0n, false,
  );
  const ackSignature = ethers.Signature.from(await author.signMessage(ackDigest));
  const identityId = BigInt(coreProfileId);
  return {
    publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
    contextGraphId,
    merkleRoot,
    knowledgeAssetsAmount: 1,
    byteSize,
    epochs,
    tokenAmount,
    isImmutable: false,
    merkleLeafCount: 1,
    reservedKaId,
    publisherNodeIdentityId: identityId,
    author: {
      address: author.address,
      signature: { r: ethers.getBytes(authorSignature.r), vs: ethers.getBytes(authorSignature.yParityAndS) },
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    },
    ackSignatures: [{
      identityId,
      r: ethers.getBytes(ackSignature.r),
      vs: ethers.getBytes(ackSignature.yParityAndS),
    }],
  };
}

describe('late-mined publish evidence on the real contracts', () => {
  beforeAll(async () => { fileSnapshotId = await takeSnapshot(); });
  afterAll(async () => { await revertSnapshot(fileSnapshotId); });
  beforeEach(async () => { testSnapshotId = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(testSnapshotId); });

  it('decodes the retry revert structurally and recovers the original mint from its receipt', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const params = await signedPublish(adapter);
    const original = await adapter.createKnowledgeAssets(params);
    const originalReceipt = await createProvider().getTransactionReceipt(original.txHash);

    let retryBroadcasts = 0;
    const retryError = await adapter.createKnowledgeAssets({
      ...params,
      onBroadcast: () => { retryBroadcasts += 1; },
    }).then(() => undefined, (error: unknown) => error);
    expect(retryError).toBeInstanceOf(Error);
    expect(retryBroadcasts).toBe(0);
    expect(kaIdAlreadyMintedFromError(retryError)).toBe(params.reservedKaId);
    // Message text alone never decodes.
    expect(kaIdAlreadyMintedFromError({ message: (retryError as Error).message })).toBeNull();

    const resolution = await adapter.resolveKnowledgeAssetMint(params.reservedKaId!);
    expect(resolution.status).toBe('confirmed');
    if (resolution.status !== 'confirmed') return;
    expect(resolution.mint).toMatchObject({
      kaId: params.reservedKaId,
      contextGraphId: params.contextGraphId,
      authorAddress: params.author.address,
      publisherAddress: adapter.getSignerAddress(),
      tokenAmount: params.tokenAmount,
      txHash: original.txHash,
      blockNumber: original.blockNumber,
      blockHash: originalReceipt!.blockHash,
      txIndex: originalReceipt!.index,
      knowledgeAssetsContract: await adapter.getDKGKnowledgeAssetsAddress(),
    });
    expect(ethers.hexlify(resolution.mint.merkleRoot)).toBe(ethers.hexlify(params.merkleRoot));
    expect(resolution.mint.blockTimestamp).toBe(original.blockTimestamp);
  }, 120_000);

  it('uses a matching hint, and scans past a hint that does not prove the mint', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const params = await signedPublish(adapter);
    const original = await adapter.createKnowledgeAssets(params);
    const unrelated = await adapter.createKnowledgeAssets(await signedPublish(adapter));

    for (const txHash of [original.txHash, unrelated.txHash, ethers.hexlify(ethers.randomBytes(32))]) {
      const resolution = await adapter.resolveKnowledgeAssetMint(params.reservedKaId!, { txHash });
      expect(resolution.status).toBe('confirmed');
      expect(resolution.status === 'confirmed' && resolution.mint.txHash).toBe(original.txHash);
    }
  }, 120_000);

  it('reports a free id as not minted, never as a missing receipt', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const author = new Wallet(HARDHAT_KEYS.CORE_OP).address;
    const freeKaId = (BigInt(author) << 96n) | 987_654_321n;
    expect(await adapter.resolveKnowledgeAssetMint(freeKaId)).toEqual({ status: 'not-minted' });
  }, 120_000);
});
