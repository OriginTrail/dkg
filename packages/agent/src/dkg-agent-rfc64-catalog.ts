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
  SYSTEM_CONTEXT_GRAPHS,
  ZERO_DIGEST32_V1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  createOperationContext,
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
import {
  resolveRpcUrls,
  verifyControlEnvelopeIssuerSignatureV1,
  type ContextGraphAuthorityReader,
  type ContextGraphAuthorityReaderCapability,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import type { Rfc64AuthorCatalogEip191SignerV1 } from './rfc64/author-catalog-producer.js';
import {
  RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1,
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
} from './rfc64/public-catalog-native-receiver-v1.js';
import { createRfc64FinalizedPolicyAgentPrecommitV1 } from './rfc64/finalized-policy-agent-precommit-v1.js';
import { createRfc64FinalizedVmAgentPrecommitV1 } from './rfc64/finalized-vm-agent-precommit-v1.js';
import {
  createRfc64CatalogAppliedHeadCoordinatorV1,
} from './rfc64/catalog-applied-head-coordinator-v1.js';
import type { Rfc64CatalogAppliedHeadEvidenceV1 } from
  './rfc64/finalized-swm-retirement-lifecycle-receipt-v1.js';
import {
  reduceRfc64CatalogSynchronizationEvidenceReplayV1,
  snapshotRfc64CatalogSynchronizationEvidenceV1,
  type Rfc64CatalogSynchronizationEvidenceV1,
} from './rfc64/catalog-synchronization-evidence-v1.js';
import {
  createRfc64BoundedPublicRootCatalogNativeReconcilerV1,
  type Rfc64BoundedPublicRootCatalogNativeReceiverClientV1,
  type Rfc64BoundedPublicRootCatalogDeploymentResolverV1,
} from './rfc64/public-catalog-native-reconciler-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import {
  type Rfc64PublicCatalogReconciliationFailureV1,
} from './rfc64/public-catalog-reconciliation-failure-v1.js';
import type { Rfc64PublicCatalogReceiverCompletionOutcomeV1 } from
  './rfc64/public-catalog-reconciliation-outcome-v1.js';
import {
  Rfc64PublicCatalogSuccessorProducerV1,
  type Rfc64PublicCatalogIssuerAuthorizationV1,
  type Rfc64PublicCatalogSuccessorAssetInputV1,
} from './rfc64/public-catalog-successor-producer-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  Rfc64PublicCatalogTransportErrorV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadReplayRequestV1,
} from './rfc64/public-catalog-transport-v1.js';
import { createRfc64CatalogNativeScopedReadProviderV1 } from './rfc64/catalog-native-scoped-read-provider-v1.js';
import {
  projectRfc64CatalogReceiverAuthorityV1,
  resolveRfc64CatalogResponsibilityAuthorityV1,
  type Rfc64CatalogAuthorityPolicyV1,
  type Rfc64CatalogExecutionPlanV1,
} from './rfc64/public-catalog-activation-config-v1.js';
import {
  Rfc64CatalogResponsibilityRegistryV1,
  resolveRfc64CatalogResponsibilityReasonV1,
  type Rfc64CatalogResponsibilitySelectionV1,
} from './rfc64/catalog-responsibility-registry-v1.js';
import {
  composeRfc64FinalizedCatalogAuthorityV1,
  composeRfc64RegisteredRosterVersionV1,
  composeRfc64UnregisteredCatalogAuthorityV1,
  parseRfc64AuthoritySnapshotV1,
  type Rfc64ReleaseNativeAuthoritySnapshotV1,
} from './rfc64/release-native-catalog-authority-v1.js';
import { readRfc64LegacySwmBoundaryCountV1 } from
  './rfc64/legacy-swm-boundary-v1.js';

/** Minimal EIP-191 EOA signer (ethers.Wallet-compatible) for author-catalog objects. */
export interface Rfc64CatalogAuthorSignerV1 {
  readonly address: string;
  signMessage(message: Uint8Array): Promise<string>;
}

/** Compatibility name retained for the legacy public/open authoring surface. */
export type Rfc64OpenCatalogAuthorSignerV1 = Rfc64CatalogAuthorSignerV1;

const RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1 =
  'https://dkg.network/ontology#rfc64RosterVersion';
const RFC64_PRIVATE_ROSTER_VERSION_RADIX_V1 = 10_000_000_000_000n;
const RFC64_OPERATIONAL_STATUS_HEAD_READ_CONCURRENCY_V1 = 8;

interface Rfc64OperationalAppliedHeadV1 {
  readonly snapshot: AppliedCatalogHeadSnapshotV1;
  readonly issuedAt: TimestampMsV1;
  readonly contextGraphId: string;
  readonly scopeKey: string;
}

async function loadRfc64OperationalAppliedHeadsV1(
  persistence: Rfc64PersistenceV1,
): Promise<readonly Readonly<Rfc64OperationalAppliedHeadV1>[]> {
  const snapshots = persistence.inventory.listAppliedCatalogHeadsV1();
  const loaded = await mapWithConcurrency(
    snapshots,
    RFC64_OPERATIONAL_STATUS_HEAD_READ_CONCURRENCY_V1,
    async (snapshot): Promise<Readonly<Rfc64OperationalAppliedHeadV1> | null> => {
      const stored = await persistence.controlObjects.getVerifiedObjectByDigest({
        objectDigest: snapshot.currentCatalogHeadDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      }).catch(() => null);
      if (stored === null) return null;
      try {
        assertSignedAuthorCatalogHeadEnvelopeV1(stored.envelope);
      } catch {
        return null;
      }
      const payload = stored.envelope.payload;
      return Object.freeze({
        snapshot,
        issuedAt: payload.issuedAt,
        contextGraphId: payload.contextGraphId,
        scopeKey: rfc64CatalogTargetScopeKeyV1({
          networkId: payload.networkId,
          contextGraphId: payload.contextGraphId,
          subGraphName: payload.subGraphName,
          authorAddress: payload.authorAddress,
          catalogEra: payload.era,
        }),
      });
    },
  );
  return Object.freeze(loaded.filter(
    (head): head is Readonly<Rfc64OperationalAppliedHeadV1> => head !== null,
  ));
}

function groupRfc64OperationalAppliedHeadsV1(
  heads: readonly Readonly<Rfc64OperationalAppliedHeadV1>[],
): ReadonlyMap<string, readonly Readonly<Rfc64OperationalAppliedHeadV1>[]> {
  const byContextGraph = new Map<string, Readonly<Rfc64OperationalAppliedHeadV1>[]>();
  for (const head of heads) {
    const grouped = byContextGraph.get(head.contextGraphId) ?? [];
    grouped.push(head);
    byContextGraph.set(head.contextGraphId, grouped);
  }
  return byContextGraph;
}

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
  Rfc64CatalogReconciliationTerminalErrorV1,
  type Rfc64CatalogReconciliationFailureCompletionV1,
  type Rfc64CatalogReconciliationFailureOutcomeV1,
  type Rfc64CatalogReconciliationTerminalReasonV1,
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
  /** Complete 0..1024-row live set; input order does not affect the signed head. */
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

export interface Rfc64CatalogRuntimeSelectionStatusV1 {
  readonly subscriptionDriven: boolean;
  readonly eligibleContextGraphs: readonly string[];
  readonly selectedContextGraphs: readonly string[];
}

export type Rfc64CatalogOperationalPhaseV1 =
  | 'inactive'
  | 'resolving-authority'
  | 'bootstrapping'
  | 'applying'
  | 'blocked'
  | 'known-incomplete'
  | 'unknown-freshness'
  | 'complete';

export interface Rfc64CatalogOperationalStatusV1 {
  readonly contextGraphId: string;
  readonly responsibilityReason: Rfc64CatalogResponsibilitySelectionV1['responsibilityReason'];
  readonly selectionSource: Rfc64CatalogResponsibilitySelectionV1['selectionSource'];
  readonly effectiveMode: Rfc64CatalogResponsibilitySelectionV1['mode'];
  /** Exact accepted policy bits; null until current authority resolves. */
  readonly accessPolicy: 0 | 1 | null;
  readonly publishPolicy: 0 | 1 | null;
  /** True only for the explicit rollback lanes that may run legacy SWM sync. */
  readonly legacySyncAllowed: boolean;
  readonly phase: Rfc64CatalogOperationalPhaseV1;
  readonly authorityState: 'inactive' | 'resolving' | 'accepted' | 'blocked';
  readonly policySource: Rfc64ReleaseNativeAuthoritySnapshotV1['source'] | 'compatibility-seed' | null;
  readonly policyDigest: Digest32V1 | null;
  readonly authorityEra: DecimalU64V1 | null;
  readonly authorityFreshness: 'current' | 'unknown' | null;
  readonly catalogServiceStarted: boolean;
  readonly expectedCatalogHeadDigest: Digest32V1 | null;
  readonly appliedCatalogHeadDigest: Digest32V1 | null;
  readonly expectedInventoryDigest: Digest32V1 | null;
  readonly appliedInventoryDigest: Digest32V1 | null;
  readonly expectedRowCount: string | null;
  readonly appliedRowCount: string | null;
  readonly missingRowCount: string | null;
  /** Pre-10.0.16 SWM heads awaiting an explicit normal share/update. */
  readonly legacyReadOnlyCount: number;
  readonly catalogVersion: DecimalU64V1 | null;
  readonly authorHeadCount: number;
  readonly lastSuccessfulAdvanceAt: TimestampMsV1 | null;
  /** Per-CG authenticated target count plus process-wide receiver counters. */
  readonly providerHealth: Readonly<{
    candidateCount: number | null;
    attempts: number;
    switches: number;
    successes: number;
    backoffMs: number;
  }>;
  readonly stableReason: string | null;
}

interface Rfc64CatalogAuthorityProgressV1 {
  readonly state: 'resolving' | 'accepted' | 'blocked';
  readonly source: Rfc64ReleaseNativeAuthoritySnapshotV1['source'] | null;
  readonly policyDigest: Digest32V1 | null;
  readonly policyEra: DecimalU64V1 | null;
  readonly reason: string | null;
  readonly updatedAtMs: number;
}

const rfc64CatalogResponsibilityRegistriesV1 =
  new WeakMap<DKGAgent, Rfc64CatalogResponsibilityRegistryV1>();
const rfc64CatalogResponsibilityRevisionsV1 =
  new WeakMap<DKGAgent, Map<string, number>>();
const rfc64CatalogResponsibilityPendingV1 =
  new WeakMap<DKGAgent, Map<string, Promise<Rfc64CatalogResponsibilitySelectionV1>>>();
const rfc64CatalogAuthorityProgressV1 =
  new WeakMap<DKGAgent, Map<string, Rfc64CatalogAuthorityProgressV1>>();
const rfc64CatalogAuthorityRevisionsV1 =
  new WeakMap<DKGAgent, Map<string, number>>();
const rfc64DirectAcceptedCompatibilityV1 = new WeakMap<DKGAgent, Set<string>>();
const rfc64SystemContextGraphIdsV1 = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));
const RFC64_CATALOG_REPLAY_MAX_QUEUED_V1 = 64;
const RFC64_CATALOG_REPLAY_MAX_QUEUED_PER_PEER_V1 = 4;
export const RFC64_CATALOG_TARGET_MAX_ENTRIES_V1 = 1_024;
export const RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 = 64;
export const RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1 = 64;

interface Rfc64CatalogReplayHeadV1 {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
}

interface Rfc64CatalogReplayRuntimeV1 {
  tail: Promise<void>;
  readonly pending: Map<string, Promise<Readonly<Rfc64CatalogReplayResultV1>>>;
  readonly pendingByPeer: Map<string, number>;
  indexFingerprint: string | null;
  indexByScope: ReadonlyMap<string, readonly Rfc64CatalogReplayHeadV1[]>;
}

interface Rfc64CatalogReplayResultV1 {
  readonly announced: number;
  readonly failed: number;
  readonly manifest: readonly Rfc64PublicCatalogHeadAnnouncementV1[];
}

function rfc64CatalogReplayInventoryFingerprintV1(
  snapshots: readonly AppliedCatalogHeadSnapshotV1[],
): string {
  return snapshots
    .map((snapshot) => [
      snapshot.catalogScopeDigest,
      snapshot.authorAddress,
      snapshot.currentCatalogHeadDigest,
      snapshot.appliedInventoryDigest,
      snapshot.catalogVersion,
      snapshot.inventoryRowCount,
    ].join(':'))
    .sort()
    .join('\n');
}

type Rfc64CatalogReplayAdmissionV1 = Readonly<{
  status: 'admitted';
  /** True only for the caller that created and owns the unique completion. */
  newlyQueued: boolean;
  completion: Promise<Readonly<Rfc64CatalogReplayResultV1>>;
}> | Readonly<{
  status: 'busy';
}>;

const rfc64CatalogReplayRuntimesV1 = new WeakMap<DKGAgent, Rfc64CatalogReplayRuntimeV1>();

interface Rfc64CatalogReplayProgressV1 {
  readonly policyDigest: Digest32V1;
  readonly pendingPeers: Set<string>;
  token: number;
  active: boolean;
  failed: boolean;
  completion: Promise<Readonly<{ requested: number; failed: number }>> | null;
}

const rfc64CatalogReplayProgressV1 =
  new WeakMap<DKGAgent, Map<string, Rfc64CatalogReplayProgressV1>>();
const rfc64CatalogReplayStatusRevisionV1 = new WeakMap<DKGAgent, number>();

function bumpRfc64CatalogReplayStatusRevisionV1(agent: DKGAgent): void {
  rfc64CatalogReplayStatusRevisionV1.set(
    agent,
    (rfc64CatalogReplayStatusRevisionV1.get(agent) ?? 0) + 1,
  );
}

