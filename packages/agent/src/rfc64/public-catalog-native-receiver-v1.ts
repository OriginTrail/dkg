// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded receiver for one public root-lane catalog bucket. The locally
 * accepted scope may be open or governed; root lane and one bucket are the
 * stable synchronization invariant.
 *
 * The supported vertical slice is intentionally narrow: one successor head,
 * one bucket with 1..1,024 rows, the root context-graph lane, and complete
 * bundles for every signed row.
 * Every network hop is RFC-64 catalog-native. Activation happens only after
 * signed head/path/bucket verification, transfer verification, canonical
 * projection verification, one atomic projection-plus-seal replace, exact
 * post-read, and a durable applied-head compare-and-swap.
 */

import {
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  ASSERTION_SEAL_PREDICATES,
  DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogHeadScopeBindingV1,
  assertAuthorCatalogScopeV1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertAuthorCatalogDirectoryNodeScopeBindingV1,
  assertCanonicalChainId,
  assertNetworkIdV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  contextGraphWorkspaceGraphUri,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  deriveAuthorCatalogScopeFromHeadV1,
  readVerifiedCatalogSealBindingV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  readVerifiedCgSharedProjectionBytesV1,
  readVerifiedCgSharedProjectionMetadataV1,
  readVerifiedTransferredCatalogBundleMetadataV1,
  verifyAuthorCatalogDirectoryPathV1,
  verifyCgSharedProjectionV1,
  verifyTransferredCatalogBundleV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type CountV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type KaIdV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
  type VerifiedCatalogSealBindingV1,
  type VerifiedCatalogSealBindingSnapshotV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import {
  quadsToNQuads,
  readExactGraphPaged,
  readExactGraphPagedWithDiscoveredCount,
  tryReplaceGraphAndSubjectAtomically,
  type Quad,
  type TripleStore,
  invalidateSwmMaterializationWitness,
} from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

import { parseNQuads } from '../dkg-agent-utils.js';
import { unpackKnowledgeAssetId } from '../ka-identity.js';
import { assertRfc64ExactIssuerSignatureProofV1 } from './catalog-transport-wire-v1-internal.js';
import {
  readVerifiedAuthorCatalogRowAuthorshipV1,
  verifyAuthorCatalogRowAuthorshipV1,
  type VerifiedAuthorCatalogRowAuthorshipV1,
  type VerifiedAuthorCatalogRowAuthorshipSnapshotV1,
} from './catalog-row-authorship.js';
import type { Rfc64ControlObjectOperationsV1 } from './control-object-store-v1.js';
import type {
  AppliedCatalogHeadSnapshotV1,
  Rfc64InventoryV1OperationsV1,
} from './inventory-v1/index.js';
import type { Rfc64KaBundleOperationsV1 } from './ka-bundle-store-v1.js';
import { assertRecoverableAuthorAttestationCapabilityV1 } from './recoverable-author-attestation-v1.js';
import {
  computeRfc64AppliedInventoryDigestV1,
  verifyRfc64PublicCatalogInventoryCompletenessV1,
  type Rfc64PublicCatalogInventoryEvidenceRowV1,
} from './public-catalog-inventory-completeness-v1.js';
import {
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
  assertRfc64PublicCatalogExactSetBundleBytesV1,
  type FetchedRfc64PublicCatalogObjectV1,
  type Rfc64PublicCatalogNativeFetchScopeV1,
  type Rfc64PublicCatalogNativeTransportV1,
} from './public-catalog-native-transport-v1.js';
import type {
  FetchedRfc64PublicCatalogHeadV1,
  Rfc64PublicCatalogHeadAnnouncementV1,
  Rfc64PublicCatalogTransportV1,
} from './public-catalog-transport-v1.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_TRANSITION_JOURNAL_ENTRIES_V1 = MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 * 2;
const MAX_TRANSITION_GRAPH_QUADS_V1 =
  DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxPublicTriples;
// Includes the graph IRI repeated on every materialized N-Quad, so it must be
// wider than the verified projection-byte ceiling while remaining finite.
const MAX_TRANSITION_GRAPH_NQUADS_BYTES_V1 = 256 * 1024 * 1024;
const MAX_TRANSITION_SEAL_SUBJECT_ROWS_V1 = 15;

export interface Rfc64PublicCatalogNativeReceiverOptionsV1 {
  /** Fetch-only capability; lifecycle ownership remains with the catalog service. */
  readonly headTransport: Pick<Rfc64PublicCatalogTransportV1, 'fetchCatalogHead'>;
  /** Fetch-only capability; lifecycle ownership remains with the catalog service. */
  readonly contentTransport: Pick<
    Rfc64PublicCatalogNativeTransportV1,
    'fetchCatalogObject' | 'fetchKaBundle'
  >;
  readonly controlObjects:
    Pick<Rfc64ControlObjectOperationsV1, 'stageVerifiedObjects' | 'getVerifiedObjectByDigest'>
    & Partial<Pick<Rfc64ControlObjectOperationsV1, 'getVerifiedObject'>>;
  readonly inventory: Pick<
    Rfc64InventoryV1OperationsV1,
    'readAppliedCatalogHeadV1' | 'compareAndSwapAppliedCatalogHeadV1'
  >;
  /** Durable immutable cache that makes every applied receiver a provider. */
  readonly kaBundles:
    Pick<Rfc64KaBundleOperationsV1, 'putKaBundle'>
    & Partial<Pick<Rfc64KaBundleOperationsV1, 'readKaBundleByDigest'>>;
  readonly store: TripleStore;
  /** Use the service's configured verifier for both network and cache paths. */
  readonly verifyIssuerSignature?: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  /**
   * Final fail-closed same-process barrier. It runs after the exact SWM
   * post-read and before the durable applied-head CAS. A rejection leaves the
   * head unapplied so a later synchronization can idempotently repair SWM and
   * any consumer-specific side effects performed by an earlier attempt.
   */
  readonly beforeAppliedHeadCommit?: Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1;
  readonly transportTimeoutMs?: number;
}

/** Bounded local resource telemetry. It contains no scope or provider identity. */
export interface Rfc64PublicCatalogNativeReceiverResourceStatsV1 {
  readonly controlObjectCacheHits: number;
  readonly controlObjectNetworkFetches: number;
  readonly kaBundleCacheHits: number;
  readonly kaBundleNetworkFetches: number;
  readonly kaBundleCacheBytes: number;
  readonly kaBundleNetworkBytes: number;
}

/** Process-local verified row capabilities withheld from serializable receiver evidence. */
export interface Rfc64PublicCatalogNativePrecommitRowPlanV1 {
  readonly authorship: VerifiedAuthorCatalogRowAuthorshipV1;
  readonly sealBinding: VerifiedCatalogSealBindingV1;
  /** Exact graph-neutral digest of the verified projection activated into SWM. */
  readonly publicQuadsDigest?: string;
}

/** Generic same-process barrier plan executed after semantic post-read and before head CAS. */
export interface Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1 {
  readonly catalogScope: Readonly<AuthorCatalogScopeV1>;
  /** Exact accepted-current generation that authorized every fetched byte. */
  readonly policyDigest: Digest32V1;
  readonly catalogHeadDigest: Digest32V1;
  readonly inventoryDigest: Digest32V1;
  /** Strictly increasing by mathematical KA ID. */
  readonly rows: readonly Readonly<Rfc64PublicCatalogNativePrecommitRowPlanV1>[];
}

export interface Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1 {
  (
    plan: Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1>,
    signal: AbortSignal,
  ): Promise<void | Rfc64PublicCatalogNativePrecommitTransactionV1>;
}

/** Side effects that become durable only when the catalog head CAS succeeds. */
export interface Rfc64PublicCatalogNativePrecommitTransactionV1 {
  /**
   * Finalize side effects only after the exact applied head is known durable.
   * Implementations may need an awaited post-commit cleanup (for example,
   * retiring the SWM staging twin of an already-finalized VM asset).
   */
  commit(): void | Promise<void>;
  rollback(cause?: unknown): Promise<void>;
}

export interface Rfc64PublicCatalogNativeActivationEvidenceV1 {
  /** Digest computed from the exact semantic projection+seal post-read. */
  readonly inventoryDigest: Digest32V1;
  readonly catalogHeadDigest: Digest32V1;
  readonly catalogRowDigest: Digest32V1;
  readonly contentDigest: Digest32V1;
  readonly bundleDigest: Digest32V1;
  readonly kaUal: string;
  readonly inventoryRowCount: 1;
  readonly activatedTripleCount: number;
  readonly swmGraph: string;
  /** Exact signed delegation/head/path/bucket/row authorization closure. */
  readonly authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
  /** Exact predecessor rows absent from this head and physically deactivated before its CAS. */
  readonly removedRows: readonly Readonly<Rfc64PublicCatalogNativeRemovedRowEvidenceV1>[];
  readonly removedRowCount: number;
  readonly appliedHeadStatus: 'applied' | 'existing';
}

export interface Rfc64PublicCatalogNativeRemovedRowEvidenceV1 {
  readonly kaId: KaIdV1;
  readonly swmGraph: string;
  readonly sealMetaGraph: string;
  readonly sealSubject: string;
}

export interface Rfc64PublicCatalogNativeActivatedRowEvidenceV1
  extends Rfc64PublicCatalogInventoryEvidenceRowV1 {
  readonly swmGraph: string;
  /** Exact signed delegation/head/path/bucket/row authorization closure. */
  readonly authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
}

/** Exact evidence for one bounded multi-asset successor inventory. */
export interface Rfc64PublicCatalogNativeMultiAssetActivationEvidenceV1 {
  readonly inventoryDigest: Digest32V1;
  readonly catalogHeadDigest: Digest32V1;
  readonly inventoryRowCount: number;
  readonly activatedTripleCount: number;
  /** Strictly increasing by mathematical KA ID. */
  readonly rows: readonly Readonly<Rfc64PublicCatalogNativeActivatedRowEvidenceV1>[];
  /** Exact predecessor rows absent from this head and physically deactivated before its CAS. */
  readonly removedRows: readonly Readonly<Rfc64PublicCatalogNativeRemovedRowEvidenceV1>[];
  readonly removedRowCount: number;
  readonly appliedHeadStatus: 'applied' | 'existing';
}

export type Rfc64PublicCatalogNativeSuccessorEvidenceV1 =
  | Rfc64PublicCatalogNativeActivationEvidenceV1
  | Rfc64PublicCatalogNativeMultiAssetActivationEvidenceV1;

/** Exact durable evidence for the canonical empty catalog bootstrap. */
export interface Rfc64PublicCatalogNativeGenesisEvidenceV1 {
  /** Digest of the exact empty applied inventory (zero rows). */
  readonly inventoryDigest: Digest32V1;
  readonly catalogHeadDigest: Digest32V1;
  readonly inventoryRowCount: 0;
  readonly activatedTripleCount: 0;
  readonly stagedObjectCount: 3;
  readonly appliedHeadStatus: 'applied' | 'existing';
}

export type Rfc64PublicCatalogNativeSynchronizationEvidenceV1 =
  | Rfc64PublicCatalogNativeGenesisEvidenceV1
  | Rfc64PublicCatalogNativeSuccessorEvidenceV1;

export type Rfc64PublicCatalogNativeReceiverErrorCodeV1 =
  | 'catalog-native-receiver-input'
  | 'catalog-native-receiver-not-found'
  | 'catalog-native-receiver-incomplete'
  | 'catalog-native-receiver-slice'
  | 'catalog-native-receiver-catalog'
  | 'catalog-native-receiver-authorization'
  | 'catalog-native-receiver-transfer'
  | 'catalog-native-receiver-activation'
  | 'catalog-native-receiver-history';

export class Rfc64PublicCatalogNativeReceiverErrorV1 extends Error {
  constructor(
    readonly code: Rfc64PublicCatalogNativeReceiverErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64PublicCatalogNativeReceiverErrorV1';
  }
}

export class Rfc64PublicCatalogNativeReceiverV1 {
  readonly #timeoutMs: number;
  readonly #verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  readonly #scopeSynchronizations = new Map<string, Promise<void>>();
  #controlObjectCacheHits = 0;
  #controlObjectNetworkFetches = 0;
  #kaBundleCacheHits = 0;
  #kaBundleNetworkFetches = 0;
  #kaBundleCacheBytes = 0;
  #kaBundleNetworkBytes = 0;

  constructor(private readonly options: Rfc64PublicCatalogNativeReceiverOptionsV1) {
    if (
      typeof options?.headTransport?.fetchCatalogHead !== 'function'
      || typeof options?.contentTransport?.fetchCatalogObject !== 'function'
      || typeof options?.contentTransport?.fetchKaBundle !== 'function'
      || typeof options.controlObjects?.stageVerifiedObjects !== 'function'
      || typeof options.controlObjects?.getVerifiedObjectByDigest !== 'function'
      || typeof options.inventory?.readAppliedCatalogHeadV1 !== 'function'
      || typeof options.inventory?.compareAndSwapAppliedCatalogHeadV1 !== 'function'
      || typeof options.kaBundles?.putKaBundle !== 'function'
      || typeof options.store?.query !== 'function'
      || (
        options.verifyIssuerSignature !== undefined
        && typeof options.verifyIssuerSignature !== 'function'
      )
      || (
        options.beforeAppliedHeadCommit !== undefined
        && typeof options.beforeAppliedHeadCommit !== 'function'
      )
    ) {
      fail('catalog-native-receiver-input', 'receiver dependencies are incomplete');
    }
    this.#verifyIssuerSignature =
      options.verifyIssuerSignature ?? verifyControlEnvelopeIssuerSignatureV1;
    const timeoutMs = options.transportTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      fail('catalog-native-receiver-input', 'transportTimeoutMs must be a positive safe integer');
    }
    this.#timeoutMs = timeoutMs;
  }

  resourceStats(): Readonly<Rfc64PublicCatalogNativeReceiverResourceStatsV1> {
    return Object.freeze({
      controlObjectCacheHits: this.#controlObjectCacheHits,
      controlObjectNetworkFetches: this.#controlObjectNetworkFetches,
      kaBundleCacheHits: this.#kaBundleCacheHits,
      kaBundleNetworkFetches: this.#kaBundleNetworkFetches,
      kaBundleCacheBytes: this.#kaBundleCacheBytes,
      kaBundleNetworkBytes: this.#kaBundleNetworkBytes,
    });
  }

  private async runBeforeAppliedHeadCommitV1(
    plan: Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1>,
    signal: AbortSignal | undefined,
    failureMessage: string,
    rollback?: (cause: unknown) => Promise<void>,
  ): Promise<Rfc64PublicCatalogNativePrecommitTransactionV1 | null> {
    const precommitSignal = signal ?? new AbortController().signal;
    let transaction: Rfc64PublicCatalogNativePrecommitTransactionV1 | null = null;
    try {
      throwIfAborted(precommitSignal);
      const returned = await this.options.beforeAppliedHeadCommit?.(
        Object.freeze(plan),
        precommitSignal,
      );
      if (returned !== undefined) {
        if (
          returned === null
          || typeof returned !== 'object'
          || typeof returned.commit !== 'function'
          || typeof returned.rollback !== 'function'
        ) {
          throw new TypeError('catalog applied-head precommit returned an invalid transaction');
        }
        transaction = returned;
      }
      throwIfAborted(precommitSignal);
      return transaction;
    } catch (cause) {
      const rollbackFailures: unknown[] = [];
      try {
        await transaction?.rollback(cause);
      } catch (rollbackCause) {
        rollbackFailures.push(rollbackCause);
      }
      try {
        await rollback?.(cause);
      } catch (rollbackCause) {
        rollbackFailures.push(rollbackCause);
      }
      if (rollbackFailures.length > 0) {
        fail(
          'catalog-native-receiver-activation',
          `${failureMessage}; exact rollback also failed`,
          new AggregateError([cause, ...rollbackFailures]),
        );
      }
      if (precommitSignal.aborted && cause === precommitSignal.reason) throw cause;
      fail('catalog-native-receiver-activation', failureMessage, cause);
    }
  }

  private async rollbackAppliedHeadPrecommitV1(
    transaction: Rfc64PublicCatalogNativePrecommitTransactionV1 | null,
    cause: unknown,
  ): Promise<void> {
    if (transaction === null) return;
    try {
      await transaction.rollback(cause);
    } catch (rollbackCause) {
      fail(
        'catalog-native-receiver-activation',
        'catalog applied-head failure could not restore exact precommit side effects',
        new AggregateError([cause, rollbackCause]),
      );
    }
  }

  async synchronizeOneBoundedPublicRootRow(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: AuthorCatalogScopeV1,
    deployment: CatalogSealDeploymentProfileV1,
    signal?: AbortSignal,
  ): Promise<Rfc64PublicCatalogNativeActivationEvidenceV1> {
    const trustedScope = snapshotTrustedBoundedPublicRootScope(
      trustedCatalogScope,
      announcement,
    );
    const trustedDeployment = snapshotTrustedDeployment(deployment, trustedScope);
    return this.withScopeSerialization(
      computeAuthorCatalogScopeDigestV1(trustedScope),
      async () => {
        const evidence = await this.synchronizeBoundedPublicRootCatalogSerialized(
          remotePeerId,
          announcement,
          trustedScope,
          trustedDeployment,
          'one-successor',
          signal,
        );
        if (evidence.inventoryRowCount !== 1 || !('catalogRowDigest' in evidence)) {
          fail('catalog-native-receiver-slice', 'one-row synchronization returned non-one-row evidence');
        }
        return evidence;
      },
    );
  }

  /**
   * Fetch and apply either the canonical empty genesis or one bounded
   * 1..1,024-row successor. This is the production-facing entrypoint for a fresh receiver:
   * callers do not need to seed durable history out of band.
   */
  async synchronizeBoundedPublicRootCatalog(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: AuthorCatalogScopeV1,
    deployment: CatalogSealDeploymentProfileV1,
    signal?: AbortSignal,
  ): Promise<Rfc64PublicCatalogNativeSynchronizationEvidenceV1> {
    const trustedScope = snapshotTrustedBoundedPublicRootScope(
      trustedCatalogScope,
      announcement,
    );
    const trustedDeployment = snapshotTrustedDeployment(deployment, trustedScope);
    return this.withScopeSerialization(
      computeAuthorCatalogScopeDigestV1(trustedScope),
      () => this.synchronizeBoundedPublicRootCatalogSerialized(
        remotePeerId,
        announcement,
        trustedScope,
        trustedDeployment,
        'any',
        signal,
      ),
    );
  }

  /** Fetch, fully verify, and durably initialize exactly one empty genesis. */
  async bootstrapEmptyBoundedPublicRootCatalog(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: AuthorCatalogScopeV1,
    deployment: CatalogSealDeploymentProfileV1,
    signal?: AbortSignal,
  ): Promise<Rfc64PublicCatalogNativeGenesisEvidenceV1> {
    const trustedScope = snapshotTrustedBoundedPublicRootScope(
      trustedCatalogScope,
      announcement,
    );
    const trustedDeployment = snapshotTrustedDeployment(deployment, trustedScope);
    return this.withScopeSerialization(
      computeAuthorCatalogScopeDigestV1(trustedScope),
      async () => {
        const evidence = await this.synchronizeBoundedPublicRootCatalogSerialized(
          remotePeerId,
          announcement,
          trustedScope,
          trustedDeployment,
          'genesis',
          signal,
        );
        if (evidence.inventoryRowCount !== 0 || !('stagedObjectCount' in evidence)) {
          fail('catalog-native-receiver-slice', 'genesis bootstrap returned successor evidence');
        }
        return evidence;
      },
    );
  }

  private async synchronizeBoundedPublicRootCatalogSerialized(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    deployment: CatalogSealDeploymentProfileV1,
    expected: 'any' | 'genesis' | 'one-successor',
    signal: AbortSignal | undefined,
  ): Promise<Rfc64PublicCatalogNativeSynchronizationEvidenceV1> {
    throwIfAborted(signal);
    const fetchedHead = await this.fetchCatalogHeadWithCacheV1(
      remotePeerId,
      announcement,
      signal,
    );
    if (fetchedHead === null) {
      fail('catalog-native-receiver-not-found', 'announced catalog head was not found');
    }
    const head = fetchedHead.envelope;
    assertFetchedHeadMatchesTrustedScope(head, trustedCatalogScope);
    if (expected === 'genesis' || (expected === 'any' && claimsGenesisHistory(head))) {
      return this.bootstrapEmptyBoundedPublicRootCatalogFetched(
        remotePeerId,
        announcement,
        trustedCatalogScope,
        fetchedHead,
        signal,
      );
    }
    if (expected === 'one-successor' && claimsGenesisHistory(head)) {
      fail('catalog-native-receiver-slice', 'one-row synchronization does not accept genesis');
    }
    if (expected === 'one-successor' && head.payload.totalRows !== '1') {
      fail('catalog-native-receiver-slice', 'one-row synchronization does not accept multi-row heads');
    }
    return this.synchronizeBoundedPublicRootCatalogFetched(
      remotePeerId,
      announcement,
      trustedCatalogScope,
      deployment,
      fetchedHead,
      signal,
    );
  }

  private async bootstrapEmptyBoundedPublicRootCatalogFetched(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    fetchedHead: FetchedRfc64PublicCatalogHeadV1,
    signal: AbortSignal | undefined,
  ): Promise<Rfc64PublicCatalogNativeGenesisEvidenceV1> {
    const head = fetchedHead.envelope;
    assertEmptyGenesisHead(head);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(trustedCatalogScope);
    const inventoryDigest = computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest,
      rows: [],
    });
    const current = this.options.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      head.payload.authorAddress,
    );
    const replay = assertEmptyGenesisHistory(current, head, inventoryDigest);
    const scope = nativeScope(announcement, trustedCatalogScope, head);
    const fetchedDelegation = await this.fetchDirectAuthorCatalogIssuerDelegation(
      remotePeerId,
      scope,
      head,
      trustedCatalogScope,
      signal,
    );
    // A self-signed head is not catalog authority. Persist it only after the
    // trusted author delegation above has bound this exact issuer and scope.
    await this.stageVerifiedControlObjectV1(
      fetchedHead,
      'authorized catalog head could not be staged for restart-safe recovery',
    );
    const fetchedDirectory = await this.fetchCatalogObjectWithCacheV1(
      remotePeerId,
      scope,
      AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      head.payload.directoryRootDigest,
      signal,
    );
    if (fetchedDirectory === null) {
      fail('catalog-native-receiver-not-found', 'genesis directory root was not found');
    }
    try {
      assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(
        fetchedDirectory.envelope,
        head.payload.bucketCount,
      );
      const directory = fetchedDirectory.envelope;
      assertAuthorCatalogDirectoryNodeScopeBindingV1(
        directory.payload,
        deriveAuthorCatalogScopeFromHeadV1(head.payload),
      );
      if (directory.issuer !== head.issuer) {
        throw new Error('genesis directory issuer differs from head');
      }
      const path = verifyAuthorCatalogDirectoryPathV1(head, [directory], '0' as never);
      const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(path, head);
      if (
        descriptor.bucketId !== '0'
        || descriptor.bucketDigest !== ZERO_DIGEST32_V1
        || descriptor.rowCount !== '0'
        || descriptor.byteLength !== '0'
      ) {
        throw new Error('genesis directory descriptor is not canonically empty');
      }
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'empty genesis directory is invalid', cause);
    }
    await this.stageVerifiedControlObjectV1(
      fetchedDirectory,
      'verified genesis directory could not be staged for restart-safe recovery',
    );

    try {
      await this.options.controlObjects.stageVerifiedObjects([
        fetchedDelegation,
        fetchedDirectory,
        fetchedHead,
      ]);
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'verified genesis objects could not be staged', cause);
    }

    const precommitTransaction = await this.runBeforeAppliedHeadCommitV1(
      Object.freeze({
        catalogScope: trustedCatalogScope,
        policyDigest: announcement.policyDigest,
        catalogHeadDigest: head.objectDigest as Digest32V1,
        inventoryDigest,
        rows: Object.freeze([]),
      }),
      signal,
      'catalog applied-head precommit rejected the exact empty inventory',
    );

    let appliedHeadStatus: 'applied' | 'existing';
    try {
      if (replay) {
        appliedHeadStatus = 'existing';
      } else {
        try {
          appliedHeadStatus = this.options.inventory.compareAndSwapAppliedCatalogHeadV1({
            catalogScopeDigest,
            authorAddress: head.payload.authorAddress,
            expectedCurrentCatalogHeadDigest: null,
            currentCatalogHeadDigest: head.objectDigest as Digest32V1,
            appliedInventoryDigest: inventoryDigest,
            catalogVersion: head.payload.version,
            inventoryRowCount: '0' as never,
          }).status;
        } catch (cause) {
          const reconciled = this.options.inventory.readAppliedCatalogHeadV1(
            catalogScopeDigest,
            head.payload.authorAddress,
          );
          if (!isExactEmptyGenesisSnapshot(reconciled, head, inventoryDigest)) {
            fail(
              'catalog-native-receiver-history',
              'genesis applied-head CAS lost to a different durable history',
              cause,
            );
          }
          appliedHeadStatus = 'existing';
        }
      }
      const postRead = this.options.inventory.readAppliedCatalogHeadV1(
        catalogScopeDigest,
        head.payload.authorAddress,
      );
      if (!isExactEmptyGenesisSnapshot(postRead, head, inventoryDigest)) {
        fail(
          'catalog-native-receiver-history',
          'empty genesis durable post-read differs in head, digest, version, or row count',
        );
      }
    } catch (cause) {
      await this.rollbackAppliedHeadPrecommitV1(precommitTransaction, cause);
      throw cause;
    }
    await precommitTransaction?.commit();
    return Object.freeze({
      inventoryDigest,
      catalogHeadDigest: head.objectDigest as Digest32V1,
      inventoryRowCount: 0 as const,
      activatedTripleCount: 0 as const,
      stagedObjectCount: 3 as const,
      appliedHeadStatus,
    });
  }

  private async synchronizeBoundedPublicRootCatalogFetched(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    deployment: CatalogSealDeploymentProfileV1,
    fetchedHead: FetchedRfc64PublicCatalogHeadV1,
    signal: AbortSignal | undefined,
  ): Promise<Rfc64PublicCatalogNativeSuccessorEvidenceV1> {
    const head = fetchedHead.envelope;
    const expectedRowCount = assertBoundedSuccessorHead(head);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(trustedCatalogScope);
    const currentAppliedHead = this.options.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      head.payload.authorAddress,
    );
    const historyDisposition = classifySuccessorHistory(
      currentAppliedHead,
      head,
      expectedRowCount,
    );
    const scope = nativeScope(announcement, trustedCatalogScope, head);
    const fetchedDelegation = await this.fetchDirectAuthorCatalogIssuerDelegation(
      remotePeerId,
      scope,
      head,
      trustedCatalogScope,
      signal,
    );
    // Keep authorization-incomplete network heads out of the durable cache.
    await this.stageVerifiedControlObjectV1(
      fetchedHead,
      'authorized catalog head could not be staged for restart-safe recovery',
    );

    const fetchedDirectory = await this.fetchCatalogObjectWithCacheV1(
      remotePeerId,
      scope,
      AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      head.payload.directoryRootDigest,
      signal,
    );
    if (fetchedDirectory === null) {
      fail('catalog-native-receiver-not-found', 'successor directory root was not found');
    }
    let directory: SignedAuthorCatalogDirectoryNodeEnvelopeV1;
    try {
      assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(
        fetchedDirectory.envelope,
        head.payload.bucketCount,
      );
      directory = fetchedDirectory.envelope;
      assertAuthorCatalogDirectoryNodeScopeBindingV1(
        directory.payload,
        deriveAuthorCatalogScopeFromHeadV1(head.payload),
      );
      if (directory.issuer !== head.issuer) throw new Error('directory issuer differs from head');
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'directory root is not bound to the successor head', cause);
    }
    await this.stageVerifiedControlObjectV1(
      fetchedDirectory,
      'verified successor directory could not be staged for restart-safe recovery',
    );

    let directoryPathProof: ReturnType<typeof verifyAuthorCatalogDirectoryPathV1>;
    let descriptor: ReturnType<typeof readVerifiedAuthorCatalogBucketDescriptorV1>;
    try {
      directoryPathProof = verifyAuthorCatalogDirectoryPathV1(head, [directory], '0' as never);
      descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(directoryPathProof, head);
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'successor directory path is invalid', cause);
    }
    if (
      descriptor.rowCount !== head.payload.totalRows
      || descriptor.bucketDigest === ZERO_DIGEST32_V1
    ) {
      fail(
        'catalog-native-receiver-slice',
        'bounded receiver requires one non-empty bucket containing the exact head row count',
      );
    }

    const fetchedBucket = await this.fetchCatalogObjectWithCacheV1(
      remotePeerId,
      scope,
      AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
      descriptor.bucketDigest,
      signal,
    );
    if (fetchedBucket === null) {
      fail('catalog-native-receiver-not-found', 'successor catalog bucket was not found');
    }
    let bucket: SignedAuthorCatalogBucketEnvelopeV1;
    try {
      assertSignedAuthorCatalogBucketEnvelopeV1(fetchedBucket.envelope);
      bucket = fetchedBucket.envelope;
      assertAuthorCatalogBucketScopeBindingV1(
        bucket.payload,
        deriveAuthorCatalogScopeFromHeadV1(head.payload),
      );
      if (
        bucket.issuer !== head.issuer
        || bucket.objectDigest !== descriptor.bucketDigest
        || bucket.payload.bucketId !== descriptor.bucketId
        || bucket.payload.rows.length !== expectedRowCount
        || bucket.payload.rows.length.toString() !== descriptor.rowCount
        || canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload).byteLength.toString()
          !== descriptor.byteLength
      ) {
        throw new Error('bucket differs from its verified directory descriptor');
      }
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'catalog bucket is not bound to its directory', cause);
    }
    await this.stageVerifiedControlObjectV1(
      fetchedBucket,
      'verified successor bucket could not be staged for restart-safe recovery',
    );
    try {
      assertRfc64PublicCatalogExactSetBundleBytesV1(
        bucket.payload.rows.map((row) => row.transfer.byteLength),
      );
    } catch (cause) {
      fail(
        'catalog-native-receiver-slice',
        'signed catalog exact set exceeds the V1 aggregate bundle-byte ceiling',
        cause,
      );
    }
    const preparedRows: Array<{
      readonly row: AuthorCatalogRowV1;
      readonly authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
      readonly authorshipCapability: VerifiedAuthorCatalogRowAuthorshipV1;
      readonly projectionMetadata: ReturnType<typeof readVerifiedCgSharedProjectionMetadataV1>;
      readonly sealBinding: VerifiedCatalogSealBindingSnapshotV1;
      readonly sealBindingCapability: VerifiedCatalogSealBindingV1;
      readonly projectionBytes: Uint8Array;
      readonly expectedEvidence: Rfc64PublicCatalogInventoryEvidenceRowV1;
    }> = [];
    for (const row of bucket.payload.rows) {
      throwIfAborted(signal);
      let authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
      let authorshipCapability: VerifiedAuthorCatalogRowAuthorshipV1;
      try {
        authorshipCapability = verifyAuthorCatalogRowAuthorshipV1({
          catalogIssuerDelegation: fetchedDelegation.envelope,
          catalogIssuerDelegationSignature: fetchedDelegation.issuerSignature,
          parentAuthorAgentEvidence: null,
          catalogHead: head,
          catalogHeadSignature: fetchedHead.issuerSignature,
          directoryPathEnvelopes: [directory],
          directoryPathSignatures: [fetchedDirectory.issuerSignature],
          directoryPathProof,
          catalogBucket: bucket,
          catalogBucketSignature: fetchedBucket.issuerSignature,
          targetKaId: row.kaId,
        });
        authorship = readVerifiedAuthorCatalogRowAuthorshipV1(authorshipCapability);
      } catch (cause) {
        fail(
          'catalog-native-receiver-authorization',
          `catalog row ${row.kaId} is not authorized by the exact direct-author delegation closure`,
          cause,
        );
      }

      const bundle = await this.fetchKaBundleWithCacheV1(
        remotePeerId,
        scope,
        row.transfer.blobDigest,
        row.transfer.byteLength,
        signal,
      );
      if (bundle === null) {
        fail(
          'catalog-native-receiver-incomplete',
          `catalog row ${row.kaId} names a KA bundle that the authorized provider cannot supply`,
        );
      }

      let projectionMetadata: ReturnType<typeof readVerifiedCgSharedProjectionMetadataV1>;
      let sealBinding: VerifiedCatalogSealBindingSnapshotV1;
      let sealBindingCapability: VerifiedCatalogSealBindingV1;
      let projectionBytes: Uint8Array;
      try {
        const transferred = verifyTransferredCatalogBundleV1(head, row, bundle, deployment);
        const transferredMetadata = readVerifiedTransferredCatalogBundleMetadataV1(
          transferred,
          head,
          row,
          deployment,
        );
        sealBindingCapability = transferredMetadata.catalogSealBinding;
        sealBinding = readVerifiedCatalogSealBindingV1(
          sealBindingCapability,
        );
        assertRecoverableAuthorAttestationCapabilityV1(sealBinding);
        const projection = verifyCgSharedProjectionV1(transferred, head, row, deployment);
        projectionMetadata = readVerifiedCgSharedProjectionMetadataV1(
          projection,
          transferred,
          head,
          row,
          deployment,
        );
        projectionBytes = readVerifiedCgSharedProjectionBytesV1(
          projection,
          transferred,
          head,
          row,
          deployment,
        );
      } catch (cause) {
        fail(
          'catalog-native-receiver-transfer',
          `KA bundle or shared projection verification failed for row ${row.kaId}`,
          cause,
        );
      }
      try {
        const receipt = await this.options.kaBundles.putKaBundle({
          blobDigest: row.transfer.blobDigest,
          bundleBytes: new Uint8Array(bundle),
        });
        if (
          receipt.durable !== true
          || receipt.blobDigest !== row.transfer.blobDigest
          || receipt.byteLength.toString() !== row.transfer.byteLength
        ) {
          throw new Error('KA-bundle store returned a different durable receipt');
        }
      } catch (cause) {
        fail(
          'catalog-native-receiver-catalog',
          `verified KA bundle for row ${row.kaId} could not be checkpointed`,
          cause,
        );
      }
      const expectedEvidence = Object.freeze({
        kaId: row.kaId,
        catalogRowDigest: projectionMetadata.catalogRowDigest,
        contentDigest: projectionMetadata.projectionDigest,
        sealDigest: sealBinding.sealDigest,
        bundleDigest: row.transfer.blobDigest,
        kaUal: projectionMetadata.kaUal,
        activatedTripleCount: Number(projectionMetadata.publicTripleCount),
      }) satisfies Rfc64PublicCatalogInventoryEvidenceRowV1;
      preparedRows.push(Object.freeze({
        row,
        authorship,
        authorshipCapability,
        projectionMetadata,
        sealBinding,
        sealBindingCapability,
        projectionBytes,
        expectedEvidence,
      }));
    }

    const expectedRows = preparedRows.map((prepared) => prepared.expectedEvidence);
    // Fail closed on exact count/order/UAL/content evidence before the first
    // semantic mutation. The second call below joins these expectations to
    // independent exact post-reads.
    try {
      verifyRfc64PublicCatalogInventoryCompletenessV1({
        catalogScope: trustedCatalogScope,
        expectedTotalRows: head.payload.totalRows as CountV1,
        expectedRows,
        observedRows: expectedRows,
      });
    } catch (cause) {
      fail(
        'catalog-native-receiver-catalog',
        'signed catalog rows do not form one exact bounded inventory',
        cause,
      );
    }

    // The durable applied-head points at the only catalog closure allowed to
    // own materialization removals. Reconstruct and re-authorize that exact
    // predecessor after every target row/bundle has verified, but before the
    // first semantic mutation. This also makes exact-head replay a repair path
    // for a prior indeterminate removal failure.
    // Every bounded successor is a complete signed exact set. A receiver with
    // no applied-head record can therefore initialize directly from the
    // authenticated current snapshot without replaying historical versions.
    // Existing receivers still reconstruct their exact durable predecessor so
    // only rows owned by that applied closure may be removed.
    const predecessorRows = historyDisposition === 'cold-bootstrap'
      ? Object.freeze([]) as readonly Readonly<AuthorCatalogRowV1>[]
      : historyDisposition === 'replay'
        // A fresh receiver may initialize directly from a bounded current
        // exact set and therefore has no obligation to stage version N-1.
        // On exact-head replay, the already-authenticated target closure is
        // itself the durable applied closure whose rows own any repair/removal
        // decision. Requiring target.previousHeadDigest here made the first
        // retry after a successful cold bootstrap fail despite exact durable
        // target state.
        ? Object.freeze(bucket.payload.rows.map((row) => Object.freeze({ ...row })))
        : await loadExactAppliedPredecessorRows(
          this.options.controlObjects,
          head,
          trustedCatalogScope,
          this.#verifyIssuerSignature,
        );
    if (historyDisposition === 'cold-bootstrap') {
      await assertColdBootstrapHasNoOmittedSemanticStateV1(
        this.options.store,
        trustedCatalogScope,
        preparedRows.map((prepared) => transitionLocationFromTarget(
          head,
          prepared.row,
          prepared.sealBinding,
        )),
      );
    }
    const targetKaIds = new Set(preparedRows.map(({ row }) => row.kaId));
    const plannedRemovals = predecessorRows
      .filter((row) => !targetKaIds.has(row.kaId))
      .map((row) => planOwnedRowRemoval(trustedCatalogScope, row));

    try {
      // Every exact bundle crossed its immutable durability barrier directly
      // after verification above. This preserves restart/failover progress
      // without making a staged-only head authoritative.
      await this.options.controlObjects.stageVerifiedObjects([
        fetchedDelegation,
        fetchedHead,
        fetchedDirectory,
        fetchedBucket,
      ]);
    } catch (cause) {
      fail(
        'catalog-native-receiver-catalog',
        'verified catalog objects or KA bundles could not be staged',
        cause,
      );
    }

    const transitionJournal = await snapshotSemanticTransitionV1(
      this.options.store,
      [
        ...plannedRemovals.map((removal) => transitionLocationFromRemoval(removal)),
        ...preparedRows.map((prepared) => transitionLocationFromTarget(
          head,
          prepared.row,
          prepared.sealBinding,
        )),
      ],
    );
    const removedRows: Rfc64PublicCatalogNativeRemovedRowEvidenceV1[] = [];
    const activatedRows: Rfc64PublicCatalogNativeActivatedRowEvidenceV1[] = [];
    const activatedPublicQuadsDigests: string[] = [];
    let completion!: ReturnType<typeof verifyRfc64PublicCatalogInventoryCompletenessV1>;
    let activatedTripleCount = 0;
    let semanticMutationAttempted = false;
    const restoreExactPredecessorAfterFailure = async (
      cause: unknown,
      failureStage: 'semantic transition' | 'catalog applied-head precommit',
    ): Promise<void> => {
      if (!semanticMutationAttempted) return;
      try {
        await restoreSemanticTransitionV1(this.options.store, transitionJournal);
      } catch (rollbackCause) {
        fail(
          'catalog-native-receiver-activation',
          `${failureStage} failed and its exact predecessor rollback also failed`,
          new AggregateError([cause, rollbackCause]),
        );
      }
    };
    try {
      for (const removal of plannedRemovals) {
        throwIfAborted(signal);
        semanticMutationAttempted = true;
        await deactivateExactOwnedPublicProjection(this.options.store, removal);
        removedRows.push(removal);
      }
      for (const prepared of preparedRows) {
        throwIfAborted(signal);
        semanticMutationAttempted = true;
        const activation = await activateExactPublicProjection(
          this.options.store,
          head,
          prepared.row,
          prepared.projectionMetadata.kaUal,
          prepared.projectionBytes,
          Number(prepared.projectionMetadata.publicTripleCount),
          prepared.sealBinding,
        );
        activatedRows.push(Object.freeze({
          ...activation.evidence,
          swmGraph: activation.swmGraph,
          authorship: prepared.authorship,
        }));
        activatedPublicQuadsDigests.push(activation.publicQuadsDigest);
      }
      completion = verifyRfc64PublicCatalogInventoryCompletenessV1({
        catalogScope: trustedCatalogScope,
        expectedTotalRows: head.payload.totalRows as CountV1,
        expectedRows,
        observedRows: activatedRows.map((row) => ({
          kaId: row.kaId,
          catalogRowDigest: row.catalogRowDigest,
          contentDigest: row.contentDigest,
          sealDigest: row.sealDigest,
          bundleDigest: row.bundleDigest,
          kaUal: row.kaUal,
          activatedTripleCount: row.activatedTripleCount,
        })),
      });
      activatedTripleCount = activatedRows.reduce(
        (total, row) => total + row.activatedTripleCount,
        0,
      );
      if (!Number.isSafeInteger(activatedTripleCount)) {
        fail(
          'catalog-native-receiver-activation',
          'total activated triple count is not a safe integer',
        );
      }
    } catch (cause) {
      await restoreExactPredecessorAfterFailure(cause, 'semantic transition');
      if (signal?.aborted && cause === signal.reason) throw cause;
      if (cause instanceof Rfc64PublicCatalogNativeReceiverErrorV1) throw cause;
      fail(
        'catalog-native-receiver-activation',
        'semantic transition failed after mutation began',
        cause,
      );
    }

    const precommitTransaction = await this.runBeforeAppliedHeadCommitV1(
      Object.freeze({
        catalogScope: trustedCatalogScope,
        policyDigest: announcement.policyDigest,
        catalogHeadDigest: head.objectDigest as Digest32V1,
        inventoryDigest: completion.inventoryDigest,
        rows: Object.freeze(preparedRows.map((prepared, index) => Object.freeze({
          authorship: prepared.authorshipCapability,
          sealBinding: prepared.sealBindingCapability,
          publicQuadsDigest: activatedPublicQuadsDigests[index]!,
        }))),
      }),
      signal,
      'catalog applied-head precommit rejected the exact activated inventory',
      (cause) => restoreExactPredecessorAfterFailure(
        cause,
        'catalog applied-head precommit',
      ),
    );

    let appliedHeadStatus: 'applied' | 'existing';
    let headCommitDisposition: 'predecessor' | 'target' | 'indeterminate' =
      historyDisposition === 'replay' ? 'target' : 'predecessor';
    let precommitFinalized = false;
    const finalizeTargetTransition = async (): Promise<void> => {
      if (precommitFinalized) return;
      // Set the fence before invoking operator code. A throwing commit hook
      // cannot make a known-durable target safe to roll back to its predecessor.
      precommitFinalized = true;
      await precommitTransaction?.commit();
    };
    const rollbackRejectedTransition = async (cause: unknown): Promise<void> => {
      const rollbackFailures: unknown[] = [];
      try {
        await this.rollbackAppliedHeadPrecommitV1(precommitTransaction, cause);
      } catch (rollbackCause) {
        rollbackFailures.push(rollbackCause);
      }
      try {
        await restoreExactPredecessorAfterFailure(cause, 'catalog applied-head precommit');
      } catch (rollbackCause) {
        rollbackFailures.push(rollbackCause);
      }
      if (rollbackFailures.length > 0) {
        fail(
          'catalog-native-receiver-activation',
          'rejected catalog head could not restore one exact SWM/VM predecessor',
          new AggregateError([cause, ...rollbackFailures]),
        );
      }
    };
    try {
      if (historyDisposition === 'replay') {
        if (currentAppliedHead!.appliedInventoryDigest !== completion.inventoryDigest) {
          fail(
            'catalog-native-receiver-history',
            'durable applied-head digest differs from exact semantic post-read',
          );
        }
        appliedHeadStatus = 'existing';
      } else {
        try {
          const casResult = this.options.inventory.compareAndSwapAppliedCatalogHeadV1({
            catalogScopeDigest,
            authorAddress: head.payload.authorAddress,
            expectedCurrentCatalogHeadDigest: historyDisposition === 'cold-bootstrap'
              ? null
              : head.payload.previousHeadDigest,
            currentCatalogHeadDigest: head.objectDigest as Digest32V1,
            appliedInventoryDigest: completion.inventoryDigest,
            catalogVersion: head.payload.version,
            inventoryRowCount: head.payload.totalRows,
          });
          headCommitDisposition = 'target';
          appliedHeadStatus = casResult.status;
        } catch (cause) {
          // The CAS adapter can throw after its durable write. Until its exact
          // state is read, predecessor rollback is unsafe.
          headCommitDisposition = 'indeterminate';
          let reconciled: ReturnType<
            typeof this.options.inventory.readAppliedCatalogHeadV1
          >;
          try {
            reconciled = this.options.inventory.readAppliedCatalogHeadV1(
              catalogScopeDigest,
              head.payload.authorAddress,
            );
          } catch (reconciliationCause) {
            fail(
              'catalog-native-receiver-history',
              'applied-head CAS outcome is indeterminate; target SWM/VM state is retained',
              new AggregateError([cause, reconciliationCause]),
            );
          }
          if (
            reconciled === null
            || reconciled.currentCatalogHeadDigest !== head.objectDigest
            || !isExactAppliedSuccessorSnapshot(
              reconciled,
              head,
              completion.inventoryDigest,
            )
          ) {
            headCommitDisposition = 'predecessor';
            fail(
              'catalog-native-receiver-history',
              'applied-head CAS lost outside the serialized receiver; semantic state requires repair',
              cause,
            );
          }
          headCommitDisposition = 'target';
          appliedHeadStatus = 'existing';
        }
      }
      // Once the exact target head is known durable, SWM and VM are the target
      // generation. Finalize that recovery unit before a diagnostic post-read:
      // a later read fault must never restore VM behind the committed head.
      await finalizeTargetTransition();
      const durablePostRead = this.options.inventory.readAppliedCatalogHeadV1(
        catalogScopeDigest,
        head.payload.authorAddress,
      );
      if (!isExactAppliedSuccessorSnapshot(
        durablePostRead,
        head,
        completion.inventoryDigest,
      )) {
        fail(
          'catalog-native-receiver-history',
          'successor durable post-read differs in head, digest, version, or exact row count',
        );
      }
    } catch (cause) {
      if (headCommitDisposition === 'predecessor') {
        await rollbackRejectedTransition(cause);
      } else {
        // A confirmed or possibly committed CAS fences predecessor rollback.
        // Keep both semantic journals on the target for exact durable repair.
        await finalizeTargetTransition();
      }
      throw cause;
    }

    if (activatedRows.length === 1) {
      const [only] = activatedRows;
      if (only === undefined) {
        fail('catalog-native-receiver-activation', 'one-row completion lost its activation row');
      }
      return Object.freeze({
        inventoryDigest: completion.inventoryDigest,
        catalogHeadDigest: head.objectDigest as Digest32V1,
        catalogRowDigest: only.catalogRowDigest,
        contentDigest: only.contentDigest,
        bundleDigest: only.bundleDigest,
        kaUal: only.kaUal,
        inventoryRowCount: 1 as const,
        activatedTripleCount: only.activatedTripleCount,
        swmGraph: only.swmGraph,
        authorship: only.authorship,
        removedRows: Object.freeze(removedRows),
        removedRowCount: removedRows.length,
        appliedHeadStatus,
      });
    }
    return Object.freeze({
      inventoryDigest: completion.inventoryDigest,
      catalogHeadDigest: head.objectDigest as Digest32V1,
      inventoryRowCount: activatedRows.length,
      activatedTripleCount,
      rows: Object.freeze(activatedRows),
      removedRows: Object.freeze(removedRows),
      removedRowCount: removedRows.length,
      appliedHeadStatus,
    });
  }

  private async fetchDirectAuthorCatalogIssuerDelegation(
    remotePeerId: string,
    scope: Rfc64PublicCatalogNativeFetchScopeV1,
    head: SignedAuthorCatalogHeadEnvelopeV1,
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    signal: AbortSignal | undefined,
  ): Promise<FetchedRfc64PublicCatalogObjectV1 & {
    readonly envelope: SignedAuthorCatalogIssuerDelegationEnvelopeV1;
  }> {
    let fetched: FetchedRfc64PublicCatalogObjectV1 | null;
    try {
      fetched = await this.fetchCatalogObjectWithCacheV1(
        remotePeerId,
        scope,
        AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
        head.payload.catalogIssuerDelegationDigest,
        signal,
      );
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      fail(
        'catalog-native-receiver-authorization',
        'catalog issuer delegation fetch or generic signature verification failed',
        cause,
      );
    }
    if (fetched === null) {
      fail('catalog-native-receiver-not-found', 'catalog issuer delegation was not found');
    }
    throwIfAborted(signal);
    try {
      assertRfc64ExactIssuerSignatureProofV1(
        fetched.envelope,
        fetched.issuerSignature,
      );
      assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(fetched.envelope);
      assertDirectAuthorCatalogIssuerDelegationBindingV1(
        fetched.envelope,
        head,
        trustedCatalogScope,
      );
    } catch (cause) {
      fail(
        'catalog-native-receiver-authorization',
        'catalog issuer delegation is not the exact direct-author authority for this head',
        cause,
      );
    }
    await this.stageVerifiedControlObjectV1(
      fetched,
      'verified catalog issuer delegation could not be staged for restart-safe recovery',
    );
    return Object.freeze({
      envelope: fetched.envelope,
      issuerSignature: fetched.issuerSignature,
    });
  }

  private async fetchCatalogHeadWithCacheV1(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    signal: AbortSignal | undefined,
  ): Promise<FetchedRfc64PublicCatalogHeadV1 | null> {
    const cached = this.options.controlObjects.getVerifiedObject === undefined
      ? await this.options.controlObjects.getVerifiedObjectByDigest({
        objectDigest: announcement.catalogHeadObjectDigest,
        verifyIssuerSignature: this.#verifyIssuerSignature,
      })
      : await this.options.controlObjects.getVerifiedObject({
        objectDigest: announcement.catalogHeadObjectDigest,
        signatureVariantDigest: announcement.signatureVariantDigest,
        verifyIssuerSignature: this.#verifyIssuerSignature,
      });
    if (cached !== null) {
      assertSignedAuthorCatalogHeadEnvelopeV1(cached.envelope);
      const signatureVariantDigest = computeControlSignatureVariantDigestHex(
        cached.envelope.objectDigest,
        cached.envelope.signature,
      );
      if (signatureVariantDigest === announcement.signatureVariantDigest) {
        this.#controlObjectCacheHits += 1;
        return Object.freeze({
          envelope: cached.envelope,
          issuerSignature: cached.issuerSignature,
        });
      }
    }
    this.#controlObjectNetworkFetches += 1;
    return this.options.headTransport.fetchCatalogHead(
      remotePeerId,
      announcement,
      { timeoutMs: this.#timeoutMs, signal },
    );
  }

  private async fetchCatalogObjectWithCacheV1(
    remotePeerId: string,
    scope: Rfc64PublicCatalogNativeFetchScopeV1,
    targetObjectType: string,
    targetObjectDigest: Digest32V1,
    signal: AbortSignal | undefined,
  ): Promise<FetchedRfc64PublicCatalogObjectV1 | null> {
    const cached = await this.options.controlObjects.getVerifiedObjectByDigest({
      objectDigest: targetObjectDigest,
      verifyIssuerSignature: this.#verifyIssuerSignature,
    });
    if (cached !== null && cached.envelope.objectType === targetObjectType) {
      this.#controlObjectCacheHits += 1;
      return Object.freeze({
        envelope: cached.envelope,
        issuerSignature: cached.issuerSignature,
      });
    }
    this.#controlObjectNetworkFetches += 1;
    return this.options.contentTransport.fetchCatalogObject(
      remotePeerId,
      {
        ...scope,
        kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
        targetObjectType,
        targetObjectDigest,
      },
      { timeoutMs: this.#timeoutMs, signal },
    );
  }

  private async fetchKaBundleWithCacheV1(
    remotePeerId: string,
    scope: Rfc64PublicCatalogNativeFetchScopeV1,
    blobDigest: Digest32V1,
    byteLength: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | null> {
    const cached = this.options.kaBundles.readKaBundleByDigest === undefined
      ? null
      : await this.options.kaBundles.readKaBundleByDigest(blobDigest);
    if (cached !== null) {
      this.#kaBundleCacheHits += 1;
      this.#kaBundleCacheBytes += cached.byteLength;
      return cached;
    }
    this.#kaBundleNetworkFetches += 1;
    const fetched = await this.options.contentTransport.fetchKaBundle(
      remotePeerId,
      {
        ...scope,
        kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
        blobDigest,
        byteLength: byteLength as never,
      },
      { timeoutMs: this.#timeoutMs, signal },
    );
    if (fetched !== null) this.#kaBundleNetworkBytes += fetched.byteLength;
    return fetched;
  }

  private async stageVerifiedControlObjectV1(
    object: FetchedRfc64PublicCatalogObjectV1 | FetchedRfc64PublicCatalogHeadV1,
    failureMessage: string,
  ): Promise<void> {
    try {
      await this.options.controlObjects.stageVerifiedObjects([object]);
    } catch (cause) {
      fail('catalog-native-receiver-catalog', failureMessage, cause);
    }
  }

  private async withScopeSerialization<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#scopeSynchronizations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#scopeSynchronizations.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#scopeSynchronizations.get(key) === tail) {
        this.#scopeSynchronizations.delete(key);
      }
    }
  }
}

