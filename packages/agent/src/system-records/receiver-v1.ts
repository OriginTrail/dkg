// SPDX-License-Identifier: Apache-2.0

import {
  decodeOpaqueKaBundleV1,
} from '@origintrail-official/dkg-core';
import {
  buildAgentProfileVerificationClosureV1,
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordStableKeyHashV1,
  decodeSystemRecordInventoryRowV1,
  encodeSystemRecordInventoryRowV1,
  parseCanonicalOwnedSubjectTableObjectV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  verifySignedSystemRecordEnvelopeV1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type Digest32V1,
  type NetworkIdV1,
  type OwnedSubjectTableObjectV1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileForkResolutionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordObjectKindV1,
  type SystemRecordVerificationClosureObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type {
  Quad,
  SystemRecordApplyOutcomeV1,
} from '@origintrail-official/dkg-storage';

import {
  cloneSystemRecordArtifactV1,
  type SystemRecordArtifactRepositoryV1,
} from './artifact-v1.js';

export interface AgentProfileReceiverVerifiedBundleV1 {
  /** Exact graphless quads parsed and authenticated from the supplied bundle. */
  readonly projectionQuads: readonly Readonly<Quad>[];
}

/** Verified active-profile facts handed to the lifecycle-owned materializer bridge. */
export interface AgentProfileReceiverCandidateV1 {
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly envelope: SignedAgentProfileHeadEnvelopeV1;
  readonly canonicalProjectionBytes: Uint8Array;
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly signal: AbortSignal;
}

export interface CreateAgentProfileReceiverOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly artifacts: SystemRecordArtifactRepositoryV1;
  /**
   * Final authority verification, including bounded EIP-1271 handling when the
   * envelope requests it. The receiver never owns a chain client or RPC queue.
   */
  readonly verifyAuthorityEnvelope?: (
    envelope:
      | SignedAgentProfileHeadEnvelopeV1
      | SignedAgentProfileAuthorityTransitionEnvelopeV1
      | SignedAgentProfileForkResolutionEnvelopeV1,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
  /**
   * Final graph-scoped publication/seal verification. Returning projection
   * quads asserts that they were parsed from this exact canonical bundle.
   */
  readonly verifyCurrentBundle: (
    head: AgentProfileActiveHeadObjectV1,
    canonicalBundleBytes: Uint8Array,
    signal: AbortSignal,
  ) => AgentProfileReceiverVerifiedBundleV1 | Promise<AgentProfileReceiverVerifiedBundleV1>;
  /**
   * Lifecycle-owned bridge into the storage runtime. It mints and consumes the
   * private replacement proof inside one structured call; no proof escapes.
   */
  readonly consumeCandidate: (
    input: AgentProfileReceiverCandidateV1,
  ) => SystemRecordApplyOutcomeV1 | Promise<SystemRecordApplyOutcomeV1>;
  readonly nowMs?: () => number;
}

export interface AgentProfileReceiverV1 {
  /**
   * Verify and apply one active inventory row. Inventory traversal, admission,
   * continuation, caching, and retries remain owned by the caller.
   */
  receiveActive(
    row: SystemRecordInventoryRowV1,
    signal: AbortSignal,
  ): Promise<SystemRecordApplyOutcomeV1>;
}

/**
 * Default-unused exact active-record receiver. The only mutable state is scoped
 * to one call, so abort and shutdown cannot strand a background operation.
 */
export function createAgentProfileReceiverV1(
  options: CreateAgentProfileReceiverOptionsV1,
): AgentProfileReceiverV1 {
  const networkId = options.networkId;
  const artifacts = options.artifacts;
  const verifyCurrentBundle = options.verifyCurrentBundle;
  const consumeCandidate = options.consumeCandidate;
  const nowMs = options.nowMs;
  const verifyAuthorityEnvelope = options.verifyAuthorityEnvelope
    ?? ((envelope: SignedAgentProfileHeadEnvelopeV1
      | SignedAgentProfileAuthorityTransitionEnvelopeV1
      | SignedAgentProfileForkResolutionEnvelopeV1) =>
      verifySignedSystemRecordEnvelopeV1<
        AgentProfileHeadObjectV1
        | AgentProfileAuthorityTransitionV1
        | AgentProfileForkResolutionV1
      >(envelope));

  return Object.freeze({
    async receiveActive(
      inputRow: SystemRecordInventoryRowV1,
      signal: AbortSignal,
    ): Promise<SystemRecordApplyOutcomeV1> {
      signal.throwIfAborted();
      const row = canonicalInventoryRow(networkId, inputRow);
      if (row.tombstone || row.quarantined || row.conflictEvidenceDigest !== undefined) {
        throw new Error('active profile receiver requires an ordinary active inventory row');
      }

      let verifiedBundle: Readonly<{
        projectionQuads: readonly Readonly<Quad>[];
        canonicalProjectionBytes: Uint8Array;
      }> | undefined;
      const closure = await buildAgentProfileVerificationClosureV1(row.headDigest, {
        nowMs: receiverNowMs(nowMs?.() ?? Date.now()),
        resolve: async (reference) => {
          signal.throwIfAborted();
          const artifact = await artifacts.resolve({
            type: 'object',
            objectKind: reference.objectKind,
            objectDigest: reference.digest,
          }, signal);
          signal.throwIfAborted();
          if (artifact === null) return undefined;
          const owned = cloneSystemRecordArtifactV1(artifact);
          if (owned.objectKind !== reference.objectKind || owned.objectDigest !== reference.digest) {
            throw new Error('system-record repository returned a different closure artifact');
          }
          return Object.freeze({
            objectKind: owned.objectKind,
            digest: owned.objectDigest,
            canonicalBytes: owned.canonicalBytes,
          });
        },
        verifyAuthorityEnvelope: async (envelope) => {
          signal.throwIfAborted();
          const verified = await verifyAuthorityEnvelope(envelope, signal);
          signal.throwIfAborted();
          return verified === true;
        },
        verifyCurrentBundle: async (head, canonicalBundleBytes) => {
          signal.throwIfAborted();
          const result = await verifyCurrentBundle(
            head,
            Uint8Array.from(canonicalBundleBytes),
            signal,
          );
          signal.throwIfAborted();
          const decoded = decodeOpaqueKaBundleV1(canonicalBundleBytes);
          verifiedBundle = Object.freeze({
            ...snapshotVerifiedBundle(result),
            canonicalProjectionBytes: Uint8Array.from(decoded.projectionBytes),
          });
          return true;
        },
      });
      signal.throwIfAborted();

      const headArtifact = requiredArtifact(
        closure.objects,
        'agent-profile-head',
        row.headDigest,
      );
      const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
        headArtifact.canonicalBytes,
      );
      const head = envelope.object;
      assertRowBindsHead(networkId, row, envelope);
      if (head.state !== 'active' || verifiedBundle === undefined) {
        throw new Error('active profile receiver resolved a non-active verification closure');
      }
      const verifiedAuthoritySummary = closure.authoritySummary;

      const subjectTableArtifact = await artifacts.resolve({
        type: 'object',
        objectKind: 'owned-subject-table',
        objectDigest: head.ownedSubjectTableDigest,
      }, signal);
      signal.throwIfAborted();
      if (subjectTableArtifact === null
        || subjectTableArtifact.objectKind !== 'owned-subject-table'
        || subjectTableArtifact.objectDigest !== head.ownedSubjectTableDigest) {
        throw new Error('active profile receiver is missing its exact owned-subject table');
      }
      const ownedSubjectTable = parseCanonicalOwnedSubjectTableObjectV1(
        head.rootSubject,
        cloneSystemRecordArtifactV1(subjectTableArtifact).canonicalBytes,
      );
      if (computeOwnedSubjectTableDigestV1(head.rootSubject, ownedSubjectTable)
          !== head.ownedSubjectTableDigest
        || BigInt(ownedSubjectTable.length) !== BigInt(head.ownedSubjectCount)) {
        throw new Error('active profile owned-subject table does not bind the verified head');
      }

      const outcome = await consumeCandidate(Object.freeze({
        head,
        envelope,
        canonicalProjectionBytes: verifiedBundle.canonicalProjectionBytes,
        projectionQuads: verifiedBundle.projectionQuads,
        ownedSubjectTable,
        verifiedAuthoritySummary,
        signal,
      }));
      // Atomic apply is the point of no return. A cancellation that arrives
      // after the storage closure returns must not hide a committed outcome and
      // make the caller retry it as if nothing happened.
      return outcome;
    },
  });
}