function rfc64CatalogReplayProgressForV1(
  agent: DKGAgent,
  contextGraphId: string,
  policyDigest: Digest32V1,
): Rfc64CatalogReplayProgressV1 {
  let byContextGraph = rfc64CatalogReplayProgressV1.get(agent);
  if (byContextGraph === undefined) {
    byContextGraph = new Map();
    rfc64CatalogReplayProgressV1.set(agent, byContextGraph);
  }
  let progress = byContextGraph.get(contextGraphId);
  if (progress === undefined || progress.policyDigest !== policyDigest) {
    progress = {
      policyDigest,
      pendingPeers: new Set(),
      token: 0,
      active: false,
      failed: false,
      completion: null,
    };
    byContextGraph.set(contextGraphId, progress);
  }
  return progress;
}

function clearRfc64CatalogReplayProgressV1(
  agent: DKGAgent,
  contextGraphId: string,
): void {
  if (rfc64CatalogReplayProgressV1.get(agent)?.delete(contextGraphId) === true) {
    bumpRfc64CatalogReplayStatusRevisionV1(agent);
  }
}

interface Rfc64CatalogTrackedTargetV1 {
  announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  terminalFailure: boolean;
}

interface Rfc64CatalogTargetOverflowV1 {
  active: number;
  readonly failureWitnesses: Map<string, Rfc64PublicCatalogHeadAnnouncementV1>;
  /** CG-owned saturation can be released only when that authority generation resets. */
  readonly saturatedContextGraphs: Set<string>;
  /** Lost attribution is fail-closed until the whole tracker reaches a reset boundary. */
  unattributedSaturation: boolean;
}

interface Rfc64CatalogTargetContextEpochV1 {
  valid: boolean;
  activeLeases: number;
}

interface Rfc64CatalogTargetLeaseStateV1 {
  active: boolean;
  readonly contextEpoch: Rfc64CatalogTargetContextEpochV1;
  readonly overflow: Rfc64CatalogTargetOverflowV1 | null;
}

export type Rfc64CatalogTargetLeaseV1 = Readonly<{
  announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  disposition: 'tracked' | 'covered' | 'context-capacity' | 'global-capacity';
  /** Opaque exactly-once settlement state owned by the tracker. */
  state: Rfc64CatalogTargetLeaseStateV1;
}>;

/** Process-local, bounded operational targets; semantic truth remains the durable inventory. */
export class Rfc64CatalogTargetTrackerV1 {
  readonly #byContextGraph =
    new Map<string, Map<string, Rfc64CatalogTrackedTargetV1>>();
  readonly #contextGraphOverflows = new Map<string, Rfc64CatalogTargetOverflowV1>();
  readonly #contextEpochs = new Map<string, Rfc64CatalogTargetContextEpochV1>();
  #globalOverflow: Rfc64CatalogTargetOverflowV1 | null = null;
  #size = 0;

  get size(): number {
    return this.#size;
  }

  targetsForContextGraph(
    contextGraphId: string,
  ): readonly Rfc64PublicCatalogHeadAnnouncementV1[] {
    return Object.freeze(
      [...this.#byContextGraph.get(contextGraphId)?.values() ?? []]
        .map(({ announcement }) => announcement),
    );
  }

  hasTerminalFailure(announcement: Rfc64PublicCatalogHeadAnnouncementV1): boolean {
    const entry = this.#byContextGraph
      .get(announcement.contextGraphId)
      ?.get(rfc64CatalogTargetScopeKeyV1(announcement));
    return entry !== undefined
      && rfc64CatalogTargetExactIdentityV1(entry.announcement, announcement)
      && entry.terminalFailure;
  }

  capacityExceededForContextGraph(contextGraphId: string): boolean {
    return this.#globalOverflow !== null
      || this.#contextGraphOverflows.has(contextGraphId);
  }

  /** Invalidate every outstanding lease and release all process-local target evidence. */
  resetAll(): void {
    for (const contextEpoch of this.#contextEpochs.values()) contextEpoch.valid = false;
    this.#contextEpochs.clear();
    this.#byContextGraph.clear();
    this.#contextGraphOverflows.clear();
    this.#globalOverflow = null;
    this.#size = 0;
  }

  clearContextGraph(contextGraphId: string): number {
    const byScope = this.#byContextGraph.get(contextGraphId);
    const contextEpoch = this.#contextEpochs.get(contextGraphId);
    if (contextEpoch !== undefined) {
      contextEpoch.valid = false;
      this.#contextEpochs.delete(contextGraphId);
    }
    this.#contextGraphOverflows.delete(contextGraphId);
    if (this.#globalOverflow !== null) {
      for (const [identity, witness] of this.#globalOverflow.failureWitnesses) {
        if (witness.contextGraphId === contextGraphId) {
          this.#globalOverflow.failureWitnesses.delete(identity);
        }
      }
      this.#globalOverflow.saturatedContextGraphs.delete(contextGraphId);
      this.#finishOverflowIfResolved(this.#globalOverflow, null);
    }
    if (byScope !== undefined) {
      this.#byContextGraph.delete(contextGraphId);
      this.#size -= byScope.size;
    }
    this.#promoteOverflowWitnesses();
    return byScope?.size ?? 0;
  }

  begin(announcement: Rfc64PublicCatalogHeadAnnouncementV1): Rfc64CatalogTargetLeaseV1 {
    const existingByScope = this.#byContextGraph.get(announcement.contextGraphId);
    const key = rfc64CatalogTargetScopeKeyV1(announcement);
    const previous = existingByScope?.get(key);
    let contextEpoch = this.#contextEpochs.get(announcement.contextGraphId);
    if (contextEpoch === undefined) {
      contextEpoch = { valid: true, activeLeases: 0 };
      this.#contextEpochs.set(announcement.contextGraphId, contextEpoch);
    }
    contextEpoch.activeLeases += 1;
    const lease = (
      disposition: Rfc64CatalogTargetLeaseV1['disposition'],
      overflow: Rfc64CatalogTargetOverflowV1 | null = null,
    ) => Object.freeze({
      announcement,
      disposition,
      state: { active: true, contextEpoch, overflow },
    });
    if (
      previous !== undefined
      && BigInt(announcement.catalogVersion)
        < BigInt(previous.announcement.catalogVersion)
    ) return lease('covered');
    if (
      previous === undefined
      && (existingByScope?.size ?? 0)
        >= RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1
    ) {
      const overflow = this.#beginContextGraphOverflow(announcement.contextGraphId);
      return lease(overflow.disposition, overflow.overflow);
    }
    if (previous === undefined && this.#size >= RFC64_CATALOG_TARGET_MAX_ENTRIES_V1) {
      this.#globalOverflow ??= this.#createOverflow();
      this.#globalOverflow.active += 1;
      return lease('global-capacity', this.#globalOverflow);
    }
    let byScope = existingByScope;
    if (byScope === undefined) {
      byScope = new Map();
      this.#byContextGraph.set(announcement.contextGraphId, byScope);
    }
    byScope.set(key, { announcement, terminalFailure: false });
    if (previous === undefined) this.#size += 1;
    return lease('tracked');
  }

  reject(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Rfc64CatalogTargetLeaseV1 {
    const lease = this.begin(announcement);
    this.settle(lease, 'dropped');
    return lease;
  }

  settle(
    lease: Rfc64CatalogTargetLeaseV1,
    outcome: Rfc64PublicCatalogReceiverCompletionOutcomeV1,
  ): void {
    if (!lease.state.active) return;
    lease.state.active = false;
    const { contextEpoch } = lease.state;
    contextEpoch.activeLeases = Math.max(0, contextEpoch.activeLeases - 1);
    if (
      contextEpoch.activeLeases === 0
      && this.#contextEpochs.get(lease.announcement.contextGraphId) === contextEpoch
    ) this.#contextEpochs.delete(lease.announcement.contextGraphId);
    const overflow = lease.state.overflow;
    if (!contextEpoch.valid) {
      if (overflow !== null) {
        overflow.active = Math.max(0, overflow.active - 1);
        if (this.#globalOverflow === overflow) {
          this.#finishOverflowIfResolved(overflow, null);
        }
      }
      return;
    }
    const resolved = outcome === 'already-applied'
      || outcome === 'applied'
      || outcome === 'closed'
      || outcome === 'staged-only';
    if (lease.disposition === 'tracked') {
      if (resolved) this.retire(lease.announcement);
      else this.#markTerminalFailure(lease.announcement);
      return;
    }
    if (lease.disposition === 'covered') return;
    if (
      overflow === null
      || (
        lease.disposition === 'context-capacity'
          ? this.#contextGraphOverflows.get(lease.announcement.contextGraphId) !== overflow
          : this.#globalOverflow !== overflow
      )
    ) return;
    overflow.active = Math.max(0, overflow.active - 1);
    const exactIdentity = rfc64CatalogTargetExactIdentityKeyV1(lease.announcement);
    if (resolved) {
      overflow.failureWitnesses.delete(exactIdentity);
    } else if (!overflow.failureWitnesses.has(exactIdentity)) {
      if (
        overflow.failureWitnesses.size
          >= RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1
      ) this.#markOverflowSaturated(overflow, lease.announcement.contextGraphId);
      else overflow.failureWitnesses.set(exactIdentity, lease.announcement);
    }
    this.#finishOverflowIfResolved(
      overflow,
      lease.disposition === 'context-capacity'
        ? lease.announcement.contextGraphId
        : null,
    );
  }

  retire(announcement: Rfc64PublicCatalogHeadAnnouncementV1): boolean {
    const byScope = this.#byContextGraph.get(announcement.contextGraphId);
    const key = rfc64CatalogTargetScopeKeyV1(announcement);
    const current = byScope?.get(key);
    let retired = false;
    if (
      current !== undefined
      && rfc64CatalogTargetExactIdentityV1(current.announcement, announcement)
    ) {
      byScope!.delete(key);
      this.#size -= 1;
      if (byScope!.size === 0) this.#byContextGraph.delete(announcement.contextGraphId);
      retired = true;
    }
    const exactIdentity = rfc64CatalogTargetExactIdentityKeyV1(announcement);
    const contextOverflow = this.#contextGraphOverflows.get(announcement.contextGraphId);
    if (contextOverflow?.failureWitnesses.delete(exactIdentity) === true) {
      this.#finishOverflowIfResolved(contextOverflow, announcement.contextGraphId);
      retired = true;
    }
    if (this.#globalOverflow?.failureWitnesses.delete(exactIdentity) === true) {
      this.#finishOverflowIfResolved(this.#globalOverflow, null);
      retired = true;
    }
    this.#promoteOverflowWitnesses();
    return retired;
  }

  #markTerminalFailure(announcement: Rfc64PublicCatalogHeadAnnouncementV1): void {
    const entry = this.#byContextGraph
      .get(announcement.contextGraphId)
      ?.get(rfc64CatalogTargetScopeKeyV1(announcement));
    if (
      entry !== undefined
      && rfc64CatalogTargetExactIdentityV1(entry.announcement, announcement)
    ) entry.terminalFailure = true;
  }

  #beginContextGraphOverflow(
    contextGraphId: string,
  ): Readonly<{
    disposition: 'context-capacity' | 'global-capacity';
    overflow: Rfc64CatalogTargetOverflowV1;
  }> {
    let overflow = this.#contextGraphOverflows.get(contextGraphId);
    if (overflow === undefined) {
      if (
        this.#contextGraphOverflows.size
          >= RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1
      ) {
        this.#globalOverflow ??= this.#createOverflow();
        this.#globalOverflow.active += 1;
        return Object.freeze({
          disposition: 'global-capacity',
          overflow: this.#globalOverflow,
        });
      }
      overflow = this.#createOverflow();
      this.#contextGraphOverflows.set(contextGraphId, overflow);
    }
    overflow.active += 1;
    return Object.freeze({ disposition: 'context-capacity', overflow });
  }

  #createOverflow(): Rfc64CatalogTargetOverflowV1 {
    return {
      active: 0,
      failureWitnesses: new Map(),
      saturatedContextGraphs: new Set(),
      unattributedSaturation: false,
    };
  }

  #markOverflowSaturated(
    overflow: Rfc64CatalogTargetOverflowV1,
    contextGraphId: string,
  ): void {
    if (overflow.saturatedContextGraphs.has(contextGraphId)) return;
    if (
      overflow.saturatedContextGraphs.size
        >= RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1
    ) {
      overflow.unattributedSaturation = true;
      return;
    }
    overflow.saturatedContextGraphs.add(contextGraphId);
  }

  #finishOverflowIfResolved(
    overflow: Rfc64CatalogTargetOverflowV1,
    contextGraphId: string | null,
  ): void {
    if (overflow.active > 0) return;
    if (
      overflow.failureWitnesses.size === 0
      && overflow.saturatedContextGraphs.size === 0
      && !overflow.unattributedSaturation
    ) {
      if (contextGraphId === null) this.#globalOverflow = null;
      else this.#contextGraphOverflows.delete(contextGraphId);
      return;
    }
    this.#promoteOverflowWitness(contextGraphId, overflow);
  }

  #promoteOverflowWitnesses(): void {
    for (const [contextGraphId, overflow] of this.#contextGraphOverflows) {
      this.#promoteOverflowWitness(contextGraphId, overflow);
    }
    if (this.#globalOverflow !== null) this.#promoteOverflowWitness(null, this.#globalOverflow);
  }

  #promoteOverflowWitness(
    contextGraphId: string | null,
    overflow: Rfc64CatalogTargetOverflowV1,
  ): void {
    if (overflow.active > 0) return;
    for (const [identity, witness] of overflow.failureWitnesses) {
      const byScope = this.#byContextGraph.get(witness.contextGraphId);
      const key = rfc64CatalogTargetScopeKeyV1(witness);
      const current = byScope?.get(key);
      if (current !== undefined) {
        if (BigInt(current.announcement.catalogVersion) > BigInt(witness.catalogVersion)) {
          overflow.failureWitnesses.delete(identity);
          continue;
        }
        current.announcement = witness;
        current.terminalFailure = true;
        overflow.failureWitnesses.delete(identity);
        continue;
      }
      if (
        (byScope?.size ?? 0) >= RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1
        || this.#size >= RFC64_CATALOG_TARGET_MAX_ENTRIES_V1
      ) continue;
      const targetByScope = byScope ?? new Map<string, Rfc64CatalogTrackedTargetV1>();
      if (byScope === undefined) this.#byContextGraph.set(witness.contextGraphId, targetByScope);
      targetByScope.set(key, { announcement: witness, terminalFailure: true });
      this.#size += 1;
      overflow.failureWitnesses.delete(identity);
    }
    if (
      overflow.failureWitnesses.size === 0
      && overflow.saturatedContextGraphs.size === 0
      && !overflow.unattributedSaturation
    ) {
      if (contextGraphId === null && this.#globalOverflow === overflow) {
        this.#globalOverflow = null;
      } else if (
        contextGraphId !== null
        && this.#contextGraphOverflows.get(contextGraphId) === overflow
      ) this.#contextGraphOverflows.delete(contextGraphId);
    }
  }
}

