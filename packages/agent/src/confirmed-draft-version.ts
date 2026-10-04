// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';

/** A draft number is unpublished only when one current chain view proves it. */
export async function readConfirmedDraftVersion(chain: ChainAdapter, kaUal: string): Promise<bigint | null> {
  const scope = createGraphKnowledgeAssetScope(kaUal, 1);
  const kaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  if (!chain.readKnowledgeAssetVersionSnapshot) return null;
  const snapshot = await chain.readKnowledgeAssetVersionSnapshot(kaId);
  if (snapshot === null || snapshot.rootCount < 0n
    || (snapshot.knowledgeAssetId !== undefined && snapshot.knowledgeAssetId !== kaId)
    || (snapshot.rootCount > 0n && snapshot.latestAuthor.toLowerCase() !== scope.agentAddress.toLowerCase())) return null;
  if (chain.knowledgeAssetVersionSnapshotIsCurrent
    && !await chain.knowledgeAssetVersionSnapshotIsCurrent(kaId, snapshot)) return null;
  return snapshot.rootCount;
}
