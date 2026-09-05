// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 Gate 1 public author-catalog service.
 *
 * Cohesive owner of the public catalog slice wired into a running DKGAgent:
 *   - constructs {@link Rfc64PublicCatalogTransportV1} on the agent's PRODUCTION
 *     {@link ProtocolRouter} (admission-gated exactly like every other node
 *     protocol; on a chain-free node admission is disabled and it is open),
 *   - routes untrusted availability hints into the {@link Rfc64PublicCatalogReceiverV1}
 *     scheduler, whose production reconciler owns fetch, semantic activation,
 *     exact post-read, and durable applied-inventory commit,
 *   - answers the transport's open-policy check from the accepted-policy
 *     registry ({@link Rfc64AcceptedOpenCatalogPolicyRegistryV1}),
 *   - and provides the author path: sign + durably stage the direct-author
 *     issuer delegation, produce + durably stage its bound genesis head, then
 *     best-effort announce availability to peers.
 *
 * Omitting a reconciler retains a staging-only diagnostic mode for the earlier
 * Gate-1A demo. That mode never reports a head as applied and never uses staged
 * control objects as restart dedup state.
 */

import {
  assertAuthorCatalogScopeV1,
  assertAuthorCatalogHeadScopeBindingV1,
  computeControlSignatureVariantDigestHex,
  type ProtocolRouter,
  type SendOptions,
  type SignedControlEnvelopeV1,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type NetworkIdV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import {
  produceEmptyAuthorCatalogGenesisV1,
  type Rfc64AuthorCatalogEip191SignerV1,
} from './author-catalog-producer.js';
import type {
  Rfc64ControlObjectOperationsV1,
  StageVerifiedControlObjectV1,
  StageVerifiedControlObjectsResultV1,
} from './control-object-store-v1.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  computeOpenContextGraphPolicyDigestV1,
  type AcceptedOpenCatalogPolicyV1,
  type BuildOpenOwnerContextGraphPolicyInputV1,
} from './open-catalog-policy-v1.js';
import {
  Rfc64CatalogAccessPolicyRegistryV1,
  rfc64CatalogAuthorityDirectionV1,
  type AcceptRfc64CatalogAccessSnapshotInputV1,
  type AcceptedRfc64CatalogAccessSnapshotV1,
  type Rfc64CatalogAuthorityDirectionV1,
  type Rfc64CatalogAuthorityOperationV1,
  type Rfc64CatalogAccessPolicyRegistryOptionsV1,
} from './catalog-access-policy-v1.js';
import {
  Rfc64PublicCatalogReceiverV1,
  type Rfc64PublicCatalogReceiverReconcilerV1,
  type Rfc64PublicCatalogReceiverOptionsV1,
  type Rfc64PublicCatalogReceiverStatsV1,
} from './public-catalog-receiver-v1.js';
import {
  isRfc64PublicCatalogReceiverSuccessCompletionV1,
  type Rfc64PublicCatalogReceiverCompletionOutcomeV1,
} from './public-catalog-reconciliation-outcome-v1.js';
import {
  Rfc64CatalogReconciliationTerminalErrorV1,
} from './public-catalog-reconciliation-failure-v1.js';
import {
  RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
  Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1,
  type Rfc64PublicCatalogCurrentHeadAuthorizationInputV1,
  type Rfc64PublicCatalogCurrentHeadAuthorizationV1,
  type Rfc64PublicCatalogCurrentHeadQueryV1,
  type Rfc64PublicCatalogCurrentHeadScopeV1,
} from './public-catalog-current-head-discovery-v1.js';
import {
  Rfc64PublicCatalogNativeTransportV1,
  type Rfc64PublicCatalogNativeTransportOptionsV1,
} from './public-catalog-native-transport-v1.js';
import {
  produceDirectAuthorCatalogIssuerDelegationV1,
} from './public-catalog-issuer-delegation-v1.js';
import {
  type Rfc64BoundedPublicRootCatalogTrustedScopeResolverV1,
} from './public-catalog-native-reconciler-v1.js';
import type {
  Rfc64PublicCatalogNativeReceiverResourceStatsV1,
} from './public-catalog-native-receiver-v1.js';
import type {
  Rfc64PublicCatalogIssuerAuthorizationV1,
} from './public-catalog-successor-producer-v1.js';
import type {
  Rfc64CatalogAuthorityPolicyV1,
} from './public-catalog-activation-config-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
  Rfc64PublicCatalogTransportV1,
  encodeRfc64PublicCatalogHeadAnnouncementV1,
  parseRfc64PublicCatalogHeadAnnouncementV1,
  type FetchedRfc64PublicCatalogHeadV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadReplayCompletionV2,
  type Rfc64PublicCatalogHeadReplayAdmissionV1,
  type Rfc64PublicCatalogHeadReplayRequestV1,
} from './public-catalog-transport-v1.js';
import {
  snapshotRfc64PublicCatalogAnnouncementPeersV1,
  snapshotRfc64RemoteCatalogAnnouncementPeersV1,
} from './catalog-peers-v1.js';
import { Rfc64CoalescingSupervisorV1 } from './coalescing-supervisor-v1.js';
import { mapWithConcurrency } from '../map-with-concurrency.js';

export {
  RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1,
  snapshotRfc64PublicCatalogAnnouncementPeersV1,
} from './catalog-peers-v1.js';

/** Default per-peer announce/fetch deadline (ms). */
const DEFAULT_TRANSPORT_TIMEOUT_MS = 10_000;
const MAX_FAILOVER_PROVIDERS_V1 = 8;
const MAX_CONCURRENT_PROVIDER_DISCOVERIES_V1 = 4;
const MAX_ANNOUNCED_CURRENT_HEAD_SCOPES_V1 = 1_024;

export interface Rfc64PublicCatalogServiceOptionsV1 {
  readonly router: ProtocolRouter;
  readonly controlObjects: Rfc64ControlObjectOperationsV1;
  /** Local libp2p identity removed at the canonical outbound fan-out boundary. */
  readonly localPeerId?: string;
  /** Omit for an explicit open-only service; required before accepting private policy. */
  readonly accessPolicyAuthority?: Rfc64CatalogAccessPolicyRegistryOptionsV1;
  readonly receiver?: Rfc64PublicCatalogReceiverOptionsV1;
  /** Full production native content/reconciliation path. Omission is diagnostic-only. */
  readonly native?: Rfc64PublicCatalogServiceNativeOptionsV1;
  /**
   * Optional Gate-3 pull-discovery capability. When native reconciliation is
   * also configured, accepted announcements coalesce into bounded,
   * authenticated current-head pulls so stale history cannot monopolize the
   * ambient receiver queue.
   */
  readonly currentHeadDiscovery?: Rfc64PublicCatalogServiceCurrentHeadDiscoveryOptionsV1;
  /** Per-peer announce/fetch timeout (ms). */
  readonly transportTimeoutMs?: number;
  /**
   * Override the generic envelope verifier. Defaults to the pure dkg-chain
   * EIP-191 verifier — sufficient for author-catalog objects (no chain call).
   */
  readonly verifyIssuerSignature?: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  readonly onHeadStaged?: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    remotePeerId: string,
  ) => void;
  /** Policy-authorized signal to replay durable current heads to one peer. */
  readonly onCatalogHeadReplayRequested?: (
    request: Readonly<Rfc64PublicCatalogHeadReplayRequestV1>,
    remotePeerId: string,
  ) => Rfc64PublicCatalogHeadReplayAdmissionV1;
  /** Canonical immutable per-CG and operation-direction authority resolver. */
  readonly resolveContextGraphAuthority?: (
    contextGraphId: ContextGraphIdV1,
    direction: Rfc64CatalogAuthorityDirectionV1,
  ) => Rfc64CatalogAuthorityPolicyV1;
  /** Share one mutation boundary with local catalog authoring for this scope. */
  readonly runCatalogMutationExclusive?: <T>(
    scope: Readonly<AuthorCatalogScopeV1>,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
}

