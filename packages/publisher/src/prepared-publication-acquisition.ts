// SPDX-License-Identifier: Apache-2.0
import { graphScopeTargetsChain } from './graph-scope-chain-target.js';
import { ethers } from 'ethers';
import type { ChainAdapter, OnChainPublishResult } from '@origintrail-official/dkg-chain';
import { GRAPH_KA_CONTENT_SCOPE_VERSION, buildAuthorAttestationTypedData,
  type CatalogRootResult, type GraphKnowledgeAssetScope, type Logger, type OperationContext } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import type { PublishOptions, KAManifestEntry, V10CoreNodeACK, V10ACKProviderParams } from './publisher.js';
import type { KAMetadata } from './metadata.js';
import { generateGraphKnowledgeAssetMetadata, generateTentativeMetadata, replaceLocallyTrustedKnowledgeAssetControls } from './metadata.js';
import { PublisherWalletRequiredError } from './errors.js';
import { isQuorumUnmetError } from './ack-errors.js';
import { isFailClosedInlineEncrypt } from './async-lift-publish-options.js';
import { isAgentRegistryContextGraph } from '@origintrail-official/dkg-core';
import { createWriteAheadHook } from './publisher-write-ahead.js';
import { resolvePublicationPricing } from './publication-pricing.js';
import type { CanonicalPublicationPayloadMeasurement } from './publication-payload-measurement.js';
import type { PublisherPlanner } from './publisher-planning.js';
import type { PublishLifecycleLogger } from './publish-lifecycle-logger.js';
import { mintOrAdoptKnowledgeAssets, type MintOrAdoptOutcome,
  type MintRecording, type SealedMintAdoption } from './adopt-existing-mint.js';

export interface GraphScopedPublishDescriptor {
  scope: GraphKnowledgeAssetScope;
  expectedPackedKaId: bigint;
  publicTripleCount: number;
  privateTripleCount: number;
  expectedPrivateMerkleRoot?: Uint8Array;
}
export type PublicationAcquisition =
  | { kind: 'confirmed'; outcome: MintOrAdoptOutcome; reservedKaId: bigint | undefined;
      effectiveAuthorAddress: string; v10ACKs?: V10CoreNodeACK[]; submitted: boolean }
  | { kind: 'tentative'; ual: string; localChainSkipReason: 'no-chain' | undefined; v10ACKs?: V10CoreNodeACK[] };
