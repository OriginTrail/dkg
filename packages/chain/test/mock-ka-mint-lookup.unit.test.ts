/**
 * MockChainAdapter models what a late-mined publish meets on chain: re-minting
 * a reserved KA id reverts `KaIdAlreadyMinted` at gas estimation, before any
 * broadcast, and the mint lookup answers with the EVM adapter's verdicts from
 * the creation events the mock records.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { V10PublishParams } from '../src/chain-adapter.js';
import { kaIdAlreadyMintedFromError } from '../src/ka-id-already-minted.js';
import { MockChainAdapter } from '../src/mock-adapter.js';

const AUTHOR = ethers.getAddress(`0x${'ab'.repeat(20)}`);
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const ROOT = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('sealed content')));
const UNRELATED_TX = `0x${'00'.repeat(31)}01`;

function mint(chain: MockChainAdapter, overrides: Partial<V10PublishParams> = {}) {
  return chain.createKnowledgeAssets({
    publishOperationId: 'op',
    contextGraphId: 35n,
    publisherAddress: chain.signerAddress,
    reservedKaId: KA_ID,
    merkleRoot: ROOT,
    knowledgeAssetsAmount: 1,
    byteSize: 1n,
    epochs: 1,
    tokenAmount: 42n,
    isImmutable: false,
    author: { address: AUTHOR, signature: { r: new Uint8Array(32), vs: new Uint8Array(32) }, schemeVersion: 1 },
    ackSignatures: [{ identityId: 1n, r: new Uint8Array(32), vs: new Uint8Array(32) }],
    ...overrides,
  });
}

describe('MockChainAdapter late-mint fidelity', () => {
  it('reverts a re-mint of a reserved id at gas estimation, before broadcasting', async () => {
    const chain = new MockChainAdapter();
    await mint(chain);
    const onBroadcast = vi.fn();

    const revert = await mint(chain, { onBroadcast }).catch((error: unknown) => error);

    expect(revert).toMatchObject({ code: 'CALL_EXCEPTION', action: 'estimateGas' });
    expect(kaIdAlreadyMintedFromError(revert)).toBe(KA_ID);
    expect(onBroadcast).not.toHaveBeenCalled();
  });

  it('resolves a mint from its creation event with the receipt facts, hinted or not', async () => {
    const chain = new MockChainAdapter();
    const minted = await mint(chain);
    const confirmed = {
      status: 'confirmed',
      mint: {
        kaId: KA_ID,
        merkleRoot: ROOT,
        contextGraphId: 35n,
        authorAddress: AUTHOR,
        publisherAddress: ethers.getAddress(chain.signerAddress),
        tokenAmount: 42n,
        knowledgeAssetsContract: ethers.getAddress(await chain.getDKGKnowledgeAssetsAddress()),
        txHash: minted.txHash,
        blockNumber: minted.blockNumber,
        blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        txIndex: expect.any(Number),
        blockTimestamp: expect.any(Number),
      },
    };

    await expect(chain.resolveKnowledgeAssetMint(KA_ID)).resolves.toEqual(confirmed);
    await expect(chain.resolveKnowledgeAssetMint(KA_ID, { txHash: minted.txHash })).resolves.toEqual(confirmed);
    // A hint that is not the creation transaction does not decide the outcome.
    await expect(chain.resolveKnowledgeAssetMint(KA_ID, { txHash: UNRELATED_TX })).resolves.toEqual(confirmed);
  });

  it('is pending until the creation transaction is final', async () => {
    const chain = new MockChainAdapter();
    const minted = await mint(chain);
    chain.__setTransactionUnfinalized(minted.txHash);

    await expect(chain.resolveKnowledgeAssetMint(KA_ID)).resolves.toEqual({ status: 'pending' });

    chain.__setTransactionUnfinalized(minted.txHash, false);
    await expect(chain.resolveKnowledgeAssetMint(KA_ID)).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('reports not-minted only for an id known to be free, and not-found otherwise', async () => {
    const free = new MockChainAdapter();
    await expect(free.resolveKnowledgeAssetMint(KA_ID)).resolves.toEqual({ status: 'not-minted' });

    const unknown = new MockChainAdapter();
    unknown.__setKnowledgeAssetMintedUnknown(KA_ID);
    await expect(unknown.resolveKnowledgeAssetMint(KA_ID)).resolves.toEqual({ status: 'not-found' });

    const mintedElsewhere = new MockChainAdapter();
    mintedElsewhere.__setKnowledgeAssetMinted(KA_ID);
    await expect(mintedElsewhere.resolveKnowledgeAssetMint(KA_ID)).resolves.toEqual({ status: 'not-found' });
  });
});
