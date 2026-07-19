// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 Gate 1 public author-catalog service.
 *
 * Cohesive owner of the public catalog slice wired into a running DKGAgent:
 *   - constructs {@link Rfc64PublicCatalogTransportV1} on the agent's PRODUCTION
 *     {@link ProtocolRouter} (admission-gated exactly like every other node
 *     protocol; on a chain-free node admission is disabled and it is open),
 *   - routes untrusted availability hints into the {@link Rfc64PublicCatalogReceiverV1}
 *     scheduler (fetch-by-digest → transport re-verify → durable stage; no
 *     activation),
 *   - answers the transport's open-policy check from the accepted-policy
 *     registry ({@link Rfc64AcceptedOpenCatalogPolicyRegistryV1}),
 *   - and provides the author path: produce a genesis head, durably stage it,
 *     then best-effort announce its availability to peers.
 *
 * Gate-1 boundary: no candidate-row admission, no KA/SWM/VM activation, no
 * invite-only policy, no successor heads.
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
  type Rfc64PublicCatalogReceiverOptionsV1,
  type Rfc64PublicCatalogReceiverStatsV1,
} from './public-catalog-receiver-v1.js';
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
  readonly #transportTimeoutMs: number;
  #started = false;
  #closed = false;

  constructor(options: Rfc64PublicCatalogServiceOptionsV1) {
    this.#controlObjects = options.controlObjects;
    this.#verifyIssuerSignature =
      options.verifyIssuerSignature ?? verifyControlEnvelopeIssuerSignatureV1;
    this.#transportTimeoutMs = options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;

    this.#receiver = new Rfc64PublicCatalogReceiverV1(
      {
        isHeadStaged: (announcement) => this.#isHeadStaged(announcement),
        fetchHead: (remotePeerId, announcement) =>
          this.#transport.fetchCatalogHead(remotePeerId, announcement, this.#sendOptions()),
        stageHead: (fetched) => this.#stageFetchedHead(fetched),
      },
      {
        ...options.receiver,
        onHeadStaged: options.onHeadStaged ?? options.receiver?.onHeadStaged,
      },
    );

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
    this.#transport.start();
    this.#started = true;
  }

  /** Stop serving, drain in-flight receiver work, then release. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    this.#transport.stop();
    await this.#receiver.close();
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

  async #isHeadStaged(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Promise<boolean> {
    const stored = await this.#controlObjects.getVerifiedObject({
      objectDigest: announcement.catalogHeadObjectDigest,
      signatureVariantDigest: announcement.signatureVariantDigest,
      verifyIssuerSignature: this.#verifyIssuerSignature,
    });
    return stored !== null;
  }

  async #stageFetchedHead(fetched: {
    readonly envelope: SignedControlEnvelopeV1;
    readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  }): Promise<void> {
    await this.#controlObjects.stageVerifiedObjects([fetched]);
  }

  #requireStarted(): void {
    if (!this.#started || this.#closed) {
      throw new Error('RFC-64 public catalog service is not started');
    }
  }
}
