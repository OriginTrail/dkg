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
  computeControlSignatureVariantDigestHex,
  type ProtocolRouter,
  type SendOptions,
  type SignedControlEnvelopeV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
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
  Rfc64AcceptedOpenCatalogPolicyRegistryV1,
  buildOpenOwnerContextGraphPolicyV1,
  computeOpenContextGraphPolicyDigestV1,
  type AcceptedOpenCatalogPolicyV1,
  type BuildOpenOwnerContextGraphPolicyInputV1,
} from './open-catalog-policy-v1.js';
import {
  Rfc64PublicCatalogReceiverV1,
  type Rfc64PublicCatalogReceiverReconcilerV1,
  type Rfc64PublicCatalogReceiverOptionsV1,
  type Rfc64PublicCatalogReceiverStatsV1,
} from './public-catalog-receiver-v1.js';
import {
  Rfc64PublicCatalogNativeTransportV1,
  type Rfc64PublicCatalogNativeAuthorizationInputV1,
  type Rfc64PublicCatalogNativeAuthorizationV1,
  type Rfc64PublicCatalogNativeTransportOptionsV1,
} from './public-catalog-native-transport-v1.js';
import {
  produceDirectAuthorCatalogIssuerDelegationV1,
} from './public-catalog-issuer-delegation-v1.js';
import type {
  Rfc64PublicCatalogIssuerAuthorizationV1,
} from './public-catalog-successor-producer-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  Rfc64PublicCatalogTransportV1,
  encodeRfc64PublicCatalogHeadAnnouncementV1,
  parseRfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from './public-catalog-transport-v1.js';

/** Default per-peer announce/fetch deadline (ms). */
const DEFAULT_TRANSPORT_TIMEOUT_MS = 10_000;
/** Hard fan-out bound for one explicit best-effort announcement call. */
export const RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 = 64;
const RFC64_PUBLIC_CATALOG_PEER_ID_MAX_BYTES_V1 = 256;
const UTF8 = new TextEncoder();

export interface Rfc64PublicCatalogServiceOptionsV1 {
  readonly router: ProtocolRouter;
  readonly controlObjects: Rfc64ControlObjectOperationsV1;
  readonly receiver?: Rfc64PublicCatalogReceiverOptionsV1;
  /** Full production native content/reconciliation path. Omission is diagnostic-only. */
  readonly native?: Rfc64PublicCatalogServiceNativeOptionsV1;
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
  readonly transportTimeoutMs: number;
}

export interface Rfc64PublicCatalogServiceNativeOptionsV1 extends Pick<
  Rfc64PublicCatalogNativeTransportOptionsV1,
  'readCatalogObjectByDigest' | 'readKaBundleByDigest'
> {
  /** Construct exactly one reconciler around the service-owned transports. */
  readonly createReconciler: (
    clients: Readonly<Rfc64PublicCatalogReconcilerClientsV1>,
  ) => Rfc64PublicCatalogReceiverReconcilerV1;
}

export interface PublishOpenAuthorCatalogGenesisInputV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly signer: Rfc64AuthorCatalogEip191SignerV1;
  readonly issuedAt: TimestampMsV1;
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
  /** The accepted open policy for the CG; its digest stamps the announcement. */
  readonly policy: AcceptedOpenCatalogPolicyV1;
  /** Peers to announce availability to. Announcements are best-effort hints. */
  readonly peers: readonly string[];
}

export interface PublishOpenAuthorCatalogGenesisResultV1 {
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

export interface AnnounceRfc64PublicCatalogHeadInputV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /** Unique peer IDs; at most RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1. */
  readonly peers: readonly string[];
}

export interface AnnounceRfc64PublicCatalogHeadResultV1 {
  /** Validated immutable snapshot used for every delivery attempt. */
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /** Input-order peers that returned the exact transport ACK. */
  readonly announcedPeers: readonly string[];
  /** Input-order peers whose bounded attempt threw or returned a non-ACK. */
  readonly failedPeers: ReadonlyArray<{ readonly peerId: string; readonly error: string }>;
}

