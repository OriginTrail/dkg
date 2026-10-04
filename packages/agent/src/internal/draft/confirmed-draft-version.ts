// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter, ChainReadOptions, KnowledgeAssetVersionSnapshot } from '@origintrail-official/dkg-chain';
import { assertCanonicalUalChainIdV1, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';

export type CoherentKnowledgeAssetVersionEvidence =
  | Readonly<{ kind: 'available'; snapshot: KnowledgeAssetVersionSnapshot }>
  | Readonly<{ kind: 'unavailable' | 'invalid' | 'stale' }>;

/** UAL prefixes are network aliases; the canonical numeric EVM chain binds the adapter. */
function boundToChain(chain: ChainAdapter, expectedChainId: string): boolean {
  try {
    const numeric = (value: string) => BigInt(assertCanonicalUalChainIdV1(value).split(':').at(-1)!);
    const expected = numeric(expectedChainId);
    return chain.chainType === 'evm' && expected > 0n && numeric(chain.chainId) === expected;
  } catch { return false; }
}

/** Read and fence chain, identity, author, count and currency from one pinned view. */
export async function readCoherentKnowledgeAssetVersionEvidence(
  chain: ChainAdapter,
  input: {
    readonly knowledgeAssetId: bigint;
    readonly expectedAuthor: string;
    readonly expectedChainId: string;
    readonly options?: ChainReadOptions;
    /** Caller-specific eligibility is checked before the currency read. */
    readonly acceptsSnapshot?: (snapshot: KnowledgeAssetVersionSnapshot) => boolean;
  },
): Promise<CoherentKnowledgeAssetVersionEvidence> {
  const { knowledgeAssetId: kaId, options } = input;
  options?.signal?.throwIfAborted();
  if (!boundToChain(chain, input.expectedChainId) || !chain.readKnowledgeAssetVersionSnapshot) return { kind: 'unavailable' };
  const snapshot = options === undefined
    ? await chain.readKnowledgeAssetVersionSnapshot(kaId)
    : await chain.readKnowledgeAssetVersionSnapshot(kaId, options);
  options?.signal?.throwIfAborted();
  if (!boundToChain(chain, input.expectedChainId) || snapshot == null) return { kind: 'unavailable' };
  if (snapshot.rootCount < 0n
    || (snapshot.knowledgeAssetId !== undefined && snapshot.knowledgeAssetId !== kaId)
    || (snapshot.rootCount > 0n && snapshot.latestAuthor.toLowerCase() !== input.expectedAuthor.toLowerCase())
    || input.acceptsSnapshot?.(snapshot) === false) return { kind: 'invalid' };
  if (chain.knowledgeAssetVersionSnapshotIsCurrent) {
    const current = options === undefined
      ? await chain.knowledgeAssetVersionSnapshotIsCurrent(kaId, snapshot)
      : await chain.knowledgeAssetVersionSnapshotIsCurrent(kaId, snapshot, options);
    options?.signal?.throwIfAborted();
    if (!boundToChain(chain, input.expectedChainId)) return { kind: 'unavailable' };
    if (!current) return { kind: 'stale' };
  }
  return { kind: 'available', snapshot };
}

/** A draft number is unpublished only when one current chain view proves it. */
export async function readConfirmedDraftVersion(
  chain: ChainAdapter, kaUal: string, options?: ChainReadOptions,
): Promise<bigint | null> {
  const scope = createGraphKnowledgeAssetScope(kaUal, 1);
  const kaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  const evidence = await readCoherentKnowledgeAssetVersionEvidence(chain, {
    knowledgeAssetId: kaId, expectedAuthor: scope.agentAddress, expectedChainId: scope.chainId, options,
  });
  return evidence.kind === 'available' ? evidence.snapshot.rootCount : null;
}