function canonicalInventoryRow(
  networkId: NetworkIdV1,
  row: SystemRecordInventoryRowV1,
): SystemRecordInventoryRowV1 {
  return decodeSystemRecordInventoryRowV1(
    networkId,
    encodeSystemRecordInventoryRowV1(networkId, row),
  );
}

function assertRowBindsHead(
  networkId: NetworkIdV1,
  row: SystemRecordInventoryRowV1,
  envelope: SignedAgentProfileHeadEnvelopeV1,
): void {
  const head = envelope.object;
  if (head.networkId !== networkId
    || head.peerId !== row.peerId
    || computeSystemRecordStableKeyHashV1(networkId, row.peerId) !== row.stableKeyHash
    || head.authoritySequence !== row.authoritySequence
    || head.version !== row.version
    || envelope.objectDigest !== row.headDigest
    || (head.state === 'tombstone') !== row.tombstone) {
    throw new Error('inventory row does not bind the verified agent-profile head');
  }
}

function requiredArtifact(
  artifacts: readonly SystemRecordVerificationClosureObjectV1[],
  objectKind: SystemRecordObjectKindV1,
  objectDigest: Digest32V1,
): SystemRecordVerificationClosureObjectV1 {
  const artifact = artifacts.find(
    (candidate) => candidate.objectKind === objectKind && candidate.digest === objectDigest,
  );
  if (artifact === undefined) {
    throw new Error(`verification closure did not retain ${objectKind}:${objectDigest}`);
  }
  return artifact;
}

function snapshotVerifiedBundle(value: AgentProfileReceiverVerifiedBundleV1): AgentProfileReceiverVerifiedBundleV1 {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.projectionQuads)) {
    throw new Error('bundle verifier returned an invalid projection');
  }
  const projectionQuads = value.projectionQuads.map((quad) => Object.freeze({
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
    graph: quad.graph,
  }));
  return Object.freeze({ projectionQuads: Object.freeze(projectionQuads) });
}

function receiverNowMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('agent-profile receiver clock returned an invalid value');
  }
  return value;
}
