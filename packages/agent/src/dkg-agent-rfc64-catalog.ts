// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 Gate 1 public author-catalog wiring, extracted as a DKGAgent mixin
 * holder. Methods take `this: DKGAgent` so cross-mixin calls resolve against
 * the composed class.
 *
 * Responsibilities:
 *   - construct + start {@link Rfc64PublicCatalogServiceV1} on the production
 *     router during `start()` (dormant when no `dataDir` opened the RFC-64
 *     persistence), and drain + close it during `stop()`;
 *   - expose the author path (sign + durably stage the direct-author issuer
 *     delegation, produce + durably stage + best-effort announce its bound
 *     genesis head) and the accepted-open-policy seed used by both sides;
 *   - expose read-only observability for tests / evidence.
 *
 * Gate-1 boundary: staging a fetched head is the terminal step. Nothing here
 * admits candidate rows or activates KA / SWM / VM state.
 */

import {
  ZERO_DIGEST32_V1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  deriveAuthorCatalogScopeFromHeadV1,
  type AssertionCoordinateV1,
  type ByteLengthV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type OperationContext,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type KaIdV1,
  type NetworkIdV1,
  type SubGraphNameV1,
  type TimestampMsV1,
  type DecimalU64V1,
  type AuthorCatalogScopeV1,
  type CountV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { Rfc64AuthorCatalogEip191SignerV1 } from './rfc64/author-catalog-producer.js';
import {
  snapshotRfc64CatalogAccessPolicyAuthorityV1,
  snapshotRfc64CatalogDeploymentProfileV1,
} from './rfc64/catalog-authority-config-v1.js';
import type { AcceptedOpenCatalogPolicyV1 } from './rfc64/open-catalog-policy-v1.js';
import type {
  AcceptRfc64CatalogAccessSnapshotInputV1,
  AcceptedRfc64CatalogAccessSnapshotV1,
} from './rfc64/catalog-access-policy-v1.js';
import type { Rfc64PublicCatalogReceiverReconcilerV1 } from './rfc64/public-catalog-receiver-v1.js';
import type { Rfc64PersistenceV1 } from './rfc64/persistence-v1.js';
import {
  Rfc64PublicCatalogServiceV1,
  snapshotRfc64PublicCatalogAnnouncementPeersV1,
  type PublishAuthorCatalogGenesisResultV1,
  type PublishOpenAuthorCatalogGenesisResultV1,
  type AnnounceRfc64PublicCatalogHeadInputV1,
  type AnnounceRfc64PublicCatalogHeadResultV1,
  type Rfc64PublicCatalogReconcilerClientsV1,
  type Rfc64PublicCatalogServiceNativeOptionsV1,
  type Rfc64PublicCatalogServiceStatsV1,
} from './rfc64/public-catalog-service-v1.js';
import {
  Rfc64PublicCatalogNativeReceiverErrorV1,
  Rfc64PublicCatalogNativeReceiverV1,
  type Rfc64PublicCatalogNativeSynchronizationEvidenceV1,
} from './rfc64/public-catalog-native-receiver-v1.js';
import {
  createRfc64BoundedPublicRootCatalogNativeReconcilerV1,
  type Rfc64BoundedPublicRootCatalogDeploymentResolverV1,
} from './rfc64/public-catalog-native-reconciler-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import type {
  Rfc64PublicCatalogReconciliationFailureV1,
} from './rfc64/public-catalog-reconciliation-failure-v1.js';
import {
  Rfc64PublicCatalogSuccessorProducerV1,
  type Rfc64PublicCatalogIssuerAuthorizationV1,
  type Rfc64PublicCatalogSuccessorAssetInputV1,
} from './rfc64/public-catalog-successor-producer-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from './rfc64/public-catalog-transport-v1.js';

/** Minimal EIP-191 EOA signer (ethers.Wallet-compatible) for author-catalog objects. */
export interface Rfc64CatalogAuthorSignerV1 {
  readonly address: string;
  signMessage(message: Uint8Array): Promise<string>;
}

/** Compatibility name retained for the legacy public/open authoring surface. */
export type Rfc64OpenCatalogAuthorSignerV1 = Rfc64CatalogAuthorSignerV1;

export interface AcceptOpenContextGraphPolicyInputV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly ownerAddress: EvmAddressV1;
  readonly ownerAuthorityEra?: DecimalU64V1;
  readonly issuedAt?: TimestampMsV1;
  readonly effectiveAt?: TimestampMsV1;
}

/** Already-authoritative current policy snapshot supplied to the catalog plane. */
export type AcceptRfc64CatalogAccessSnapshotParamsV1 =
  AcceptRfc64CatalogAccessSnapshotInputV1;