const rfc64CatalogTargetAnnouncementsV1 =
  new WeakMap<DKGAgent, Rfc64CatalogTargetTrackerV1>();

function rfc64CatalogReplayRuntimeForV1(agent: DKGAgent): Rfc64CatalogReplayRuntimeV1 {
  let runtime = rfc64CatalogReplayRuntimesV1.get(agent);
  if (runtime === undefined) {
    runtime = {
      tail: Promise.resolve(),
      pending: new Map(),
      pendingByPeer: new Map(),
      indexFingerprint: null,
      indexByScope: new Map(),
    };
    rfc64CatalogReplayRuntimesV1.set(agent, runtime);
  }
  return runtime;
}

function rfc64CatalogReplayScopeKeyV1(networkId: string, contextGraphId: string): string {
  return `${networkId}\0${contextGraphId}`;
}

function rfc64CatalogTargetScopeKeyV1(input: Readonly<{
  networkId: string;
  contextGraphId: string;
  subGraphName: string | null;
  authorAddress: string;
  catalogEra: string;
}>): string {
  return [
    input.networkId,
    input.contextGraphId,
    input.subGraphName ?? '',
    input.authorAddress.toLowerCase(),
    input.catalogEra,
  ].join('\0');
}

function rfc64CatalogTargetExactIdentityV1(
  left: Rfc64PublicCatalogHeadAnnouncementV1,
  right: Rfc64PublicCatalogHeadAnnouncementV1,
): boolean {
  return rfc64CatalogTargetExactIdentityKeyV1(left)
    === rfc64CatalogTargetExactIdentityKeyV1(right);
}

function rfc64CatalogTargetExactIdentityKeyV1(
  target: Rfc64PublicCatalogHeadAnnouncementV1,
): string {
  return [
    rfc64CatalogTargetScopeKeyV1(target),
    target.catalogVersion,
    target.policyDigest,
    target.catalogHeadObjectDigest,
    target.signatureVariantDigest,
  ].join('\0');
}

function recordRfc64CatalogTargetAnnouncementV1(
  agent: DKGAgent,
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): Rfc64CatalogTargetLeaseV1 {
  let tracker = rfc64CatalogTargetAnnouncementsV1.get(agent);
  if (tracker === undefined) {
    tracker = new Rfc64CatalogTargetTrackerV1();
    rfc64CatalogTargetAnnouncementsV1.set(agent, tracker);
  }
  return tracker.begin(announcement);
}

function rejectRfc64CatalogTargetAnnouncementV1(
  agent: DKGAgent,
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): void {
  let tracker = rfc64CatalogTargetAnnouncementsV1.get(agent);
  if (tracker === undefined) {
    tracker = new Rfc64CatalogTargetTrackerV1();
    rfc64CatalogTargetAnnouncementsV1.set(agent, tracker);
  }
  tracker.reject(announcement);
}

function retireRfc64CatalogTargetAnnouncementV1(
  agent: DKGAgent,
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): void {
  rfc64CatalogTargetAnnouncementsV1.get(agent)?.retire(announcement);
}

function markRfc64DirectAcceptedCompatibilityV1(
  agent: DKGAgent,
  contextGraphId: string,
): void {
  let accepted = rfc64DirectAcceptedCompatibilityV1.get(agent);
  if (accepted === undefined) {
    accepted = new Set<string>();
    rfc64DirectAcceptedCompatibilityV1.set(agent, accepted);
  }
  accepted.add(contextGraphId);
}

function rfc64CatalogAuthorityGenerationChangedV1(
  previous: Readonly<{
    policyDigest: Digest32V1;
    roster?: AcceptedRfc64CatalogAccessSnapshotV1['roster'];
  }> | null,
  accepted: Readonly<{
    policyDigest: Digest32V1;
    roster?: AcceptedRfc64CatalogAccessSnapshotV1['roster'];
  }>,
): boolean {
  return previous !== null
    && (
      previous.policyDigest !== accepted.policyDigest
      || previous.roster?.version !== accepted.roster?.version
    );
}

function rfc64CatalogResponsibilityRegistryForV1(
  agent: DKGAgent,
  executionPlan: Rfc64CatalogExecutionPlanV1,
): Rfc64CatalogResponsibilityRegistryV1 {
  let registry = rfc64CatalogResponsibilityRegistriesV1.get(agent);
  if (registry !== undefined) return registry;
  const defaultMode = executionPlan.responsibilityDefaultMode ?? 'legacy';
  registry = new Rfc64CatalogResponsibilityRegistryV1({
    defaultMode,
    contextGraphModes: executionPlan.contextGraphModes,
    killSwitchActive: executionPlan.killSwitchActive,
  });
  rfc64CatalogResponsibilityRegistriesV1.set(agent, registry);
  return registry;
}

function nextRfc64CatalogResponsibilityRevisionV1(
  agent: DKGAgent,
  contextGraphId: string,
): number {
  let revisions = rfc64CatalogResponsibilityRevisionsV1.get(agent);
  if (revisions === undefined) {
    revisions = new Map<string, number>();
    rfc64CatalogResponsibilityRevisionsV1.set(agent, revisions);
  }
  const revision = (revisions.get(contextGraphId) ?? 0) + 1;
  revisions.set(contextGraphId, revision);
  return revision;
}

function isCurrentRfc64CatalogResponsibilityRevisionV1(
  agent: DKGAgent,
  contextGraphId: string,
  revision: number,
): boolean {
  return rfc64CatalogResponsibilityRevisionsV1.get(agent)?.get(contextGraphId) === revision;
}

function setRfc64CatalogAuthorityProgressV1(
  agent: DKGAgent,
  contextGraphId: string,
  progress: Rfc64CatalogAuthorityProgressV1,
): void {
  let statuses = rfc64CatalogAuthorityProgressV1.get(agent);
  if (statuses === undefined) {
    statuses = new Map();
    rfc64CatalogAuthorityProgressV1.set(agent, statuses);
  }
  statuses.set(contextGraphId, Object.freeze({ ...progress }));
}

function nextRfc64CatalogAuthorityRevisionV1(
  agent: DKGAgent,
  contextGraphId: string,
): number {
  let revisions = rfc64CatalogAuthorityRevisionsV1.get(agent);
  if (revisions === undefined) {
    revisions = new Map<string, number>();
    rfc64CatalogAuthorityRevisionsV1.set(agent, revisions);
  }
  const revision = (revisions.get(contextGraphId) ?? 0) + 1;
  revisions.set(contextGraphId, revision);
  return revision;
}

function isCurrentRfc64CatalogAuthorityRevisionV1(
  agent: DKGAgent,
  contextGraphId: string,
  revision: number,
): boolean {
  return rfc64CatalogAuthorityRevisionsV1.get(agent)?.get(contextGraphId) === revision;
}

type Rfc64CatalogAuthorityFailureCodeV1 =
  | 'catalog-service-unavailable'
  | 'registered-authority-adapter-unsupported'
  | 'registered-authority-binding-mismatch'
  | 'unregistered-owner-unresolved'
  | 'access-policy-unresolved';

class Rfc64CatalogAuthorityResolutionErrorV1 extends Error {
  constructor(
    readonly code: Rfc64CatalogAuthorityFailureCodeV1,
    message: string,
  ) {
    super(message);
    this.name = 'Rfc64CatalogAuthorityResolutionErrorV1';
  }
}

function requireRfc64ContextGraphAuthorityReaderV1(
  capability: ContextGraphAuthorityReaderCapability,
): ContextGraphAuthorityReader {
  if (capability.status === 'unsupported') {
    throw new Rfc64CatalogAuthorityResolutionErrorV1(
      'registered-authority-adapter-unsupported',
      'registered RFC-64 Context Graph requires finalized authority snapshot support',
    );
  }
  return capability.reader;
}

function rfc64CatalogAuthorityFailureCodeV1(error: unknown): string {
  if (error instanceof Rfc64CatalogAuthorityResolutionErrorV1) return error.code;
  return 'authority-resolution-failed';
}

function aggregateRfc64DigestV1(values: readonly string[]): Digest32V1 | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort();
  if (sorted.length === 1) return sorted[0] as Digest32V1;
  return ethers.keccak256(ethers.toUtf8Bytes(sorted.join('\n'))) as Digest32V1;
}

function sumDecimalCountsV1(values: readonly string[]): string {
  return values.reduce((sum, value) => sum + BigInt(value), 0n).toString(10);
}

export class Rfc64CatalogMethods extends DKGAgentBase {
  /** Forget process-local operational targets when receiver ownership ends. */
  clearRfc64CatalogOperationalTargetsV1(
    this: DKGAgent,
    contextGraphId: string,
  ): void {
    rfc64CatalogTargetAnnouncementsV1.get(this)?.clearContextGraph(contextGraphId);
    clearRfc64CatalogReplayProgressV1(this, contextGraphId);
  }

  /** Fence operational completeness synchronously when a replay-capable peer connects. */
  markRfc64CatalogReplayPeerPendingV1(
    this: DKGAgent,
    contextGraphId: string,
    peerId: string,
  ): void {
    const service = this.rfc64PublicCatalogServiceV1;
    const networkId = (
      this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.config.networkIdentity?.chainId
    ) as NetworkIdV1 | undefined;
    if (service === undefined || networkId === undefined || networkId === 'none') return;
    const accepted = service.acceptedPolicySnapshot(
      networkId,
      contextGraphId as ContextGraphIdV1,
    );
    if (accepted === null) return;
    const progress = rfc64CatalogReplayProgressForV1(
      this,
      contextGraphId,
      accepted.policyDigest,
    );
    progress.pendingPeers.add(peerId);
    if (!progress.active) {
      progress.active = true;
      progress.failed = false;
      bumpRfc64CatalogReplayStatusRevisionV1(this);
    }
  }

  /** Release a synchronous connection fence when admission rejects that peer. */
  clearRfc64CatalogReplayPeerPendingV1(
    this: DKGAgent,
    contextGraphId: string,
    peerId: string,
  ): void {
    const progress = rfc64CatalogReplayProgressV1.get(this)?.get(contextGraphId);
    if (progress === undefined) return;
    progress.pendingPeers.delete(peerId);
    if (progress.pendingPeers.size === 0 && progress.completion === null && progress.active) {
      progress.active = false;
      bumpRfc64CatalogReplayStatusRevisionV1(this);
    }
  }

  /** Desired RFC-64 selection derived from the normal live CG lifecycle. */
  readRfc64CatalogResponsibilitiesV1(
    this: DKGAgent,
  ): readonly Rfc64CatalogResponsibilitySelectionV1[] {
    return rfc64CatalogResponsibilityRegistryForV1(
      this,
      this.config.rfc64CatalogExecutionPlan,
    ).snapshot();
  }