export type Rfc64PublicCatalogHeadFetchClientV1 = Pick<
  Rfc64PublicCatalogTransportV1,
  'fetchCatalogHead'
>;

export type Rfc64PublicCatalogContentFetchClientV1 = Pick<
  Rfc64PublicCatalogNativeTransportV1,
  'fetchCatalogObject' | 'fetchKaBundle'
>;

export interface Rfc64PublicCatalogReconcilerClientsV1 {
  readonly headTransport: Rfc64PublicCatalogHeadFetchClientV1;
  readonly contentTransport: Rfc64PublicCatalogContentFetchClientV1;
  readonly resolveTrustedCatalogScope: Rfc64BoundedPublicRootCatalogTrustedScopeResolverV1;
  readonly verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  readonly transportTimeoutMs: number;
}

export interface Rfc64PublicCatalogServiceNativeOptionsV1 extends Pick<
  Rfc64PublicCatalogNativeTransportOptionsV1,
  | 'readCatalogObjectByDigest'
  | 'readKaBundleByDigest'
  | 'resolveScopedReadCapability'
> {
  /** Construct exactly one reconciler around the service-owned transports. */
  readonly createReconciler: (
    clients: Readonly<Rfc64PublicCatalogReconcilerClientsV1>,
  ) => Rfc64PublicCatalogReceiverReconcilerV1;
  /** Local aggregate resource counters. Never include provider or private scope identity. */
  readonly readResourceStats?: () =>
    Readonly<Rfc64PublicCatalogNativeReceiverResourceStatsV1> | null;
}

export interface Rfc64PublicCatalogServiceCurrentHeadDiscoveryOptionsV1 {
  /**
   * Resolve the durable semantically applied head for one locally trusted
   * public-root scope. Staged-only and candidate heads must not be returned.
   */
  readonly readCurrentAppliedCatalogHeadDigest: (
    trustedScope: Readonly<AuthorCatalogScopeV1>,
  ) => Promise<Digest32V1 | null>;
}

export interface PublishAuthorCatalogGenesisInputV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly signer: Rfc64AuthorCatalogEip191SignerV1;
  readonly issuedAt: TimestampMsV1;
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
  /** Peers to announce availability to. Announcements are best-effort hints. */
  readonly peers: readonly string[];
}

export interface PublishOpenAuthorCatalogGenesisInputV1
  extends PublishAuthorCatalogGenesisInputV1 {
  /** The accepted open policy for the CG; its digest stamps the announcement. */
  readonly policy: AcceptedOpenCatalogPolicyV1;
}

export interface PublishAuthorCatalogGenesisResultV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  readonly headObjectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
  /** Exact signed direct-author proof usable by the hardened successor producer. */
  readonly catalogIssuerAuthorization: Rfc64PublicCatalogIssuerAuthorizationV1;
  readonly catalogIssuerDelegationObjectDigest: Digest32V1;
  readonly catalogIssuerDelegationSignatureVariantDigest: Digest32V1;
  /** Peers the announcement was acknowledged by. */
  readonly announcedPeers: readonly string[];
  /** Peers whose announcement failed (best-effort; correctness comes from pull). */
  readonly failedPeers: ReadonlyArray<{ readonly peerId: string; readonly error: string }>;
}

export type PublishOpenAuthorCatalogGenesisResultV1 =
  PublishAuthorCatalogGenesisResultV1;

export interface AnnounceRfc64PublicCatalogHeadInputV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /** Unique peer IDs; at most RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1. */
  readonly peers: readonly string[];
  readonly signal?: AbortSignal;
}

export interface AnnounceRfc64PublicCatalogHeadResultV1 {
  /** Validated immutable snapshot used for every delivery attempt. */
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /** Input-order peers that returned the exact transport ACK. */
  readonly announcedPeers: readonly string[];
  /** Input-order peers whose bounded attempt threw or returned a non-ACK. */
  readonly failedPeers: ReadonlyArray<{ readonly peerId: string; readonly error: string }>;
}

export interface RequestRfc64CatalogHeadReplayInputV1 {
  readonly remotePeerId: string;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly signal?: AbortSignal;
}

export interface DiscoverRfc64PublicCatalogCurrentHeadInputV1 {
  readonly remotePeerId: string;
  readonly scope: Rfc64PublicCatalogCurrentHeadScopeV1;
  readonly signal?: AbortSignal;
}

export interface DiscoverRfc64PublicCatalogCurrentHeadProvidersInputV1 {
  readonly remotePeerIds: readonly string[];
  readonly scope: Rfc64PublicCatalogCurrentHeadScopeV1;
  readonly signal?: AbortSignal;
}

/** Verified discovery result. Returning it never stages or activates the head. */
export interface DiscoveredRfc64PublicCatalogCurrentHeadV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  readonly head: FetchedRfc64PublicCatalogHeadV1;
}

/**
 * A current head that was authenticated through discovery and handed to the
 * receiver scheduler. The receiver remains the only owner of semantic
 * activation and the durable applied-head commit.
 */
export type SynchronizedRfc64PublicCatalogCurrentHeadV1 =
  DiscoveredRfc64PublicCatalogCurrentHeadV1;

export interface SynchronizedRfc64CatalogCurrentHeadProvidersV1 {
  readonly current: DiscoveredRfc64PublicCatalogCurrentHeadV1;
  /** Exact successful terminal result for the current accepted policy attempt. */
  readonly completionOutcome: Rfc64PublicCatalogReceiverCompletionOutcomeV1;
  /** Providers that proved the exact selected current head before reconciliation. */
  readonly providerPeerIds: readonly string[];
  /** Provider that produced the applied transition; null for a durable replay. */
  readonly appliedProviderPeerId: string | null;
  /** Actual reconciliation attempts for this exact scheduled task. */
  readonly providerAttempts: number;
}

interface AnnouncedCurrentHeadTargetV1 {
  readonly scope: Readonly<Rfc64PublicCatalogCurrentHeadScopeV1>;
  readonly remotePeerIds: Set<string>;
}

export interface Rfc64PublicCatalogServiceStatsV1 {
  readonly started: boolean;
  readonly acceptedPolicies: number;
  readonly receiver: Rfc64PublicCatalogReceiverStatsV1;
  readonly nativeReceiver: Readonly<Rfc64PublicCatalogNativeReceiverResourceStatsV1> | null;
}