export interface PublishOpenAuthorCatalogGenesisParamsV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName?: SubGraphNameV1 | null;
  /** The EOA that authors and owns the open CG (also the open-policy owner). */
  readonly author: Rfc64OpenCatalogAuthorSignerV1;
  /** Peers to announce head availability to (best-effort hints). */
  readonly peers: readonly string[];
  /** Head object timestamp; defaults to now. */
  readonly issuedAt?: TimestampMsV1;
  /** Required half-open validity interval for the signed direct-author delegation. */
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
  /** Open-policy timestamps; MUST match on every party (default '0'). */
  readonly policyIssuedAt?: TimestampMsV1;
  readonly policyEffectiveAt?: TimestampMsV1;
  readonly ownerAuthorityEra?: DecimalU64V1;
}

export interface PublishAuthorCatalogGenesisParamsV1 {
  /** Exact accepted policy-bound author catalog scope. */
  readonly scope: AuthorCatalogScopeV1;
  readonly author: Rfc64CatalogAuthorSignerV1;
  readonly peers: readonly string[];
  readonly issuedAt?: TimestampMsV1;
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
}

export interface Rfc64StagedAuthorCatalogHeadRefV1 {
  readonly objectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
}

export interface Rfc64StagedCatalogIssuerDelegationRefV1 {
  readonly objectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
}

/** Exact durable applied-head key exposed for devnet evidence collection. */
export interface Rfc64AppliedCatalogHeadRefV1 {
  readonly catalogScopeDigest: Digest32V1;
  readonly authorAddress: EvmAddressV1;
}

export type {
  SynchronizeRfc64PublicCatalogFromProviderParamsV1,
  SynchronizeRfc64PublicCatalogFromProviderResultV1,
} from './dkg-agent-rfc64-catalog-sync.js';

export {
  RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_MAX_ENTRIES_V1,
  type Rfc64PublicCatalogReconciliationFailureV1,
} from './rfc64/public-catalog-reconciliation-failure-v1.js';

export {
  snapshotRfc64CatalogAccessPolicyAuthorityV1,
  snapshotRfc64CatalogDeploymentProfileV1,
  snapshotRfc64PublicCatalogAutoPublishConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
} from './rfc64/catalog-authority-config-v1.js';

export interface PublishOpenAuthorCatalogSuccessorParamsV1 {
  /** Exact durable predecessor returned by genesis or a prior successor. */
  readonly previousHead: Rfc64StagedAuthorCatalogHeadRefV1;
  /** Same author/catalog key that signed the predecessor. */
  readonly author: Rfc64OpenCatalogAuthorSignerV1;
  /** Exact signed authorization returned by genesis publication. */
  readonly catalogIssuerAuthorization: Rfc64PublicCatalogIssuerAuthorizationV1;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly projectionBytes: Uint8Array;
  readonly seal: CanonicalGraphScopedAuthorSealV1;
  readonly deployment: CatalogSealDeploymentProfileV1;
  /** Successor head timestamp; defaults to now. */
  readonly issuedAt?: TimestampMsV1;
  /** Peers to announce head availability to after both durable barriers. */
  readonly peers: readonly string[];
}

/** One member of the complete live set supplied to an ordinary successor. */
export type Rfc64CatalogSuccessorAssetInputV1 =
  Rfc64PublicCatalogSuccessorAssetInputV1;

export interface PublishAuthorCatalogExactSetSuccessorParamsV1 {
  /** Exact durable predecessor returned by genesis or a prior successor. */
  readonly previousHead: Rfc64StagedAuthorCatalogHeadRefV1;
  readonly author: Rfc64CatalogAuthorSignerV1;
  readonly catalogIssuerAuthorization: Rfc64PublicCatalogIssuerAuthorizationV1;
  /** Complete 1..1024-row live set; input order does not affect the signed head. */
  readonly assets: readonly Rfc64CatalogSuccessorAssetInputV1[];
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly issuedAt?: TimestampMsV1;
  readonly peers: readonly string[];
}

export type Rfc64OpenCatalogSuccessorAssetInputV1 =
  Rfc64CatalogSuccessorAssetInputV1;
export type PublishOpenAuthorCatalogExactSetSuccessorParamsV1 =
  PublishAuthorCatalogExactSetSuccessorParamsV1;

export interface PublishOpenAuthorCatalogSuccessorResultV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  readonly headObjectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
  readonly catalogRowDigest: Digest32V1;
  readonly bundleDigest: Digest32V1;
  readonly contentDigest: Digest32V1;
  readonly contentByteLength: ByteLengthV1;
  readonly bundleByteLength: ByteLengthV1;
  readonly kaUal: string;
  readonly inventoryRowCount: CountV1;
  readonly announcedPeers: readonly string[];
  readonly failedPeers: ReadonlyArray<{ readonly peerId: string; readonly error: string }>;
}

