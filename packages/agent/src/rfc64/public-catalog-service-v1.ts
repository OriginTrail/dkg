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
 *   - and provides the author path: produce a genesis head, durably stage it,
 *     then best-effort announce its availability to peers.
 *
 * Omitting a reconciler retains a staging-only diagnostic mode for the earlier
 * Gate-1A demo. That mode never reports a head as applied and never uses staged
 * control objects as restart dedup state.
 */

import {
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
import type { Rfc64ControlObjectOperationsV1 } from './control-object-store-v1.js';
import {
  Rfc64AcceptedOpenCatalogPolicyRegistryV1,
  buildOpenOwnerContextGraphPolicyV1,
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
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  Rfc64PublicCatalogTransportV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from './public-catalog-transport-v1.js';

/** Default per-peer announce/fetch deadline (ms). */
const DEFAULT_TRANSPORT_TIMEOUT_MS = 10_000;

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
  readonly catalogIssuerDelegationDigest: Digest32V1;
  readonly issuedAt: TimestampMsV1;
  /** The accepted open policy for the CG; its digest stamps the announcement. */
  readonly policy: AcceptedOpenCatalogPolicyV1;
  /** Peers to announce availability to. Announcements are best-effort hints. */
  readonly peers: readonly string[];
}

export interface PublishOpenAuthorCatalogGenesisResultV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  readonly headObjectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
  /** Peers the announcement was acknowledged by. */
  readonly announcedPeers: readonly string[];
  /** Peers whose announcement failed (best-effort; correctness comes from pull). */
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
      : options.native.createReconciler({
        headTransport: this.#transport,
        contentTransport: this.#nativeTransport!,
        transportTimeoutMs: this.#transportTimeoutMs,
      });
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
   * Author path: produce a signed empty genesis head, durably stage its
   * immutable objects, then best-effort announce availability to `peers`. The
   * head is durable before any announcement; announcements grant no authority.
   */
  async publishOpenAuthorCatalogGenesis(
    input: PublishOpenAuthorCatalogGenesisInputV1,
  ): Promise<PublishOpenAuthorCatalogGenesisResultV1> {
    this.#requireStarted();
    const produced = await produceEmptyAuthorCatalogGenesisV1({
      scope: input.scope,
      catalogIssuerDelegationDigest: input.catalogIssuerDelegationDigest,
      issuedAt: input.issuedAt,
      signer: input.signer,
    });

    const verified = await Promise.all(
      produced.stagedObjects.map(async (envelope) => ({
        envelope,
        issuerSignature: await this.#verifyIssuerSignature(envelope),
      })),
    );
    const staged = await this.#controlObjects.stageVerifiedObjects(verified);
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
      policyDigest: input.policy.policyDigest,
      catalogHeadObjectDigest: headKeys.objectDigest,
      signatureVariantDigest: headKeys.signatureVariantDigest,
    });

    const announcedPeers: string[] = [];
    const failedPeers: Array<{ peerId: string; error: string }> = [];
    for (const peerId of input.peers) {
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
      headObjectDigest: headKeys.objectDigest,
      signatureVariantDigest: headKeys.signatureVariantDigest,
      announcedPeers: Object.freeze(announcedPeers),
      failedPeers: Object.freeze(failedPeers),
    });
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
