// SPDX-License-Identifier: Apache-2.0
import { graphScopeTargetsChain } from './graph-scope-chain-target.js';
import type { ChainAdapter, OnChainPublishResult } from '@origintrail-official/dkg-chain';
import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import type { V10CoreNodeACK } from './publisher.js';
import { createWriteAheadHook } from './publisher-write-ahead.js';
import type { PublishLifecycleLogger } from './publish-lifecycle-logger.js';
import { mintOrAdoptKnowledgeAssets, type PreparedMintAdoption } from './adopt-existing-mint.js';
import type { PreparedOnChainPublication } from './prepared-publication.js';

interface PublicationReceipt {
  receipt: OnChainPublishResult; reservedKaId: bigint | undefined;
  effectiveAuthorAddress: string; v10ACKs?: V10CoreNodeACK[];
}
export type PublicationAcquisition = PublicationReceipt & (
  | { kind: 'live' }
  | { kind: 'adopted'; evidence: PreparedMintAdoption }
);
interface PublicationAcquisitionPorts {
  chain: ChainAdapter;
  log: Logger;
  ensureReservedKaId(author: string, precomputed?: bigint): Promise<bigint | undefined>;
}
/** Acquire a receipt from validated submission parameters. Persistence belongs to recording. */
export async function acquirePreparedPublication(input: PreparedOnChainPublication, ports: PublicationAcquisitionPorts): Promise<PublicationAcquisition> {
  const { submission, graphPublish, chainId, diagnostics, lifecycle, ctx, v10ACKs } = input;
  const { onPhase, onBroadcastAccepted, onBeforeBroadcast } = input.hooks;
  const { contextGraphId, publisherAddress, entityCount, publicRecordCount, hiddenCommitmentCount } = diagnostics;
  const v10CgId = submission.contextGraphId;
  onPhase?.('chain:sign', 'start');
  try { ports.log.info(ctx, `Signing on-chain publish (attributionId=${submission.publisherNodeIdentityId}, signer=${submission.publisherAddress})`); }
  finally { onPhase?.('chain:sign', 'end'); }
  onPhase?.('chain:submit', 'start');
  try {
    ports.log.info(ctx, `Submitting V10 on-chain publish tx (${submission.knowledgeAssetsAmount} KAs, networkVisibleByteSize=${submission.byteSize}, billableByteSize=${diagnostics.billableByteSize}, pricingPolicy=${diagnostics.pricingPolicy}, tokenAmount=${submission.tokenAmount})`);
    const reservedKaId = await ports.ensureReservedKaId(submission.author.address, submission.reservedKaId);
    if (graphPublish && reservedKaId !== undefined) {
      if (reservedKaId !== graphPublish.expectedPackedKaId) {
        throw new Error(`Graph-scoped publish reserved kaId ${reservedKaId} does not derive from UAL ${graphPublish.scope.ual} (expected ${graphPublish.expectedPackedKaId}); refusing to mint`);
      }
      if (!graphScopeTargetsChain(graphPublish.scope.chainId, ports.chain.chainId, chainId)) {
        throw new Error(`Graph-scoped publish UAL ${graphPublish.scope.ual} targets chain ${graphPublish.scope.chainId}, but this publisher mints on ${ports.chain.chainId} (EIP-155 ${chainId})`);
      }
    }
    await lifecycle.rememberAssetUal(reservedKaId);
    if (!lifecycle.identityAllocatedEmitted && reservedKaId !== undefined) {
      lifecycle.emit('identity', 'asset_ual_allocated', { metadata: { contextGraphId,
        kaId: reservedKaId.toString(), publisherAddress, entityCount, publicRecordCount, hiddenCommitmentCount } });
    }
    const writeAhead = createWriteAheadHook({ onPhase, onBeforeBroadcast, operationKind: 'create' });
    try {
      lifecycle.emit('chain', 'submit', { metadata: {
        contextGraphId: v10CgId.toString(), kaId: reservedKaId?.toString(), byteSize: submission.byteSize.toString(),
        billableByteSize: diagnostics.billableByteSize.toString(), pricingPolicy: diagnostics.pricingPolicy,
        tokenAmount: submission.tokenAmount.toString(), ackCount: v10ACKs.length, merkleLeafCount: submission.merkleLeafCount,
      } });
      const outcome = await mintOrAdoptKnowledgeAssets(ports.chain, { ...submission, reservedKaId,
        onBroadcast: writeAhead.emitWriteAheadStart,
        onBroadcastAccepted: signal => onBroadcastAccepted?.({ ...signal, operationKind: 'create' }),
        ...(writeAhead.onBeforeReplacementBroadcast ? { onBeforeReplacementBroadcast: writeAhead.onBeforeReplacementBroadcast } : {}),
      }, graphPublish !== undefined);
      if (!outcome.adopted) outcome.result.tokenAmount = submission.tokenAmount;
      const receipt = { receipt: outcome.result, reservedKaId, effectiveAuthorAddress: submission.author.address, v10ACKs };
      return outcome.adopted ? { ...receipt, kind: 'adopted', evidence: outcome.evidence } : { ...receipt, kind: 'live' };
    } finally {
      if (writeAhead.didWriteAhead()) onPhase?.('chain:writeahead', 'end');
    }
  } catch (error) {
    throw publicationAcquisitionFailure(error, ports.log, ctx, lifecycle, v10CgId, v10ACKs.length);
  } finally {
    onPhase?.('chain:submit', 'end');
  }
}

/** Identical failure evidence for receipt acquisition and confirmed recording. */
export function publicationAcquisitionFailure(error: unknown, log: Logger, ctx: OperationContext,
  lifecycle: PublishLifecycleLogger, contextGraphId: bigint, ackCount: number): Error {
  const tag = error instanceof Error ? error.name : 'unknown';
  const message = error instanceof Error ? error.message : String(error);
  lifecycle.emit('chain', 'failure', { level: 'error', metadata: { outcome: 'failure',
    contextGraphId: contextGraphId.toString(), ackCount, errorClass: tag, reason: message } });
  log.warn(ctx, `On-chain publish failed (${tag}): ${message}`);
  return error instanceof Error ? error : new Error(message);
}