export class Rfc64PublicCatalogServiceV1 {
  readonly #controlObjects: Rfc64ControlObjectOperationsV1;
  readonly #verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  readonly #policies: Rfc64CatalogAccessPolicyRegistryV1;
  readonly #receiver: Rfc64PublicCatalogReceiverV1;
  readonly #transport: Rfc64PublicCatalogTransportV1;
  readonly #currentHeadDiscoveryTransport:
    Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1 | undefined;
  readonly #nativeTransport: Rfc64PublicCatalogNativeTransportV1 | undefined;
  readonly #transportTimeoutMs: number;
  readonly #readNativeResourceStats: () =>
    Readonly<Rfc64PublicCatalogNativeReceiverResourceStatsV1> | null;
  readonly #resolveContextGraphAuthority: (
    contextGraphId: ContextGraphIdV1,
    direction: Rfc64CatalogAuthorityDirectionV1,
  ) => Rfc64CatalogAuthorityPolicyV1;
  readonly #localPeerId: string | undefined;
  readonly #announcedCurrentHeadTargets = new Map<string, AnnouncedCurrentHeadTargetV1>();
  readonly #announcedCurrentHeadSupervisor: Rfc64CoalescingSupervisorV1 | undefined;
  #started = false;
  #closed = false;

  constructor(options: Rfc64PublicCatalogServiceOptionsV1) {
    this.#controlObjects = options.controlObjects;
    this.#policies = new Rfc64CatalogAccessPolicyRegistryV1(options.accessPolicyAuthority);
    this.#verifyIssuerSignature =
      options.verifyIssuerSignature ?? verifyControlEnvelopeIssuerSignatureV1;
    this.#transportTimeoutMs = options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;
    this.#readNativeResourceStats = options.native?.readResourceStats ?? (() => null);
    this.#localPeerId = options.localPeerId;
    this.#resolveContextGraphAuthority = options.resolveContextGraphAuthority
      ?? ((contextGraphId, _direction) => Object.freeze({
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
      }));

    this.#transport = new Rfc64PublicCatalogTransportV1(options.router, {
      controlObjects: this.#controlObjects,
      authorizeCatalogOperation: async (input) => {
        const authority = this.#authorityForOperation(
          input.contextGraphId,
          input.operation,
        );
        return !authority.track2Enabled
          ? null
          : this.#policies.authorize(input);
      },
      verifyIssuerSignature: this.#verifyIssuerSignature,
      // Non-blocking: schedule() enqueues synchronously so the transport's ACK
      // path (which awaits this callback) is never stalled on a fetch.
      onCatalogHeadAvailable: (announcement, remotePeerId) => {
        this.#receiver.schedule(announcement, remotePeerId);
        this.#requestAnnouncedCurrentHeadSynchronization(announcement, remotePeerId);
      },
      onCatalogHeadReplayRequested: options.onCatalogHeadReplayRequested,
    });

    this.#currentHeadDiscoveryTransport = options.currentHeadDiscovery === undefined
      ? undefined
      : new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(options.router, {
        controlObjects: this.#controlObjects,
        readCurrentAppliedCatalogHeadDigest:
          options.currentHeadDiscovery.readCurrentAppliedCatalogHeadDigest,
        authorizeCatalogOperation: (input) =>
          this.#authorizeCurrentHeadDiscovery(input),
        verifyIssuerSignature: this.#verifyIssuerSignature,
      });

    this.#nativeTransport = options.native === undefined
      ? undefined
      : new Rfc64PublicCatalogNativeTransportV1(options.router, {
        readCatalogObjectByDigest: options.native.readCatalogObjectByDigest,
        readKaBundleByDigest: options.native.readKaBundleByDigest,
        resolveScopedReadCapability: options.native.resolveScopedReadCapability,
        authorizeCatalogOperation: async (input) => {
          const authority = this.#authorityForOperation(
            input.contextGraphId,
            input.operation,
          );
          return !authority.track2Enabled
            ? null
            : this.#policies.authorize(input);
        },
        verifyIssuerSignature: this.#verifyIssuerSignature,
      });
    const stagingReconciler = {
      isHeadApplied: async () => false,
      reconcileHead: (remotePeerId, announcement, signal) =>
        this.#stageHeadOnly(remotePeerId, announcement, signal, options.onHeadStaged),
    } satisfies Rfc64PublicCatalogReceiverReconcilerV1;
    const nativeReconciler = options.native === undefined
      ? undefined
      : options.native.createReconciler(Object.freeze({
        // Pass explicit capability objects rather than the owned transport
        // instances. The reconciler may fetch, but cannot start/stop protocols
        // or retain the router through a runtime-private implementation field.
        headTransport: Object.freeze({
          fetchCatalogHead: this.#transport.fetchCatalogHead.bind(this.#transport),
        }),
        contentTransport: Object.freeze({
          fetchCatalogObject: this.#nativeTransport!.fetchCatalogObject.bind(
            this.#nativeTransport!,
          ),
          fetchKaBundle: this.#nativeTransport!.fetchKaBundle.bind(this.#nativeTransport!),
        }),
        resolveTrustedCatalogScope: (announcement: Rfc64PublicCatalogHeadAnnouncementV1) =>
          this.#resolveTrustedCatalogScope(announcement),
        verifyIssuerSignature: this.#verifyIssuerSignature,
        transportTimeoutMs: this.#transportTimeoutMs,
      }));
    const reconciler: Rfc64PublicCatalogReceiverReconcilerV1 = nativeReconciler === undefined
      ? stagingReconciler
      : {
        isHeadApplied: (announcement) => (
          this.#resolveContextGraphAuthority(
            announcement.contextGraphId,
            'receiving',
          ).reconciliationLane
            === 'catalog-apply'
            ? nativeReconciler.isHeadApplied(announcement)
            : Promise.resolve(false)
        ),
        reconcileHead: (remotePeerId, announcement, signal) => {
          const lane = this.#resolveContextGraphAuthority(
            announcement.contextGraphId,
            'receiving',
          ).reconciliationLane;
          if (lane === 'legacy' || lane === 'disabled') {
            throw new Error('RFC-64 catalog reconciliation is disabled for legacy-mode CG');
          }
          if (lane === 'shadow-stage') {
            return stagingReconciler.reconcileHead(remotePeerId, announcement, signal);
          }
          const reconcile = async () => {
            // The scheduler's optimistic applied-head check happens before it
            // enters the semantic mutation lane. Re-check while holding that
            // lane so an ambient hint and an awaited bootstrap cannot both
            // run post-commit lifecycle work for the same durable head.
            if (await nativeReconciler.isHeadApplied(announcement)) {
              return 'applied' as const;
            }
            return nativeReconciler.reconcileHead(
              remotePeerId,
              announcement,
              signal,
            );
          };
          return options.runCatalogMutationExclusive === undefined
            ? reconcile()
            : options.runCatalogMutationExclusive(
              this.#resolveTrustedCatalogScope(announcement),
              reconcile,
              signal,
            );
        },
      };
    this.#receiver = new Rfc64PublicCatalogReceiverV1(reconciler, options.receiver);
    this.#announcedCurrentHeadSupervisor = (
      this.#currentHeadDiscoveryTransport === undefined || nativeReconciler === undefined
    )
      ? undefined
      : new Rfc64CoalescingSupervisorV1({
        runPass: (signal) => this.#synchronizeAnnouncedCurrentHeads(signal),
        onError: () => undefined,
        closingMessage: 'RFC-64 announced current-head synchronization closing',
      });
  }

  get started(): boolean {
    return this.#started;
  }

  /** Registry accessor for accepting the CG's open policy (author or receiver). */
  acceptOpenPolicy(
    input: BuildOpenOwnerContextGraphPolicyInputV1,
  ): AcceptedOpenCatalogPolicyV1 {
    const policy = buildOpenOwnerContextGraphPolicyV1(input);
    const accepted = this.acceptPolicySnapshot({
      policy,
      policyDigest: computeOpenContextGraphPolicyDigestV1(policy),
    });
    return Object.freeze({ policy: accepted.policy, policyDigest: accepted.policyDigest });
  }

  /**
   * Accept one policy/optional-roster snapshot that already crossed the
   * administrative/finality authority boundary. All four access/publish cells
   * are retained; a roster is required exactly when accessPolicy is private.
   */
  acceptPolicySnapshot(
    input: AcceptRfc64CatalogAccessSnapshotInputV1,
  ): AcceptedRfc64CatalogAccessSnapshotV1 {
    return this.#policies.acceptCurrent(input);
  }

  /** Accept a generation independently rebuilt from canonical DKG authority. */
  acceptAuthoritativePolicySnapshot(
    input: AcceptRfc64CatalogAccessSnapshotInputV1,
  ): AcceptedRfc64CatalogAccessSnapshotV1 {
    return this.#policies.acceptAuthoritativeCurrent(input);
  }

  acceptedPolicySnapshot(
    networkId: NetworkIdV1,
    contextGraphId: ContextGraphIdV1,
  ): AcceptedRfc64CatalogAccessSnapshotV1 | null {
    return this.#policies.lookup(networkId, contextGraphId);
  }

  /** Resolve the locally accepted policy digest for one exact catalog scope. */
  acceptedPolicyDigestForCatalogScope(scopeInput: AuthorCatalogScopeV1): Digest32V1 {
    return this.acceptedPolicySnapshotForCatalogScope(scopeInput).policyDigest;
  }

  acceptedPolicySnapshotForCatalogScope(
    scopeInput: AuthorCatalogScopeV1,
  ): AcceptedRfc64CatalogAccessSnapshotV1 {
    const scope = snapshotCatalogScope(scopeInput);
    const held = this.#policies.lookup(scope.networkId, scope.contextGraphId);
    if (held === null) {
      throw new Error('RFC-64 catalog scope has no locally accepted policy snapshot');
    }
    assertAcceptedPolicyMatchesCatalogScope(this.#policies, held, scope);
    return held;
  }

  /** Compatibility alias for the original public/open authoring surface. */
  acceptedOpenPolicyDigestForCatalogScope(scopeInput: AuthorCatalogScopeV1): Digest32V1 {
    const scope = snapshotCatalogScope(scopeInput);
    const held = this.#policies.lookup(scope.networkId, scope.contextGraphId);
    if (held === null) {
      throw new Error('RFC-64 catalog scope has no locally accepted open policy');
    }
    assertOpenPolicyMatchesCatalogScope(held, held, scope);
    return held.policyDigest;
  }

  start(): void {
    if (this.#closed) throw new Error('RFC-64 public catalog service is closed');
    if (this.#started) return;
    this.#nativeTransport?.start();
    try {
      this.#currentHeadDiscoveryTransport?.start();
      // Register the announcement protocol last so no callback can schedule
      // reconciliation before content-fetch and pull-discovery are live.
      this.#transport.start();
      this.#started = true;
    } catch (cause) {
      this.#currentHeadDiscoveryTransport?.stop();
      this.#nativeTransport?.stop();
      throw cause;
    }
  }

  /** Fence receiver scheduling and drain applied-head callbacks; keep authoring live. */
  async closeReceiverAdmissionAndDrain(): Promise<void> {
    await this.#announcedCurrentHeadSupervisor?.close();
    this.#announcedCurrentHeadTargets.clear();
    await this.#receiver.close();
  }

  /** Abort receiver work for a graph while retaining verified served data. */
  deactivateReceiverContextGraph(contextGraphId: string): void {
    for (const [key, target] of this.#announcedCurrentHeadTargets) {
      if (target.scope.contextGraphId === contextGraphId) {
        this.#announcedCurrentHeadTargets.delete(key);
      }
    }
    this.#receiver.cancelContextGraph(contextGraphId);
  }

  /** Stop serving, drain in-flight receiver work, then release. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    try {
      // Keep both outbound transports live until the scheduler has drained.
      // Post-close availability callbacks are harmless: schedule() rejects them.
      await this.closeReceiverAdmissionAndDrain();
    } finally {
      this.#transport.stop();
      this.#currentHeadDiscoveryTransport?.stop();
      this.#nativeTransport?.stop();
    }
  }

  /**
   * Author path: produce and durably stage the signed issuer delegation, then
   * produce and durably stage its bound empty genesis, then best-effort
   * announce availability to `peers`. Both durability barriers complete before
   * any announcement; announcements grant no authority.
   */
  async publishOpenAuthorCatalogGenesis(
    input: PublishOpenAuthorCatalogGenesisInputV1,
  ): Promise<PublishOpenAuthorCatalogGenesisResultV1> {
    const scope = snapshotCatalogScope(input.scope);
    const heldPolicy = this.#policies.lookup(scope.networkId, scope.contextGraphId);
    assertOpenPolicyMatchesCatalogScope(input.policy, heldPolicy, scope);
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(input.peers);
    return this.#publishAuthorCatalogGenesis(input, heldPolicy!, peers);
  }

  /** Author path for any already-accepted RFC-64 catalog access-policy cell. */
  async publishAuthorCatalogGenesis(
    input: PublishAuthorCatalogGenesisInputV1,
  ): Promise<PublishAuthorCatalogGenesisResultV1> {
    const scope = snapshotCatalogScope(input.scope);
    const heldPolicy = this.#policies.lookup(scope.networkId, scope.contextGraphId);
    if (heldPolicy === null) {
      throw new Error('RFC-64 catalog scope has no locally accepted policy snapshot');
    }
    assertAcceptedPolicyMatchesCatalogScope(this.#policies, heldPolicy, scope);
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(input.peers);
    assertSupportedCatalogFanout(
      heldPolicy,
      peers,
      this.#nativeTransport?.privateScopeBoundReadsConfigured === true,
    );
    return this.#publishAuthorCatalogGenesis(input, heldPolicy, peers);
  }

  async #publishAuthorCatalogGenesis(
    input: PublishAuthorCatalogGenesisInputV1,
    heldPolicy: AcceptedRfc64CatalogAccessSnapshotV1,
    peers: readonly string[],
  ): Promise<PublishAuthorCatalogGenesisResultV1> {
    this.#requireStarted();
    const scope = snapshotCatalogScope(input.scope);
    if (!this.#resolveContextGraphAuthority(
      scope.contextGraphId,
      'serving',
    ).authoringAllowed) {
      throw new Error('RFC-64 catalog authoring is disabled for legacy-mode CG');
    }
    const signer = Object.freeze({
      issuer: input.signer.issuer,
      signDigest: input.signer.signDigest,
    });
    const issuedAt = input.issuedAt;
    const effectiveAt = input.catalogIssuerDelegationEffectiveAt;
    const expiresAt = input.catalogIssuerDelegationExpiresAt;
    assertAcceptedPolicyMatchesCatalogScope(this.#policies, heldPolicy, scope);
    const policyDigest = heldPolicy.policyDigest;
    const delegation = await produceDirectAuthorCatalogIssuerDelegationV1({
      scope,
      signer,
      effectiveAt,
      expiresAt,
      catalogHeadIssuedAt: issuedAt,
    });

    // The delegation is an independent durable prerequisite.  A single batch
    // would permit the store to write its objects concurrently; two awaited
    // barriers prove the named delegation is durable before any head that
    // references it can be durably staged or announced.
    const delegationEnvelope = delegation.authorization.catalogIssuerDelegation;
    const delegationObject: StageVerifiedControlObjectV1 = Object.freeze({
      envelope: delegationEnvelope,
      issuerSignature: delegation.issuerSignature,
    });
    const stagedDelegation = await this.#controlObjects.stageVerifiedObjects([
      delegationObject,
    ]);
    assertExactDurableStageReceipt(stagedDelegation, [delegationEnvelope]);
    const delegationKeys = stagedDelegation.objects[0]!;
    const produced = await produceEmptyAuthorCatalogGenesisV1({
      scope,
      catalogIssuerDelegationDigest: delegationEnvelope.objectDigest as Digest32V1,
      issuedAt,
      signer,
    });

    const verified = await Promise.all(
      produced.stagedObjects.map(async (envelope) => ({
        envelope,
        issuerSignature: await this.#verifyIssuerSignature(envelope),
      })),
    );
    const staged = await this.#controlObjects.stageVerifiedObjects(verified);
    assertExactDurableStageReceipt(staged, produced.stagedObjects);
    const headKeys = staged.objects.at(-1);
    if (headKeys === undefined) {
      throw new Error('RFC-64 author catalog producer staged no head object');
    }

    const announcement: Rfc64PublicCatalogHeadAnnouncementV1 = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
      networkId: produced.head.payload.networkId,
      contextGraphId: produced.head.payload.contextGraphId,
      subGraphName: produced.head.payload.subGraphName,
      authorAddress: produced.head.payload.authorAddress,
      catalogEra: produced.head.payload.era,
      catalogVersion: produced.head.payload.version,
      policyDigest,
      catalogHeadObjectDigest: headKeys.objectDigest,
      signatureVariantDigest: headKeys.signatureVariantDigest,
    });

    const delivery = await this.#announceCatalogHeadSnapshot(announcement, peers);

    return Object.freeze({
      announcement: delivery.announcement,
      headObjectDigest: headKeys.objectDigest,
      signatureVariantDigest: headKeys.signatureVariantDigest,
      catalogIssuerAuthorization: delegation.authorization,
      catalogIssuerDelegationObjectDigest: delegationKeys.objectDigest,
      catalogIssuerDelegationSignatureVariantDigest: delegationKeys.signatureVariantDigest,
      announcedPeers: delivery.announcedPeers,
      failedPeers: delivery.failedPeers,
    });
  }

  /**
   * Best-effort availability fan-out for an already durable head (including a
   * successor produced by a separate authoring path). The announcement and
   * peer list are fully snapshotted before the first send; one peer failure
   * never suppresses later attempts.
   */
  async announceCatalogHead(
    input: AnnounceRfc64PublicCatalogHeadInputV1,
  ): Promise<AnnounceRfc64PublicCatalogHeadResultV1> {
    this.#requireStarted();
    const announcement = parseRfc64PublicCatalogHeadAnnouncementV1(
      encodeRfc64PublicCatalogHeadAnnouncementV1(input.announcement),
    );
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(input.peers);
    const heldPolicy = this.#assertAcceptedCatalogAnnouncement(
      announcement,
      'announce-outbound',
    );
    assertSupportedCatalogFanout(
      heldPolicy,
      peers,
      this.#nativeTransport?.privateScopeBoundReadsConfigured === true,
    );
    return this.#announceCatalogHeadSnapshot(announcement, peers, input.signal);
  }

  /** Ask one authorized peer to replay every durable current head for a CG. */
  async requestCatalogHeadReplay(
    input: RequestRfc64CatalogHeadReplayInputV1,
  ): Promise<Readonly<Rfc64PublicCatalogHeadReplayCompletionV2>> {
    this.#requireStarted();
    const held = this.#policies.lookup(input.networkId, input.contextGraphId);
    if (held === null) {
      throw new Error('RFC-64 catalog replay request is not bound to an accepted policy');
    }
    return this.#transport.requestCatalogHeadReplay(
      input.remotePeerId,
      Object.freeze({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
        networkId: held.policy.networkId,
        contextGraphId: held.policy.contextGraphId,
        policyDigest: held.policyDigest,
      }),
      this.#sendOptions(input.signal),
    );
  }

  /**
   * Pull and authenticate one provider's semantically current public-root head.
   * The discovery response is treated as a hint: this method exact-fetches the
   * named signed head, re-verifies it, and binds it to local accepted policy
   * before returning. It intentionally does not stage, schedule, or activate.
   */
  async discoverCurrentCatalogHead(
    input: DiscoverRfc64PublicCatalogCurrentHeadInputV1,
  ): Promise<DiscoveredRfc64PublicCatalogCurrentHeadV1 | null> {
    this.#requireStarted();
    const discovery = this.#currentHeadDiscoveryTransport;
    if (discovery === undefined) {
      throw new Error('RFC-64 current-head discovery is not configured');
    }
    // Detach caller-owned fields before the first await. In particular, the
    // same immutable peer-id primitive must drive both the hint query and its
    // exact-head fetch; a mutable object or switching accessor must not rebind
    // those two halves to different providers.
    const remotePeerId = input.remotePeerId;
    const signal = input.signal;
    const trustedScope = this.#resolveTrustedCurrentHeadScope(input.scope);
    const held = this.#policies.lookup(trustedScope.networkId, trustedScope.contextGraphId)!;
    const query: Rfc64PublicCatalogCurrentHeadQueryV1 = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      networkId: trustedScope.networkId,
      contextGraphId: trustedScope.contextGraphId,
      subGraphName: trustedScope.subGraphName,
      authorAddress: trustedScope.authorAddress,
      catalogEra: trustedScope.era,
      policyDigest: held.policyDigest,
    });
    const announcement = await discovery.discoverCurrentCatalogHead(
      remotePeerId,
      query,
      this.#sendOptions(signal),
    );
    if (announcement === null) return null;
    this.#assertAcceptedCatalogAnnouncement(announcement);
    const currentTrustedScope = this.#resolveTrustedCatalogScope(announcement);
    const head = await this.#transport.fetchCatalogHead(
      remotePeerId,
      announcement,
      this.#sendOptions(signal),
    );
    if (head === null) {
      throw new Error('RFC-64 discovered current head is no longer available by exact digest');
    }
    try {
      assertAuthorCatalogHeadScopeBindingV1(head.envelope.payload, currentTrustedScope);
    } catch (cause) {
      throw new Error(
        'RFC-64 discovered head differs from the accepted public policy scope',
        { cause },
      );
    }
    return Object.freeze({ announcement, head });
  }

  /**
   * Discover one provider's current public-root head, enqueue that exact
   * authenticated head through the ordinary receiver, and await this request's
   * terminal completion. Observer callbacks remain diagnostic-only; semantic
   * failure is returned directly by the receiver and translated to the public
   * terminal error here.
   *
   * Once discovery has completed, reconciliation is deliberately durable work
   * owned by the receiver lifecycle. Aborting the caller's signal after that
   * boundary does not cancel a semantic transition already accepted by the
   * scheduler; service close remains the cancellation authority.
   */
  async synchronizeCurrentCatalogHead(
    input: DiscoverRfc64PublicCatalogCurrentHeadInputV1,
  ): Promise<SynchronizedRfc64PublicCatalogCurrentHeadV1 | null> {
    // Snapshot caller-owned values before discovery's first await so a Proxy or
    // switching accessor cannot redirect the later scheduled fetch to another
    // provider.
    const remotePeerId = input.remotePeerId;
    const scope = input.scope;
    const signal = input.signal;
    const discovered = await this.discoverCurrentCatalogHead({
      remotePeerId,
      scope,
      ...(signal === undefined ? {} : { signal }),
    });
    if (discovered === null) return null;
    if (signal?.aborted) throw signal.reason;
    // Discovery is an asynchronous authority boundary. Revalidate immediately
    // before queue admission so a policy/roster rotation or receiver
    // deactivation that completed during exact fetch cannot enqueue stale work.
    this.#assertAcceptedCatalogAnnouncement(discovered.announcement);
    const completion = await this.#receiver.scheduleVerifiedCurrentHeadAndWait([{
      announcement: discovered.announcement,
      remotePeerId,
    }]);
    const shadowStaged = completion.outcome === 'staged-only'
      && this.#resolveContextGraphAuthority(
        discovered.announcement.contextGraphId,
        'receiving',
      ).reconciliationLane === 'shadow-stage';
    if (!isRfc64PublicCatalogReceiverSuccessCompletionV1(completion) && !shadowStaged) {
      throw new Rfc64CatalogReconciliationTerminalErrorV1(completion);
    }
    return discovered;
  }

  /**
   * Discover candidates with bounded hedging, retain every provider for the
   * exact highest current head, then let the ordinary receiver own scoring,
   * backoff, failover, and the durable applied transition.
   */
  async synchronizeCurrentCatalogHeadFromProviders(
    input: DiscoverRfc64PublicCatalogCurrentHeadProvidersInputV1,
  ): Promise<SynchronizedRfc64CatalogCurrentHeadProvidersV1 | null> {
    const remotePeerIds = snapshotRfc64PublicCatalogAnnouncementPeersV1(
      input.remotePeerIds,
    );
    if (remotePeerIds.length < 1 || remotePeerIds.length > MAX_FAILOVER_PROVIDERS_V1) {
      throw new TypeError('RFC-64 provider failover requires 1-8 distinct providers');
    }
    const scope = input.scope;
    const signal = input.signal;
    const attempts = await mapWithConcurrency(
      remotePeerIds,
      MAX_CONCURRENT_PROVIDER_DISCOVERIES_V1,
      async (remotePeerId) => {
        try {
          const discovered = await this.discoverCurrentCatalogHead({
            remotePeerId,
            scope,
            ...(signal === undefined ? {} : { signal }),
          });
          return Object.freeze({ remotePeerId, discovered, error: null });
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          return Object.freeze({ remotePeerId, discovered: null, error });
        }
      },
    );
    const available = attempts.filter((attempt) => attempt.discovered !== null) as Array<{
      readonly remotePeerId: string;
      readonly discovered: DiscoveredRfc64PublicCatalogCurrentHeadV1;
      readonly error: null;
    }>;
    if (available.length === 0) {
      const errors = attempts.flatMap(({ error }) => error === null ? [] : [error]);
      if (errors.length > 0) {
        throw new AggregateError(errors, 'RFC-64 no configured provider was reachable');
      }
      return null;
    }
    let highestVersion = -1n;
    for (const { discovered } of available) {
      const version = BigInt(discovered.announcement.catalogVersion);
      if (version > highestVersion) highestVersion = version;
    }
    const highest = available.filter(({ discovered }) => (
      BigInt(discovered.announcement.catalogVersion) === highestVersion
    ));
    const selectedIdentity = exactHeadIdentityV1(highest[0]!.discovered.announcement);
    if (highest.some(({ discovered }) => (
      exactHeadIdentityV1(discovered.announcement) !== selectedIdentity
    ))) {
      throw new Error('RFC-64 providers reported conflicting heads at the same catalog version');
    }
    const selected = highest.filter(({ discovered }) => (
      exactHeadIdentityV1(discovered.announcement) === selectedIdentity
    ));
    if (signal?.aborted) throw signal.reason;
    for (const { discovered } of selected) {
      this.#assertAcceptedCatalogAnnouncement(discovered.announcement);
    }
    const completion = await this.#receiver.scheduleVerifiedCurrentHeadAndWait(selected.map(({
      remotePeerId,
      discovered,
    }) => ({
      remotePeerId,
      announcement: discovered.announcement,
    })));
    const providerPeerIds = Object.freeze(selected.map(({ remotePeerId }) => remotePeerId));
    const shadowStaged = completion.outcome === 'staged-only'
      && this.#resolveContextGraphAuthority(
        selected[0]!.discovered.announcement.contextGraphId,
        'receiving',
      ).reconciliationLane === 'shadow-stage';
    if (!isRfc64PublicCatalogReceiverSuccessCompletionV1(completion) && !shadowStaged) {
      throw new Rfc64CatalogReconciliationTerminalErrorV1(completion);
    }
    if (
      completion.appliedProviderPeerId !== null
      && !providerPeerIds.includes(completion.appliedProviderPeerId)
    ) {
      throw new Error(
        'RFC-64 receiver completed through a provider outside the requested failover set',
      );
    }
    return Object.freeze({
      current: selected[0]!.discovered,
      completionOutcome: completion.outcome,
      providerPeerIds,
      appliedProviderPeerId: completion.appliedProviderPeerId,
      providerAttempts: completion.providerAttempts,
    });
  }

  /** Idle-await pull acceleration and the receiver (tests / graceful shutdown coordination). */
  async whenReceiverIdle(): Promise<void> {
    await this.#announcedCurrentHeadSupervisor?.whenIdle();
    await this.#receiver.whenIdle();
  }

  stats(): Rfc64PublicCatalogServiceStatsV1 {
    return Object.freeze({
      started: this.#started,
      acceptedPolicies: this.#policies.size,
      receiver: this.#receiver.stats(),
      nativeReceiver: this.#readNativeResourceStats(),
    });
  }

  #sendOptions(signal?: AbortSignal): SendOptions {
    return signal === undefined
      ? { timeoutMs: this.#transportTimeoutMs }
      : { timeoutMs: this.#transportTimeoutMs, signal };
  }

  /**
   * Turn a policy-admitted availability hint into a bounded pull request. The
   * announcement itself never gains priority: only discovery's exact-fetch and
   * signature/scope checks may schedule the verified-current-head lane.
   */
  #requestAnnouncedCurrentHeadSynchronization(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    remotePeerId: string,
  ): void {
    const supervisor = this.#announcedCurrentHeadSupervisor;
    if (supervisor === undefined || supervisor.closed || this.#closed) return;
    const key = announcedCurrentHeadScopeKeyV1(announcement);
    let target = this.#announcedCurrentHeadTargets.get(key);
    if (target === undefined) {
      if (this.#announcedCurrentHeadTargets.size >= MAX_ANNOUNCED_CURRENT_HEAD_SCOPES_V1) {
        return;
      }
      target = {
        scope: Object.freeze({
          networkId: announcement.networkId,
          contextGraphId: announcement.contextGraphId,
          subGraphName: announcement.subGraphName,
          authorAddress: announcement.authorAddress,
          catalogEra: announcement.catalogEra,
        }),
        remotePeerIds: new Set<string>(),
      };
      this.#announcedCurrentHeadTargets.set(key, target);
    }
    if (target.remotePeerIds.size < MAX_FAILOVER_PROVIDERS_V1) {
      target.remotePeerIds.add(remotePeerId);
    }
    supervisor.request();
  }

  /** One globally bounded pass; requests arriving during it coalesce into the next pass. */
  async #synchronizeAnnouncedCurrentHeads(signal: AbortSignal): Promise<void> {
    const targets = [...this.#announcedCurrentHeadTargets.values()];
    this.#announcedCurrentHeadTargets.clear();
    await mapWithConcurrency(
      targets,
      MAX_CONCURRENT_PROVIDER_DISCOVERIES_V1,
      async ({ scope, remotePeerIds }) => {
        if (signal.aborted || remotePeerIds.size === 0) return;
        try {
          await this.synchronizeCurrentCatalogHeadFromProviders({
            remotePeerIds: [...remotePeerIds],
            scope,
            signal,
          });
        } catch {
          // Best-effort acceleration only. The original ambient task remains
          // authoritative recovery work, and a later hint requests a new pull.
        }
      },
    );
  }

  #authorityForOperation(
    contextGraphId: ContextGraphIdV1,
    operation: Rfc64CatalogAuthorityOperationV1,
  ): Rfc64CatalogAuthorityPolicyV1 {
    return this.#resolveContextGraphAuthority(
      contextGraphId,
      rfc64CatalogAuthorityDirectionV1(operation),
    );
  }

  async #announceCatalogHeadSnapshot(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    peers: readonly string[],
    signal?: AbortSignal,
  ): Promise<AnnounceRfc64PublicCatalogHeadResultV1> {
    const remotePeers = this.#localPeerId === undefined
      ? snapshotRfc64PublicCatalogAnnouncementPeersV1(peers)
      : snapshotRfc64RemoteCatalogAnnouncementPeersV1(peers, this.#localPeerId);
    const announcedPeers: string[] = [];
    const failedPeers: Array<{ peerId: string; error: string }> = [];
    for (const peerId of remotePeers) {
      if (signal?.aborted) break;
      try {
        await this.#transport.announceCatalogHead(
          peerId,
          announcement,
          this.#sendOptions(signal),
        );
        announcedPeers.push(peerId);
      } catch (error) {
        failedPeers.push({
          peerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return Object.freeze({
      announcement,
      announcedPeers: Object.freeze(announcedPeers),
      failedPeers: Object.freeze(failedPeers.map((failure) => Object.freeze(failure))),
    });
  }

  #assertAcceptedCatalogAnnouncement(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    operation: Rfc64CatalogAuthorityOperationV1 = 'announce-inbound',
  ): AcceptedRfc64CatalogAccessSnapshotV1 {
    const authority = this.#authorityForOperation(
      announcement.contextGraphId,
      operation,
    );
    if (!authority.track2Enabled) {
      throw new Error('RFC-64 catalog reconciliation is disabled for legacy-mode CG');
    }
    const held = this.#policies.lookup(announcement.networkId, announcement.contextGraphId);
    if (
      held === null
      || held.policyDigest !== announcement.policyDigest
      || !this.#policies.isSwmAuthorAuthorized({
        networkId: announcement.networkId,
        contextGraphId: announcement.contextGraphId,
        policyDigest: announcement.policyDigest,
        authorAddress: announcement.authorAddress,
      })
    ) {
      throw new Error(
        'RFC-64 catalog announcement is not bound to the locally accepted policy snapshot',
      );
    }
    return held;
  }

  async #authorizeCurrentHeadDiscovery(
    input: Rfc64PublicCatalogCurrentHeadAuthorizationInputV1,
  ): Promise<Rfc64PublicCatalogCurrentHeadAuthorizationV1 | null> {
    const authority = this.#authorityForOperation(input.contextGraphId, input.operation);
    if (!authority.track2Enabled) return null;
    let trustedCatalogScope: Readonly<AuthorCatalogScopeV1>;
    try {
      trustedCatalogScope = this.#resolveTrustedCurrentHeadScope(input);
    } catch {
      return null;
    }
    const record = this.#policies.lookup(input.networkId, input.contextGraphId);
    if (record === null || record.policyDigest !== input.policyDigest) return null;
    const authorization = await this.#policies.authorize(Object.freeze({
      operation: input.operation === 'current-head-discovery-inbound'
        ? 'fetch-inbound'
        : 'fetch-outbound',
      remotePeerId: input.remotePeerId,
      networkId: input.networkId,
      contextGraphId: input.contextGraphId,
      policyDigest: input.policyDigest,
    }));
    if (
      authorization === null
      || authorization.policyDigest !== record.policyDigest
      || authorization.accessPolicy !== record.policy.accessPolicy
    ) return null;
    return Object.freeze({
      accessPolicy: authorization.accessPolicy,
      policyDigest: record.policyDigest,
      trustedCatalogScope,
    });
  }

  #resolveTrustedCatalogScope(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Readonly<AuthorCatalogScopeV1> {
    const record = this.#policies.lookup(announcement.networkId, announcement.contextGraphId);
    if (record === null || record.policyDigest !== announcement.policyDigest) {
      throw new Error('RFC-64 announcement has no matching accepted policy generation');
    }
    this.#assertAcceptedCatalogAnnouncement(announcement);
    return Object.freeze({
      networkId: record.policy.networkId,
      contextGraphId: record.policy.contextGraphId,
      governanceChainId: record.policy.governanceChainId,
      governanceContractAddress: record.policy.governanceContractAddress,
      ownershipTransitionDigest: record.policy.ownershipTransitionDigest,
      subGraphName: announcement.subGraphName,
      authorAddress: announcement.authorAddress,
      era: announcement.catalogEra,
      bucketCount: '1',
    }) as Readonly<AuthorCatalogScopeV1>;
  }

  #resolveTrustedCurrentHeadScope(
    input: Rfc64PublicCatalogCurrentHeadScopeV1,
  ): Readonly<AuthorCatalogScopeV1> {
    const record = this.#policies.lookup(input.networkId, input.contextGraphId);
    if (record === null) {
      throw new Error(
        'RFC-64 current-head query is not bound to an accepted policy snapshot',
      );
    }
    try {
      if (record.policy.accessPolicy === 1 && input.subGraphName !== null) {
        throw new Error(
          'RFC-64 current-head discovery supports only the root catalog lane',
        );
      }
      if (!this.#policies.isSwmAuthorAuthorized({
        networkId: input.networkId,
        contextGraphId: input.contextGraphId,
        policyDigest: record.policyDigest,
        authorAddress: input.authorAddress,
      })) {
        throw new Error('catalog author is not authorized by the accepted policy');
      }
      if (
        record.policy.networkId !== input.networkId
        || record.policy.contextGraphId !== input.contextGraphId
        || record.policy.era !== input.catalogEra
      ) {
        throw new Error('catalog identity differs from the accepted policy');
      }
      return Object.freeze({
        networkId: record.policy.networkId,
        contextGraphId: record.policy.contextGraphId,
        governanceChainId: record.policy.governanceChainId,
        governanceContractAddress: record.policy.governanceContractAddress,
        ownershipTransitionDigest: record.policy.ownershipTransitionDigest,
        subGraphName: input.subGraphName,
        authorAddress: input.authorAddress,
        era: record.policy.era,
        bucketCount: '1',
      }) as Readonly<AuthorCatalogScopeV1>;
    } catch (cause) {
      throw new Error(
        'RFC-64 current-head query is not bound to the accepted policy snapshot',
        { cause },
      );
    }
  }

  async #stageHeadOnly(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    signal: AbortSignal,
    onHeadStaged?: Rfc64PublicCatalogServiceOptionsV1['onHeadStaged'],
  ): Promise<'not-found' | 'staged-only'> {
    if (signal.aborted) throw signal.reason;
    const trustedCatalogScope = this.#resolveTrustedCatalogScope(announcement);
    const fetched = await this.#transport.fetchCatalogHead(
      remotePeerId,
      announcement,
      this.#sendOptions(signal),
    );
    if (fetched === null) return 'not-found';
    try {
      assertAuthorCatalogHeadScopeBindingV1(
        fetched.envelope.payload,
        trustedCatalogScope,
      );
    } catch (cause) {
      throw new Error(
        'RFC-64 fetched head differs from the accepted public policy scope',
        { cause },
      );
    }
    await this.#controlObjects.stageVerifiedObjects([fetched]);
    onHeadStaged?.(announcement, remotePeerId);
    return 'staged-only';
  }

  #requireStarted(): void {
    if (!this.#started || this.#closed) {
      throw new Error('RFC-64 public catalog service is not started');
    }
  }
}