function snapshotTrustedBoundedPublicRootScope(
  input: AuthorCatalogScopeV1,
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): Readonly<AuthorCatalogScopeV1> {
  const scope = Object.freeze({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    governanceChainId: input.governanceChainId,
    governanceContractAddress: input.governanceContractAddress,
    ownershipTransitionDigest: input.ownershipTransitionDigest,
    subGraphName: input.subGraphName,
    authorAddress: input.authorAddress,
    era: input.era,
    bucketCount: input.bucketCount,
  });
  try {
    assertAuthorCatalogScopeV1(scope);
    if (
      scope.subGraphName !== null
      || scope.bucketCount !== '1'
    ) {
      throw new Error('bounded public catalog synchronization requires the root one-bucket lane');
    }
    if (
      announcement.networkId !== scope.networkId
      || announcement.contextGraphId !== scope.contextGraphId
      || announcement.subGraphName !== scope.subGraphName
      || announcement.authorAddress !== scope.authorAddress
      || announcement.catalogEra !== scope.era
    ) {
      throw new Error('announcement differs from the locally trusted catalog scope');
    }
  } catch (cause) {
    fail(
      'catalog-native-receiver-authorization',
      'catalog request is not bound to the locally accepted bounded public root scope',
      cause,
    );
  }
  return scope;
}

