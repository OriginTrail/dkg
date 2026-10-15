// SPDX-License-Identifier: Apache-2.0

import {
  GRAPH_KA_CONTENT_SCOPE_VERSION, contextGraphFinalizationTopic, encodeFinalizationMessage,
  type AssertionSeal, type FinalizationMessageMsg, type Logger, type OperationContext,
  type createGraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import {
  VM_CURRENT_ASSERTION_PRED, WM_CURRENT_ASSERTION_PRED,
  type DKGPublisher, type LiftJobTailStep, type LiftJobTailStepObserver, type PublishResult,
} from '@origintrail-official/dkg-publisher';
import type { SharedMemoryGraphScope, TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import type { DKGAgent } from './dkg-agent.js';
import type {
  GraphScopedKnowledgeAssetVmPublishRequest, planKnowledgeAssetVmPublication,
} from './internal/knowledge-asset-vm-publish-request.js';

/** The local confirmed publisher has already written VM and drained this exact SWM root. */
export async function retireLegacySwmAfterConfirmedLocalPublish(
  agent: Pick<FinalizationAgentCapabilities, 'retireLegacySwmAfterVerifiedVmTwin'>,
  log: Pick<Logger, 'warn'>,
  contextGraphId: string,
  kaUal: string,
  assertionVersion: string,
  subGraphName: string | undefined,
  ctx: OperationContext,
): Promise<boolean> {
  try {
    await agent.retireLegacySwmAfterVerifiedVmTwin({
      contextGraphId,
      kaUal,
      assertionVersion,
      subGraphName,
    });
    return true;
  } catch (err) {
    log.warn(
      ctx,
      `Failed to retire the legacy SWM boundary after confirmed local VM publish: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
}

interface QueuedPublishFinalizationContext {
  readonly request: GraphScopedKnowledgeAssetVmPublishRequest;
  readonly seal: AssertionSeal;
  readonly result: PublishResult;
  readonly operationPlan: ReturnType<typeof planKnowledgeAssetVmPublication>;
  readonly graphScope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  readonly sharedMemoryScope: SharedMemoryGraphScope;
  readonly assertionUri: string;
  readonly lifecycleUri: string;
  readonly metaGraph: string;
  readonly agentAddress: string;
  readonly packedKaId: bigint;
  readonly snapshotPrivateRoot?: Uint8Array;
  readonly queuedOnChainContextGraphId?: string;
  readonly onChainCapable: boolean;
  readonly ctx: OperationContext;
}

type FinalizationAgentMethod =
  | '_writeQueuedKnowledgeAssetVmPublishReceipt' | '_stampQueuedKnowledgeAssetVmPublishedLifecycle'
  | '_stampPointer' | '_stampPointerIfDivergedFromVm' | 'retireLegacySwmAfterVerifiedVmTwin'
  | 'getContextGraphOnChainId';

/** Keep the original receiver and lazy access to capabilities that some branches never use. */
type FinalizationAgentCapabilities = {
  readonly [Method in FinalizationAgentMethod]: OmitThisParameter<DKGAgent[Method]>;
} & {
  readonly store: Pick<TripleStore, 'insert'>;
  readonly gossip: Pick<DKGAgent['gossip'], 'publish'>;
};

/** Existing capabilities only: the phase owns their arguments, order, and failure handling. */
interface QueuedPublishFinalizationServices {
  readonly agent: FinalizationAgentCapabilities;
  readonly publisher: Pick<DKGPublisher,
    'clearPublishedKnowledgeAssetSwm' | 'clearRemainingSharedMemory' | 'clearSwmShareComplete'>;
  readonly log: Pick<Logger, 'warn' | 'info'>;
  readonly observeConfirmedCatalog: OmitThisParameter<DKGAgent['afterConfirmedGraphScopedVmPublishV1']>;
  readonly onPostConfirmationStep?: LiftJobTailStepObserver;
}

/**
 * Own the complete queued create/update tail. A caught local failure continues the remaining
 * operations, but only complete required outcomes and a durable catalog obligation certify it.
 */
export async function finalizeQueuedKnowledgeAssetVmPublish(
  context: QueuedPublishFinalizationContext,
  services: QueuedPublishFinalizationServices,
): Promise<true | undefined> {
  const {
    request, seal, result, operationPlan, graphScope, sharedMemoryScope,
    assertionUri, lifecycleUri, metaGraph, agentAddress, packedKaId,
    snapshotPrivateRoot, queuedOnChainContextGraphId, onChainCapable, ctx,
  } = context;
  const { agent, publisher, log } = services;
  const ended = (step: LiftJobTailStep): void => {
    try { services.onPostConfirmationStep?.(step); } catch { /* observation only */ }
  };
  let complete = true;
  const required = async (
    run: () => Promise<void>,
    failureLabel: string,
    observation?: LiftJobTailStep,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      log.warn(ctx, `${failureLabel}: ${error instanceof Error ? error.message : String(error)}`);
      complete = false;
    } finally {
      if (observation) ended(observation);
    }
  };

  ended('publish');
  if (result.status === 'confirmed') {
    if (result.onChainResult) {
      const chainResult = result.onChainResult;
      await required(() => agent._writeQueuedKnowledgeAssetVmPublishReceipt(
        request,
        chainResult.txHash ?? '',
        chainResult.blockNumber ?? 0,
        seal.reservedKaId ?? chainResult.kaId ?? chainResult.batchId ?? 0n,
      ), `Failed to write publish receipt for <${assertionUri}>`, 'receiptWrite');
    }
    const operationLabel = operationPlan.kind === 'update' ? 'update' : 'publish';
    let clearReturned = false;
    await required(async () => {
      const cleared = await publisher.clearPublishedKnowledgeAssetSwm(
        request.contextGraphId, sharedMemoryScope, request.subGraphName, ctx,
        graphScope.ual, graphScope.assertionVersion,
      );
      clearReturned = true;
      if (cleared !== true) complete = false;
    }, `Failed to clear published SWM graph after confirmed queued ${operationLabel} of <${lifecycleUri}>`,
    'publishedGraphClear');
    // A thrown clear skips retirement; an incomplete clear still attempts its best-effort admission.
    if (clearReturned) {
      await required(async () => {
        if (await retireLegacySwmAfterConfirmedLocalPublish(
          agent, log, request.contextGraphId, graphScope.ual, graphScope.assertionVersion, request.subGraphName, ctx,
        ) !== true) complete = false;
      }, 'Failed to retire the legacy SWM boundary after confirmed local VM publish', 'legacySwmRetire');
    }
    if (request.clearSharedMemoryAfter === true) {
      await required(() => publisher.clearRemainingSharedMemory(
        request.contextGraphId, request.subGraphName, ctx,
      ), `Failed to clear remaining SWM after confirmed queued publish of <${lifecycleUri}>`, 'remainingSwmClear');
    }
    if (operationPlan.kind === 'update') {
      // Provenance has historically been part of the update tail without its own observation.
      await required(async () => {
        const newMerkleHexBare = ethers.hexlify(seal.merkleRoot).slice(2);
        const priorBare = operationPlan.vmCurrentAssertion.startsWith('0x')
          ? operationPlan.vmCurrentAssertion.slice(2)
          : operationPlan.vmCurrentAssertion;
        const priorUri = `${lifecycleUri}#assertion-${priorBare}`;
        await agent._stampPointer(lifecycleUri, VM_CURRENT_ASSERTION_PRED, newMerkleHexBare, metaGraph);
        await agent._stampPointerIfDivergedFromVm(lifecycleUri, WM_CURRENT_ASSERTION_PRED, newMerkleHexBare, metaGraph);
        await agent.store.insert([
          { subject: lifecycleUri, predicate: 'http://www.w3.org/ns/prov#wasRevisionOf', object: priorUri, graph: metaGraph },
          { subject: priorUri, predicate: VM_CURRENT_ASSERTION_PRED, object: `"${priorBare}"`, graph: metaGraph },
        ]);
      }, `Failed to stamp queued update provenance for <${lifecycleUri}>`);
    }
    await required(() => agent._stampQueuedKnowledgeAssetVmPublishedLifecycle(
      request, result.ual,
      packedKaId ?? seal.reservedKaId ?? result.onChainResult?.kaId ?? result.kaId,
    ), `Failed to stamp queued VM lifecycle marker for <${lifecycleUri}>`, 'lifecycleStamp');
    if (result.onChainResult) {
      // Graph lookup and message construction intentionally precede the best-effort gossip catch.
      const broadcastCgId = queuedOnChainContextGraphId ?? (onChainCapable
        ? (await agent.getContextGraphOnChainId(request.contextGraphId))?.trim() || undefined
        : undefined);
      if (queuedOnChainContextGraphId === undefined && onChainCapable) ended('graphIdRead');
      const msg: FinalizationMessageMsg = {
        ual: result.ual,
        contextGraphId: request.contextGraphId,
        kcMerkleRoot: result.merkleRoot,
        txHash: result.onChainResult.txHash ?? '',
        blockNumber: result.onChainResult.blockNumber ?? 0,
        txIndex: result.onChainResult.txIndex ?? 0,
        batchId: result.onChainResult.batchId ?? 0n,
        startKAId: result.onChainResult.startKAId ?? 0n,
        endKAId: result.onChainResult.endKAId ?? 0n,
        publisherAddress: result.onChainResult.publisherAddress ?? '',
        rootEntities: [],
        timestampMs: Date.now(),
        operationId: ctx.operationId,
        targetContextGraphId: result.contextGraphError ? undefined : broadcastCgId,
        subGraphName: request.subGraphName,
        keepRootCopyOnLabel: true,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        assertionVersion: graphScope.assertionVersion,
        publicTripleCount: seal.publicTripleCount,
        ...(snapshotPrivateRoot ? { privateMerkleRoot: snapshotPrivateRoot } : {}),
        privateTripleCount: seal.privateTripleCount,
        accessPolicy: result.accessPolicy ?? 'ownerOnly',
        allowedPeers: result.allowedPeers ?? [],
      };
      const topic = contextGraphFinalizationTopic(request.contextGraphId);
      try {
        await agent.gossip.publish(topic, encodeFinalizationMessage(msg));
        log.info(ctx, `Broadcast queued finalization for ${result.ual} to ${topic}${broadcastCgId ? ` (contextGraph=${broadcastCgId})` : ''}`);
      } catch {
        log.warn(ctx, `No peers subscribed to ${topic} yet`);
      }
      ended('finalizationGossip');
    }
    await required(() => publisher.clearSwmShareComplete(
      request.contextGraphId, request.name, agentAddress, request.subGraphName,
    ), `Failed to clear swmShareComplete after queued publish of <${lifecycleUri}>`, 'shareMarkerClear');
  }
  // Records the durable obligation without awaiting private catalog placement. Called for tentative results too.
  const catalogCompletionRecorded = await services.observeConfirmedCatalog({
    status: result.status,
    contextGraphId: request.contextGraphId,
    subGraphName: request.subGraphName,
    assertionCoordinate: request.name,
    shareOperationId: request.shareOperationId,
    seal, assertionUri, ctx, publicationLabel: 'queued publish',
  });
  ended('catalogObserver');
  return result.status === 'confirmed' && Boolean(result.onChainResult) && catalogCompletionRecorded === true
    && complete ? true : undefined;
}
