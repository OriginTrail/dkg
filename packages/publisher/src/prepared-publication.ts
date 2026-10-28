// SPDX-License-Identifier: Apache-2.0


import {GRAPH_KA_CONTENT_SCOPE_VERSION, type CatalogRootResult, type GraphKnowledgeAssetScope, type Logger, type OperationContext} from '@origintrail-official/dkg-core';
import type {Quad} from '@origintrail-official/dkg-storage';
import type {PublishOptions, KAManifestEntry, V10CoreNodeACK, V10ACKProviderParams} from './publisher.js';
import type {KAMetadata} from './metadata.js';


import {isQuorumUnmetError} from './ack-errors.js';
import {isFailClosedInlineEncrypt} from './async-lift-publish-options.js';


import {resolvePublicationPricing} from './publication-pricing.js';
import type {CanonicalPublicationPayloadMeasurement} from './publication-payload-measurement.js';
import type {FinalizedPublisherPlan, PublisherPlanner} from './publisher-planning.js';
import type {PublishLifecycleLogger} from './publish-lifecycle-logger.js';
import {type SealedMintAdoption} from './adopt-existing-mint.js';

export interface GraphScopedPublishDescriptor {
  scope: GraphKnowledgeAssetScope;
  expectedPackedKaId: bigint;
  publicTripleCount: number;
  privateTripleCount: number;
  expectedPrivateMerkleRoot?: Uint8Array;
}
export interface PreparedPublicationInput {
  payload: {
    catalogCommitment: CatalogRootResult | undefined;
    privateRoots: Uint8Array[];
    catalogByteSize: bigint;
    publicByteSize: bigint;
    payloadMeasurement: CanonicalPublicationPayloadMeasurement;
    encryptableNquadsStr: string;
    kcMerkleRoot: Uint8Array;
    catalogNquadsStr: string | undefined;
    publicNquadsBytes: Uint8Array;
    allSkolemizedQuads: Quad[];
    manifestEntries: KAManifestEntry[];
    effectiveAccessPolicy: 'public' | 'ownerOnly' | 'allowList';
    kcMerkleLeafCount: number;
    normalizedAllowedPeers: string[];
    kaMetadata: KAMetadata[];
    normalizedQuads: Quad[];
    kaCount: number;
    entityCount: number;
  };
  target: {
    publisherContextGraphId: bigint | undefined;
    graphPublish: GraphScopedPublishDescriptor | undefined;
    v10CgDomain: string;
    normalizedPublisherPeerId: string;
    dataGraph: string;
    contextGraphId: string;
    attributionIdentityId: bigint;
    hasAttributionOverride: boolean;
    v10ChainId: bigint | undefined;
    v10KavAddress: string | undefined;
    sealedAdoption: SealedMintAdoption | undefined;
  };
  options: PublishOptions;
  pricingPolicy: PublishOptions['pricingPolicy'];
  lifecycle: PublishLifecycleLogger;
  ctx: OperationContext;
  explicitPublishEpochs: number | undefined;
  publicStagingMode: 'inline' | 'strict-swm' | 'inline-small-swm';
}
export interface PublicationPreparationPorts {
  publisherPlanner: PublisherPlanner;
  log: Logger;
  allocateOperationId(): string;
  selectPublicStagingQuads(mode: PreparedPublicationInput['publicStagingMode'], quads: Uint8Array): Uint8Array | undefined;
  invokeV10ACKProvider(provider: NonNullable<PublishOptions['v10ACKProvider']>, params: V10ACKProviderParams): Promise<V10CoreNodeACK[]>;
}
export async function preparePublication(input: PreparedPublicationInput, ports: PublicationPreparationPorts): Promise<PreparedPublication> {
  const { catalogCommitment, privateRoots, catalogByteSize, publicByteSize, payloadMeasurement, encryptableNquadsStr, kcMerkleRoot, catalogNquadsStr, publicNquadsBytes, allSkolemizedQuads, manifestEntries, effectiveAccessPolicy, kcMerkleLeafCount, normalizedAllowedPeers, kaCount, entityCount } = input.payload;
  const { publisherContextGraphId, graphPublish, v10CgDomain, contextGraphId } = input.target;
  const { options, pricingPolicy, lifecycle, ctx, explicitPublishEpochs, publicStagingMode } = input;
  const { onPhase } = options;
  const swmGraphId = contextGraphId;
  let publishOperationId = '';
  const ensurePublishOperationIdentity = () => { publishOperationId ||= ports.allocateOperationId(); };
  let v10ACKs: V10CoreNodeACK[] | undefined;
  const publisherPlanning = await ports.publisherPlanner.prepare(publisherContextGraphId);
  const { canAttemptOnChainPublish } = publisherPlanning;
  const inlineEncryptCb = options.encryptInlinePayload;
  const useEncryptedInline =
    typeof inlineEncryptCb === 'function'
    && (canAttemptOnChainPublish || !isFailClosedInlineEncrypt(inlineEncryptCb));
  const useCuratedCatalog = useEncryptedInline && catalogCommitment !== undefined;
  if (useEncryptedInline && privateRoots.length > 0 && !graphPublish) {
    throw new Error(
      'Encrypted inline publishes with privateQuads are not supported by the current V10 ACK model. ' +
      'The publisher can collect either curated-catalog ACKs or folded-private public-CG ACKs, ' +
      'but not both in one publish without a mixed ACK mode that preserves curated confidentiality.',
    );
  }
  const stagingByteSize = useCuratedCatalog
    ? catalogByteSize
    : publicByteSize;
  const networkVisibleByteSize = stagingByteSize;
  const publicationPricing = resolvePublicationPricing({
    policy: pricingPolicy,
    networkVisibleByteSize,
    fullContentByteSize: payloadMeasurement.fullContentByteSize,
  });
  const finalizedPublisherPlan = await publisherPlanning.finalize({
    explicitPublishEpochs,
    billableByteSize: publicationPricing.billableByteSize,
    ctx,
  });
  const publisherAddress = finalizedPublisherPlan.publisherAddress;
  const publishEpochs = finalizedPublisherPlan.publishEpochs;
  const precomputedTokenAmount = finalizedPublisherPlan.tokenAmount;

  let stagingQuads: Uint8Array | undefined;
  if (useEncryptedInline) {
    const plaintextBytes = new TextEncoder().encode(encryptableNquadsStr);
    if (typeof options.encryptInlineChunked === 'function') {
      ensurePublishOperationIdentity();
      await options.encryptInlineChunked({
        plaintextNquads: plaintextBytes,
        batchId: kcMerkleRoot,
        publishOperationId,
      });
    } else {
      await options.encryptInlinePayload!(plaintextBytes);
    }
    if (useCuratedCatalog) {
      stagingQuads = new TextEncoder().encode(catalogNquadsStr);
    } else {
      stagingQuads = undefined;
    }
  } else {
    stagingQuads = ports.selectPublicStagingQuads(
      publicStagingMode,
      publicNquadsBytes,
    );
  }

  if (canAttemptOnChainPublish && options.precomputedAttestation?.reservedKaId !== undefined) {
    await lifecycle.rememberAssetUal(options.precomputedAttestation.reservedKaId);
    lifecycle.emit('identity', 'asset_ual_allocated', {
      metadata: {
        contextGraphId,
        kaId: options.precomputedAttestation.reservedKaId.toString(),
        publisherAddress,
        entityCount,
        publicRecordCount: allSkolemizedQuads.length,
        hiddenCommitmentCount: privateRoots.length,
      },
    });
  }
  lifecycle.emit('wm', 'write', {
    metadata: {
      contextGraphId,
      recordCount: allSkolemizedQuads.length,
      rootEntityCount: manifestEntries.length,
      accessPolicy: effectiveAccessPolicy,
      hiddenCommitmentCount: privateRoots.length,
      subGraphName: options.subGraphName,
    },
  });
  lifecycle.emit('swm_share', 'prepared', {
    metadata: {
      contextGraphId,
      swmGraphId,
      source: options.fromSharedMemory ? 'shared_memory' : 'inline',
      recordCount: allSkolemizedQuads.length,
      byteSize: publicationPricing.networkVisibleByteSize.toString(),
      billableByteSize: publicationPricing.billableByteSize.toString(),
      pricingPolicy: publicationPricing.policy,
      encryptedInline: useEncryptedInline,
      catalogCommitment: useCuratedCatalog ? 'present' : 'absent',
    },
  });

  {
    let parsedDomain: bigint | null = null;
    try {
      parsedDomain = BigInt(v10CgDomain);
    } catch {
    }
    if (parsedDomain !== null && parsedDomain <= 0n) {
      throw new Error(
        `V10 publish requires a positive on-chain context graph id; ` +
        `got '${v10CgDomain}' (parsed to ${parsedDomain}). ` +
        'Register the CG via ContextGraphs.createContextGraph first ' +
        'and pass the returned numeric id as `publishContextGraphId` ' +
        '(or as the first argument to `publish()`).',
      );
    }
  }

  const v10ACKProvider = options.v10ACKProvider;
  const shouldCollectV10ACKs = v10ACKProvider !== undefined && canAttemptOnChainPublish;
  if (shouldCollectV10ACKs) {
    onPhase?.('collect_v10_acks', 'start');
    try {
      const rootEntities = manifestEntries.map(m => m.rootEntity);
      const reservedAckKaId =
        (options as PublishOptions).reservedKaId ?? options.precomputedAttestation?.reservedKaId;
      const assetUal = await lifecycle.rememberAssetUal(reservedAckKaId);
      const commonACKParams = {
        merkleRoot: kcMerkleRoot,
        contextGraphId: v10CgDomain,
        kaCount,
        rootEntities,
        publicByteSize: publicationPricing.networkVisibleByteSize,
        epochs: publishEpochs,
        tokenAmount: precomputedTokenAmount,
        swmGraphId,
        subGraphName: options.subGraphName,
        merkleLeafCount: kcMerkleLeafCount,
        assetUal,
        ...(graphPublish
          ? {
              contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
              kaUal: graphPublish.scope.ual,
              assertionVersion: graphPublish.scope.assertionVersion,
              publicTripleCount: graphPublish.publicTripleCount,
              ...(privateRoots[0] ? { privateMerkleRoot: privateRoots[0] } : {}),
              privateTripleCount: graphPublish.privateTripleCount,
              accessPolicy: effectiveAccessPolicy,
              allowedPeers: [...normalizedAllowedPeers],
            }
          : {}),
      };
      const lifecycleAckMode = useCuratedCatalog
        ? 'curated_catalog'
        : privateRoots.length > 0
          ? 'folded_private'
          : 'public';
      lifecycle.emit('storage_ack', 'request', {
        metadata: {
          contextGraphId: v10CgDomain,
          swmGraphId,
          subGraphName: options.subGraphName,
          ackMode: lifecycleAckMode,
          kaCount,
          rootEntityCount: rootEntities.length,
          publicByteSize: publicationPricing.networkVisibleByteSize.toString(),
          tokenAmount: precomputedTokenAmount.toString(),
          merkleLeafCount: kcMerkleLeafCount,
          outcome: 'request',
        },
      });
      if (useCuratedCatalog) {
        if (!catalogCommitment || !stagingQuads || stagingQuads.length === 0) {
          throw new Error('Curated catalog ACK mode requires a non-empty catalog commitment and stagingQuads');
        }
        v10ACKs = await ports.invokeV10ACKProvider(v10ACKProvider, {
          ...commonACKParams,
          stagingQuads,
          ackMode: {
            kind: 'curated-catalog',
            catalogCommitment: {
              catalogRoot: catalogCommitment.root,
              catalogLeafCount: catalogCommitment.leafCount,
            },
          },
        });
      } else if (privateRoots.length > 0) {
        v10ACKs = await ports.invokeV10ACKProvider(v10ACKProvider, {
          ...commonACKParams,
          stagingQuads,
          ackMode: {
            kind: 'folded-private',
            privateMerkleRoots: privateRoots,
          },
        });
      } else {
        v10ACKs = await ports.invokeV10ACKProvider(v10ACKProvider, {
          ...commonACKParams,
          stagingQuads,
          ackMode: { kind: 'public' },
        });
      }
      const provenance = v10ACKs
        .map((a) => `${a.peerId.slice(-8)}:${a.subscriptionSource ?? '?'}`)
        .join(', ');
      for (const ack of v10ACKs) {
        lifecycle.emit('storage_ack', 'success', {
          peer: ack.peerId,
          peerNodeIdentityId: ack.nodeIdentityId.toString(),
          metadata: {
            outcome: 'success',
            quorumCollected: v10ACKs.length,
            subscriptionSource: ack.subscriptionSource,
          },
        });
      }
      lifecycle.emit('storage_ack', 'quorum', {
        metadata: {
          outcome: 'success',
          quorumCollected: v10ACKs.length,
        },
      });
      ports.log.info(
        ctx,
        `V10: Collected ${v10ACKs.length} core node ACKs [${provenance}]`,
      );
    } catch (err) {
      const tag = err instanceof Error ? err.name : 'unknown';
      if (isQuorumUnmetError(err)) {
        for (const peerOutcome of err.peerOutcomes) {
          const reason = peerOutcome.reason;
          const outcome = reason?.startsWith('STORAGE_ACK_DECLINE')
            ? 'decline'
            : reason === 'no_response'
              ? 'timeout'
              : reason === 'ACK' || reason?.startsWith('ACK:')
                ? 'success'
                : 'failure';
          lifecycle.emit('storage_ack', outcome, {
            level: 'warn',
            peer: peerOutcome.peerId,
            metadata: {
              outcome,
              reason,
              dialOk: peerOutcome.dialOk,
              protocolSupported: peerOutcome.protocolSupported,
              swmHostModeAdvertised: peerOutcome.swmHostModeAdvertised,
            },
          });
        }
        lifecycle.emit('storage_ack', 'quorum', {
          level: 'warn',
          metadata: {
            outcome: 'failure',
            quorumCollected: err.collected,
            quorumRequired: err.required,
            peerDialled: err.dialled,
          },
        });
      }
      lifecycle.emit('storage_ack', 'failure', {
        level: 'warn',
        metadata: {
          outcome: 'failure',
          errorClass: tag,
          reason: err instanceof Error ? err.message : String(err),
        },
      });
      ports.log.warn(
        ctx,
        `V10 ACK collection failed (${tag}): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    } finally {
      onPhase?.('collect_v10_acks', 'end');
    }
  }

  ensurePublishOperationIdentity();
  if (finalizedPublisherPlan.kind === 'local') {
    const { kaMetadata, normalizedQuads } = input.payload;
    const { normalizedPublisherPeerId, dataGraph } = input.target;
    return { kind: 'local', ctx, onPhase, publisherAddress, publishOperationId,
      reason: publisherContextGraphId === undefined ? 'no on-chain CG id' : 'chain not V10-ready',
      recording: {
        content: { privateRoots, kcMerkleRoot, effectiveAccessPolicy, normalizedAllowedPeers, kaMetadata, normalizedQuads },
        graphPublish, normalizedPublisherPeerId, dataGraph, contextGraphId, ctx,
        subGraphName: options.subGraphName, targetMetaGraphUri: options.targetMetaGraphUri,
        authorAddress: options.precomputedAttestation?.authorAddress,
      } };
  }
  const { attributionIdentityId, hasAttributionOverride, v10ChainId, v10KavAddress, sealedAdoption } = input.target;
  return { kind: 'on-chain',
    content: { catalogCommitment, privateRoots, kcMerkleRoot, publicRecordCount: allSkolemizedQuads.length,
      kcMerkleLeafCount, kaCount, entityCount },
    target: { graphPublish, v10CgDomain, contextGraphId, attributionIdentityId, hasAttributionOverride,
      v10ChainId, v10KavAddress, sealedAdoption },
    plan: finalizedPublisherPlan, publicationPricing, useCuratedCatalog, publishOperationId, v10ACKs,
    lifecycle, ctx, options: { precomputedAttestation: options.precomputedAttestation,
      reservedKaId: options.reservedKaId, onPhase, onBroadcastAccepted: options.onBroadcastAccepted,
      onBeforeBroadcast: options.onBeforeBroadcast } };
}
/** Content and local recording metadata have no encryption, ACK or chain execution capabilities. */
export interface TentativePublicationRecording {
  content: Pick<PreparedPublicationInput['payload'], 'privateRoots' | 'kcMerkleRoot' | 'effectiveAccessPolicy'
    | 'normalizedAllowedPeers' | 'kaMetadata' | 'normalizedQuads'>;
  graphPublish: GraphScopedPublishDescriptor | undefined;
  normalizedPublisherPeerId: string;
  dataGraph: string;
  contextGraphId: string;
  authorAddress: string | undefined;
  subGraphName: string | undefined;
  targetMetaGraphUri: string | undefined;
  ctx: OperationContext;
}
export type PreparedPublication = {
  kind: 'local'; recording: TentativePublicationRecording; ctx: OperationContext;
  onPhase: PublishOptions['onPhase']; publisherAddress: string; publishOperationId: string;
  reason: 'no on-chain CG id' | 'chain not V10-ready';
} | {
  kind: 'on-chain';
  content: Pick<PreparedPublicationInput['payload'], 'catalogCommitment' | 'privateRoots' | 'kcMerkleRoot'
    | 'kcMerkleLeafCount' | 'kaCount' | 'entityCount'> & { publicRecordCount: number };
  target: Pick<PreparedPublicationInput['target'], 'graphPublish' | 'v10CgDomain' | 'contextGraphId'
    | 'attributionIdentityId' | 'hasAttributionOverride' | 'v10ChainId' | 'v10KavAddress' | 'sealedAdoption'>;
  plan: Extract<FinalizedPublisherPlan, { kind: 'on-chain' }>;
  publicationPricing: ReturnType<typeof resolvePublicationPricing>;
  useCuratedCatalog: boolean; publishOperationId: string; v10ACKs: V10CoreNodeACK[] | undefined;
  lifecycle: PublishLifecycleLogger; ctx: OperationContext;
  options: Pick<PublishOptions, 'precomputedAttestation' | 'reservedKaId' | 'onPhase' | 'onBroadcastAccepted' | 'onBeforeBroadcast'>;
};