export interface Rfc64PublicCatalogServiceStatsV1 {
  readonly started: boolean;
  readonly acceptedPolicies: number;
  readonly receiver: Rfc64PublicCatalogReceiverStatsV1;
}

export class Rfc64PublicCatalogServiceV1 {
  readonly #controlObjects: Rfc64ControlObjectOperationsV1;
  readonly #verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  readonly #policies = new Rfc64AcceptedOpenCatalogPolicyRegistryV1();
  readonly #receiver: Rfc64PublicCatalogReceiverV1;
  readonly #transport: Rfc64PublicCatalogTransportV1;
  readonly #nativeTransport: Rfc64PublicCatalogNativeTransportV1 | undefined;
  readonly #transportTimeoutMs: number;
  #started = false;
  #closed = false;

  constructor(options: Rfc64PublicCatalogServiceOptionsV1) {
    this.#controlObjects = options.controlObjects;
    this.#verifyIssuerSignature =
      options.verifyIssuerSignature ?? verifyControlEnvelopeIssuerSignatureV1;
    this.#transportTimeoutMs = options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;

    this.#transport = new Rfc64PublicCatalogTransportV1(options.router, {
      controlObjects: this.#controlObjects,
      authorizeOpenCatalogOperation: this.#policies.authorize,
      verifyIssuerSignature: this.#verifyIssuerSignature,
      // Non-blocking: schedule() enqueues synchronously so the transport's ACK
      // path (which awaits this callback) is never stalled on a fetch.
      onCatalogHeadAvailable: (announcement, remotePeerId) => {
        this.#receiver.schedule(announcement, remotePeerId);
      },
    });

    this.#nativeTransport = options.native === undefined
      ? undefined
      : new Rfc64PublicCatalogNativeTransportV1(options.router, {
        readCatalogObjectByDigest: options.native.readCatalogObjectByDigest,
        readKaBundleByDigest: options.native.readKaBundleByDigest,
        authorizeOpenCatalogOperation: (input) => this.#authorizeNativeOperation(input),
        verifyIssuerSignature: this.#verifyIssuerSignature,
      });
    const reconciler = options.native === undefined
      ? {
        isHeadApplied: async () => false,
        reconcileHead: (remotePeerId, announcement, signal) =>
          this.#stageHeadOnly(remotePeerId, announcement, signal, options.onHeadStaged),
      } satisfies Rfc64PublicCatalogReceiverReconcilerV1
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
        transportTimeoutMs: this.#transportTimeoutMs,
      }));
    this.#receiver = new Rfc64PublicCatalogReceiverV1(reconciler, options.receiver);
  }

  get started(): boolean {
    return this.#started;
  }

  /** Registry accessor for accepting the CG's open policy (author or receiver). */
  acceptOpenPolicy(
    input: BuildOpenOwnerContextGraphPolicyInputV1,
  ): AcceptedOpenCatalogPolicyV1 {
    return this.#policies.accept(buildOpenOwnerContextGraphPolicyV1(input));
  }

  /** Resolve the locally accepted open-policy digest for one exact catalog scope. */
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
      // Register the announcement protocol last so no callback can schedule
      // reconciliation before the content-fetch protocols are live.
      this.#transport.start();
      this.#started = true;
    } catch (cause) {
      this.#nativeTransport?.stop();
      throw cause;
    }
  }

  /** Stop serving, drain in-flight receiver work, then release. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    try {
      // Keep both outbound transports live until the scheduler has drained.
      // Post-close availability callbacks are harmless: schedule() rejects them.
      await this.#receiver.close();
    } finally {
      this.#transport.stop();
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
    this.#requireStarted();
    const scope = snapshotCatalogScope(input.scope);
    const signer = Object.freeze({
      issuer: input.signer.issuer,
      signDigest: input.signer.signDigest,
    });
    const issuedAt = input.issuedAt;
    const effectiveAt = input.catalogIssuerDelegationEffectiveAt;
    const expiresAt = input.catalogIssuerDelegationExpiresAt;
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(input.peers);
    const heldPolicy = this.#policies.lookup(scope.networkId, scope.contextGraphId);
    assertOpenPolicyMatchesCatalogScope(input.policy, heldPolicy, scope);
    const policyDigest = heldPolicy!.policyDigest;
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
    this.#assertAcceptedOpenAnnouncement(announcement);
    return this.#announceCatalogHeadSnapshot(announcement, peers);
  }

  /** Idle-await the receiver (tests / graceful shutdown coordination). */
  whenReceiverIdle(): Promise<void> {
    return this.#receiver.whenIdle();
  }

  stats(): Rfc64PublicCatalogServiceStatsV1 {
    return Object.freeze({
      started: this.#started,
      acceptedPolicies: this.#policies.size,
      receiver: this.#receiver.stats(),
    });
  }

  #sendOptions(): SendOptions {
    return { timeoutMs: this.#transportTimeoutMs };
  }

  async #announceCatalogHeadSnapshot(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    peers: readonly string[],
  ): Promise<AnnounceRfc64PublicCatalogHeadResultV1> {
    const announcedPeers: string[] = [];
    const failedPeers: Array<{ peerId: string; error: string }> = [];
    for (const peerId of peers) {
      try {
        await this.#transport.announceCatalogHead(peerId, announcement, this.#sendOptions());
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

  #assertAcceptedOpenAnnouncement(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): void {
    const held = this.#policies.lookup(announcement.networkId, announcement.contextGraphId);
    if (
      held === null
      || held.policy.accessPolicy !== 0
      || held.policyDigest !== announcement.policyDigest
      || held.policy.source.kind !== 'owner-signed-unregistered'
      || held.policy.source.ownerAddress !== announcement.authorAddress
    ) {
      throw new Error(
        'RFC-64 catalog announcement is not bound to the locally accepted open policy',
      );
    }
  }
  async #authorizeNativeOperation(
    input: Rfc64PublicCatalogNativeAuthorizationInputV1,
  ): Promise<Rfc64PublicCatalogNativeAuthorizationV1 | null> {
    const record = this.#policies.lookup(input.networkId, input.contextGraphId);
    if (record === null || record.policy.accessPolicy !== 0) return null;
    return Object.freeze({
      accessPolicy: 0,
      policyDigest: record.policyDigest,
    });
  }

  async #stageHeadOnly(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    signal: AbortSignal,
    onHeadStaged?: Rfc64PublicCatalogServiceOptionsV1['onHeadStaged'],
  ): Promise<'not-found' | 'staged-only'> {
    if (signal.aborted) throw signal.reason;
    const fetched = await this.#transport.fetchCatalogHead(
      remotePeerId,
      announcement,
      this.#sendOptions(),
    );
    if (fetched === null) return 'not-found';
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

export function snapshotRfc64PublicCatalogAnnouncementPeersV1(
  input: readonly string[],
): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TypeError('RFC-64 catalog announcement peers must be an array');
  }
  if (input.length > RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) {
    throw new RangeError(
      `RFC-64 catalog announcement accepts at most `
      + `${RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1} peers`,
    );
  }
  const seen = new Set<string>();
  const peers: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const peerId = input[index];
    const byteLength = typeof peerId === 'string' ? UTF8.encode(peerId).byteLength : 0;
    if (
      typeof peerId !== 'string'
      || byteLength === 0
      || byteLength > RFC64_PUBLIC_CATALOG_PEER_ID_MAX_BYTES_V1
      || peerId.trim() !== peerId
    ) {
      throw new TypeError(`RFC-64 catalog announcement peer ${index} is invalid`);
    }
    if (seen.has(peerId)) {
      throw new TypeError(`RFC-64 catalog announcement peer ${index} is duplicated`);
    }
    seen.add(peerId);
    peers.push(peerId);
  }
  return Object.freeze(peers);
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