function snapshotTrustedDeployment(
  input: CatalogSealDeploymentProfileV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
): Readonly<CatalogSealDeploymentProfileV1> {
  const deployment = Object.freeze({
    networkId: input.networkId,
    assertedAtChainId: input.assertedAtChainId,
    assertedAtKav10Address: input.assertedAtKav10Address,
  });
  try {
    assertNetworkIdV1(deployment.networkId);
    assertCanonicalChainId(deployment.assertedAtChainId, 'assertedAtChainId');
    if (
      !ethers.isAddress(deployment.assertedAtKav10Address)
      || deployment.assertedAtKav10Address !== deployment.assertedAtKav10Address.toLowerCase()
    ) {
      throw new Error('assertedAtKav10Address is not a canonical EVM address');
    }
    if (deployment.networkId !== trustedCatalogScope.networkId) {
      throw new Error('deployment network differs from the locally trusted catalog scope');
    }
  } catch (cause) {
    fail(
      'catalog-native-receiver-authorization',
      'locally resolved deployment is not bound to the accepted catalog scope',
      cause,
    );
  }
  return deployment;
}

function assertFetchedHeadMatchesTrustedScope(
  head: SignedAuthorCatalogHeadEnvelopeV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
): void {
  try {
    assertAuthorCatalogHeadScopeBindingV1(head.payload, trustedCatalogScope);
  } catch (cause) {
    fail(
      'catalog-native-receiver-authorization',
      'fetched catalog head differs from the locally accepted bounded public root scope',
      cause,
    );
  }
}