  /** Local, privacy-safe per-CG release evidence used by status and harnesses. */
  async readRfc64CatalogOperationalStatusV1(
    this: DKGAgent,
  ): Promise<readonly Rfc64CatalogOperationalStatusV1[]> {
    const service = this.rfc64PublicCatalogServiceV1;
    const persistence = this.rfc64PersistenceV1;
    const networkId = (
      this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.config.networkIdentity?.chainId
    ) as NetworkIdV1 | undefined;
    const responsibilities = this.readRfc64CatalogResponsibilitiesV1();
    const responsibilityByContextGraph = new Map(
      responsibilities.map((selection) => [selection.contextGraphId, selection]),
    );
    const configuredAuthorities = this.config.rfc64CatalogExecutionPlan.selectedAuthority;
    const selections = Object.freeze([...new Set([
      ...Object.keys(configuredAuthorities),
      ...responsibilityByContextGraph.keys(),
    ])].sort().map((contextGraphId): Rfc64CatalogResponsibilitySelectionV1 => {
      const responsibility = responsibilityByContextGraph.get(contextGraphId);
      const configured = configuredAuthorities[contextGraphId];
      if (configured === undefined) return responsibility!;
      const receiverAuthority = this.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId);
      return Object.freeze({
        contextGraphId,
        responsible: responsibility?.responsible ?? configured.selected,
        responsibilityReason: responsibility?.responsibilityReason ?? null,
        active: receiverAuthority.active,
        mode: configured.mode,
        selectionSource: configured.killSwitchActive
          ? 'kill-switch'
          : 'operator-override',
      });
    }));
    let replaySnapshotRevision = rfc64CatalogReplayStatusRevisionV1.get(this) ?? 0;
    let appliedByContextGraph = persistence === undefined
      ? new Map<string, readonly Readonly<Rfc64OperationalAppliedHeadV1>[]>()
      : groupRfc64OperationalAppliedHeadsV1(
          await loadRfc64OperationalAppliedHeadsV1(persistence),
        );
    if (
      persistence !== undefined
      && replaySnapshotRevision !== (rfc64CatalogReplayStatusRevisionV1.get(this) ?? 0)
    ) {
      replaySnapshotRevision = rfc64CatalogReplayStatusRevisionV1.get(this) ?? 0;
      appliedByContextGraph = groupRfc64OperationalAppliedHeadsV1(
        await loadRfc64OperationalAppliedHeadsV1(persistence),
      );
    }
    const replaySnapshotUnstable = replaySnapshotRevision
      !== (rfc64CatalogReplayStatusRevisionV1.get(this) ?? 0);
    const progressByContextGraph = rfc64CatalogAuthorityProgressV1.get(this);
    const receiverStats = service?.stats().receiver;
    return Object.freeze(selections.map((selection) => {
      const accepted = service !== undefined && networkId !== undefined
        ? service.acceptedPolicySnapshot(
          networkId,
          selection.contextGraphId as ContextGraphIdV1,
        )
        : null;
      const progress = progressByContextGraph?.get(selection.contextGraphId);
      const replayProgress = rfc64CatalogReplayProgressV1
        .get(this)?.get(selection.contextGraphId);
      const currentReplayProgress = accepted !== null
        && replayProgress?.policyDigest === accepted.policyDigest
        ? replayProgress
        : undefined;
      const replayActive = replaySnapshotUnstable || currentReplayProgress?.active === true;
      const replayFailed = currentReplayProgress?.failed === true;
      const replayUnsettled = replayActive || replayFailed;
      const heads = appliedByContextGraph.get(selection.contextGraphId) ?? [];
      const targetTracker = rfc64CatalogTargetAnnouncementsV1.get(this);
      const targets = targetTracker?.targetsForContextGraph(selection.contextGraphId) ?? [];
      const targetCapacityExceeded = targetTracker
        ?.capacityExceededForContextGraph(selection.contextGraphId) ?? false;
      const appliedByScope = new Map(heads.map((head) => [head.scopeKey, head]));
      const pendingTargets = targets.filter((target) => {
        const applied = appliedByScope.get(rfc64CatalogTargetScopeKeyV1(target));
        return applied === undefined
          || BigInt(target.catalogVersion) > BigInt(applied.snapshot.catalogVersion)
          || (
            target.catalogVersion === applied.snapshot.catalogVersion
            && target.catalogHeadObjectDigest !== applied.snapshot.currentCatalogHeadDigest
          );
      });
      const catalogHeadDigest = aggregateRfc64DigestV1(
        heads.map(({ snapshot }) => snapshot.currentCatalogHeadDigest),
      );
      const expectedCatalogHeadDigests = new Map(heads.map(({ scopeKey, snapshot }) => [
        scopeKey,
        snapshot.currentCatalogHeadDigest,
      ]));
      for (const target of pendingTargets) {
        expectedCatalogHeadDigests.set(
          rfc64CatalogTargetScopeKeyV1(target),
          target.catalogHeadObjectDigest,
        );
      }
      const expectedCatalogHeadDigest = aggregateRfc64DigestV1(
        [...expectedCatalogHeadDigests.values()],
      );
      const inventoryDigest = aggregateRfc64DigestV1(
        heads.map(({ snapshot }) => snapshot.appliedInventoryDigest),
      );
      const rowCount = heads.length === 0
        ? null
        : sumDecimalCountsV1(heads.map(({ snapshot }) => snapshot.inventoryRowCount));
      const appliedCatalogVersion = heads.length === 0
        ? null
        : heads.reduce((highest, { snapshot }) => (
          BigInt(snapshot.catalogVersion) > BigInt(highest)
            ? snapshot.catalogVersion
            : highest
        ), heads[0]!.snapshot.catalogVersion);
      const catalogVersion = pendingTargets.reduce<DecimalU64V1 | null>(
        (highest, target) => highest === null
          || BigInt(target.catalogVersion) > BigInt(highest)
          ? target.catalogVersion
          : highest,
        appliedCatalogVersion,
      );
      const lastSuccessfulAdvanceAt = heads.length === 0
        ? null
        : heads.reduce((latest, head) => (
          BigInt(head.issuedAt) > BigInt(latest) ? head.issuedAt : latest
        ), heads[0]!.issuedAt);
      const activeCatalog = selection.active && selection.mode !== 'legacy';
      const authorityState = !activeCatalog
        ? 'inactive' as const
        : progress?.state === 'blocked'
          ? 'blocked' as const
          : progress?.state === 'resolving'
            ? 'resolving' as const
            : accepted !== null
              ? 'accepted' as const
              : progress?.state ?? 'resolving' as const;
      const compatibilitySeed = accepted !== null
        && this.config.rfc64CatalogExecutionPlan.selectedAuthority[selection.contextGraphId]
          !== undefined;
      const authorityFreshness = accepted === null
        ? null
        : compatibilitySeed
          ? 'current' as const
          : progress?.state === 'accepted'
            && Date.now() - progress.updatedAtMs
              <= RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.intervalMs
                * RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.freshnessIntervalCount
            ? 'current' as const
            : 'unknown' as const;
      const legacyReadOnlyCount = readRfc64LegacySwmBoundaryCountV1(
        this,
        selection.contextGraphId,
      );
      const targetFailure = pendingTargets.find((target) => (
        targetTracker?.hasTerminalFailure(target) === true
      ));
      const stableReason = targetFailure !== undefined
        ? 'catalog-reconciliation-failed'
        : targetCapacityExceeded
          ? 'catalog-target-capacity-exceeded'
        : replayFailed
          ? 'catalog-replay-incomplete'
        : !selection.active
        ? selection.selectionSource === 'kill-switch' ? 'kill-switch-active' : null
        : selection.mode === 'legacy'
          ? 'explicit-legacy-mode'
          : progress?.state === 'blocked'
            ? progress.reason
            : service === undefined
              ? 'catalog-service-unavailable'
              : accepted !== null
                && authorityFreshness === 'current'
                && legacyReadOnlyCount > 0
                ? 'legacy-read-only-boundary'
              : null;
      const phase: Rfc64CatalogOperationalPhaseV1 = !activeCatalog
        ? 'inactive'
        : stableReason !== null && stableReason !== 'legacy-read-only-boundary'
          ? 'blocked'
          : accepted === null || authorityState === 'resolving'
            ? 'resolving-authority'
            : authorityFreshness === 'unknown'
              ? 'unknown-freshness'
            : targetFailure !== undefined
              ? 'blocked'
            : replayActive
              ? 'applying'
            : pendingTargets.length > 0
              ? 'applying'
            : legacyReadOnlyCount > 0
              ? 'known-incomplete'
            : heads.length === 0
              ? 'bootstrapping'
              : 'complete';
      return Object.freeze({
        contextGraphId: selection.contextGraphId,
        responsibilityReason: selection.responsibilityReason,
        selectionSource: selection.selectionSource,
        effectiveMode: selection.mode,
        accessPolicy: accepted?.policy.accessPolicy ?? null,
        publishPolicy: accepted?.policy.publishPolicy ?? null,
        legacySyncAllowed: this.resolveRfc64CatalogReceiverAuthorityV1(
          selection.contextGraphId,
        ).legacySyncAllowed,
        phase,
        authorityState,
        policySource: accepted === null
          ? progress?.source ?? null
          : compatibilitySeed
            ? 'compatibility-seed' as const
            : progress?.source ?? accepted.policy.source.kind,
        policyDigest: accepted?.policyDigest ?? progress?.policyDigest ?? null,
        authorityEra: accepted?.policy.era ?? progress?.policyEra ?? null,
        authorityFreshness,
        catalogServiceStarted: service?.started ?? false,
        expectedCatalogHeadDigest:
          targetCapacityExceeded || replayUnsettled ? null : expectedCatalogHeadDigest,
        appliedCatalogHeadDigest: catalogHeadDigest,
        expectedInventoryDigest:
          targetCapacityExceeded || replayUnsettled || pendingTargets.length > 0
            ? null
            : inventoryDigest,
        appliedInventoryDigest: inventoryDigest,
        expectedRowCount:
          targetCapacityExceeded || replayUnsettled || pendingTargets.length > 0
            ? null
            : rowCount,
        appliedRowCount: rowCount,
        missingRowCount:
          targetCapacityExceeded
          || replayUnsettled
          || pendingTargets.length > 0
          || rowCount === null
            ? null
            : '0',
        legacyReadOnlyCount,
        catalogVersion,
        authorHeadCount: heads.length,
        lastSuccessfulAdvanceAt,
        providerHealth: Object.freeze({
          candidateCount: targetCapacityExceeded || replayUnsettled ? null : targets.length,
          attempts: receiverStats?.providerAttempts ?? 0,
          switches: receiverStats?.providerSwitches ?? 0,
          successes: receiverStats?.providerSuccesses ?? 0,
          backoffMs: receiverStats?.providerBackoffMs ?? 0,
        }),
        stableReason,
      });
    }));
  }

  /**
   * Resolve the private member set from the hardened, store-backed `_meta`
   * gate after the complete graph definition has been authenticated. This is
   * deliberately independent of the accepted RFC-64 roster: responsibility
   * and roster rotation cannot ask the roster they are about to establish for
   * permission to establish it.
   */
  async resolveRfc64VerifiedPrivateRosterV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<readonly EvmAddressV1[] | null> {
    if (!await this.hasConfirmedMetaState(contextGraphId).catch(() => false)) {
      return null;
    }
    const gate = await this.getMemberRecoveryGate(contextGraphId).catch(() => null);
    if (gate === null || gate.length === 0) return null;
    const members = new Set<EvmAddressV1>();
    for (const candidate of gate) {
      if (!ethers.isAddress(candidate) || candidate === ethers.ZeroAddress) continue;
      members.add(candidate.toLowerCase() as EvmAddressV1);
    }
    return members.size === 0
      ? null
      : Object.freeze([...members].sort());
  }

  async hasRfc64VerifiedPrivateMembershipV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<boolean> {
    return await this.resolveRfc64CatalogLocalAgentAddressV1(contextGraphId) !== null;
  }

  /**
   * Resolve this node's exact private-CG principal from authenticated lifecycle
   * state. An explicit operator authority remains authoritative; default mode
   * otherwise uses a valid CG-scoped approval hint or one unambiguous
   * intersection between the verified roster and locally held identities.
   */
  async resolveRfc64CatalogLocalAgentAddressV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<EvmAddressV1 | null> {
    const roster = await this.resolveRfc64VerifiedPrivateRosterV1(contextGraphId);
    if (roster === null) return null;
    const rosterSet = new Set(roster);
    const configured = this.config.rfc64CatalogAccessPolicyAuthority
      ?.localAgentAddress
      ?.toLowerCase();
    if (configured !== undefined) {
      return ethers.isAddress(configured) && rosterSet.has(configured as EvmAddressV1)
        ? configured as EvmAddressV1
        : null;
    }

    const localAgents = new Set<EvmAddressV1>();
    for (const { agentAddress } of this.listLocalAgents()) {
      const normalized = agentAddress.toLowerCase();
      if (ethers.isAddress(normalized) && normalized !== ethers.ZeroAddress) {
        localAgents.add(normalized as EvmAddressV1);
      }
    }
    const defaultAgentAddress = this.defaultAgentAddress?.toLowerCase();
    if (
      defaultAgentAddress !== undefined
      && ethers.isAddress(defaultAgentAddress)
      && defaultAgentAddress !== ethers.ZeroAddress
    ) {
      localAgents.add(defaultAgentAddress as EvmAddressV1);
    }

    const approvedAgent = this.localApprovedAgentByCG.get(contextGraphId)?.toLowerCase();
    if (
      approvedAgent !== undefined
      && localAgents.has(approvedAgent as EvmAddressV1)
      && rosterSet.has(approvedAgent as EvmAddressV1)
    ) return approvedAgent as EvmAddressV1;

    const matching = [...localAgents].filter((address) => rosterSet.has(address));
    return matching.length === 1 ? matching[0]! : null;
  }

  /** Read the exact current owner generation used to bind a curator peer. */
  async readRfc64CurrentCuratorAuthorityBindingV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<Readonly<{
    agentAddress: EvmAddressV1;
    authorityEra: DecimalU64V1;
  }> | null> {
    const onChainId = await this.getContextGraphOnChainId(contextGraphId);
    if (onChainId !== null) {
      const reader = requireRfc64ContextGraphAuthorityReaderV1(
        this.contextGraphAuthorityReaderCapability,
      );
      const expectedOnChainId = BigInt(onChainId);
      const snapshot = parseRfc64AuthoritySnapshotV1(
        await reader.getContextGraphAuthoritySnapshot(expectedOnChainId),
        expectedOnChainId,
      );
      const explicitNameHash = this.subscribedContextGraphs.get(contextGraphId)?.onChainHash;
      const expectedNameHash = explicitNameHash === undefined
        ? this.contextGraphNameCommitment(contextGraphId)
        : this.contextGraphWireId(explicitNameHash);
      if (
        !snapshot.active
        || snapshot.nameHash !== expectedNameHash
      ) return null;
      return Object.freeze({
        agentAddress: snapshot.owner,
        authorityEra: snapshot.ownershipEra,
      });
    }
    const ownerDid = await this.getContextGraphOwner(contextGraphId);
    const owner = ownerDid
      ?.trim()
      .replace(/^<|>$/gu, '')
      .replace(/^did:dkg:agent:/u, '')
      .toLowerCase();
    return owner !== undefined && ethers.isAddress(owner) && owner !== ethers.ZeroAddress
      ? Object.freeze({
        agentAddress: owner as EvmAddressV1,
        authorityEra: '0' as DecimalU64V1,
      })
      : null;
  }

  /**
   * Resolve a catalog peer from authenticated, Context-Graph-scoped state.
   * Public agent profiles remain the first choice, but private admission must
   * not depend on best-effort profile gossip. Curators already hold the
   * member's signed delegatee binding, while approved receivers persist the
   * authenticated curator peer together with its exact owner generation.
   */
  async resolveRfc64CatalogRemoteAgentAddressV1(
    this: DKGAgent,
    remotePeerId: string,
    contextGraphId: ContextGraphIdV1,
  ): Promise<EvmAddressV1 | null> {
    const discovered = (await this.findAgentByPeerId(remotePeerId))
      ?.agentAddress
      ?.toLowerCase();
    if (discovered !== undefined && /^0x[0-9a-f]{40}$/u.test(discovered)) {
      return discovered as EvmAddressV1;
    }
    if (!await this.hasConfirmedMetaState(contextGraphId).catch(() => false)) {
      return null;
    }

    const delegatedAgents = new Set<EvmAddressV1>();
    const delegateePeers = await this.getContextGraphAllowedDelegateePeers(contextGraphId)
      .catch(() => new Map<string, string[]>());
    for (const [agentAddress, peerIds] of delegateePeers) {
      const normalized = agentAddress.toLowerCase();
      if (
        peerIds.includes(remotePeerId)
        && /^0x[0-9a-f]{40}$/u.test(normalized)
      ) {
        delegatedAgents.add(normalized as EvmAddressV1);
      }
    }
    if (delegatedAgents.size === 1) return [...delegatedAgents][0]!;
    if (delegatedAgents.size > 1) return null;

    const approvedAgent = this.localApprovedAgentByCG.get(contextGraphId);
    if (approvedAgent === undefined) return null;
    const requesterState = await this.readRequesterJoinRequestState(
      contextGraphId,
      approvedAgent,
    ).catch(() => null);
    if (
      requesterState?.status !== 'approved'
      || requesterState.curatorPeerId !== remotePeerId
      || requesterState.curatorAgentAddress === undefined
      || requesterState.curatorAuthorityEra === undefined
    ) return null;
    const current = await this.readRfc64CurrentCuratorAuthorityBindingV1(
      contextGraphId,
    ).catch(() => null);
    if (
      current === null
      || current.agentAddress !== requesterState.curatorAgentAddress
      || current.authorityEra !== requesterState.curatorAuthorityEra
    ) return null;
    return current.agentAddress;
  }

  /** Read the curator-authored local roster generation from authenticated metadata. */
  async readRfc64PrivateRosterVersionV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<string> {
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const result = await this.store.query(`
      SELECT ?version WHERE {
        GRAPH <${metaGraph}> {
          <${contextGraphUri}> <${RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1}> ?version .
        }
      }
    `, { source: 'agent.rfc64.privateRosterVersion' });
    if (result.type !== 'bindings' || result.bindings.length === 0) return '0';
    const versions = new Set<string>();
    for (const row of result.bindings) {
      const raw = row['version'];
      if (typeof raw !== 'string') {
        throw new Error('RFC-64 private roster version is not a literal');
      }
      const lexical = raw.match(/^"([0-9]+)"(?:\^\^<[^>]+>)?$/u)?.[1]
        ?? (/^[0-9]+$/u.test(raw) ? raw : undefined);
      if (lexical === undefined || !/^(0|[1-9][0-9]*)$/u.test(lexical)) {
        throw new Error('RFC-64 private roster version is not canonical');
      }
      if (BigInt(lexical) >= RFC64_PRIVATE_ROSTER_VERSION_RADIX_V1) {
        throw new Error('RFC-64 private roster version exceeds its generation lane');
      }
      versions.add(lexical);
    }
    if (versions.size !== 1) {
      throw new Error('RFC-64 private roster metadata has conflicting generations');
    }
    return [...versions][0]!;
  }

  /**
   * Advance and persist the private lifecycle roster generation under the
   * caller's per-CG admission lock. Public allowlists do not define a read
   * roster and therefore do not consume a generation.
   */
  async advanceRfc64PrivateRosterVersionV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<string | null> {
    if (await this.getExplicitAccessPolicy(contextGraphId) !== 'private') return null;
    if (typeof this.store.update !== 'function') {
      throw new Error('RFC-64 private roster rotation requires atomic SPARQL UPDATE support');
    }
    const current = BigInt(await this.readRfc64PrivateRosterVersionV1(contextGraphId));
    const next = BigInt(Math.max(Date.now(), Number(current + 1n)));
    if (next >= RFC64_PRIVATE_ROSTER_VERSION_RADIX_V1) {
      throw new Error('RFC-64 private roster clock exceeds its generation lane');
    }
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    await this.store.update(`
      DELETE { GRAPH <${metaGraph}> {
        <${contextGraphUri}> <${RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1}> ?oldVersion .
      } }
      INSERT { GRAPH <${metaGraph}> {
        <${contextGraphUri}> <${RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1}>
          "${next.toString(10)}"^^<http://www.w3.org/2001/XMLSchema#integer> .
      } }
      WHERE { OPTIONAL { GRAPH <${metaGraph}> {
        <${contextGraphUri}> <${RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1}> ?oldVersion .
      } } }
    `, { touchedGraphs: [metaGraph], source: 'agent.rfc64.privateRosterRotate' });
    return next.toString(10);
  }

  /**
   * Refresh one CG from canonical local subscription/hosting state and
   * verified access facts. Revision fencing prevents a slow authority read
   * from reviving a responsibility after unsubscribe or membership removal.
   */
  reconcileRfc64CatalogResponsibilityV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<Rfc64CatalogResponsibilitySelectionV1> {
    const registry = rfc64CatalogResponsibilityRegistryForV1(
      this,
      this.config.rfc64CatalogExecutionPlan,
    );
    // Explicit activation/compatibility manifests already own this CG's
    // authority and receiver lifecycle. The release-native responsibility
    // registry is only for CGs discovered from ordinary daemon state; letting
    // it also claim a configured CG creates duplicate bootstrap invalidations
    // and can silently replace a shadow/legacy override with the default mode.
    if (
      this.config.rfc64CatalogExecutionPlan.selectedAuthority[contextGraphId]
      !== undefined
    ) {
      return Promise.resolve(registry.read(contextGraphId));
    }
    const commit = (
      reason: Parameters<Rfc64CatalogResponsibilityRegistryV1['setResponsibility']>[1],
    ): Rfc64CatalogResponsibilitySelectionV1 => {
      const transition = registry.setResponsibility(contextGraphId, reason);
      if (transition.changed) {
        this.handleRfc64CatalogReceiverSelectionTransitionV1(
          contextGraphId,
          {
            kind: 'responsibility',
            previousReceiverActive:
              transition.previous.active && transition.previous.mode !== 'legacy',
            nextReceiverActive:
              transition.next.active && transition.next.mode !== 'legacy',
          },
        );
      }
      return transition.next;
    };
    const revision = nextRfc64CatalogResponsibilityRevisionV1(this, contextGraphId);
    const subscription = this.subscribedContextGraphs.get(contextGraphId);
    if (
      rfc64SystemContextGraphIdsV1.has(contextGraphId)
      || subscription === undefined
    ) {
      const inactive = commit(null);
      return Promise.resolve(inactive);
    }

    const run = (async (): Promise<Rfc64CatalogResponsibilitySelectionV1> => {
      let accessPolicy = await this.getExplicitAccessPolicy(contextGraphId);
      if (accessPolicy === null && subscription.onChainId !== undefined) {
        const onChainPolicy = await this.getContextGraphOnChainPolicy(contextGraphId);
        accessPolicy = onChainPolicy.accessPolicy === 0
          ? 'public'
          : onChainPolicy.accessPolicy === 1
            ? 'private'
            : null;
      }
      const privateMembershipVerified = accessPolicy === 'private'
        && await this.hasRfc64VerifiedPrivateMembershipV1(contextGraphId);
      const reason = resolveRfc64CatalogResponsibilityReasonV1({
        nodeRole: (this.config.nodeRole ?? 'edge') === 'core' ? 'core' : 'edge',
        subscribed: subscription.subscribed === true,
        coreHosted: subscription.coreHosted === true,
        accessPolicy,
        privateMembershipVerified,
      });
      if (!isCurrentRfc64CatalogResponsibilityRevisionV1(this, contextGraphId, revision)) {
        return registry.read(contextGraphId);
      }
      const next = commit(reason);
      if (
        next.active
        && next.mode !== 'legacy'
        && this.resolveRfc64AcceptedCompatibilityAuthorityV1(contextGraphId) === null
      ) {
        await this.reconcileRfc64CatalogAccessAuthorityV1(contextGraphId).catch((error) => {
          this.log.warn(
            createOperationContext('system'),
            `RFC-64 authority bootstrap incomplete for "${contextGraphId}": ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        });
      }
      return next;
    })().catch((error) => {
      if (isCurrentRfc64CatalogResponsibilityRevisionV1(this, contextGraphId, revision)) {
        commit(null);
      }
      throw error;
    });

    let pending = rfc64CatalogResponsibilityPendingV1.get(this);
    if (pending === undefined) {
      pending = new Map<string, Promise<Rfc64CatalogResponsibilitySelectionV1>>();
      rfc64CatalogResponsibilityPendingV1.set(this, pending);
    }
    pending.set(contextGraphId, run);
    void run.finally(() => {
      if (pending!.get(contextGraphId) === run) pending!.delete(contextGraphId);
    }).catch(() => undefined);
    return run;
  }

  /** Test/operator fence for asynchronous access-policy responsibility reads. */
  async whenRfc64CatalogResponsibilitiesIdleV1(this: DKGAgent): Promise<void> {
    const pending = rfc64CatalogResponsibilityPendingV1.get(this);
    while (pending !== undefined && pending.size > 0) {
      await Promise.allSettled(pending.values());
    }
  }

  /**
   * Rebuild and accept current RFC-64 authority from ordinary DKG state. A
   * supplied compatibility manifest remains an authority seed for its exact
   * graph; every other responsible graph takes this release-native path.
   */
  async reconcileRfc64CatalogAccessAuthorityV1(
    this: DKGAgent,
    contextGraphId: string,
    signal?: AbortSignal,
  ): Promise<Rfc64ReleaseNativeAuthoritySnapshotV1 | null> {
    const service = this.rfc64PublicCatalogServiceV1;
    if (this.config.rfc64CatalogExecutionPlan.selectedAuthority[contextGraphId] !== undefined) {
      return null;
    }
    const authorityRevision = nextRfc64CatalogAuthorityRevisionV1(this, contextGraphId);
    setRfc64CatalogAuthorityProgressV1(this, contextGraphId, {
      state: 'resolving',
      source: null,
      policyDigest: null,
      policyEra: null,
      reason: null,
      updatedAtMs: Date.now(),
    });
    try {
      if (signal?.aborted) throw signal.reason;
      if (service === undefined) {
        throw new Rfc64CatalogAuthorityResolutionErrorV1(
          'catalog-service-unavailable',
          'RFC-64 catalog service is unavailable',
        );
      }
      const networkId = (
        this.config.rfc64CatalogDeploymentProfile?.networkId
        ?? this.config.networkIdentity?.chainId
      ) as NetworkIdV1 | undefined;
      if (networkId === undefined || networkId === 'none') {
        throw new Error('RFC-64 release-native authority requires a trusted chain network');
      }
      const onChainId = await this.getContextGraphOnChainId(contextGraphId);
      let authority: Rfc64ReleaseNativeAuthoritySnapshotV1;
      if (onChainId !== null) {
        const reader = requireRfc64ContextGraphAuthorityReaderV1(
          this.contextGraphAuthorityReaderCapability,
        );
        const expectedOnChainId = BigInt(onChainId);
        const snapshot = parseRfc64AuthoritySnapshotV1(
          await reader.getContextGraphAuthoritySnapshot(expectedOnChainId),
          expectedOnChainId,
        );
        if (signal?.aborted) throw signal.reason;
        const explicitNameHash = this.subscribedContextGraphs.get(contextGraphId)?.onChainHash;
        const expectedNameHash = explicitNameHash === undefined
          ? this.contextGraphNameCommitment(contextGraphId)
          : this.contextGraphWireId(explicitNameHash);
        if (!snapshot.active || snapshot.nameHash !== expectedNameHash) {
          throw new Rfc64CatalogAuthorityResolutionErrorV1(
            'registered-authority-binding-mismatch',
            'registered RFC-64 Context Graph authority is inactive or name-bound elsewhere',
          );
        }
        let authoritativeSnapshot = snapshot;
        if (snapshot.accessPolicy === 1) {
          const localRoster = await this.resolveRfc64VerifiedPrivateRosterV1(contextGraphId);
          if (localRoster === null) {
            throw new Error(
              'registered private RFC-64 Context Graph has no authenticated lifecycle roster',
            );
          }
          // The finalized chain snapshot can lag an authenticated local
          // removal. Never union a chain participant back into the catalog
          // roster after the curator has durably revoked that address.
          const revokedAgents = new Set(
            (await this.getCgMeta(contextGraphId)).revokedAgents
              .map((address) => address.toLowerCase()),
          );
          const localRosterVersion = await this.readRfc64PrivateRosterVersionV1(contextGraphId);
          authoritativeSnapshot = Object.freeze({
            ...snapshot,
            participantAgents: Object.freeze([
              ...new Set([
                ...snapshot.participantAgents,
                ...localRoster,
              ].filter((address) => !revokedAgents.has(address))),
            ].sort()),
            rosterVersion: composeRfc64RegisteredRosterVersionV1(
              snapshot.rosterVersion,
              localRosterVersion,
            ),
          });
        }
        authority = composeRfc64FinalizedCatalogAuthorityV1({
          networkId,
          contextGraphId: contextGraphId as ContextGraphIdV1,
          snapshot: authoritativeSnapshot,
        });
      } else {
        const ownerDid = await this.getContextGraphOwner(contextGraphId);
        if (signal?.aborted) throw signal.reason;
        const normalizedOwnerDid = ownerDid
          ?.trim()
          .replace(/^<|>$/gu, '')
          .replace(/^did:dkg:agent:/u, '')
          .toLowerCase();
        // An unregistered graph's owner is an authority fact, not something
        // that may be inferred from an untrusted graph name or this node's
        // wallet. Missing authenticated owner metadata must fail closed.
        const ownerAddress = normalizedOwnerDid;
        if (ownerAddress === undefined || !/^0x[0-9a-f]{40}$/u.test(ownerAddress)) {
          throw new Rfc64CatalogAuthorityResolutionErrorV1(
            'unregistered-owner-unresolved',
            'unregistered RFC-64 Context Graph has no canonical owner address',
          );
        }
        const accessPolicy = await this.getExplicitAccessPolicy(contextGraphId);
        if (signal?.aborted) throw signal.reason;
        if (accessPolicy === null) {
          throw new Rfc64CatalogAuthorityResolutionErrorV1(
            'access-policy-unresolved',
            'unregistered RFC-64 Context Graph access policy is unresolved',
          );
        }
        const stored = await this.getStoredContextGraphRegistrationOptions(contextGraphId);
        const publishPolicy = stored.publishPolicy === 0 || stored.publishPolicy === 1
          ? stored.publishPolicy
          : accessPolicy === 'private' ? 0 : 1;
        const members = accessPolicy === 'private'
          ? await this.resolveRfc64VerifiedPrivateRosterV1(contextGraphId)
          : [];
        if (accessPolicy === 'private' && members === null) {
          throw new Error(
            'unregistered private RFC-64 Context Graph has no authenticated lifecycle roster',
          );
        }
        const rosterVersion = await this.readRfc64PrivateRosterVersionV1(contextGraphId);
        if (signal?.aborted) throw signal.reason;
        authority = composeRfc64UnregisteredCatalogAuthorityV1({
          networkId,
          contextGraphId: contextGraphId as ContextGraphIdV1,
          ownerAddress: ownerAddress as EvmAddressV1,
          accessPolicy: accessPolicy === 'private' ? 1 : 0,
          publishPolicy,
          publishAuthorityAccountId: stored.publishAuthorityAccountId?.toString(10) ?? '0',
          memberAddresses: (members ?? [])
            .map((address) => address.toLowerCase())
            .filter((address) => /^0x[0-9a-f]{40}$/u.test(address)) as EvmAddressV1[],
          rosterVersion,
        });
      }
      const previousAuthority = service.acceptedPolicySnapshot(
        authority.policy.networkId,
        authority.policy.contextGraphId,
      );
      if (!isCurrentRfc64CatalogAuthorityRevisionV1(
        this,
        contextGraphId,
        authorityRevision,
      )) return null;
      const acceptedAuthority = service.acceptAuthoritativePolicySnapshot({
        policy: authority.policy,
        policyDigest: authority.policyDigest,
        roster: authority.roster,
      });
      if (rfc64CatalogAuthorityGenerationChangedV1(previousAuthority, acceptedAuthority)) {
        service.deactivateReceiverContextGraph(contextGraphId);
        this.clearRfc64CatalogOperationalTargetsV1(contextGraphId);
      }
      setRfc64CatalogAuthorityProgressV1(this, contextGraphId, {
        state: 'accepted',
        source: authority.source,
        policyDigest: authority.policyDigest,
        policyEra: authority.policy.era,
        reason: null,
        updatedAtMs: Date.now(),
      });
      await this.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(contextGraphId);
      return authority;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isCurrentRfc64CatalogAuthorityRevisionV1(
        this,
        contextGraphId,
        authorityRevision,
      )) {
        setRfc64CatalogAuthorityProgressV1(this, contextGraphId, {
          state: 'blocked',
          source: null,
          policyDigest: null,
          policyEra: null,
          reason: rfc64CatalogAuthorityFailureCodeV1(error),
          updatedAtMs: Date.now(),
        });
      }
      throw error;
    }
  }

  /**
   * Receiver authority is the configured manifest policy projected through the
   * canonical live subscription registry on edges. Cores deliberately retain
   * manifest-wide receiver activity.
   */
  resolveRfc64CatalogReceiverAuthorityV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Rfc64CatalogAuthorityPolicyV1 {
    // AGENTS and ONTOLOGY are protocol bootstrap/control graphs. RFC-64 never
    // assumes responsibility for them, so they must remain on durable sync
    // even when catalog responsibility is default-on for application CGs.
    if (rfc64SystemContextGraphIdsV1.has(contextGraphId)) {
      return Object.freeze({
        contextGraphId,
        selected: false,
        eligible: false,
        active: true,
        mode: 'legacy',
        killSwitchActive: this.config.rfc64CatalogExecutionPlan.killSwitchActive,
        legacySyncAllowed: true,
        track2Enabled: false,
        authoringAllowed: false,
        reconciliationLane: 'legacy',
      });
    }
    const configured = this.config.rfc64CatalogExecutionPlan
      .selectedAuthority[contextGraphId];
    if (configured?.selected !== true) {
      const compatibility = this.resolveRfc64AcceptedCompatibilityAuthorityV1(
        contextGraphId,
      );
      if (compatibility !== null) return compatibility;
    }
    if (configured !== undefined) {
      const active = (
        (this.config.nodeRole ?? 'edge') === 'core'
        || this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true
      );
      return projectRfc64CatalogReceiverAuthorityV1(configured, { active });
    }
    const selection = rfc64CatalogResponsibilityRegistryForV1(
      this,
      this.config.rfc64CatalogExecutionPlan,
    ).read(contextGraphId);
    const resolved = resolveRfc64CatalogResponsibilityAuthorityV1({
      ...selection,
      killSwitchActive: this.config.rfc64CatalogExecutionPlan.killSwitchActive,
    });
    const authorityProgress = rfc64CatalogAuthorityProgressV1.get(this)?.get(contextGraphId);
    return selection.active && selection.mode !== 'legacy'
      && authorityProgress?.state !== 'accepted'
      ? projectRfc64CatalogReceiverAuthorityV1(resolved, { active: false })
      : resolved;
  }

  /** Serving and explicit repair authority is independent of edge receipt. */
  resolveRfc64CatalogServingAuthorityV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Rfc64CatalogAuthorityPolicyV1 {
    const configured = this.config.rfc64CatalogExecutionPlan
      .selectedAuthority[contextGraphId];
    if (configured?.selected !== true) {
      const compatibility = this.resolveRfc64AcceptedCompatibilityAuthorityV1(
        contextGraphId,
      );
      if (compatibility !== null) return compatibility;
    }
    if (configured !== undefined) return configured;
    const selection = rfc64CatalogResponsibilityRegistryForV1(
      this,
      this.config.rfc64CatalogExecutionPlan,
    ).read(contextGraphId);
    const resolved = resolveRfc64CatalogResponsibilityAuthorityV1({
      ...selection,
      killSwitchActive: this.config.rfc64CatalogExecutionPlan.killSwitchActive,
    });
    const authorityProgress = rfc64CatalogAuthorityProgressV1.get(this)?.get(contextGraphId);
    return selection.active && selection.mode !== 'legacy'
      && authorityProgress?.state !== 'accepted'
      ? projectRfc64CatalogReceiverAuthorityV1(resolved, { active: false })
      : resolved;
  }

  /**
   * Preserve the pre-10.0.16 direct policy-acceptance API as an additive
   * compatibility lane only after that API explicitly accepted the CG in this
   * process. A selected release-native manifest still takes precedence, and
   * an unsubscribed default Edge cannot manufacture this compatibility mark.
   */
  private resolveRfc64AcceptedCompatibilityAuthorityV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Rfc64CatalogAuthorityPolicyV1 | null {
    const plan = this.config.rfc64CatalogExecutionPlan;
    if (
      plan.killSwitchActive
      || plan.responsibilityDefaultMode === 'legacy'
      || plan.selectedAuthority[contextGraphId]?.selected === true
    ) return null;
    if (
      this.rfc64PublicCatalogServiceV1 === undefined
      || rfc64DirectAcceptedCompatibilityV1.get(this)?.has(contextGraphId) !== true
    ) return null;
    return Object.freeze({
      contextGraphId,
      selected: false,
      eligible: false,
      active: true,
      mode: 'catalog',
      killSwitchActive: false,
      legacySyncAllowed: true,
      track2Enabled: true,
      authoringAllowed: true,
      reconciliationLane: 'catalog-apply',
    });
  }

  /** Safe runtime selection projection for daemon status and release harnesses. */
  readRfc64CatalogRuntimeSelectionV1(
    this: DKGAgent,
  ): Readonly<Rfc64CatalogRuntimeSelectionStatusV1> {
    const responsibilities = this.readRfc64CatalogResponsibilitiesV1();
    const eligibleContextGraphs = Object.freeze([...new Set([
      ...Object.keys(this.config.rfc64CatalogExecutionPlan.selectedAuthority),
      ...responsibilities.map(({ contextGraphId }) => contextGraphId),
    ])].sort());
    const subscriptionDriven = (this.config.nodeRole ?? 'edge') === 'edge';
    return Object.freeze({
      subscriptionDriven,
      eligibleContextGraphs,
      selectedContextGraphs: subscriptionDriven
        ? Object.freeze(eligibleContextGraphs.filter((contextGraphId) => (
          this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true
        )))
        : eligibleContextGraphs,
    });
  }

  /** Start the complete agent-owned RFC-64 catalog runtime. */
  startRfc64CatalogRuntimeV1(this: DKGAgent, ctx: OperationContext): void {
    this.rfc64CatalogRuntimeV1.start(ctx);
  }

  /**
   * @deprecated Use `startRfc64CatalogRuntimeV1`. Kept as a patch-release
   * compatibility alias while the complete runtime owns the service lifecycle.
  */
  startRfc64PublicCatalogServiceV1(this: DKGAgent, ctx: OperationContext): void {
    // Preserve the patch-release alias's former readiness contract. Calling it
    // before agent.start() must not commit the aggregate runtime to a dormant
    // started state merely because persistence has not opened yet. Intentional
    // kill-switch and legacy-mode dormancy are still decided by the aggregate
    // once persistence is available.
    if (this.rfc64PersistenceV1 === undefined) return;
    this.startRfc64CatalogRuntimeV1(ctx);
  }

  /** Construct the transport, or return null while RFC-64 is dormant. */
  createRfc64PublicCatalogServiceV1(
    this: DKGAgent,
    ctx: OperationContext,
  ): Rfc64PublicCatalogServiceV1 | null {
    if (this.config.rfc64CatalogExecutionPlan.killSwitchActive) {
      this.log.warn(ctx, 'RFC-64 catalog kill switch is active; Track-2 protocols are dormant');
      return null;
    }
    if (
      !this.config.rfc64CatalogExecutionPlan.standaloneTrack2Enabled
      && this.config.rfc64CatalogExecutionPlan.responsibilityDefaultMode === 'legacy'
      && this.config.rfc64CatalogExecutionPlan.track2ContextGraphs.length === 0
    ) {
      this.log.info(ctx, 'RFC-64 catalog protocols are dormant; every selected CG is legacy-mode');
      return null;
    }
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) return null;
    const verifyIssuerSignature = verifyControlEnvelopeIssuerSignatureV1;
    let nextReconciliationAttemptToken = 0;
    const reconciliationAttempts = new Map<number, Readonly<{
      announcement: Rfc64PublicCatalogHeadAnnouncementV1;
      succeeded: { value: boolean };
      terminalOutcome: { value: Rfc64PublicCatalogReceiverCompletionOutcomeV1 | null };
    }>>();
    const verifiedTargetLeases = new Map<number, Rfc64CatalogTargetLeaseV1>();
    const service = new Rfc64PublicCatalogServiceV1({
      router: this.router,
      controlObjects: persistence.controlObjects,
      localPeerId: this.peerId,
      accessPolicyAuthority: this.config.rfc64CatalogAccessPolicyAuthority
        ?? {
          resolveLocalAgentAddress: (contextGraphId) =>
            this.resolveRfc64CatalogLocalAgentAddressV1(contextGraphId),
          resolveRemoteAgentAddress: (peerId, contextGraphId) =>
            this.resolveRfc64CatalogRemoteAgentAddressV1(peerId, contextGraphId),
        },
      native: this.createRfc64PublicCatalogNativeOptionsV1(verifyIssuerSignature),
      verifyIssuerSignature,
      resolveContextGraphAuthority: (contextGraphId, direction) =>
        direction === 'serving'
          ? this.resolveRfc64CatalogServingAuthorityV1(contextGraphId)
          : this.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId),
      runCatalogMutationExclusive: (scope, operation, signal) =>
        this.rfc64CatalogMutationCoordinatorV1.run(scope, operation, signal),
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
        onReconciliationAttemptStart: (announcement) => {
          const token = ++nextReconciliationAttemptToken;
          reconciliationAttempts.set(token, Object.freeze({
            announcement,
            succeeded: { value: false },
            terminalOutcome: { value: null },
          }));
          return token;
        },
        onReconciliationAttemptSuccess: (announcement, token) => {
          // A retained failed/not-found verified target may later converge
          // through the ambient lane. Exact retirement must not depend on the
          // optional attempt-observer bookkeeping still being present.
          retireRfc64CatalogTargetAnnouncementV1(this, announcement);
          const attempt = reconciliationAttempts.get(token);
          if (attempt === undefined) return;
          attempt.succeeded.value = true;
        },
        onVerifiedCurrentHeadTargetAccepted: (announcement, targetToken) => {
          verifiedTargetLeases.set(
            targetToken,
            recordRfc64CatalogTargetAnnouncementV1(this, announcement),
          );
        },
        onVerifiedCurrentHeadTargetRejected: (announcement) => {
          rejectRfc64CatalogTargetAnnouncementV1(this, announcement);
          this.rfc64PublicCatalogReconciliationFailuresV1.record(
            announcement.catalogHeadObjectDigest,
            Object.assign(
              new Error('RFC-64 verified current-head admission queue is full'),
              {
                name: 'Rfc64VerifiedCurrentHeadAdmissionErrorV1',
                code: 'catalog-receiver-queue-full',
              },
            ),
          );
        },
        onVerifiedCurrentHeadTargetSettled: (
          announcement,
          targetToken,
          token,
          outcome,
        ) => {
          if (token !== null) {
            const attempt = reconciliationAttempts.get(token);
            if (attempt !== undefined) attempt.terminalOutcome.value = outcome;
          }
          const lease = verifiedTargetLeases.get(targetToken);
          verifiedTargetLeases.delete(targetToken);
          if (lease !== undefined) {
            rfc64CatalogTargetAnnouncementsV1.get(this)?.settle(lease, outcome);
          }
        },
        onReconciliationAttemptEnd: (_announcement, token) => {
          const attempt = reconciliationAttempts.get(token);
          reconciliationAttempts.delete(token);
          if (attempt === undefined || attempt.succeeded.value) return;
          if (
            attempt.terminalOutcome.value === 'failed'
            || attempt.terminalOutcome.value === 'closed'
            || attempt.terminalOutcome.value === 'staged-only'
            || attempt.terminalOutcome.value === 'dropped'
          ) return;
          // A not-found terminal result has no thrown error callback, but it
          // is still a failed expected-head advance for operational status.
          this.rfc64PublicCatalogReconciliationFailuresV1.record(
            attempt.announcement.catalogHeadObjectDigest,
            new Error('RFC-64 catalog reconciliation ended without applying the scheduled head'),
          );
        },
        onHeadApplied: (announcement) => {
          const authorAddress = announcement.authorAddress.toLowerCase();
          if (!this.listLocalAgents().some(
            ({ agentAddress }) => agentAddress.toLowerCase() === authorAddress,
          )) return;
          this.requestRfc64SwmCatalogProjectionV1({
            contextGraphId: announcement.contextGraphId,
            authorAddress: authorAddress as EvmAddressV1,
            ctx,
          });
        },
        onError: (announcement, error) => {
          this.rfc64PublicCatalogReconciliationFailuresV1.record(
            announcement.catalogHeadObjectDigest,
            error,
          );
          const failure = this.rfc64PublicCatalogReconciliationFailuresV1.read(
            announcement.catalogHeadObjectDigest,
          );
          this.log.warn(
            ctx,
            `RFC-64 catalog reconciliation failed head=${announcement.catalogHeadObjectDigest}`
              + ` error=${failure?.errorName ?? 'UnknownError'}`
              + ` code=${failure?.errorCode ?? 'none'}`
              + ` cause=${failure?.causeCode ?? 'none'}`
              + ` detail=${error instanceof Rfc64PublicCatalogNativeReceiverErrorV1
                ? error.message
                : 'unavailable'}`,
          );
        },
      },
      onCatalogHeadReplayRequested: (request, remotePeerId) => {
        const admission = this.tryQueueRfc64CatalogHeadReplayV1(remotePeerId, request);
        if (admission.status === 'busy') return admission;
        if (admission.newlyQueued) {
          void admission.completion
            .then((result) => {
              if (result.announced > 0) {
                this.log.info(
                  ctx,
                  `Replayed ${result.announced} RFC-64 catalog head(s) to ${remotePeerId.slice(-8)}`,
                );
              }
            })
            .catch((error: unknown) => {
              this.log.warn(
                ctx,
                `RFC-64 catalog head replay failed for ${remotePeerId.slice(-8)}: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }
        return admission;
      },
    });
    return service;
  }

  /** Fence receiver admission while keeping local authoring transports live. */
  async closeRfc64PublicCatalogReceiverAdmissionV1(this: DKGAgent): Promise<void> {
    await this.rfc64PublicCatalogOwnerV1.closeReceiverAdmission();
  }

  /** Close the complete agent-owned RFC-64 catalog runtime. */
  closeRfc64CatalogRuntimeV1(this: DKGAgent): Promise<void> {
    return this.rfc64CatalogRuntimeV1.close();
  }

  /**
   * @deprecated Use `closeRfc64CatalogRuntimeV1`. Kept as a patch-release
   * compatibility alias while preserving the complete physical drain.
   */
  closeRfc64PublicCatalogServiceV1(this: DKGAgent): Promise<void> {
    return this.closeRfc64CatalogRuntimeV1();
  }

  /** Final runtime stage after transport and every workload physically retire. */
  async closeRfc64PublicCatalogMutationPersistenceV1(this: DKGAgent): Promise<void> {
    try {
      await this.rfc64CatalogMutationCoordinatorV1.closeAndDrain();
    } finally {
      this.rfc64PublicCatalogSynchronizationEvidenceV1.clear();
      this.rfc64PublicCatalogReconciliationFailuresV1.clear();
      rfc64DirectAcceptedCompatibilityV1.delete(this);
      rfc64CatalogReplayRuntimesV1.delete(this);
      rfc64CatalogReplayProgressV1.delete(this);
      rfc64CatalogReplayStatusRevisionV1.delete(this);
      rfc64CatalogTargetAnnouncementsV1.get(this)?.resetAll();
      rfc64CatalogTargetAnnouncementsV1.delete(this);
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
    const service = this.requireRfc64PublicCatalogServiceV1();
    const previousAuthority = service.acceptedPolicySnapshot(
      input.networkId,
      input.contextGraphId,
    );
    const accepted = service.acceptOpenPolicy(input);
    if (rfc64CatalogAuthorityGenerationChangedV1(previousAuthority, accepted)) {
      service.deactivateReceiverContextGraph(input.contextGraphId);
      this.clearRfc64CatalogOperationalTargetsV1(input.contextGraphId);
    }
    markRfc64DirectAcceptedCompatibilityV1(this, input.contextGraphId);
    return accepted;
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
    const service = this.requireRfc64PublicCatalogServiceV1();
    const previousAuthority = service.acceptedPolicySnapshot(
      input.policy.networkId,
      input.policy.contextGraphId,
    );
    const accepted = service.acceptPolicySnapshot(input);
    if (rfc64CatalogAuthorityGenerationChangedV1(previousAuthority, accepted)) {
      service.deactivateReceiverContextGraph(input.policy.contextGraphId);
      this.clearRfc64CatalogOperationalTargetsV1(input.policy.contextGraphId);
    }
    markRfc64DirectAcceptedCompatibilityV1(this, input.policy.contextGraphId);
    return accepted;
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
    markRfc64DirectAcceptedCompatibilityV1(this, params.contextGraphId);
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

  /** Re-advertise durable current heads to one newly admitted peer. */
  async queueRfc64CatalogHeadReplayV1(
    this: DKGAgent,
    peerId: string,
    requestedScope: Readonly<Rfc64PublicCatalogHeadReplayRequestV1>,
  ): Promise<Readonly<Rfc64CatalogReplayResultV1>> {
    const admission = this.tryQueueRfc64CatalogHeadReplayV1(peerId, requestedScope);
    if (admission.status === 'busy') {
      throw new Error('RFC-64 catalog head replay queue is full');
    }
    return admission.completion;
  }

  /** Admit replay work synchronously so the wire ACK cannot outrun the queue. */
  tryQueueRfc64CatalogHeadReplayV1(
    this: DKGAgent,
    peerId: string,
    requestedScope: Readonly<Rfc64PublicCatalogHeadReplayRequestV1>,
  ): Rfc64CatalogReplayAdmissionV1 {
    const runtime = rfc64CatalogReplayRuntimeForV1(this);
    const key = [
      peerId,
      requestedScope.networkId,
      requestedScope.contextGraphId,
      requestedScope.policyDigest,
    ].join('\0');
    const coalesced = runtime.pending.get(key);
    if (coalesced !== undefined) {
      return Object.freeze({
        status: 'admitted',
        newlyQueued: false,
        completion: coalesced,
      });
    }
    const peerPending = runtime.pendingByPeer.get(peerId) ?? 0;
    if (
      runtime.pending.size >= RFC64_CATALOG_REPLAY_MAX_QUEUED_V1
      || peerPending >= RFC64_CATALOG_REPLAY_MAX_QUEUED_PER_PEER_V1
    ) {
      return Object.freeze({ status: 'busy' });
    }
    const run = runtime.tail
      .catch(() => undefined)
      .then(() => this.reannounceRfc64CatalogHeadsToPeerV1(peerId, requestedScope));
    runtime.tail = run.then(() => undefined, () => undefined);
    runtime.pending.set(key, run);
    runtime.pendingByPeer.set(peerId, peerPending + 1);
    void run.finally(() => {
      if (runtime.pending.get(key) === run) runtime.pending.delete(key);
      const remaining = (runtime.pendingByPeer.get(peerId) ?? 1) - 1;
      if (remaining <= 0) runtime.pendingByPeer.delete(peerId);
      else runtime.pendingByPeer.set(peerId, remaining);
    }).catch(() => undefined);
    return Object.freeze({ status: 'admitted', newlyQueued: true, completion: run });
  }

  private async readRfc64CatalogReplayIndexV1(
    this: DKGAgent,
  ): Promise<ReadonlyMap<string, readonly Rfc64CatalogReplayHeadV1[]>> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) return new Map();
    const runtime = rfc64CatalogReplayRuntimeForV1(this);
    const snapshots = persistence.inventory.listAppliedCatalogHeadsV1();
    const fingerprint = rfc64CatalogReplayInventoryFingerprintV1(snapshots);
    if (runtime.indexFingerprint === fingerprint) return runtime.indexByScope;

    const index = new Map<string, Rfc64CatalogReplayHeadV1[]>();
    for (const applied of snapshots) {
      const stored = await persistence.controlObjects.getVerifiedObjectByDigest({
        objectDigest: applied.currentCatalogHeadDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      }).catch(() => null);
      if (stored === null) {
        throw new Error('RFC-64 durable catalog head is missing or unverifiable');
      }
      try {
        assertSignedAuthorCatalogHeadEnvelopeV1(stored.envelope);
        const head = stored.envelope;
        const scope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
        if (
          computeAuthorCatalogScopeDigestV1(scope) !== applied.catalogScopeDigest
          || head.payload.authorAddress !== applied.authorAddress
          || head.payload.version !== applied.catalogVersion
        ) {
          throw new Error('RFC-64 durable catalog head does not match its applied inventory row');
        }
        const key = rfc64CatalogReplayScopeKeyV1(
          head.payload.networkId,
          head.payload.contextGraphId,
        );
        const entries = index.get(key) ?? [];
        entries.push(Object.freeze({ head }));
        index.set(key, entries);
      } catch (cause) {
        throw new Error('RFC-64 durable catalog inventory contains an invalid head', {
          cause,
        });
      }
    }
    runtime.indexFingerprint = fingerprint;
    runtime.indexByScope = new Map([...index].map(([key, entries]) => [
      key,
      Object.freeze(entries),
    ]));
    return runtime.indexByScope;
  }

  async reannounceRfc64CatalogHeadsToPeerV1(
    this: DKGAgent,
    peerId: string,
    requestedScope?: Readonly<Rfc64PublicCatalogHeadReplayRequestV1>,
  ): Promise<Readonly<Rfc64CatalogReplayResultV1>> {
    const service = this.rfc64PublicCatalogServiceV1;
    const persistence = this.rfc64PersistenceV1;
    if (service === undefined || persistence === undefined) {
      if (requestedScope !== undefined) {
        throw new Error('RFC-64 scoped catalog replay service is unavailable');
      }
      return Object.freeze({ announced: 0, failed: 0, manifest: Object.freeze([]) });
    }
    let announced = 0;
    let failed = 0;
    const replayInventoryFingerprint = rfc64CatalogReplayInventoryFingerprintV1(
      persistence.inventory.listAppliedCatalogHeadsV1(),
    );
    const index = await this.readRfc64CatalogReplayIndexV1();
    const entries = requestedScope === undefined
      ? [...index.values()].flat()
      : index.get(rfc64CatalogReplayScopeKeyV1(
        requestedScope.networkId,
        requestedScope.contextGraphId,
      )) ?? [];
    const replayScopes = [...new Map(entries.map(({ head }) => {
      const scope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
      return [
        `${computeAuthorCatalogScopeDigestV1(scope)}\0${scope.authorAddress}`,
        scope,
      ] as const;
    })).entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, scope]) => scope);
    const runWithReplayScopesLocked = async <T>(
      scopeIndex: number,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const scope = replayScopes[scopeIndex];
      if (scope === undefined) return operation();
      return this.rfc64CatalogMutationCoordinatorV1.run(
        scope,
        () => runWithReplayScopesLocked(scopeIndex + 1, operation),
      );
    };
    return runWithReplayScopesLocked(0, async () => {
      if (rfc64CatalogReplayInventoryFingerprintV1(
        persistence.inventory.listAppliedCatalogHeadsV1(),
      ) !== replayInventoryFingerprint) {
        throw new Error('RFC-64 durable catalog inventory changed before replay snapshot');
      }
      const manifest: Rfc64PublicCatalogHeadAnnouncementV1[] = [];
      for (const { head } of entries) {
        const servingAuthority = this.resolveRfc64CatalogServingAuthorityV1(
          head.payload.contextGraphId,
        );
        const accepted = service.acceptedPolicySnapshot(
          head.payload.networkId,
          head.payload.contextGraphId,
        );
        if (!servingAuthority.track2Enabled || accepted === null) {
          if (requestedScope !== undefined) {
            throw new Error('RFC-64 scoped catalog replay authority is unavailable');
          }
          continue;
        }
        if (
          requestedScope !== undefined
          && accepted.policyDigest !== requestedScope.policyDigest
        ) {
          throw new Error('RFC-64 scoped catalog replay policy changed before snapshot');
        }
        manifest.push(Object.freeze({
          kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
          networkId: head.payload.networkId,
          contextGraphId: head.payload.contextGraphId,
          subGraphName: head.payload.subGraphName,
          authorAddress: head.payload.authorAddress,
          catalogEra: head.payload.era,
          catalogVersion: head.payload.version,
          policyDigest: accepted.policyDigest,
          catalogHeadObjectDigest: head.objectDigest as Digest32V1,
          signatureVariantDigest: computeControlSignatureVariantDigestHex(
            head.objectDigest,
            head.signature,
          ) as Digest32V1,
        }));
      }
      if (manifest.length > RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1) {
        throw new Error('RFC-64 scoped catalog replay manifest exceeds the per-CG target cap');
      }
      manifest.sort((left, right) => {
        const leftKey = rfc64CatalogTargetExactIdentityKeyV1(left);
        const rightKey = rfc64CatalogTargetExactIdentityKeyV1(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      const completedManifest: Rfc64PublicCatalogHeadAnnouncementV1[] = [];
      for (const announcement of manifest) {
        try {
          const delivery = await service.announceCatalogHead({
            announcement,
            peers: [peerId],
          });
          announced += delivery.announcedPeers.length;
          failed += delivery.failedPeers.length;
          if (delivery.announcedPeers.length === 1) {
            completedManifest.push(announcement);
          }
        } catch {
          failed += 1;
        }
      }
      if (rfc64CatalogReplayInventoryFingerprintV1(
        persistence.inventory.listAppliedCatalogHeadsV1(),
      ) !== replayInventoryFingerprint) {
        throw new Error('RFC-64 durable catalog inventory changed during replay');
      }
      return Object.freeze({
        announced,
        failed,
        manifest: Object.freeze(completedManifest),
      });
    });
  }

  /** Request scoped head replay from already-connected peers after late activation. */
  async requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<Readonly<{ requested: number; failed: number }>> {
    const service = this.rfc64PublicCatalogServiceV1;
    const networkId = (
      this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.config.networkIdentity?.chainId
    ) as NetworkIdV1 | undefined;
    const accepted = service !== undefined && networkId !== undefined && networkId !== 'none'
      ? service.acceptedPolicySnapshot(
        networkId,
        contextGraphId as ContextGraphIdV1,
      )
      : null;
    if (
      service === undefined
      || networkId === undefined
      || networkId === 'none'
      || accepted === null
    ) {
      return Object.freeze({ requested: 0, failed: 0 });
    }
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(
      this.node.libp2p.getPeers().map((peer) => peer.toString()).slice(0, 64),
    );
    const replayProgress = rfc64CatalogReplayProgressForV1(
      this,
      contextGraphId,
      accepted.policyDigest,
    );
    for (const peer of peers) replayProgress.pendingPeers.add(peer);
    if (replayProgress.pendingPeers.size === 0) {
      return Object.freeze({ requested: 0, failed: 0 });
    }
    if (replayProgress.completion !== null) return replayProgress.completion;
    replayProgress.token += 1;
    const token = replayProgress.token;
    replayProgress.active = true;
    replayProgress.failed = false;
    bumpRfc64CatalogReplayStatusRevisionV1(this);
    const run = (async (): Promise<Readonly<{ requested: number; failed: number }>> => {
      let requested = 0;
      let failed = 0;
      let replayFailed = true;
      try {
        const manifests: Rfc64PublicCatalogHeadAnnouncementV1[][] = [];
        for (;;) {
          const replayPeers = [...replayProgress.pendingPeers];
          replayProgress.pendingPeers.clear();
          await Promise.all(replayPeers.map(async (remotePeerId) => {
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                const completion = await service.requestCatalogHeadReplay({
                  remotePeerId,
                  networkId,
                  contextGraphId: contextGraphId as ContextGraphIdV1,
                });
                manifests.push([...completion.heads]);
                requested += 1;
                return;
              } catch (error) {
                // A connected peer that does not hold the current CG is not a
                // promised provider. Policy denial is therefore a bounded
                // negative discovery result, while unsupported V2, malformed
                // completion, transport failure, and provider incompleteness
                // remain fail-closed.
                if (
                  error instanceof Rfc64PublicCatalogTransportErrorV1
                  && error.code === 'catalog-transport-policy-denied'
                ) return;
                if (attempt === 1) failed += 1;
              }
            }
          }));
          // Completion-capable provider responses are returned only after every
          // promised announcement is synchronously admitted at this receiver.
          await service.whenReceiverIdle();
          if (replayProgress.pendingPeers.size > 0) continue;

          const promisedByIdentity = new Map<string, Rfc64PublicCatalogHeadAnnouncementV1>();
          for (const target of manifests.flat()) {
            promisedByIdentity.set(rfc64CatalogTargetExactIdentityKeyV1(target), target);
          }
          const promised = [...promisedByIdentity.values()];
          let parityFailures = 0;
          if (promised.length > RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1) {
            parityFailures = 1;
          } else if (this.rfc64PersistenceV1 === undefined) {
            parityFailures = 1;
          } else {
            const applied = new Map(
              (await loadRfc64OperationalAppliedHeadsV1(this.rfc64PersistenceV1))
                .filter((head) => head.contextGraphId === contextGraphId)
                .map((head) => [head.scopeKey, head]),
            );
            const unsatisfied = promised.some((target) => {
              const current = applied.get(rfc64CatalogTargetScopeKeyV1(target));
              if (current === undefined) return true;
              const currentVersion = BigInt(current.snapshot.catalogVersion);
              const promisedVersion = BigInt(target.catalogVersion);
              return currentVersion < promisedVersion || (
                currentVersion === promisedVersion
                && current.snapshot.currentCatalogHeadDigest
                  !== target.catalogHeadObjectDigest
              );
            });
            if (unsatisfied) parityFailures = 1;
          }
          // A connection arriving during the asynchronous durable parity read
          // owns another replay pass; never settle the coalesced run around it.
          if (replayProgress.pendingPeers.size > 0) continue;
          failed += parityFailures;
          break;
        }
        replayFailed = failed > 0;
        return Object.freeze({ requested, failed });
      } catch {
        failed += 1;
        return Object.freeze({ requested, failed });
      } finally {
        const current = rfc64CatalogReplayProgressV1.get(this)?.get(contextGraphId);
        if (current === replayProgress && current.token === token) {
          current.active = false;
          current.failed = replayFailed;
          current.completion = null;
          bumpRfc64CatalogReplayStatusRevisionV1(this);
        }
      }
    })();
    replayProgress.completion = run;
    return run;
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
    this.assertRfc64CatalogAuthoringAuthorityV1();
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
    this.assertRfc64CatalogAuthoringAuthorityV1(scope.contextGraphId);
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
    this.assertRfc64CatalogAuthoringAuthorityV1();
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 persistence is not available');
    }
    const history = await loadBoundedAuthorCatalogHistoryV1(persistence, params.previousHead);
    return this.publishAuthorCatalogExactSetSuccessorFromHistoryV1(params, history);
  }

  /** Reject a disabled successor before any durable mutation. */
  private assertRfc64CatalogAuthoringAuthorityV1(
    this: DKGAgent,
    contextGraphId?: string,
  ): void {
    if (this.config.rfc64CatalogExecutionPlan.killSwitchActive) {
      throw new Error('RFC-64 catalog authoring is disabled by the Track-2 kill switch');
    }
    if (
      contextGraphId !== undefined
      && !this.resolveRfc64CatalogServingAuthorityV1(contextGraphId).authoringAllowed
    ) {
      throw new Error('RFC-64 catalog authoring is disabled for legacy-mode CG');
    }
  }

  private async publishAuthorCatalogExactSetSuccessorFromHistoryV1(
    this: DKGAgent,
    params: PublishAuthorCatalogExactSetSuccessorParamsV1,
    history: BoundedAuthorCatalogHistoryV1,
  ): Promise<PublishAuthorCatalogExactSetSuccessorResultV1> {
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(params.peers);
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 persistence is not available');
    }
    const scope = deriveAuthorCatalogScopeFromHeadV1(history.previousHead.payload);
    this.assertRfc64CatalogAuthoringAuthorityV1(scope.contextGraphId);
    const service = this.requireRfc64PublicCatalogServiceV1();
    const heldPolicy = service.acceptedPolicySnapshotForCatalogScope(scope);
    const policyDigest = heldPolicy.policyDigest;
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
      readKaBundleByDigest: persistence.kaBundles.readKaBundleByDigest,
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
    const signedBucketRowCount = produced.publication.bucket?.payload.rows.length.toString() ?? '0';
    if (
      signedBucketRowCount !== head.payload.totalRows
      || (head.payload.totalRows === '0' && produced.publication.bucket !== null)
      || (head.payload.totalRows !== '0' && produced.publication.bucket === null)
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
  ): Rfc64CatalogSynchronizationEvidenceV1 | null {
    const evidence = this.rfc64PublicCatalogSynchronizationEvidenceV1.get(
      catalogHeadDigest,
    );
    return evidence ?? null;
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
        ...(failure.causeCode === undefined ? {} : { causeCode: failure.causeCode }),
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
    verifyIssuerSignature: typeof verifyControlEnvelopeIssuerSignatureV1,
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
    const resolveScopedReadCapability = createRfc64CatalogNativeScopedReadProviderV1({
      controlObjects: persistence.controlObjects,
      kaBundles: persistence.kaBundles,
      verifyIssuerSignature,
      resolveAcceptedPolicySnapshot: (networkId, contextGraphId) =>
        this.requireRfc64PublicCatalogServiceV1().acceptedPolicySnapshot(
          networkId,
          contextGraphId,
        ),
    });
    let readNativeResourceStats: () => ReturnType<
      Rfc64PublicCatalogNativeReceiverV1['resourceStats']
    > | null = () => null;
    return Object.freeze({
      readCatalogObjectByDigest: async (objectDigest: Digest32V1) => {
        const stored = await persistence.controlObjects.getVerifiedObjectByDigest({
          objectDigest,
          verifyIssuerSignature,
        });
        return stored?.envelope ?? null;
      },
      readKaBundleByDigest: persistence.kaBundles.readKaBundleByDigest,
      resolveScopedReadCapability,
      readResourceStats: () => readNativeResourceStats(),
      createReconciler: (clients: Readonly<Rfc64PublicCatalogReconcilerClientsV1>) => {
        const chainConfig = this.config.chainConfig;
        const acceptedPolicySnapshotForCatalogScope = (scope: AuthorCatalogScopeV1) =>
          this.requireRfc64PublicCatalogServiceV1()
            .acceptedPolicySnapshotForCatalogScope(scope);
        const finalizedPolicyPrecommit = createRfc64FinalizedPolicyAgentPrecommitV1({
          acceptedPolicySnapshotForCatalogScope,
          rpcEndpoints: chainConfig === undefined
            ? null
            : resolveRpcUrls(chainConfig.rpcUrl, chainConfig.rpcUrls),
          getOnChainContextGraphId: (contextGraphId, signal) =>
            this.getContextGraphOnChainId(contextGraphId, { signal }),
          getEvmChainId: () => this.chain.getEvmChainId(),
        });
        const finalizedVmPrecommit = createRfc64FinalizedVmAgentPrecommitV1({
          acceptedPolicySnapshotForCatalogScope,
          rpcEndpoints: chainConfig === undefined
            ? null
            : resolveRpcUrls(chainConfig.rpcUrl, chainConfig.rpcUrls),
          getOnChainContextGraphId: (contextGraphId, signal) =>
            this.getContextGraphOnChainId(contextGraphId, { signal }),
          getEvmChainId: () => this.chain.getEvmChainId(),
          getKnowledgeAssetStorageAddress: async () => {
            if (typeof this.chain.getDKGKnowledgeAssetsAddress !== 'function') {
              throw new Error('RFC-64 finalized VM recovery requires KnowledgeAssetStorage');
            }
            return this.chain.getDKGKnowledgeAssetsAddress();
          },
          getKnowledgeAssetsLifecycleAddress: () =>
            this.chain.getKnowledgeAssetsLifecycleAddress(),
          store: this.store,
        });
        const beforeAppliedHeadCommit = createRfc64CatalogAppliedHeadCoordinatorV1({
          acceptedPolicySnapshotForCatalogScope,
          finalizedPolicyPrecommit,
          finalizedVmPrecommit,
          store: this.store,
          writeLocks: this.writeLocks,
          retire: (retirement, ctx) => this.publisher.clearPublishedKnowledgeAssetSwm(
            retirement.contextGraphId,
            {
              kind: 'named-lifecycle',
              identity: {
                agentAddress: retirement.agentAddress,
                kaNumber: retirement.kaNumber,
              },
            },
            retirement.subGraphName,
            ctx,
            retirement.kaUal,
          ),
          logInfo: (ctx, message) => this.log.info(ctx, message),
        });
        const nativeReceiver = new Rfc64PublicCatalogNativeReceiverV1<
          Rfc64CatalogAppliedHeadEvidenceV1
        >({
          headTransport: clients.headTransport,
          contentTransport: clients.contentTransport,
          controlObjects: persistence.controlObjects,
          inventory: persistence.inventory,
          kaBundles: persistence.kaBundles,
          store: this.store,
          verifyIssuerSignature: clients.verifyIssuerSignature,
          beforeAppliedHeadCommit,
          transportTimeoutMs: clients.transportTimeoutMs,
        });
        readNativeResourceStats = () => nativeReceiver.resourceStats();
        const synchronizeBoundedPublicRootCatalog:
          Rfc64BoundedPublicRootCatalogNativeReceiverClientV1[
            'synchronizeBoundedPublicRootCatalog'
          ] = async (
            remotePeerId,
            announcement,
            trustedCatalogScope,
            deployment,
            signal,
          ) => {
            const evidence = await nativeReceiver.synchronizeBoundedPublicRootCatalog(
              remotePeerId,
              announcement,
              trustedCatalogScope,
              deployment,
              signal,
            );
            const current = snapshotRfc64CatalogSynchronizationEvidenceV1(evidence);
            const previous = this.rfc64PublicCatalogSynchronizationEvidenceV1.get(
              evidence.catalogHeadDigest,
            );
            const observed = previous === undefined
              ? current
              : reduceRfc64CatalogSynchronizationEvidenceReplayV1(previous, current);
            this.rfc64PublicCatalogSynchronizationEvidenceV1.set(
              evidence.catalogHeadDigest,
              observed,
            );
            return evidence;
          };
        const nativeReceiverClient: Rfc64BoundedPublicRootCatalogNativeReceiverClientV1 =
          Object.freeze({
            synchronizeBoundedPublicRootCatalog,
          });
        const reconciler = createRfc64BoundedPublicRootCatalogNativeReconcilerV1({
          nativeReceiver: nativeReceiverClient,
          inventory: persistence.inventory,
          resolveTrustedCatalogScope: clients.resolveTrustedCatalogScope,
          resolveDeployment,
          requiresAppliedHeadPrecommit: (announcement) => {
            const accepted = this.requireRfc64PublicCatalogServiceV1()
              .acceptedPolicySnapshotForCatalogScope(
                clients.resolveTrustedCatalogScope(announcement),
              );
            return accepted.policy.accessPolicy === 1
              && accepted.policy.source.kind === 'finalized-chain'
              // A durable head alone cannot prove that finalized VM/SWM
              // post-commit work finished on a prior process, so restart must
              // replay it. Within this process, however, synchronization
              // evidence is recorded only after that lifecycle succeeds and
              // safely closes the scheduler's check/lock race for this head.
              && !this.rfc64PublicCatalogSynchronizationEvidenceV1.has(
                announcement.catalogHeadObjectDigest,
              );
          },
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
