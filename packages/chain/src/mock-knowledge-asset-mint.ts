// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { ChainEvent } from './knowledge-asset-update-identity.js';
import type { KnowledgeAssetMintResolution } from './knowledge-asset-mint-evidence.js';

/**
 * MockChainAdapter's mint lookup over the `KCCreated` events its
 * `createKnowledgeAssets` records. It answers with the EVM adapter's verdicts:
 * a transaction declared unfinalized is `pending`, and `not-minted` needs the
 * mock's minted state to say the id is free.
 */
export function resolveMockKnowledgeAssetMint(input: {
  kaId: bigint;
  txHash?: string;
  events: readonly ChainEvent[];
  minted: boolean | null;
  isFinal: (txHash: string) => boolean;
  blockHash: (blockNumber: number) => string;
  knowledgeAssetsContract: string;
}): KnowledgeAssetMintResolution {
  const created = input.events.filter(
    (event) => event.type === 'KCCreated' && event.data.kaId === input.kaId.toString(),
  );
  const event = created.find((candidate) => candidate.data.txHash === input.txHash) ?? created[0];
  if (!event) return input.minted === false ? { status: 'not-minted' } : { status: 'not-found' };
  const txHash = String(event.data.txHash);
  if (!input.isFinal(txHash)) return { status: 'pending' };
  return {
    status: 'confirmed',
    mint: {
      kaId: input.kaId,
      merkleRoot: ethers.getBytes(String(event.data.merkleRoot)),
      contextGraphId: BigInt(String(event.data.contextGraphId)),
      authorAddress: ethers.getAddress(String(event.data.authorAddress)),
      publisherAddress: ethers.getAddress(String(event.data.publisherAddress)),
      tokenAmount: BigInt(String(event.data.tokenAmount ?? 0)),
      knowledgeAssetsContract: ethers.getAddress(input.knowledgeAssetsContract),
      txHash,
      blockNumber: event.blockNumber,
      blockHash: input.blockHash(event.blockNumber),
      txIndex: Number(event.data.txIndex),
      blockTimestamp: Math.floor(Date.now() / 1000),
    },
  };
}