function claimsGenesisHistory(head: SignedAuthorCatalogHeadEnvelopeV1): boolean {
  return head.payload.version === '0' || head.payload.previousHeadDigest === null;
}

function assertEmptyGenesisHead(head: SignedAuthorCatalogHeadEnvelopeV1): void {
  if (
    head.payload.subGraphName !== null
    || head.payload.era !== '0'
    || head.payload.bucketCount !== '1'
    || head.payload.directoryHeight !== '0'
    || head.payload.totalRows !== '0'
    || head.payload.version !== '0'
    || head.payload.previousHeadDigest !== null
  ) {
    fail(
      'catalog-native-receiver-slice',
      'genesis bootstrap requires the canonical empty bounded public root catalog',
    );
  }
}

function assertEmptyGenesisHistory(
  current: AppliedCatalogHeadSnapshotV1 | null,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  inventoryDigest: Digest32V1,
): boolean {
  if (current === null) return false;
  if (!isExactEmptyGenesisSnapshot(current, head, inventoryDigest)) {
    fail(
      'catalog-native-receiver-history',
      'genesis cannot replace or diverge from existing durable applied history',
    );
  }
  return true;
}

function isExactEmptyGenesisSnapshot(
  current: AppliedCatalogHeadSnapshotV1 | null,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  inventoryDigest: Digest32V1,
): boolean {
  return current !== null
    && current.catalogScopeDigest === computeAuthorCatalogScopeDigestV1(
      deriveAuthorCatalogScopeFromHeadV1(head.payload),
    )
    && current.authorAddress === head.payload.authorAddress
    && current.currentCatalogHeadDigest === head.objectDigest
    && current.appliedInventoryDigest === inventoryDigest
    && current.catalogVersion === '0'
    && current.inventoryRowCount === '0';
}