function exactHeadIdentityV1(
  announcement: Readonly<Rfc64PublicCatalogHeadAnnouncementV1>,
): string {
  return [
    announcement.networkId,
    announcement.contextGraphId,
    announcement.subGraphName ?? '',
    announcement.authorAddress,
    announcement.catalogEra,
    announcement.catalogVersion,
    announcement.policyDigest,
    announcement.catalogHeadObjectDigest,
    announcement.signatureVariantDigest,
  ].join('\n');
}

function announcedCurrentHeadScopeKeyV1(
  announcement: Readonly<Rfc64PublicCatalogHeadAnnouncementV1>,
): string {
  return [
    announcement.networkId,
    announcement.contextGraphId,
    announcement.subGraphName ?? '',
    announcement.authorAddress,
    announcement.catalogEra,
  ].join('\n');
}

function assertSupportedCatalogFanout(
  heldPolicy: AcceptedRfc64CatalogAccessSnapshotV1,
  peers: readonly string[],
  privateScopeBoundReadsConfigured: boolean,
): void {
  if (
    heldPolicy.policy.accessPolicy === 1
    && peers.length > 0
    && !privateScopeBoundReadsConfigured
  ) {
    throw new Error(
      'RFC-64 private catalog peer fan-out requires scope-bound private content transport',
    );
  }
}