interface PreparedPublicationInput {
  publisherContextGraphId: bigint | undefined;
  options: PublishOptions;
  catalogCommitment: CatalogRootResult | undefined;
  privateRoots: Uint8Array[];
  graphPublish: GraphScopedPublishDescriptor | undefined;
  catalogByteSize: bigint;
  publicByteSize: bigint;
  pricingPolicy: PublishOptions['pricingPolicy'];
  payloadMeasurement: CanonicalPublicationPayloadMeasurement;
  encryptableNquadsStr: string;
  kcMerkleRoot: Uint8Array;
  catalogNquadsStr: string | undefined;
  publicNquadsBytes: Uint8Array;
  lifecycle: PublishLifecycleLogger;
  allSkolemizedQuads: Quad[];
  manifestEntries: KAManifestEntry[];
  effectiveAccessPolicy: 'public' | 'ownerOnly' | 'allowList';
  v10CgDomain: string;
  kcMerkleLeafCount: number;
  normalizedAllowedPeers: string[];
  ctx: OperationContext;
  kaMetadata: KAMetadata[];
  normalizedPublisherPeerId: string;
  dataGraph: string;
  contextGraphId: string;
  normalizedQuads: Quad[];
  attributionIdentityId: bigint;
  hasAttributionOverride: boolean;
  kaCount: number;
  entityCount: number;
  v10ChainId: bigint | undefined;
  v10KavAddress: string | undefined;
  sealedAdoption: SealedMintAdoption | undefined;
  explicitPublishEpochs: number | undefined;
  publicStagingMode: 'inline' | 'strict-swm' | 'inline-small-swm';
}
interface PublicationAcquisitionPorts {
  publisherPlanner: PublisherPlanner;
  log: Logger;
  chain: ChainAdapter;
  store: TripleStore;
  replaceExactKnowledgeAssetGraph(graphUri: string, quads: readonly Quad[], operation: string): Promise<void>;
  ensureReservedKaId(author: string, precomputed?: bigint): Promise<bigint | undefined>;
  allocateOperationId(): string;
  validateSealIntegrity(): Promise<void>;
  persistFinalizedPrivateSlices(): Promise<void>;
  persistCatalogEntry(): Promise<void>;
  selectPublicStagingQuads(mode: PreparedPublicationInput['publicStagingMode'], quads: Uint8Array): Uint8Array | undefined;
  invokeV10ACKProvider(provider: NonNullable<PublishOptions['v10ACKProvider']>, params: V10ACKProviderParams): Promise<V10CoreNodeACK[]>;
}
/** Acquire a receipt or explicitly finalize a local-only publish. Never record a confirmed receipt. */
export async function acquirePreparedPublication(input: PreparedPublicationInput, ports: PublicationAcquisitionPorts): Promise<PublicationAcquisition> {
  const { publisherContextGraphId, options, catalogCommitment, privateRoots, graphPublish, catalogByteSize, publicByteSize, pricingPolicy, payloadMeasurement, encryptableNquadsStr, kcMerkleRoot, catalogNquadsStr, publicNquadsBytes, lifecycle, allSkolemizedQuads, manifestEntries, effectiveAccessPolicy, v10CgDomain, kcMerkleLeafCount, normalizedAllowedPeers, ctx, kaMetadata, normalizedPublisherPeerId, dataGraph, contextGraphId, normalizedQuads, attributionIdentityId, hasAttributionOverride, kaCount, entityCount, v10ChainId, v10KavAddress, sealedAdoption, explicitPublishEpochs, publicStagingMode } = input;
  const { onPhase, onBroadcastAccepted, onBeforeBroadcast } = options;
  const swmGraphId = contextGraphId;
  const v10CgId = /^\d+$/.test(v10CgDomain) ? BigInt(v10CgDomain) : 0n;
  let publishOperationId = '', ual = '';
  const ensurePublishOperationIdentity = () => { publishOperationId ||= ports.allocateOperationId(); };
  let onChainResult: OnChainPublishResult;
  let v10ACKs: V10CoreNodeACK[] | undefined;
  let localChainSkipReason: 'no-chain' | undefined;

  const publisherPlanning = await ports.publisherPlanner.prepare(publisherContextGraphId);
  const { chainV10Ready, canAttemptOnChainPublish } = publisherPlanning;
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
  const publisherSigner = finalizedPublisherPlan.kind === 'on-chain'
    ? finalizedPublisherPlan.signer
    : undefined;
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

  onPhase?.('chain', 'start');

  let recording: MintRecording | undefined;
  ensurePublishOperationIdentity();
  ual = graphPublish?.scope.ual
    ?? `did:dkg:${ports.chain.chainId}/${publisherAddress}/t${publishOperationId}`;

  const finalizeIntentionalLocalPublish = async (reasonLog: string) => {
    for (const km of kaMetadata) {
      km.kcUal = ual;
    }
    const commonMeta = {
      ual,
      contextGraphId,
      merkleRoot: kcMerkleRoot,
      publisherPeerId: normalizedPublisherPeerId || 'unknown',
      accessPolicy: effectiveAccessPolicy,
      allowedPeers: normalizedAllowedPeers,
      timestamp: new Date(),
      subGraphName: options.subGraphName,
      ...((options.precomputedAttestation?.authorAddress
        ?? publisherSigner?.address) != null
        ? {
            authorAddress: (options.precomputedAttestation?.authorAddress
              ?? publisherSigner!.address),
          }
        : {}),
    };
    let tentativeMeta = graphPublish
      ? generateGraphKnowledgeAssetMetadata(
          {
            ...commonMeta,
            assertionVersion: graphPublish.scope.assertionVersion,
            publicTripleCount: graphPublish.publicTripleCount,
            privateTripleCount: graphPublish.privateTripleCount,
            ...(privateRoots[0] ? { privateMerkleRoot: privateRoots[0] } : {}),
            assertionGraph: dataGraph,
          },
          { status: 'tentative' },
        )
      : generateTentativeMetadata(commonMeta, kaMetadata);
    if (options.targetMetaGraphUri) {
      const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
      tentativeMeta = tentativeMeta.map((q) =>
        q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
      );
    }
    if (graphPublish && !isAgentRegistryContextGraph(contextGraphId)) {
      await replaceLocallyTrustedKnowledgeAssetControls(
        ports.store,
        graphPublish.scope.ual,
        tentativeMeta,
      );
    }
    ports.log.info(ctx, `Storing ${normalizedQuads.length} triples in local store (${reasonLog})`);
    if (graphPublish) {
      await ports.replaceExactKnowledgeAssetGraph(
        dataGraph,
        normalizedQuads,
        'Graph-scoped local publish',
      );
    } else {
      await ports.store.insert(normalizedQuads);
    }
    await ports.persistFinalizedPrivateSlices();
    if (!isAgentRegistryContextGraph(contextGraphId)) {
      await ports.store.insert(tentativeMeta);
    }
    await ports.persistCatalogEntry();
  };

  if (publisherContextGraphId === undefined) {
    ports.log.warn(ctx, `No positive on-chain context graph id resolved from "${v10CgDomain}" — skipping on-chain publish`);
    localChainSkipReason = 'no-chain';
    await finalizeIntentionalLocalPublish('no on-chain CG id');
  } else if (!chainV10Ready) {
    ports.log.warn(ctx, 'Chain adapter is not V10-ready — skipping on-chain publish');
    localChainSkipReason = 'no-chain';
    await finalizeIntentionalLocalPublish('chain not V10-ready');
  } else {
    const tokenAmount = precomputedTokenAmount;
    

    await ports.validateSealIntegrity();

    let signStarted = false;
    let submitStarted = false;
    try {
      onPhase?.('chain:sign', 'start');
      signStarted = true;
      if (!publisherSigner) throw new PublisherWalletRequiredError('publish');
      if (publisherSigner) ports.log.info(ctx, `Signing on-chain publish (attributionId=${attributionIdentityId}${hasAttributionOverride ? ' [override]' : ''}, signer=${publisherSigner.address}, source=${publisherSigner.source})`);

      onPhase?.('chain:sign', 'end');
      signStarted = false;
      onPhase?.('chain:submit', 'start');
      submitStarted = true;
      ports.log.info(ctx, `Submitting V10 on-chain publish tx (${kaCount} KAs, networkVisibleByteSize=${publicationPricing.networkVisibleByteSize}${useCuratedCatalog ? ' [catalog]' : ''}, billableByteSize=${publicationPricing.billableByteSize}, pricingPolicy=${publicationPricing.policy}, tokenAmount=${tokenAmount})`);

      if (!v10ACKs || v10ACKs.length === 0) {
        throw new Error('V10 ACKs required for on-chain publish — no ACKs collected');
      }
      if (typeof ports.chain.isV10Ready !== 'function' || !ports.chain.isV10Ready()) {
        throw new Error(
          'Chain adapter is not V10-ready (isV10Ready() returned false or is missing). ' +
          'Publish is routed through KnowledgeAssetsV10.publish, which requires ' +
          'the adapter to expose createKnowledgeAssets, getEvmChainId, and ' +
          'getKnowledgeAssetsLifecycleAddress — use an EVM adapter pointed at a chain where ' +
          'KnowledgeAssetsV10 is deployed.',
        );
      }
      if (v10ChainId === undefined || v10KavAddress === undefined) {
        throw new Error(
          'V10 publish requires the chain adapter to expose getEvmChainId() and ' +
          'getKnowledgeAssetsLifecycleAddress(); neither was resolved. The adapter is not V10-capable.',
        );
      }
      if (!options.precomputedAttestation) {
        throw new Error(
          'Publish rejected: on-chain publish requires precomputedAttestation. ' +
          'RFC-001 §9.x — every published assertion must be sealed at finalize-time. ' +
          'Call agent.assertion.finalize(...) first; the daemon\'s assertion-name-aware ' +
          '/api/knowledge-assets/:name/vm/publish route resolves the seal automatically.',
        );
      }
      const effectiveAuthorAddress = options.precomputedAttestation.authorAddress;
      const effectiveSchemeVersion = options.precomputedAttestation.schemeVersion;
      buildAuthorAttestationTypedData({
        chainId: v10ChainId,
        kav10Address: v10KavAddress,
        merkleRoot: kcMerkleRoot,
        authorAddress: effectiveAuthorAddress,
        reservedKaId: options.precomputedAttestation.reservedKaId,
        schemeVersion: effectiveSchemeVersion,
      });
      const authorSig: ethers.Signature = ethers.Signature.from({
        r: ethers.hexlify(options.precomputedAttestation.signature.r),
        yParityAndS: ethers.hexlify(options.precomputedAttestation.signature.vs),
      });
      const writeAhead = createWriteAheadHook({ onPhase, onBeforeBroadcast, operationKind: 'create' });
      const emitWriteAheadStart = writeAhead.emitWriteAheadStart;
      const reservedKaId = await ports.ensureReservedKaId(
        effectiveAuthorAddress,
        (options as PublishOptions).reservedKaId ?? options.precomputedAttestation?.reservedKaId,
      );
      if (graphPublish && reservedKaId !== undefined) {
        if (reservedKaId !== graphPublish.expectedPackedKaId) {
          throw new Error(
            `Graph-scoped publish reserved kaId ${reservedKaId} does not derive from ` +
              `UAL ${graphPublish.scope.ual} (expected ${graphPublish.expectedPackedKaId}); refusing to mint`,
          );
        }
        if (!graphScopeTargetsChain(
          graphPublish.scope.chainId,
          ports.chain.chainId,
          v10ChainId,
        )) {
          throw new Error(
            `Graph-scoped publish UAL ${graphPublish.scope.ual} targets chain ` +
              `${graphPublish.scope.chainId}, but this publisher mints on ` +
              `${ports.chain.chainId} (EIP-155 ${v10ChainId})`,
          );
        }
      }
      await lifecycle.rememberAssetUal(reservedKaId);
      if (!lifecycle.identityAllocatedEmitted && reservedKaId !== undefined) {
        lifecycle.emit('identity', 'asset_ual_allocated', {
          metadata: {
            contextGraphId,
            kaId: reservedKaId.toString(),
            publisherAddress,
            entityCount,
            publicRecordCount: allSkolemizedQuads.length,
            hiddenCommitmentCount: privateRoots.length,
          },
        });
      }
      try {
        if (useCuratedCatalog) {
          if (
            !catalogCommitment
            || catalogCommitment.root.length !== 32
            || catalogCommitment.leafCount <= 0
            || catalogCommitment.root.every((b) => b === 0)
          ) {
            throw new Error(
              `OT-RFC-49: dkg-publisher refused to submit a curated publish with an empty ` +
              `catalog commitment (root=${catalogCommitment?.root.length ?? 0} bytes, ` +
              `count=${catalogCommitment?.leafCount ?? 0}). The catalog root MUST be the V10 ` +
              `Merkle root over the committed catalog leaf-set, never bytes32(0) — without it ` +
              `the prover cannot prove the curated CG and random sampling skips the KC.`,
            );
          }
        }
        lifecycle.emit('chain', 'submit', {
          metadata: {
            contextGraphId: v10CgId.toString(),
            kaId: reservedKaId?.toString(),
            byteSize: publicationPricing.networkVisibleByteSize.toString(),
            billableByteSize: publicationPricing.billableByteSize.toString(),
            pricingPolicy: publicationPricing.policy,
            tokenAmount: tokenAmount.toString(),
            ackCount: v10ACKs?.length ?? 0,
            merkleLeafCount: kcMerkleLeafCount,
          },
        });
        ({ result: onChainResult, recording } = await mintOrAdoptKnowledgeAssets(ports.chain, {
          publishOperationId,
          contextGraphId: v10CgId,
          publisherAddress: publisherSigner.address,
          reservedKaId,
          merkleRoot: kcMerkleRoot,
          knowledgeAssetsAmount: kaCount,
          byteSize: publicationPricing.networkVisibleByteSize,
          catalogRoot: useCuratedCatalog ? catalogCommitment?.root : undefined,
          catalogLeafCount: useCuratedCatalog ? catalogCommitment?.leafCount : undefined,
          epochs: publishEpochs,
          tokenAmount,
          merkleLeafCount: kcMerkleLeafCount,
          isImmutable: false,
          publisherNodeIdentityId: attributionIdentityId,
          author: {
            address: effectiveAuthorAddress,
            signature: {
              r: ethers.getBytes(authorSig.r),
              vs: ethers.getBytes(authorSig.yParityAndS),
            },
            schemeVersion: effectiveSchemeVersion,
          },
          ackSignatures: v10ACKs.map(ack => ({
            identityId: ack.nodeIdentityId,
            r: ack.signatureR,
            vs: ack.signatureVS,
          })),
          onBroadcast: emitWriteAheadStart,
          onBroadcastAccepted: (signal) =>
            onBroadcastAccepted?.({ ...signal, operationKind: 'create' }),
          ...(writeAhead.onBeforeReplacementBroadcast
            ? { onBeforeReplacementBroadcast: writeAhead.onBeforeReplacementBroadcast }
            : {}),
        }, sealedAdoption));
      } finally {
        if (writeAhead.didWriteAhead()) onPhase?.('chain:writeahead', 'end');
      }

      if (!recording.adopted) onChainResult.tokenAmount = tokenAmount;
      return { kind: 'confirmed', outcome: { result: onChainResult, recording },
        reservedKaId, effectiveAuthorAddress, v10ACKs, submitted: true };
    } catch (err) {
      if (signStarted) onPhase?.('chain:sign', 'end');
      if (submitStarted) onPhase?.('chain:submit', 'end');
      throw publicationAcquisitionFailure(err, ports.log, ctx, lifecycle, v10CgId, v10ACKs?.length ?? 0);
    }
  }

  return { kind: 'tentative', ual, localChainSkipReason, v10ACKs };
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