type Rfc64SuccessorHistoryDispositionV1 =
  | 'cold-bootstrap'
  | 'monotonic-successor'
  | 'replay';

function classifySuccessorHistory(
  current: AppliedCatalogHeadSnapshotV1 | null,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  expectedRowCount: number,
): Rfc64SuccessorHistoryDispositionV1 {
  if (current === null) return 'cold-bootstrap';
  if (current.currentCatalogHeadDigest === head.objectDigest) {
    if (
      current.catalogVersion !== head.payload.version
      || current.inventoryRowCount !== expectedRowCount.toString()
    ) {
      fail('catalog-native-receiver-history', 'replayed head differs from its durable applied state');
    }
    return 'replay';
  }
  if (
    current.currentCatalogHeadDigest !== head.payload.previousHeadDigest
    || BigInt(current.catalogVersion) + 1n !== BigInt(head.payload.version)
  ) {
    fail(
      'catalog-native-receiver-history',
      'successor does not monotonically extend the durable current head',
    );
  }
  return 'monotonic-successor';
}

function assertBoundedSuccessorHead(head: SignedAuthorCatalogHeadEnvelopeV1): number {
  let totalRows = 0;
  try {
    totalRows = Number(BigInt(head.payload.totalRows));
  } catch {}
  if (
    head.payload.subGraphName !== null
    || head.payload.bucketCount !== '1'
    || head.payload.directoryHeight !== '0'
    || !Number.isSafeInteger(totalRows)
    || totalRows < 1
    || totalRows > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1
    || head.payload.version === '0'
    || head.payload.previousHeadDigest === null
  ) {
    fail(
      'catalog-native-receiver-slice',
      `bounded receiver requires 1..${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1} root-lane rows in one non-genesis successor bucket`,
    );
  }
  return totalRows;
}

