// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { buildAssertionPublishReceiptQuads } from '@origintrail-official/dkg-core';
import type { OnChainPublishResult } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { FinalizedAssertionReservation } from './finalized-assertion-reservation.js';
import type { PublishedNamedKaVmLifecycleWriter } from '../named-ka-vm-lifecycle.js';
import type { CompleteNamedPublishFinalization } from '../named-publish-finalization.js';

export type NamedMintCompletionStage = 'receipt' | 'catalog' | 'lifecycle' | 'share-marker';
export interface NamedMintCompletionInput {
  readonly reservation: FinalizedAssertionReservation;
  readonly contextGraphId: string;
  readonly name: string;
  readonly agentAddress: string;
  readonly subGraphName?: string;
  readonly receipt?: OnChainPublishResult;
}
export interface NamedMintCompletionHost {
  readonly store: TripleStore;
  readonly stampPublishedLifecycle: PublishedNamedKaVmLifecycleWriter;
  readonly completeFinalization: CompleteNamedPublishFinalization;
  clearShareMarker(): Promise<void>;
}

/**
 * Idempotent durable completion after content verification and publish-owned checkpoint creation.
 * Callers retain their lifecycle/materialization custody and decide whether a failed step
 * aborts immediately or is reported while preserving an ordinary confirmed publish result.
 */
export async function completeNamedMint(host: NamedMintCompletionHost, input: NamedMintCompletionInput,
  policy: { consumeShare: boolean; onFailure(stage: NamedMintCompletionStage, error: unknown): void }): Promise<void> {
  const { reservation: { seal, scope, kaId, assertionUri, metaGraph }, receipt } = input;
  const step = async (stage: NamedMintCompletionStage, work: () => Promise<unknown>) => {
    try { await work(); } catch (error) { policy.onFailure(stage, error); }
  };
  if (receipt) await step('receipt', () => host.store.insert(buildAssertionPublishReceiptQuads({
    assertionUri, metaGraph, txHash: receipt.txHash, blockNumber: BigInt(receipt.blockNumber), kaId: receipt.batchId,
  })));
  await step('catalog', async () => {
    if (await host.completeFinalization({ contextGraphId: input.contextGraphId, subGraphName: input.subGraphName,
      assertionCoordinate: input.name, seal, assertionUri }) === 'pending')
      throw Object.assign(new Error('Named publish catalog finalization remains pending; retry to finish it'),
        { code: 'KA_MINT_RECONCILE_INCOMPLETE' });
  });
  await step('lifecycle', () => host.stampPublishedLifecycle({ contextGraphId: input.contextGraphId,
    agentAddress: input.agentAddress, name: input.name, subGraphName: input.subGraphName,
    publishedUal: scope.ual, merkleRoot: ethers.hexlify(seal.merkleRoot), packedKaId: kaId }));
  if (policy.consumeShare) await step('share-marker', () => host.clearShareMarker());
}
