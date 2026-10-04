// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter, AdoptedMintPublishResult, OnChainPublishResult } from '../src/index.js';
import { EVMChainAdapter, MockChainAdapter } from '../src/index.js';

async function verifiedOrdering(adapter: Pick<ChainAdapter, 'getMintedKnowledgeAssetProvenance'>) {
  const result = await adapter.getMintedKnowledgeAssetProvenance?.(1n, new Uint8Array(32), 2n);
  if (!result) return;
  const txIndex: number = result.txIndex;
  const kaId: bigint = result.kaId;
  const startKAId: bigint = result.startKAId;
  const endKAId: bigint = result.endKAId;
  const root: Uint8Array = result.merkleRoot;
  const blockHash: string = result.blockHash;
  const gasCostWei: bigint | undefined = result.gasCostWei;
  return { txIndex, kaId, startKAId, endKAId, root, blockHash, gasCostWei };
}
void verifiedOrdering(new MockChainAdapter());
void verifiedOrdering(Object.create(EVMChainAdapter.prototype) as EVMChainAdapter);

declare const permissive: OnChainPublishResult;
// @ts-expect-error Legacy optional identity/order fields are not verified adoption evidence.
const legacyAdoption: AdoptedMintPublishResult = permissive;
declare const verified: AdoptedMintPublishResult;
// @ts-expect-error Transaction ordering must remain definite.
const noIndex: AdoptedMintPublishResult = { ...verified, txIndex: undefined };
// @ts-expect-error Minted identity must remain definite.
const noIdentity: AdoptedMintPublishResult = { ...verified, kaId: undefined };
// @ts-expect-error Canonical block identity must remain definite.
const noBlockHash: AdoptedMintPublishResult = { ...verified, blockHash: undefined };
void legacyAdoption; void noIndex; void noIdentity; void noBlockHash;