export interface PublishAuthorCatalogSuccessorAssetResultV1 {
  readonly kaId: KaIdV1;
  readonly catalogRowDigest: Digest32V1;
  readonly bundleDigest: Digest32V1;
  readonly contentDigest: Digest32V1;
  /** Exact verified graph-scoped author seal committed by the catalog row. */
  readonly sealDigest: Digest32V1;
  /** Checked safe-integer form of the verified public projection triple count. */
  readonly activatedTripleCount: number;
  readonly contentByteLength: ByteLengthV1;
  readonly bundleByteLength: ByteLengthV1;
  readonly kaUal: string;
}

export interface PublishAuthorCatalogExactSetSuccessorResultV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  readonly headObjectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
  /** Detached exact catalog scope derived from the signed successor head. */
  readonly catalogScope: Readonly<AuthorCatalogScopeV1>;
  /** Canonical digest independently recomputed from `catalogScope`. */
  readonly catalogScopeDigest: Digest32V1;
  /** Exact signed bucket row count, sourced independently of head `totalRows`. */
  readonly signedBucketRowCount: CountV1;
  /** Strictly increasing by mathematical KA ID. */
  readonly assets: readonly Readonly<PublishAuthorCatalogSuccessorAssetResultV1>[];
  readonly inventoryRowCount: CountV1;
  readonly announcedPeers: readonly string[];
  readonly failedPeers: ReadonlyArray<{ readonly peerId: string; readonly error: string }>;
}

export type PublishOpenAuthorCatalogSuccessorAssetResultV1 =
  PublishAuthorCatalogSuccessorAssetResultV1;
export type PublishOpenAuthorCatalogExactSetSuccessorResultV1 =
  PublishAuthorCatalogExactSetSuccessorResultV1;