function snapshotCatalogScope(input: AuthorCatalogScopeV1): Readonly<AuthorCatalogScopeV1> {
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
  assertAuthorCatalogScopeV1(scope);
  return scope;
}

function assertOpenPolicyMatchesCatalogScope(
  supplied: AcceptedOpenCatalogPolicyV1,
  held: AcceptedOpenCatalogPolicyV1 | null,
  scope: AuthorCatalogScopeV1,
): void {
  const policy = supplied.policy;
  if (
    held === null
    || held.policyDigest !== supplied.policyDigest
    || supplied.policyDigest !== computeOpenContextGraphPolicyDigestV1(policy)
    || policy.networkId !== scope.networkId
    || policy.contextGraphId !== scope.contextGraphId
    || policy.governanceChainId !== scope.governanceChainId
    || policy.governanceContractAddress !== scope.governanceContractAddress
    || policy.ownershipTransitionDigest !== scope.ownershipTransitionDigest
    || policy.era !== scope.era
    || policy.source.kind !== 'owner-signed-unregistered'
    || policy.source.ownerAddress !== scope.authorAddress
  ) {
    throw new Error(
      'RFC-64 open policy is not bound to the exact catalog network, CG, governance scope, era, and author',
    );
  }
}

function assertAcceptedPolicyMatchesCatalogScope(
  registry: Rfc64CatalogAccessPolicyRegistryV1,
  held: AcceptedRfc64CatalogAccessSnapshotV1,
  scope: AuthorCatalogScopeV1,
): void {
  const policy = held.policy;
  if (
    policy.networkId !== scope.networkId
    || policy.contextGraphId !== scope.contextGraphId
    || policy.governanceChainId !== scope.governanceChainId
    || policy.governanceContractAddress !== scope.governanceContractAddress
    || policy.ownershipTransitionDigest !== scope.ownershipTransitionDigest
    || policy.era !== scope.era
    || !registry.isSwmAuthorAuthorized({
      networkId: scope.networkId,
      contextGraphId: scope.contextGraphId,
      policyDigest: held.policyDigest,
      authorAddress: scope.authorAddress,
    })
  ) {
    throw new Error(
      'RFC-64 policy snapshot is not bound to the exact catalog network, CG, governance scope, era, and author',
    );
  }
}

function assertExactDurableStageReceipt(
  receipt: StageVerifiedControlObjectsResultV1,
  expected: readonly SignedControlEnvelopeV1[],
): void {
  if (receipt?.durable !== true || receipt.objects.length !== expected.length) {
    throw new Error('RFC-64 control-object store did not return an exact durable receipt');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const envelope = expected[index];
    const staged = receipt.objects[index];
    if (
      staged.objectDigest !== envelope.objectDigest
      || staged.signatureVariantDigest !== computeControlSignatureVariantDigestHex(
        envelope.objectDigest,
        envelope.signature,
      )
    ) {
      throw new Error('RFC-64 control-object store receipt changed an exact staged object');
    }
  }
}