function isExactAppliedSuccessorSnapshot(
  current: AppliedCatalogHeadSnapshotV1 | null,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  inventoryDigest: Digest32V1,
): boolean {
  return current !== null
    && current.catalogScopeDigest === computeAuthorCatalogScopeDigestV1(
      deriveAuthorCatalogScopeFromHeadV1(head.payload),
    )
    && current.authorAddress === head.payload.authorAddress
    && current.currentCatalogHeadDigest === head.objectDigest
    && current.appliedInventoryDigest === inventoryDigest
    && current.catalogVersion === head.payload.version
    && current.inventoryRowCount === head.payload.totalRows;
}

function nativeScope(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
  head: SignedAuthorCatalogHeadEnvelopeV1,
): Rfc64PublicCatalogNativeFetchScopeV1 {
  return Object.freeze({
    networkId: trustedCatalogScope.networkId,
    contextGraphId: trustedCatalogScope.contextGraphId,
    subGraphName: trustedCatalogScope.subGraphName,
    authorAddress: trustedCatalogScope.authorAddress,
    catalogEra: trustedCatalogScope.era,
    catalogVersion: head.payload.version,
    policyDigest: announcement.policyDigest,
    catalogHeadObjectDigest: head.objectDigest as Digest32V1,
  });
}

/** Gate 1 accepts only an author-signed issuer grant with no parent-agent hop. */
function assertDirectAuthorCatalogIssuerDelegationBindingV1(
  delegation: SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
): void {
  const left = delegation.payload;
  const right = head.payload;
  if (
    delegation.objectDigest !== right.catalogIssuerDelegationDigest
    || delegation.issuer !== left.authorAddress
    || left.authorAuthorityEvidenceDigest !== null
    || left.catalogIssuerKey !== head.issuer
  ) {
    throw new Error(
      'delegation digest, direct author issuer, null parent evidence, or catalog issuer key differs',
    );
  }
  if (
    left.networkId !== right.networkId
    || left.contextGraphId !== right.contextGraphId
    || left.governanceChainId !== right.governanceChainId
    || left.governanceContractAddress !== right.governanceContractAddress
    || left.ownershipTransitionDigest !== right.ownershipTransitionDigest
    || left.subGraphName !== right.subGraphName
    || left.authorAddress !== right.authorAddress
    || left.catalogEra !== right.era
  ) {
    throw new Error('delegation scope, governance tuple, author, lane, or era differs from head');
  }
  if (
    left.networkId !== trustedCatalogScope.networkId
    || left.contextGraphId !== trustedCatalogScope.contextGraphId
    || left.governanceChainId !== trustedCatalogScope.governanceChainId
    || left.governanceContractAddress !== trustedCatalogScope.governanceContractAddress
    || left.ownershipTransitionDigest !== trustedCatalogScope.ownershipTransitionDigest
    || left.subGraphName !== trustedCatalogScope.subGraphName
    || left.authorAddress !== trustedCatalogScope.authorAddress
    || left.catalogEra !== trustedCatalogScope.era
  ) {
    throw new Error('delegation differs from the locally trusted bounded public root catalog scope');
  }
  if (
    (left.catalogEra === '0') !== (left.previousDelegationDigest === null)
    || BigInt(right.issuedAt) < BigInt(left.effectiveAt)
    || BigInt(right.issuedAt) >= BigInt(left.expiresAt)
  ) {
    throw new Error('delegation history or half-open validity interval does not authorize head');
  }
}

async function loadExactAppliedPredecessorRows(
  controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'getVerifiedObjectByDigest'>,
  targetHead: SignedAuthorCatalogHeadEnvelopeV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
  verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>,
): Promise<readonly Readonly<AuthorCatalogRowV1>[]> {
  const predecessorDigest = targetHead.payload.previousHeadDigest;
  if (predecessorDigest === null) {
    fail('catalog-native-receiver-history', 'successor has no predecessor digest');
  }
  try {
    const storedHead = await controlObjects.getVerifiedObjectByDigest({
      objectDigest: predecessorDigest,
      verifyIssuerSignature,
    });
    if (storedHead === null) throw new Error('applied predecessor head is not staged');
    assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
    const predecessorHead = storedHead.envelope;
    if (
      predecessorHead.objectDigest !== predecessorDigest
      || predecessorHead.payload.version === targetHead.payload.version
      || BigInt(predecessorHead.payload.version) + 1n !== BigInt(targetHead.payload.version)
      || BigInt(predecessorHead.payload.totalRows) > BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1)
    ) {
      throw new Error('predecessor identity, version, or row bound differs from target history');
    }
    assertAuthorCatalogHeadScopeBindingV1(predecessorHead.payload, trustedCatalogScope);

    const storedDelegation = await controlObjects.getVerifiedObjectByDigest({
      objectDigest: predecessorHead.payload.catalogIssuerDelegationDigest,
      verifyIssuerSignature,
    });
    if (storedDelegation === null) throw new Error('predecessor delegation is not staged');
    assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(storedDelegation.envelope);
    assertDirectAuthorCatalogIssuerDelegationBindingV1(
      storedDelegation.envelope,
      predecessorHead,
      trustedCatalogScope,
    );

    const storedDirectory = await controlObjects.getVerifiedObjectByDigest({
      objectDigest: predecessorHead.payload.directoryRootDigest,
      verifyIssuerSignature,
    });
    if (storedDirectory === null) throw new Error('predecessor directory root is not staged');
    assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(
      storedDirectory.envelope,
      predecessorHead.payload.bucketCount,
    );
    const directory = storedDirectory.envelope;
    assertAuthorCatalogDirectoryNodeScopeBindingV1(
      directory.payload,
      deriveAuthorCatalogScopeFromHeadV1(predecessorHead.payload),
    );
    if (
      directory.objectDigest !== predecessorHead.payload.directoryRootDigest
      || directory.issuer !== predecessorHead.issuer
    ) {
      throw new Error('predecessor directory identity or issuer differs from its head');
    }
    const directoryPathProof = verifyAuthorCatalogDirectoryPathV1(
      predecessorHead,
      [directory],
      '0' as never,
    );
    const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(
      directoryPathProof,
      predecessorHead,
    );
    if (descriptor.rowCount !== predecessorHead.payload.totalRows) {
      throw new Error('predecessor directory row count differs from its head');
    }
    if (predecessorHead.payload.totalRows === '0') {
      if (
        descriptor.bucketDigest !== ZERO_DIGEST32_V1
        || descriptor.byteLength !== '0'
        || descriptor.rowCount !== '0'
      ) {
        throw new Error('empty predecessor descriptor is not canonical');
      }
      return Object.freeze([]);
    }
    if (descriptor.bucketDigest === ZERO_DIGEST32_V1) {
      throw new Error('non-empty predecessor has an empty bucket digest');
    }

    const storedBucket = await controlObjects.getVerifiedObjectByDigest({
      objectDigest: descriptor.bucketDigest,
      verifyIssuerSignature,
    });
    if (storedBucket === null) throw new Error('predecessor bucket is not staged');
    assertSignedAuthorCatalogBucketEnvelopeV1(storedBucket.envelope);
    const bucket = storedBucket.envelope;
    assertAuthorCatalogBucketScopeBindingV1(
      bucket.payload,
      deriveAuthorCatalogScopeFromHeadV1(predecessorHead.payload),
    );
    if (
      bucket.objectDigest !== descriptor.bucketDigest
      || bucket.issuer !== predecessorHead.issuer
      || bucket.payload.bucketId !== descriptor.bucketId
      || bucket.payload.rows.length.toString() !== descriptor.rowCount
      || canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload).byteLength.toString()
        !== descriptor.byteLength
    ) {
      throw new Error('predecessor bucket differs from its verified descriptor');
    }

    for (const row of bucket.payload.rows) {
      verifyAuthorCatalogRowAuthorshipV1({
        catalogIssuerDelegation: storedDelegation.envelope,
        catalogIssuerDelegationSignature: storedDelegation.issuerSignature,
        parentAuthorAgentEvidence: null,
        catalogHead: predecessorHead,
        catalogHeadSignature: storedHead.issuerSignature,
        directoryPathEnvelopes: [directory],
        directoryPathSignatures: [storedDirectory.issuerSignature],
        directoryPathProof,
        catalogBucket: bucket,
        catalogBucketSignature: storedBucket.issuerSignature,
        targetKaId: row.kaId,
      });
    }
    return Object.freeze(bucket.payload.rows.map((row) => Object.freeze({ ...row })));
  } catch (cause) {
    fail(
      'catalog-native-receiver-history',
      'exact applied predecessor catalog closure could not authorize removals',
      cause,
    );
  }
}