export class Rfc64CatalogMethods extends DKGAgentBase {
  /**
   * Construct + start the public catalog service on the production router.
   * No-op when RFC-64 persistence is dormant (no `dataDir`) or already started.
   */
  startRfc64PublicCatalogServiceV1(this: DKGAgent, ctx: OperationContext): void {
    if (this.rfc64PublicCatalogServiceV1 !== undefined) return;
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) return;
    const service = new Rfc64PublicCatalogServiceV1({
      router: this.router,
      controlObjects: persistence.controlObjects,
      accessPolicyAuthority: this.config.rfc64CatalogAccessPolicyAuthority,
      native: this.createRfc64PublicCatalogNativeOptionsV1(),
      currentHeadDiscovery: {
        readCurrentAppliedCatalogHeadDigest: async (trustedScope) => {
          const applied = persistence.inventory.readAppliedCatalogHeadV1(
            computeAuthorCatalogScopeDigestV1(trustedScope),
            trustedScope.authorAddress,
          );
          return applied?.currentCatalogHeadDigest ?? null;
        },
      },
      receiver: {
        onError: (announcement, error) => {
          this.rfc64PublicCatalogReconciliationFailuresV1.record(
            announcement.catalogHeadObjectDigest,
            error,
          );
        },
      },
    });
    service.start();
    this.rfc64PublicCatalogServiceV1 = service;
    this.log.info(ctx, 'RFC-64 public author-catalog transport started');
  }

  /** Stop serving and drain in-flight receiver work. Idempotent + undefined-safe. */
  async closeRfc64PublicCatalogServiceV1(this: DKGAgent): Promise<void> {
    const service = this.rfc64PublicCatalogServiceV1;
    this.rfc64PublicCatalogServiceV1 = undefined;
    try {
      await service?.close();
    } finally {
      this.rfc64PublicCatalogSynchronizationEvidenceV1.clear();
      this.rfc64PublicCatalogReconciliationFailuresV1.clear();
    }
  }

  /**
   * Accept the CG's open (accessPolicy=0) current policy into the authorizer.
   * Author and receiver each call this from independently-held CG identity
   * facts — the accepted digest, not the untrusted wire hint, gates operations.
   */
  acceptOpenContextGraphPolicyV1(
    this: DKGAgent,
    input: AcceptOpenContextGraphPolicyInputV1,
  ): AcceptedOpenCatalogPolicyV1 {
    return this.requireRfc64PublicCatalogServiceV1().acceptOpenPolicy(input);
  }

  /**
   * Accept an independently verified current ContextGraphPolicyV1 snapshot and
   * its conditional MemberRosterV1 into the catalog data-plane authorizer.
   * This method does not verify administrative/finality authority itself.
   */
  acceptRfc64CatalogAccessSnapshotV1(
    this: DKGAgent,
    input: AcceptRfc64CatalogAccessSnapshotParamsV1,
  ): AcceptedRfc64CatalogAccessSnapshotV1 {
    return this.requireRfc64PublicCatalogServiceV1().acceptPolicySnapshot(input);
  }

  /** Author path for a previously accepted policy snapshot in any V1 cell. */
  async publishAuthorCatalogGenesisV1(
    this: DKGAgent,
    params: PublishAuthorCatalogGenesisParamsV1,
  ): Promise<PublishAuthorCatalogGenesisResultV1> {
    const authorAddress = params.author.address.toLowerCase() as EvmAddressV1;
    if (authorAddress !== params.scope.authorAddress) {
      throw new Error('RFC-64 genesis author must equal the exact catalog scope author');
    }
    return this.requireRfc64PublicCatalogServiceV1().publishAuthorCatalogGenesis({
      scope: params.scope,
      signer: {
        issuer: authorAddress,
        signDigest: (objectDigest) => params.author.signMessage(objectDigest),
      },
      issuedAt: params.issuedAt ?? (Date.now().toString() as TimestampMsV1),
      catalogIssuerDelegationEffectiveAt: params.catalogIssuerDelegationEffectiveAt,
      catalogIssuerDelegationExpiresAt: params.catalogIssuerDelegationExpiresAt,
      peers: params.peers,
    });
  }

  /**
   * Author path: accept the CG's open policy, durably stage its signed direct-
   * author issuer delegation, durably stage the bound genesis, then best-effort
   * announce availability.
   */
  async publishOpenAuthorCatalogGenesisV1(
    this: DKGAgent,
    params: PublishOpenAuthorCatalogGenesisParamsV1,
  ): Promise<PublishOpenAuthorCatalogGenesisResultV1> {
    const service = this.requireRfc64PublicCatalogServiceV1();
    const authorAddress = params.author.address.toLowerCase() as EvmAddressV1;
    const policy = service.acceptOpenPolicy({
      networkId: params.networkId,
      contextGraphId: params.contextGraphId,
      ownerAddress: authorAddress,
      ownerAuthorityEra: params.ownerAuthorityEra,
      issuedAt: params.policyIssuedAt,
      effectiveAt: params.policyEffectiveAt,
    });
    const scope: AuthorCatalogScopeV1 = {
      networkId: params.networkId,
      contextGraphId: params.contextGraphId,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: params.subGraphName ?? null,
      authorAddress,
      era: '0' as DecimalU64V1,
      bucketCount: '1' as CountV1,
    };
    const signer: Rfc64AuthorCatalogEip191SignerV1 = {
      issuer: authorAddress,
      signDigest: (objectDigest) => params.author.signMessage(objectDigest),
    };
    const issuedAt = params.issuedAt ?? (Date.now().toString() as TimestampMsV1);
    return service.publishOpenAuthorCatalogGenesis({
      scope,
      signer,
      issuedAt,
      catalogIssuerDelegationEffectiveAt: params.catalogIssuerDelegationEffectiveAt,
      catalogIssuerDelegationExpiresAt: params.catalogIssuerDelegationExpiresAt,
      policy,
      peers: params.peers,
    });
  }

  /** Explicit best-effort availability fan-out for an already durable head. */
  announceRfc64PublicCatalogHeadV1(
    this: DKGAgent,
    input: AnnounceRfc64PublicCatalogHeadInputV1,
  ): Promise<AnnounceRfc64PublicCatalogHeadResultV1> {
    return this.requireRfc64PublicCatalogServiceV1().announceCatalogHead(input);
  }

  /**
   * Public/open author path for one exact root-lane successor. The predecessor
   * is reloaded from durable provider storage, the hardened producer performs
   * every authorship/bundle/projection check, and announcement happens only
   * after exact bundle and control-object durability receipts.
   */
  async publishOpenAuthorCatalogSuccessorV1(
    this: DKGAgent,
    params: PublishOpenAuthorCatalogSuccessorParamsV1,
  ): Promise<PublishOpenAuthorCatalogSuccessorResultV1> {
    const result = await this.publishOpenAuthorCatalogExactSetSuccessorV1({
      previousHead: params.previousHead,
      author: params.author,
      catalogIssuerAuthorization: params.catalogIssuerAuthorization,
      assets: [{
        assertionCoordinate: params.assertionCoordinate,
        projectionBytes: params.projectionBytes,
        seal: params.seal,
      }],
      deployment: params.deployment,
      issuedAt: params.issuedAt,
      peers: params.peers,
    });
    const asset = result.assets[0];
    if (asset === undefined) {
      throw new Error('RFC-64 one-row successor returned no exact asset evidence');
    }
    return Object.freeze({
      announcement: result.announcement,
      headObjectDigest: result.headObjectDigest,
      signatureVariantDigest: result.signatureVariantDigest,
      catalogRowDigest: asset.catalogRowDigest,
      bundleDigest: asset.bundleDigest,
      contentDigest: asset.contentDigest,
      contentByteLength: asset.contentByteLength,
      bundleByteLength: asset.bundleByteLength,
      kaUal: asset.kaUal,
      inventoryRowCount: result.inventoryRowCount,
      announcedPeers: result.announcedPeers,
      failedPeers: result.failedPeers,
    });
  }

  /**
   * Public/open author path for a complete bounded exact set. Canonical RFC-64
   * ordinary-successor rules still require exactly one KA delta from the
   * predecessor; callers grow a catalog through successive exact sets.
   */
  async publishOpenAuthorCatalogExactSetSuccessorV1(
    this: DKGAgent,
    params: PublishOpenAuthorCatalogExactSetSuccessorParamsV1,
  ): Promise<PublishOpenAuthorCatalogExactSetSuccessorResultV1> {
    const service = this.requireRfc64PublicCatalogServiceV1();
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 persistence is not available');
    }
    const history = await loadBoundedAuthorCatalogHistoryV1(
      persistence,
      params.previousHead,
    );
    const scope = deriveAuthorCatalogScopeFromHeadV1(history.previousHead.payload);
    if (scope.subGraphName !== null) {
      throw new Error('RFC-64 public/open compatibility successor requires the root lane');
    }
    service.acceptedOpenPolicyDigestForCatalogScope(scope);
    return this.publishAuthorCatalogExactSetSuccessorFromHistoryV1(params, history);
  }

  /** Exact-set successor path for any locally accepted policy cell. */
  async publishAuthorCatalogExactSetSuccessorV1(
    this: DKGAgent,
    params: PublishAuthorCatalogExactSetSuccessorParamsV1,
  ): Promise<PublishAuthorCatalogExactSetSuccessorResultV1> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 persistence is not available');
    }
    const history = await loadBoundedAuthorCatalogHistoryV1(persistence, params.previousHead);
    return this.publishAuthorCatalogExactSetSuccessorFromHistoryV1(params, history);
  }

  private async publishAuthorCatalogExactSetSuccessorFromHistoryV1(
    this: DKGAgent,
    params: PublishAuthorCatalogExactSetSuccessorParamsV1,
    history: BoundedAuthorCatalogHistoryV1,
  ): Promise<PublishAuthorCatalogExactSetSuccessorResultV1> {
    const service = this.requireRfc64PublicCatalogServiceV1();
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(params.peers);
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 persistence is not available');
    }
    const scope = deriveAuthorCatalogScopeFromHeadV1(history.previousHead.payload);
    const heldPolicy = service.acceptedPolicySnapshotForCatalogScope(scope);
    const policyDigest = heldPolicy.policyDigest;
    if (heldPolicy.policy.accessPolicy === 1 && peers.length > 0) {
      throw new Error(
        'RFC-64 private catalog peer fan-out requires scope-bound private content transport',
      );
    }
    const authorAddress = params.author.address.toLowerCase() as EvmAddressV1;
    if (authorAddress !== scope.authorAddress) {
      throw new Error('RFC-64 successor author must equal the exact predecessor author');
    }
    if (
      params.catalogIssuerAuthorization.catalogIssuerDelegation.objectDigest
      !== history.previousHead.payload.catalogIssuerDelegationDigest
    ) {
      throw new Error(
        'RFC-64 successor authorization does not match the predecessor delegation digest',
      );
    }

    const producer = new Rfc64PublicCatalogSuccessorProducerV1({
      controlObjects: persistence.controlObjects,
      stageKaBundle: persistence.kaBundles.putKaBundle,
    });
    const produced = await producer.produceAndStageExactSet({
      previousHead: history.previousHead,
      previousDirectoryPath: history.previousDirectoryPath,
      previousBucket: history.previousBucket,
      assets: params.assets,
      deployment: params.deployment,
      issuedAt: params.issuedAt ?? (Date.now().toString() as TimestampMsV1),
      catalogSigner: {
        issuer: authorAddress,
        signDigest: (objectDigest) => params.author.signMessage(objectDigest),
      },
      catalogIssuerAuthorization: params.catalogIssuerAuthorization,
    });
    const head = produced.publication.head;
    const headKeys = produced.stagedControlObjects.objects.find(
      (keys) => keys.objectDigest === head.objectDigest,
    );
    const expectedSignatureVariantDigest = computeControlSignatureVariantDigestHex(
      head.objectDigest,
      head.signature,
    );
    if (
      headKeys === undefined
      || headKeys.signatureVariantDigest !== expectedSignatureVariantDigest
    ) {
      throw new Error('RFC-64 successor control store returned no exact durable head receipt');
    }
    const announcement: Rfc64PublicCatalogHeadAnnouncementV1 = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
      networkId: head.payload.networkId,
      contextGraphId: head.payload.contextGraphId,
      subGraphName: head.payload.subGraphName,
      authorAddress: head.payload.authorAddress,
      catalogEra: head.payload.era,
      catalogVersion: head.payload.version,
      policyDigest,
      catalogHeadObjectDigest: headKeys.objectDigest,
      signatureVariantDigest: headKeys.signatureVariantDigest,
    });
    const delivery = await service.announceCatalogHead({
      announcement,
      peers,
    });
    const catalogScope = Object.freeze({
      ...deriveAuthorCatalogScopeFromHeadV1(head.payload),
    }) as Readonly<AuthorCatalogScopeV1>;
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(catalogScope);
    const predecessorScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
    const signedBucketRowCount = produced.publication.bucket?.payload.rows.length.toString();
    if (
      signedBucketRowCount === undefined
      || signedBucketRowCount !== head.payload.totalRows
      || catalogScopeDigest !== predecessorScopeDigest
      || produced.assets.some(
        (asset) => asset.projection.catalogScopeDigest !== catalogScopeDigest,
      )
    ) {
      throw new Error('RFC-64 successor evidence differs from its verified signed catalog scope');
    }
    const assets = produced.assets.map((asset) => Object.freeze({
      kaId: asset.row.kaId,
      catalogRowDigest: asset.sealBinding.catalogRowDigest,
      bundleDigest: asset.bundleDigest,
      contentDigest: asset.projection.projectionDigest,
      sealDigest: asset.sealBinding.sealDigest,
      activatedTripleCount: countToSafeInteger(
        asset.projection.publicTripleCount,
        `RFC-64 successor asset ${asset.row.kaId} public triple count`,
      ),
      contentByteLength: asset.projection.projectionByteLength,
      bundleByteLength: asset.row.transfer.byteLength,
      kaUal: asset.projection.kaUal,
    }));
    return Object.freeze({
      announcement: delivery.announcement,
      headObjectDigest: headKeys.objectDigest,
      signatureVariantDigest: headKeys.signatureVariantDigest,
      catalogScope,
      catalogScopeDigest,
      signedBucketRowCount: signedBucketRowCount as CountV1,
      assets: Object.freeze(assets),
      inventoryRowCount: head.payload.totalRows,
      announcedPeers: delivery.announcedPeers,
      failedPeers: delivery.failedPeers,
    });
  }

  /**
   * Read a head back from the control-object store by its exact digests — the
   * "durably staged the exact head" proof. Returns null when not staged.
   */
  async readRfc64StagedAuthorCatalogHeadV1(
    this: DKGAgent,
    ref: Rfc64StagedAuthorCatalogHeadRefV1,
  ): Promise<Digest32V1 | null> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) return null;
    const stored = await persistence.controlObjects.getVerifiedObject({
      objectDigest: ref.objectDigest,
      signatureVariantDigest: ref.signatureVariantDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    return stored === null ? null : (stored.envelope.objectDigest as Digest32V1);
  }

  /** Read back the exact durably staged delegation returned by genesis publication. */
  async readRfc64StagedCatalogIssuerDelegationV1(
    this: DKGAgent,
    ref: Rfc64StagedCatalogIssuerDelegationRefV1,
  ): Promise<Digest32V1 | null> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) return null;
    const stored = await persistence.controlObjects.getVerifiedObject({
      objectDigest: ref.objectDigest,
      signatureVariantDigest: ref.signatureVariantDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    if (stored === null) return null;
    assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(stored.envelope);
    return stored.envelope.objectDigest as Digest32V1;
  }

  /** Read the exact durable applied-head record; returns null while dormant/missing. */
  readRfc64AppliedCatalogHeadV1(
    this: DKGAgent,
    ref: Rfc64AppliedCatalogHeadRefV1,
  ): AppliedCatalogHeadSnapshotV1 | null {
    return this.rfc64PersistenceV1?.inventory.readAppliedCatalogHeadV1(
      ref.catalogScopeDigest,
      ref.authorAddress,
    ) ?? null;
  }

  /**
   * Read the receiver's exact post-verification synchronization evidence for
   * one head in this process. Durable restart truth remains the applied-head
   * API above; this process-local record proves the semantic post-read that
   * immediately preceded that durable commit.
   */
  readRfc64PublicCatalogSynchronizationEvidenceV1(
    this: DKGAgent,
    catalogHeadDigest: Digest32V1,
  ): Rfc64PublicCatalogNativeSynchronizationEvidenceV1 | null {
    const evidence = this.rfc64PublicCatalogSynchronizationEvidenceV1.get(
      catalogHeadDigest,
    );
    return evidence === undefined ? null : Object.freeze({ ...evidence });
  }

  /**
   * Read the immutable process-local terminal failure for one announced head.
   * This is diagnostic evidence only; it is neither durable nor an input to
   * receiver retry, deduplication, reconciliation, or authorization decisions.
   */
  readRfc64PublicCatalogReconciliationFailureV1(
    this: DKGAgent,
    catalogHeadDigest: Digest32V1,
  ): Rfc64PublicCatalogReconciliationFailureV1 | null {
    const failure = this.rfc64PublicCatalogReconciliationFailuresV1.read(
      catalogHeadDigest,
    );
    return failure === null
      ? null
      : Object.freeze({
        catalogHeadDigest: failure.catalogHeadDigest,
        errorName: failure.errorName,
        errorCode: failure.errorCode,
      });
  }

  /** Read a fresh copy of one exact durably staged opaque KA bundle. */
  readRfc64StagedKaBundleV1(
    this: DKGAgent,
    bundleDigest: Digest32V1,
  ): Promise<Uint8Array | null> {
    return this.rfc64PersistenceV1?.kaBundles.readKaBundleByDigest(bundleDigest)
      ?? Promise.resolve(null);
  }

  /** Await the receiver scheduler draining all queued + in-flight fetch/stage work. */
  whenRfc64PublicCatalogReceiverIdleV1(this: DKGAgent): Promise<void> {
    const service = this.rfc64PublicCatalogServiceV1;
    return service === undefined ? Promise.resolve() : service.whenReceiverIdle();
  }

  rfc64PublicCatalogStatsV1(this: DKGAgent): Rfc64PublicCatalogServiceStatsV1 | null {
    return this.rfc64PublicCatalogServiceV1?.stats() ?? null;
  }

  private requireRfc64PublicCatalogServiceV1(this: DKGAgent): Rfc64PublicCatalogServiceV1 {
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error(
        'RFC-64 public catalog service is not available (agent not started or no dataDir)',
      );
    }
    return service;
  }

  /** Build native mode only when a local deployment source exists. */
  private createRfc64PublicCatalogNativeOptionsV1(
    this: DKGAgent,
  ): Rfc64PublicCatalogServiceNativeOptionsV1 | undefined {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) return undefined;
    if (
      this.config.rfc64CatalogDeploymentProfile === undefined
      && this.chain.chainId === 'none'
    ) {
      return undefined;
    }
    this.rfc64PublicCatalogSynchronizationEvidenceV1.clear();
    const resolveDeployment: Rfc64BoundedPublicRootCatalogDeploymentResolverV1 =
      (announcement, signal) => this.resolveRfc64CatalogDeploymentProfileV1(
        announcement.networkId,
        signal,
      );
    return Object.freeze({
      readCatalogObjectByDigest: async (objectDigest: Digest32V1) => {
        const stored = await persistence.controlObjects.getVerifiedObjectByDigest({
          objectDigest,
          verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
        });
        return stored?.envelope ?? null;
      },
      readKaBundleByDigest: persistence.kaBundles.readKaBundleByDigest,
      createReconciler: (clients: Readonly<Rfc64PublicCatalogReconcilerClientsV1>) => {
        const nativeReceiver = new Rfc64PublicCatalogNativeReceiverV1({
          headTransport: clients.headTransport,
          contentTransport: clients.contentTransport,
          controlObjects: persistence.controlObjects,
          inventory: persistence.inventory,
          kaBundles: persistence.kaBundles,
          store: this.store,
          transportTimeoutMs: clients.transportTimeoutMs,
        });
        const reconciler = createRfc64BoundedPublicRootCatalogNativeReconcilerV1({
          nativeReceiver: Object.freeze({
            synchronizeBoundedPublicRootCatalog: async (...args) => {
              const evidence = await nativeReceiver.synchronizeBoundedPublicRootCatalog(...args);
              this.rfc64PublicCatalogSynchronizationEvidenceV1.set(
                evidence.catalogHeadDigest,
                evidence,
              );
              return evidence;
            },
          }),
          inventory: persistence.inventory,
          resolveTrustedCatalogScope: clients.resolveTrustedCatalogScope,
          resolveDeployment,
          readStagedCatalogHead: async (announcement) => {
            const stored = await persistence.controlObjects.getVerifiedObject({
              objectDigest: announcement.catalogHeadObjectDigest,
              signatureVariantDigest: announcement.signatureVariantDigest,
              verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
            });
            if (stored === null) return null;
            assertSignedAuthorCatalogHeadEnvelopeV1(stored.envelope);
            const signatureVariantDigest = computeControlSignatureVariantDigestHex(
              stored.envelope.objectDigest,
              stored.envelope.signature,
            ) as Digest32V1;
            if (
              stored.envelope.objectDigest !== announcement.catalogHeadObjectDigest
              || signatureVariantDigest !== announcement.signatureVariantDigest
            ) {
              throw new Error(
                'RFC-64 control-object store returned a different staged head identity',
              );
            }
            return Object.freeze({
              envelope: stored.envelope,
              signatureVariantDigest,
            });
          },
        });
        const deploymentAwareReconciler: Rfc64PublicCatalogReceiverReconcilerV1 = {
          isHeadApplied: (announcement) => {
            this.assertRfc64CatalogNetworkMatchesTrustedSourceV1(announcement.networkId);
            return reconciler.isHeadApplied(announcement);
          },
          reconcileHead: (remotePeerId, announcement, signal) =>
            reconciler.reconcileHead(remotePeerId, announcement, signal),
        };
        return Object.freeze(deploymentAwareReconciler);
      },
    });
  }

  /** Reject a stale applied-head dedupe before trusting any durable row. */
  private assertRfc64CatalogNetworkMatchesTrustedSourceV1(
    this: DKGAgent,
    catalogNetworkId: NetworkIdV1,
  ): void {
    const trustedNetworkId = this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.chain.chainId;
    if (trustedNetworkId === 'none') {
      throw new Error(
        'RFC-64 native reconciliation requires a trusted chain or '
        + 'rfc64CatalogDeploymentProfile override',
      );
    }
    if (trustedNetworkId !== catalogNetworkId) {
      throw new Rfc64PublicCatalogNativeReceiverErrorV1(
        'catalog-native-receiver-authorization',
        'catalog network differs from the locally trusted deployment network',
      );
    }
  }

  /** Resolve only from the create-time snapshot or this node's chain adapter. */
  private async resolveRfc64CatalogDeploymentProfileV1(
    this: DKGAgent,
    catalogNetworkId: NetworkIdV1,
    signal: AbortSignal,
  ): Promise<CatalogSealDeploymentProfileV1> {
    if (signal.aborted) throw signal.reason;
    this.assertRfc64CatalogNetworkMatchesTrustedSourceV1(catalogNetworkId);
    let deployment = this.config.rfc64CatalogDeploymentProfile;
    if (deployment === undefined) {
      if (this.chain.chainId === 'none') {
        throw new Error(
          'RFC-64 native reconciliation requires a trusted chain or '
          + 'rfc64CatalogDeploymentProfile override',
        );
      }
      const [chainId, kav10Address] = await Promise.all([
        this.chain.getEvmChainId(),
        this.chain.getKnowledgeAssetsLifecycleAddress(),
      ]);
      if (signal.aborted) throw signal.reason;
      deployment = snapshotRfc64CatalogDeploymentProfileV1({
        networkId: this.chain.chainId as NetworkIdV1,
        assertedAtChainId: chainId.toString() as never,
        assertedAtKav10Address: kav10Address as EvmAddressV1,
      });
      if (deployment === undefined) {
        throw new Error('RFC-64 chain deployment profile resolution failed');
      }
    }
    return deployment;
  }
}

