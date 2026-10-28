// SPDX-License-Identifier: Apache-2.0


import {GRAPH_KA_CONTENT_SCOPE_VERSION, type CatalogRootResult, type GraphKnowledgeAssetScope, type Logger, type OperationContext} from '@origintrail-official/dkg-core';
import type {Quad} from '@origintrail-official/dkg-storage';
import type {PublishOptions, KAManifestEntry, V10CoreNodeACK, V10ACKProviderParams} from './publisher.js';
import type { V10PublishParams } from '@origintrail-official/dkg-chain';
import { buildAuthorAttestationTypedData } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { publicationAcquisitionFailure } from './prepared-publication-acquisition.js';


import {isQuorumUnmetError} from './ack-errors.js';
import {isFailClosedInlineEncrypt} from './async-lift-publish-options.js';


import {resolvePublicationPricing} from './publication-pricing.js';
import type {CanonicalPublicationPayloadMeasurement} from './publication-payload-measurement.js';
import type {PublisherPlanner} from './publisher-planning.js';
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
    kaCount: number;
    entityCount: number;
  };
  target: {
    publisherContextGraphId: bigint | undefined;
    graphPublish: GraphScopedPublishDescriptor | undefined;
    v10CgDomain: string;
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
  validateSealIntegrity(): Promise<void>;
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
    return { kind: 'local', publisherAddress, publishOperationId,
      reason: publisherContextGraphId === undefined ? 'no on-chain CG id' : 'chain not V10-ready' };
  }
  const { attributionIdentityId, hasAttributionOverride, v10ChainId, v10KavAddress, sealedAdoption } = input.target;
  onPhase?.('chain', 'start');
  await ports.validateSealIntegrity();
  let signStarted = false, submitStarted = false;
  try {
    onPhase?.('chain:sign', 'start'); signStarted = true;
    ports.log.info(ctx, `Signing on-chain publish (attributionId=${attributionIdentityId}${hasAttributionOverride ? ' [override]' : ''}, signer=${finalizedPublisherPlan.signer.address}, source=${finalizedPublisherPlan.signer.source})`);
    onPhase?.('chain:sign', 'end'); signStarted = false;
    onPhase?.('chain:submit', 'start'); submitStarted = true;
    ports.log.info(ctx, `Submitting V10 on-chain publish tx (${kaCount} KAs, networkVisibleByteSize=${publicationPricing.networkVisibleByteSize}${useCuratedCatalog ? ' [catalog]' : ''}, billableByteSize=${publicationPricing.billableByteSize}, pricingPolicy=${publicationPricing.policy}, tokenAmount=${precomputedTokenAmount})`);
  if (publisherContextGraphId === undefined || v10ChainId === undefined || v10KavAddress === undefined) {
    throw new Error('V10 publish requires a parsed context graph id, getEvmChainId() and getKnowledgeAssetsLifecycleAddress()');
  }
  if (!v10ACKs?.length) throw new Error('V10 ACKs required for on-chain publish — no ACKs collected');
  const attestation = options.precomputedAttestation;
  if (!attestation) throw new Error('Publish rejected: on-chain publish requires precomputedAttestation. Call agent.assertion.finalize(...) first.');
  buildAuthorAttestationTypedData({ chainId: v10ChainId, kav10Address: v10KavAddress,
    merkleRoot: kcMerkleRoot, authorAddress: attestation.authorAddress,
    reservedKaId: attestation.reservedKaId, schemeVersion: attestation.schemeVersion });
  const authorSig = ethers.Signature.from({ r: ethers.hexlify(attestation.signature.r),
    yParityAndS: ethers.hexlify(attestation.signature.vs) });
  if (useCuratedCatalog && (!catalogCommitment || catalogCommitment.root.length !== 32
    || catalogCommitment.leafCount <= 0 || catalogCommitment.root.every(b => b === 0))) {
    throw new Error('OT-RFC-49: dkg-publisher refused to submit a curated publish with an empty catalog commitment');
  }
  return { kind: 'on-chain', submission: {
      publishOperationId, contextGraphId: publisherContextGraphId,
      publisherAddress: finalizedPublisherPlan.signer.address,
      reservedKaId: options.reservedKaId ?? attestation.reservedKaId,
      merkleRoot: kcMerkleRoot, knowledgeAssetsAmount: kaCount,
      byteSize: publicationPricing.networkVisibleByteSize, epochs: publishEpochs,
      tokenAmount: precomputedTokenAmount, merkleLeafCount: kcMerkleLeafCount,
      isImmutable: false, publisherNodeIdentityId: attributionIdentityId,
      author: { address: attestation.authorAddress, schemeVersion: attestation.schemeVersion,
        signature: { r: ethers.getBytes(authorSig.r), vs: ethers.getBytes(authorSig.yParityAndS) } },
      ackSignatures: v10ACKs.map(ack => ({ identityId: ack.nodeIdentityId, r: ack.signatureR, vs: ack.signatureVS })),
      catalogRoot: useCuratedCatalog ? catalogCommitment?.root : undefined,
      catalogLeafCount: useCuratedCatalog ? catalogCommitment?.leafCount : undefined,
    }, chainId: v10ChainId, graphPublish, sealedAdoption, v10ACKs, lifecycle, ctx,
    diagnostics: { contextGraphId, publisherAddress, entityCount, publicRecordCount: allSkolemizedQuads.length,
      hiddenCommitmentCount: privateRoots.length, billableByteSize: publicationPricing.billableByteSize,
      pricingPolicy: publicationPricing.policy },
    hooks: { onPhase, onBroadcastAccepted: options.onBroadcastAccepted, onBeforeBroadcast: options.onBeforeBroadcast } };
  } catch (error) {
    if (signStarted) onPhase?.('chain:sign', 'end');
    if (submitStarted) onPhase?.('chain:submit', 'end');
    throw publicationAcquisitionFailure(error, ports.log, ctx, lifecycle, publisherContextGraphId ?? 0n, v10ACKs?.length ?? 0);
  }
}
/** Local preparation carries identity only; the recorder owns the content and persistence inputs. */
export interface PreparedLocalPublication {
  kind: 'local'; publisherAddress: string; publishOperationId: string;
  reason: 'no on-chain CG id' | 'chain not V10-ready';
}
/** The chain stage receives validated transaction parameters and execution hooks. */
export interface PreparedOnChainPublication {
  kind: 'on-chain';
  submission: Omit<V10PublishParams, 'onBroadcast' | 'onBroadcastAccepted' | 'onBeforeReplacementBroadcast'>;
  chainId: bigint;
  graphPublish: GraphScopedPublishDescriptor | undefined;
  sealedAdoption: SealedMintAdoption | undefined;
  v10ACKs: V10CoreNodeACK[];
  lifecycle: PublishLifecycleLogger;
  ctx: OperationContext;
  diagnostics: { contextGraphId: string; publisherAddress: string; entityCount: number; publicRecordCount: number;
    hiddenCommitmentCount: number; billableByteSize: bigint; pricingPolicy: string };
  hooks: Pick<PublishOptions, 'onPhase' | 'onBroadcastAccepted' | 'onBeforeBroadcast'>;
}
export type PreparedPublication = PreparedLocalPublication | PreparedOnChainPublication;