function planOwnedRowRemoval(
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
  row: Readonly<AuthorCatalogRowV1>,
): Readonly<Rfc64PublicCatalogNativeRemovedRowEvidenceV1> {
  const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1({
    contextGraphId: trustedCatalogScope.contextGraphId,
    subGraphName: trustedCatalogScope.subGraphName,
    authorAddress: trustedCatalogScope.authorAddress,
    assertionCoordinate: row.assertionCoordinate,
  });
  return Object.freeze({
    kaId: row.kaId,
    swmGraph: derivePublicSwmGraph(trustedCatalogScope.contextGraphId, row.kaId),
    sealMetaGraph: placement.metaGraph,
    sealSubject: placement.subject,
  });
}

interface Rfc64SemanticTransitionLocationV1 {
  readonly swmGraph: string;
  readonly sealMetaGraph: string;
  readonly sealSubject: string;
}

interface Rfc64SemanticTransitionPreimageV1
  extends Rfc64SemanticTransitionLocationV1 {
  readonly graphQuads: readonly Readonly<Quad>[];
  readonly sealQuads: readonly Readonly<Quad>[];
}

/**
 * Missing durable history is not proof that the semantic store is empty: a
 * process may have died after atomic activation and before the applied-head
 * CAS. Cold bootstrap is therefore allowed only when every materialization
 * already present for this exact author/root scope belongs to the fetched
 * target. Matching target rows are safe repair preimages; any omitted graph or
 * author-seal subject makes the successor fail closed before mutation/CAS.
 */
async function assertColdBootstrapHasNoOmittedSemanticStateV1(
  store: TripleStore,
  scope: Readonly<AuthorCatalogScopeV1>,
  targets: readonly Readonly<Rfc64SemanticTransitionLocationV1>[],
): Promise<void> {
  const allowedGraphs = new Set(targets.map((target) => target.swmGraph));
  const allowedSealSubjects = new Set(targets.map((target) => target.sealSubject));
  const swmPrefix = `${contextGraphWorkspaceGraphUri(scope.contextGraphId)}`
    + `/${scope.authorAddress}/`;
  let existingGraphs: string[];
  try {
    existingGraphs = store.listGraphsByPrefix === undefined
      ? (await store.listGraphs({ source: 'rfc64-cold-bootstrap-namespace-proof' }))
        .filter((graph) => graph.startsWith(swmPrefix))
      : await store.listGraphsByPrefix(
        swmPrefix,
        { source: 'rfc64-cold-bootstrap-namespace-proof' },
      );
  } catch (cause) {
    fail(
      'catalog-native-receiver-history',
      'cold bootstrap could not prove the author SWM namespace is exact',
      cause,
    );
  }
  if (
    existingGraphs.length > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1
    || existingGraphs.some((graph) => !allowedGraphs.has(graph))
  ) {
    fail(
      'catalog-native-receiver-history',
      'cold bootstrap found author SWM materialization omitted by the fetched exact head',
    );
  }

  const metaGraph = targets[0]?.sealMetaGraph;
  if (metaGraph === undefined) {
    fail('catalog-native-receiver-history', 'cold successor has no semantic target scope');
  }
  let sealSubjects;
  try {
    sealSubjects = await store.query(
      `SELECT DISTINCT ?s WHERE { GRAPH <${metaGraph}> { `
        + `?s <${ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS}> `
        + `${JSON.stringify(scope.authorAddress)} } } `
        + `LIMIT ${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 + 1}`,
      {
        source: 'rfc64-cold-bootstrap-namespace-proof',
        maxResponseBytes: 1024 * 1024,
      },
    );
  } catch (cause) {
    fail(
      'catalog-native-receiver-history',
      'cold bootstrap could not prove the author-seal namespace is exact',
      cause,
    );
  }
  if (
    sealSubjects.type !== 'bindings'
    || sealSubjects.bindings.length > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1
    || sealSubjects.bindings.some(({ s }) => typeof s !== 'string' || !allowedSealSubjects.has(s))
  ) {
    fail(
      'catalog-native-receiver-history',
      'cold bootstrap found author-seal materialization omitted by the fetched exact head',
    );
  }
}

function transitionLocationFromRemoval(
  removal: Readonly<Rfc64PublicCatalogNativeRemovedRowEvidenceV1>,
): Readonly<Rfc64SemanticTransitionLocationV1> {
  return Object.freeze({
    swmGraph: removal.swmGraph,
    sealMetaGraph: removal.sealMetaGraph,
    sealSubject: removal.sealSubject,
  });
}

function transitionLocationFromTarget(
  head: SignedAuthorCatalogHeadEnvelopeV1,
  row: Readonly<AuthorCatalogRowV1>,
  binding: VerifiedCatalogSealBindingSnapshotV1,
): Readonly<Rfc64SemanticTransitionLocationV1> {
  return Object.freeze({
    swmGraph: derivePublicSwmGraph(head.payload.contextGraphId, row.kaId),
    sealMetaGraph: binding.placement.metaGraph,
    sealSubject: binding.placement.subject,
  });
}

/**
 * Capture only the exact graph/subject pairs this verified transition may
 * mutate. The journal is deliberately in-memory: it closes returned-failure
 * consistency, while process-death recovery remains a Gate-4 durable protocol.
 */
async function snapshotSemanticTransitionV1(
  store: TripleStore,
  locations: readonly Readonly<Rfc64SemanticTransitionLocationV1>[],
): Promise<readonly Readonly<Rfc64SemanticTransitionPreimageV1>[]> {
  if (locations.length > MAX_TRANSITION_JOURNAL_ENTRIES_V1) {
    fail(
      'catalog-native-receiver-activation',
      `semantic transition exceeds ${MAX_TRANSITION_JOURNAL_ENTRIES_V1} exact preimages`,
    );
  }
  const journal: Rfc64SemanticTransitionPreimageV1[] = [];
  try {
    for (const location of locations) {
      const graphQuads = await readExactGraphPagedWithDiscoveredCount(
        store,
        location.swmGraph,
        {
          maxQuadCount: MAX_TRANSITION_GRAPH_QUADS_V1,
          maxNQuadsBytes: MAX_TRANSITION_GRAPH_NQUADS_BYTES_V1,
          outputGraph: location.swmGraph,
          queryOptions: { source: 'rfc64-public-catalog-transition-snapshot' },
        },
      );
      const sealQuads = await readExactSealSubjectRowsV1(
        store,
        location.sealMetaGraph,
        location.sealSubject,
        'rfc64-public-catalog-transition-snapshot',
      );
      journal.push(Object.freeze({
        ...location,
        graphQuads: Object.freeze(graphQuads.map((quad) => Object.freeze({ ...quad }))),
        sealQuads,
      }));
    }
  } catch (cause) {
    fail(
      'catalog-native-receiver-activation',
      'bounded exact semantic transition snapshot failed before mutation',
      cause,
    );
  }
  return Object.freeze(journal);
}

async function restoreSemanticTransitionV1(
  store: TripleStore,
  journal: readonly Readonly<Rfc64SemanticTransitionPreimageV1>[],
): Promise<void> {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const preimage = journal[index];
    if (preimage === undefined) continue;
    const restored = await tryReplaceGraphAndSubjectAtomically(
      store,
      preimage.swmGraph,
      preimage.graphQuads.map((quad) => ({ ...quad })),
      preimage.sealMetaGraph,
      preimage.sealSubject,
      preimage.sealQuads.map((quad) => ({ ...quad })),
      { source: 'rfc64-public-catalog-transition-rollback' },
    );
    if (!restored) {
      throw new Error('store lacks atomic graph/subject replacement during semantic rollback');
    }
    await assertExactSemanticTransitionPreimageV1(store, preimage);
  }
}

async function assertExactSemanticTransitionPreimageV1(
  store: TripleStore,
  preimage: Readonly<Rfc64SemanticTransitionPreimageV1>,
): Promise<void> {
  const [graphQuads, sealQuads] = await Promise.all([
    readExactGraphPaged(store, preimage.swmGraph, {
      expectedQuadCount: preimage.graphQuads.length,
      maxQuadCount: MAX_TRANSITION_GRAPH_QUADS_V1,
      maxNQuadsBytes: MAX_TRANSITION_GRAPH_NQUADS_BYTES_V1,
      outputGraph: preimage.swmGraph,
      queryOptions: { source: 'rfc64-public-catalog-transition-rollback-post-read' },
    }),
    readExactSealSubjectRowsV1(
      store,
      preimage.sealMetaGraph,
      preimage.sealSubject,
      'rfc64-public-catalog-transition-rollback-post-read',
    ),
  ]);
  if (
    canonicalQuadSetV1(graphQuads) !== canonicalQuadSetV1(preimage.graphQuads)
    || canonicalQuadSetV1(sealQuads) !== canonicalQuadSetV1(preimage.sealQuads)
  ) {
    throw new Error('semantic transition rollback post-read differs from its exact preimage');
  }
}