function countToSafeInteger(value: CountV1, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed.toString() !== value) {
    throw new Error(`${label} is outside the exact safe-integer evidence boundary`);
  }
  return parsed;
}

export interface BoundedAuthorCatalogHistoryV1 {
  readonly previousHead: SignedAuthorCatalogHeadEnvelopeV1;
  readonly previousDirectoryPath: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
  readonly previousBucket: SignedAuthorCatalogBucketEnvelopeV1 | null;
}

export async function loadBoundedAuthorCatalogHistoryV1(
  persistence: Rfc64PersistenceV1,
  ref: Rfc64StagedAuthorCatalogHeadRefV1,
): Promise<BoundedAuthorCatalogHistoryV1> {
  const storedHead = await persistence.controlObjects.getVerifiedObject({
    objectDigest: ref.objectDigest,
    signatureVariantDigest: ref.signatureVariantDigest,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  if (storedHead === null) throw new Error('RFC-64 predecessor head is not durably staged');
  assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
  const previousHead = storedHead.envelope;
  if (
    previousHead.payload.bucketCount !== '1'
    || previousHead.payload.directoryHeight !== '0'
    || BigInt(previousHead.payload.totalRows) > BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1)
  ) {
    throw new Error('RFC-64 predecessor is outside the bounded one-bucket successor slice');
  }

  const storedRoot = await persistence.controlObjects.getVerifiedObjectByDigest({
    objectDigest: previousHead.payload.directoryRootDigest,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  if (storedRoot === null) throw new Error('RFC-64 predecessor directory root is not staged');
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(
    storedRoot.envelope,
    previousHead.payload.bucketCount,
  );
  const root = storedRoot.envelope;
  const descriptor = root.payload.entries[0];
  if (descriptor === undefined || !('bucketDigest' in descriptor)) {
    throw new Error('RFC-64 predecessor root has no level-zero bucket descriptor');
  }
  if (descriptor.rowCount !== previousHead.payload.totalRows) {
    throw new Error('RFC-64 predecessor root row count does not match its head');
  }
  if (
    (previousHead.payload.totalRows === '0')
    !== (descriptor.bucketDigest === ZERO_DIGEST32_V1)
  ) {
    throw new Error('RFC-64 predecessor empty-bucket descriptor is inconsistent');
  }

  let previousBucket: SignedAuthorCatalogBucketEnvelopeV1 | null = null;
  if (descriptor.bucketDigest !== ZERO_DIGEST32_V1) {
    const storedBucket = await persistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: descriptor.bucketDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    if (storedBucket === null) throw new Error('RFC-64 predecessor bucket is not staged');
    assertSignedAuthorCatalogBucketEnvelopeV1(storedBucket.envelope);
    previousBucket = storedBucket.envelope;
    if (previousBucket.payload.rows.length !== Number(previousHead.payload.totalRows)) {
      throw new Error('RFC-64 predecessor bucket row count does not match its head');
    }
  }
  return Object.freeze({
    previousHead,
    previousDirectoryPath: Object.freeze([root]),
    previousBucket,
  });
}
