import type { FinalizedAssertionReservation } from './finalized-assertion-reservation.js';
// SPDX-License-Identifier: Apache-2.0
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { SharedMemoryGraphScope } from '@origintrail-official/dkg-storage';
import type { DKGPublisher, PublishOptions, PhaseCallback, AssertionLifecycleWriteLease } from '@origintrail-official/dkg-publisher';
import type { PreSignedAuthorAttestation } from '../dkg-agent-types.js';

export type AgentSharedMemoryPublishOptions = {
      clearSharedMemoryAfter?: boolean;
      operationCtx?: OperationContext;
      onPhase?: PhaseCallback;
      /** @deprecated Use subContextGraphId */
      contextGraphId?: string | bigint;
      subContextGraphId?: string | bigint;
      contextGraphSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
      /** Target sub-graph within the context graph (e.g. "code", "decisions"). */
      subGraphName?: string;
      /**
       * Per-publish override for the on-chain
       * `KnowledgeAssetsV10.PublishParams.publisherNodeIdentityId`
       * attribution field (RFC-001 §4). Threaded as a per-call option
       * into `publisher.publishFromSharedMemory` — no global mutation,
       * so concurrent publishes with conflicting overrides are safe.
       *
       * Lets an edge-mode operator route a publish through the
       * home-core's `publishFromSharedMemory` while attributing the
       * publishing-factor credit (and PCA discount, when the submitter
       * is on the named core's `authorizedKeys`) to a different core.
       * `0n` is a valid explicit value and means "no attribution"
       * (RFC-001 §4(d)) — the contract validates this case and the
       * publish proceeds on-chain. The publisher's own
       * `publisherNodeIdentityId` is unchanged and continues to be
       * used for ACK self-signing and signer resolution.
       */
      publisherNodeIdentityIdOverride?: bigint;
      publishEpochs?: number;
      pricingPolicy?: PublishOptions['pricingPolicy'];
      /**
       * OT-RFC-43 A2 (decision 1) — precomputed packed kaId stamped at
       * `assertionFinalize` (ALLOCATE-AT-FINALIZE). When set, the publisher's
       * `ensureReservedKaId` REUSES it instead of allocating again, so a
       * finalize→publish for one KA mints exactly the stamped id (no
       * double-allocation). Undefined for direct/mock publishes — the
       * publisher then keeps its existing allocate-at-publish behavior.
       */
      reservedKaId?: bigint;
      sharedMemoryScope?: SharedMemoryGraphScope;
      contentScopeVersion?: PublishOptions['contentScopeVersion'];
      kaUal?: PublishOptions['kaUal'];
      assertionVersion?: PublishOptions['assertionVersion'];
      publicTripleCount?: PublishOptions['publicTripleCount'];
      privateMerkleRoot?: PublishOptions['privateMerkleRoot'];
      privateTripleCount?: PublishOptions['privateTripleCount'];
      /**
       * RFC-001 §9.x — pre-computed attestation captured by
       * `agent.assertion.finalize()`. When the caller has already
       * sealed a named assertion they can plumb the seal here verbatim
       * and the publisher forwards it unchanged.
       *
       * If omitted AND the publish is going on-chain (V10-capable
       * adapter + on-chain CG id), the agent mints a seal inline at
       * the selection boundary using `authorAgentAddress` /
       * `preSignedAuthorAttestation` / publisher fallback. This is the
       * "selection-based publish" UX bridge — agents/users keep
       * picking rootEntities post-hoc, but the seal is still computed
       * and signed before the publisher sees the payload.
       */
      precomputedAttestation?: PublishOptions['precomputedAttestation'];
      /**
       * Agent address to attribute authorship to when minting an
       * inline seal at this layer. Must be a registered local agent
       * with custodial keys (the daemon holds the private key). For
       * self-sovereign agents use `preSignedAuthorAttestation`. Has
       * no effect when `precomputedAttestation` is also supplied.
       */
      authorAgentAddress?: string;
      /**
       * Pre-signed AuthorAttestation by a self-sovereign agent whose
       * private key isn't held by the daemon. Has no effect when
       * `precomputedAttestation` is also supplied. Mutually exclusive
       * with `authorAgentAddress`.
       */
      preSignedAuthorAttestation?: PreSignedAuthorAttestation;
      /** Author scheme version override (defaults to AUTHOR_SCHEME_VERSION_V1). */
      schemeVersion?: number;
      publisherOverride?: DKGPublisher;
    };
export interface SharedMemoryPublicationContext {
  ctx: OperationContext; ctxGraphIdStr: string | undefined; onChainId: string | undefined;
}

export type FinalizedAssertionPublishOptions = {
      subGraphName?: string;
      agentAddress?: string;
      /** GH#1778 — token/caller identity hint (routes); NOT an author selector. */
      callerAgentAddress?: string;
      /**
       * GH#1786 — selects among the authors already resident at this coordinate.
       * Coexists with `callerAgentAddress`; never changes the caller identity.
       */
      selectedAuthorAgentAddress?: string;
      operationCtx?: OperationContext;
      onPhase?: PhaseCallback;
      publisherNodeIdentityIdOverride?: bigint;
      publishEpochs?: number;
      pricingPolicy?: PublishOptions['pricingPolicy'];
      clearSharedMemoryAfter?: boolean;
      publisherOverride?: DKGPublisher;
    };
export interface FinalizedAssertionRecordingContext {
  readonly reservation: FinalizedAssertionReservation;
  readonly heldLifecycle: AssertionLifecycleWriteLease;
}