async function readExactSealSubjectRowsV1(
  store: TripleStore,
  metaGraph: string,
  subject: string,
  source: string,
): Promise<readonly Readonly<Quad>[]> {
  const result = await store.query(
    `SELECT ?p ?o WHERE { GRAPH <${metaGraph}> { <${subject}> ?p ?o } } `
      + `ORDER BY ?p ?o LIMIT ${MAX_TRANSITION_SEAL_SUBJECT_ROWS_V1 + 1}`,
    { source, maxResponseBytes: 64 * 1024 },
  );
  if (
    result.type !== 'bindings'
    || result.bindings.length > MAX_TRANSITION_SEAL_SUBJECT_ROWS_V1
  ) {
    throw new Error('exact transition seal subject exceeds its bounded row contract');
  }
  const quads = result.bindings.map((row) => {
    if (typeof row.p !== 'string' || typeof row.o !== 'string') {
      throw new Error('exact transition seal subject row is incomplete');
    }
    return Object.freeze({
      subject,
      predicate: row.p,
      object: row.o,
      graph: metaGraph,
    });
  });
  return Object.freeze(quads);
}

function canonicalQuadSetV1(quads: readonly Readonly<Quad>[]): string {
  return quadsToNQuads([...quads].sort(compareQuads));
}

async function deactivateExactOwnedPublicProjection(
  store: TripleStore,
  removal: Readonly<Rfc64PublicCatalogNativeRemovedRowEvidenceV1>,
): Promise<void> {
  let replaced: boolean;
  try {
    replaced = await tryReplaceGraphAndSubjectAtomically(
      store,
      removal.swmGraph,
      [],
      removal.sealMetaGraph,
      removal.sealSubject,
      [],
      { source: 'rfc64-public-catalog-native-deactivation' },
    );
  } catch (cause) {
    fail(
      'catalog-native-receiver-activation',
      `atomic SWM projection and author-seal removal failed for KA ${removal.kaId}`,
      cause,
    );
  }
  if (!replaced) {
    fail(
      'catalog-native-receiver-activation',
      'store lacks atomic named-graph and author-seal replacement for catalog removal',
    );
  }

  let graphExists: boolean;
  let sealRows;
  try {
    graphExists = await store.hasGraph(removal.swmGraph, {
      source: 'rfc64-public-catalog-native-removal-post-read',
    });
    sealRows = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${removal.sealMetaGraph}> { `
        + `<${removal.sealSubject}> ?p ?o } } LIMIT 1`,
      {
        source: 'rfc64-public-catalog-native-removal-post-read',
        maxResponseBytes: 4 * 1024,
      },
    );
  } catch (cause) {
    fail('catalog-native-receiver-activation', 'removed-row exact post-read failed', cause);
  }
  if (
    graphExists
    || sealRows.type !== 'bindings'
    || sealRows.bindings.length !== 0
  ) {
    fail(
      'catalog-native-receiver-activation',
      `removed KA ${removal.kaId} projection or author seal remains present`,
    );
  }
}

function derivePublicSwmGraph(contextGraphId: ContextGraphIdV1, kaId: KaIdV1): string {
  const identity = unpackKnowledgeAssetId(BigInt(kaId));
  return `${contextGraphWorkspaceGraphUri(contextGraphId)}`
    + `/${identity.agentAddress}/${identity.kaNumber.toString()}`;
}

async function activateExactPublicProjection(
  store: TripleStore,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  kaUal: string,
  projectionBytes: Uint8Array,
  expectedTripleCount: number,
  sealBinding: VerifiedCatalogSealBindingSnapshotV1,
): Promise<{
  readonly swmGraph: string;
  readonly publicQuadsDigest: string;
  readonly evidence: Rfc64PublicCatalogInventoryEvidenceRowV1;
}> {
  let projectionText: string;
  let quads;
  try {
    projectionText = UTF8.decode(projectionBytes);
    quads = parseNQuads(projectionText);
  } catch (cause) {
    fail('catalog-native-receiver-activation', 'verified projection could not be materialized', cause);
  }
  if (
    !Number.isSafeInteger(expectedTripleCount)
    || expectedTripleCount < 1
    || quads.length !== expectedTripleCount
    || quads.some((quad) => quad.graph !== '')
  ) {
    fail('catalog-native-receiver-activation', 'projection/parser triple count or graph scope changed');
  }
  const swmGraph = derivePublicSwmGraph(head.payload.contextGraphId, row.kaId);
  const graphQuads = quads.map((quad) => ({ ...quad, graph: swmGraph }));
  let replaced: boolean;
  try {
    replaced = await tryReplaceGraphAndSubjectAtomically(
      store,
      swmGraph,
      graphQuads,
      sealBinding.placement.metaGraph,
      sealBinding.placement.subject,
      [...sealBinding.sealRows],
      {
        source: 'rfc64-public-catalog-native-activation',
      },
    );
  } catch (cause) {
    fail(
      'catalog-native-receiver-activation',
      `atomic SWM projection and author-seal replace failed for ${kaUal}`,
      cause,
    );
  }
  if (!replaced) {
    fail(
      'catalog-native-receiver-activation',
      'store lacks atomic named-graph and author-seal replacement',
    );
  }
  // #2079: `derivePublicSwmGraph` resolves to the byte-identical URI the
  // catch-up materialization witness keys on, and this is a REPLACE — so the
  // count gate cannot see it, and a standing memo would certify content that is
  // gone. Activation merges its selected CGs into `syncContextGraphs`, so where
  // `rfc64PublicCatalog` is enabled the two lanes land on the same graph by
  // construction; and the catalog seal writes `{scope}/_meta` rather than the
  // SWM head, so the version guard does not intervene.
  //
  // This site was missed for four review rounds because the tripwire in
  // `swm-materialization-witness.ts` named `tryReplaceGraphAtomically`, and this
  // path uses `tryReplaceGraphAndSubjectAtomically`. That comment now names the
  // shape rather than one token.
  //
  // Best-effort, like every other invalidate: never fail an activation that has
  // already committed in order to drop a memo.
  await invalidateSwmMaterializationWitness(store, swmGraph, {
    source: 'rfc64-public-catalog-native-activation.witnessInvalidate',
  }).catch(() => {});

  let readBack;
  try {
    readBack = await readExactGraphPaged(store, swmGraph, {
      expectedQuadCount: expectedTripleCount,
      maxQuadCount: expectedTripleCount,
      maxNQuadsBytes: projectionBytes.byteLength,
      outputGraph: '',
      queryOptions: { source: 'rfc64-public-catalog-native-post-read' },
    });
  } catch (cause) {
    fail('catalog-native-receiver-activation', 'exact SWM post-read failed', cause);
  }
  if (`${quadsToNQuads(readBack)}\n` !== projectionText) {
    fail('catalog-native-receiver-activation', 'exact SWM post-read differs from verified projection');
  }
  await assertExactAuthorSealPostRead(store, sealBinding);
  return {
    swmGraph,
    publicQuadsDigest: workspacePublicQuadsDigest(graphQuads),
    evidence: Object.freeze({
      kaId: row.kaId,
      catalogRowDigest: sealBinding.catalogRowDigest,
      contentDigest: row.projectionDigest,
      sealDigest: sealBinding.sealDigest,
      bundleDigest: row.transfer.blobDigest,
      kaUal,
      activatedTripleCount: expectedTripleCount,
    }),
  };
}

async function assertExactAuthorSealPostRead(
  store: TripleStore,
  binding: VerifiedCatalogSealBindingSnapshotV1,
): Promise<void> {
  const expected = [...binding.sealRows].sort(compareQuads);
  let result;
  try {
    result = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${binding.placement.metaGraph}> { `
        + `<${binding.placement.subject}> ?p ?o } } ORDER BY ?p ?o `
        + `LIMIT ${expected.length + 1}`,
      {
        source: 'rfc64-public-catalog-native-seal-post-read',
        maxResponseBytes: 64 * 1024,
      },
    );
  } catch (cause) {
    fail('catalog-native-receiver-activation', 'exact author-seal post-read failed', cause);
  }
  if (result.type !== 'bindings' || result.bindings.length !== expected.length) {
    fail('catalog-native-receiver-activation', 'author-seal post-read cardinality changed');
  }
  const actual = result.bindings.map((row) => {
    if (typeof row.p !== 'string' || typeof row.o !== 'string') {
      fail('catalog-native-receiver-activation', 'author-seal post-read row is incomplete');
    }
    return {
      subject: binding.placement.subject,
      predicate: row.p,
      object: row.o,
      graph: binding.placement.metaGraph,
    };
  }).sort(compareQuads);
  const normalizedActual = actual.map(normalizeAuthorSealPostReadQuadV1);
  const normalizedExpected = expected.map(normalizeAuthorSealPostReadQuadV1);
  if (quadsToNQuads(normalizedActual) !== quadsToNQuads(normalizedExpected)) {
    fail(
      'catalog-native-receiver-activation',
      'author-seal post-read differs from verified seal',
    );
  }
}

function normalizeAuthorSealPostReadQuadV1(
  quad: Readonly<{ subject: string; predicate: string; object: string; graph: string }>,
): Readonly<{ subject: string; predicate: string; object: string; graph: string }> {
  let object = quad.object;
  if (
    quad.predicate === ASSERTION_SEAL_PREDICATES.KA_UAL
    && !object.startsWith('<')
  ) {
    object = `<${object}>`;
  } else if (quad.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT) {
    const match = /^"([^"]+)"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#dateTime>$/.exec(object);
    const instant = match === null ? Number.NaN : Date.parse(match[1]!);
    if (Number.isFinite(instant)) {
      object = `${JSON.stringify(new Date(instant).toISOString())}`
        + '^^<http://www.w3.org/2001/XMLSchema#dateTime>';
    }
  }
  return Object.freeze({ ...quad, object });
}

function compareQuads(
  left: { subject: string; predicate: string; object: string; graph: string },
  right: { subject: string; predicate: string; object: string; graph: string },
): number {
  return left.predicate.localeCompare(right.predicate)
    || left.object.localeCompare(right.object)
    || left.subject.localeCompare(right.subject)
    || left.graph.localeCompare(right.graph);
}

export function rfc64CatalogSignatureVariantDigestV1(
  envelope: SignedAuthorCatalogHeadEnvelopeV1,
): Digest32V1 {
  return computeControlSignatureVariantDigestHex(
    envelope.objectDigest,
    envelope.signature,
  ) as Digest32V1;
}

/**
 * Preserve the package-root receiver contract while keeping the pure
 * attestation capability free of receiver-specific error translation.
 */
export function assertRecoverableAuthorAttestationV1(
  binding: VerifiedCatalogSealBindingSnapshotV1,
): void {
  try {
    assertRecoverableAuthorAttestationCapabilityV1(binding);
  } catch (cause) {
    if (cause instanceof Rfc64PublicCatalogNativeReceiverErrorV1) throw cause;
    fail(
      'catalog-native-receiver-transfer',
      cause instanceof Error
        ? cause.message
        : 'author attestation does not recover the catalog author',
      cause,
    );
  }
}

function fail(
  code: Rfc64PublicCatalogNativeReceiverErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64PublicCatalogNativeReceiverErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}
