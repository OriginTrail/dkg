// SPDX-License-Identifier: Apache-2.0

import {
  decodeOpaqueKaBundleV1,
} from '@origintrail-official/dkg-core';
import {
  buildAgentProfileVerificationClosureV1,
  copyBoundedSystemRecordBytesV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  computeSignedSystemRecordEnvelopeDigestV1,
  computeSystemRecordStableKeyHashV1,
  decodeSystemRecordInventoryRowV1,
  encodeSystemRecordInventoryRowV1,
  parseCanonicalOwnedSubjectTableObjectV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
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
} from '@origintrail-official/dkg-core/system-record-v1';
import type {
  Quad,
  SystemRecordApplyOutcomeV1,
} from '@origintrail-official/dkg-storage';

import {
  type SystemRecordArtifactRepositoryV1,
  type SystemRecordArtifactV1,
} from './artifact-v1.js';
import type { AgentProfileAdmittedSliceContextV1 } from './admitted-slice-context-v1.js';
import { isOrdinaryActiveInventoryRowV1 } from './inventory-row-policy-v1.js';

export interface AgentProfileReceiverVerifiedBundleV1 {
  /** Exact canonical projection bytes parsed and authenticated from the supplied bundle. */
  readonly canonicalProjectionBytes: Uint8Array;
  /** Exact graphless quads parsed from canonicalProjectionBytes. */
  readonly projectionQuads: readonly Readonly<Quad>[];
}

export type SignedAgentProfileActiveHeadEnvelopeV1 = SignedAgentProfileHeadEnvelopeV1 & {
  readonly object: AgentProfileActiveHeadObjectV1;
};

/** Verified active-profile facts handed to the lifecycle-owned materializer bridge. */
export interface AgentProfileReceiverCandidateV1 {
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly envelope: SignedAgentProfileActiveHeadEnvelopeV1;
  readonly canonicalProjectionBytes: Uint8Array;
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
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
  /** Final graph-scoped publication/seal verification of one coherent projection. */
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
    admittedContext: AgentProfileAdmittedSliceContextV1,
    signal: AbortSignal,
  ) => SystemRecordApplyOutcomeV1 | Promise<SystemRecordApplyOutcomeV1>;
  readonly nowMs?: () => number;
}

export interface AgentProfileReceiverV1 {
  /** Immutable construction-time source used only by the legacy direct path. */
  readonly artifacts: SystemRecordArtifactRepositoryV1;
  /** Open one bounded logical preparation that may resume across physical slices. */
  openPreparation(row: SystemRecordInventoryRowV1): AgentProfileActivePreparationV1;
  /** Prepare through one explicit admitted-slice artifact source. */
  prepareActive(
    row: SystemRecordInventoryRowV1,
    artifacts: SystemRecordArtifactRepositoryV1,
    signal: AbortSignal,
  ): Promise<AgentProfilePreparedActiveV1>;
  /** Convenience for direct callers that already own the admitted slice lifetime. */
  receiveActive(
    row: SystemRecordInventoryRowV1,
    admittedContext: AgentProfileAdmittedSliceContextV1,
    signal: AbortSignal,
  ): Promise<SystemRecordApplyOutcomeV1>;
}

export interface AgentProfileActivePreparationV1 {
  prepare(
    artifacts: SystemRecordArtifactRepositoryV1,
    signal: AbortSignal,
  ): Promise<AgentProfilePreparedActiveV1>;
  release(): void;
}

export interface AgentProfilePreparedActiveV1 {
  /**
   * Dispatch exactly once. Once called, the returned promise is the physical
   * settlement boundary and must not be detached on abort or deadline.
   */
  apply(
    admittedContext: AgentProfileAdmittedSliceContextV1,
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
  const resolveArtifact = options.artifacts.resolve.bind(options.artifacts);
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

  const defaultArtifacts: SystemRecordArtifactRepositoryV1 = Object.freeze({
    resolve: resolveArtifact,
  });
  const receiver: AgentProfileReceiverV1 = Object.freeze({
    artifacts: defaultArtifacts,
    openPreparation(inputRow: SystemRecordInventoryRowV1): AgentProfileActivePreparationV1 {
      const row = canonicalInventoryRow(networkId, inputRow);
      if (!isOrdinaryActiveInventoryRowV1(row)) {
        throw new Error('active profile receiver requires an ordinary active inventory row');
      }
      const verificationNowMs = receiverNowMs(nowMs?.() ?? Date.now());
      const verifiedAuthorityEnvelopes = new Set<Digest32V1>();
      const verifiedBundles = new Map<string, VerifiedActiveProfileClosureV1['verifiedBundle']>();
      let released = false;
      return Object.freeze({ prepare, release });

      function prepare(
        artifacts: SystemRecordArtifactRepositoryV1,
        signal: AbortSignal,
      ): Promise<AgentProfilePreparedActiveV1> {
        if (released) throw new Error('agent-profile receiver preparation is released');
        return prepareActiveFromResolver(
          row,
          artifacts.resolve.bind(artifacts),
          signal,
          verificationNowMs,
          verifiedAuthorityEnvelopes,
          verifiedBundles,
        );
      }

      function release(): void {
        if (released) return;
        released = true;
        verifiedAuthorityEnvelopes.clear();
        verifiedBundles.clear();
      }
    },
    async prepareActive(
      row: SystemRecordInventoryRowV1,
      artifacts: SystemRecordArtifactRepositoryV1,
      signal: AbortSignal,
    ): Promise<AgentProfilePreparedActiveV1> {
      signal.throwIfAborted();
      const preparation = receiver.openPreparation(row);
      try {
        return await preparation.prepare(artifacts, signal);
      } finally {
        preparation.release();
      }
    },
    async receiveActive(
      row: SystemRecordInventoryRowV1,
      admittedContext: AgentProfileAdmittedSliceContextV1,
      signal: AbortSignal,
    ): Promise<SystemRecordApplyOutcomeV1> {
      const prepared = await receiver.prepareActive(row, receiver.artifacts, signal);
      signal.throwIfAborted();
      return prepared.apply(admittedContext, signal);
    },
  });
  return receiver;

  async function prepareActiveFromResolver(
    row: SystemRecordInventoryRowV1,
    resolveForCall: SystemRecordArtifactRepositoryV1['resolve'],
    signal: AbortSignal,
    verificationNowMs: number,
    verifiedAuthorityEnvelopes: Set<Digest32V1>,
    verifiedBundles: Map<string, VerifiedActiveProfileClosureV1['verifiedBundle']>,
  ): Promise<AgentProfilePreparedActiveV1> {
    signal.throwIfAborted();
    const {
      envelope,
      verifiedBundle,
      verifiedAuthoritySummary,
    } = await verifyActiveProfileClosureForRowV1({
      networkId,
      row,
      signal,
      nowMs: verificationNowMs,
      resolveArtifact: resolveForCall,
      verifyAuthorityEnvelope,
      verifyCurrentBundle,
      verifiedAuthorityEnvelopes,
      verifiedBundles,
    });
    signal.throwIfAborted();

    const head = envelope.object;
    const resolvedSubjectTableArtifact = await resolveForCall({
      type: 'object',
      objectKind: 'owned-subject-table',
      objectDigest: head.ownedSubjectTableDigest,
    }, signal);
    signal.throwIfAborted();
    if (resolvedSubjectTableArtifact === null) {
      throw new Error('active profile receiver is missing its exact owned-subject table');
    }
    const subjectTableArtifact = snapshotExpectedArtifactV1(
      resolvedSubjectTableArtifact,
      'owned-subject-table',
      head.ownedSubjectTableDigest,
      'owned-subject table',
    );
    const ownedSubjectTable = parseCanonicalOwnedSubjectTableObjectV1(
      head.rootSubject,
      subjectTableArtifact.canonicalBytes,
    );
    if (computeOwnedSubjectTableDigestV1(head.rootSubject, ownedSubjectTable)
        !== head.ownedSubjectTableDigest
      || BigInt(ownedSubjectTable.length) !== BigInt(head.ownedSubjectCount)) {
      throw new Error('active profile owned-subject table does not bind the verified head');
    }

    const candidate = Object.freeze({
      head,
      envelope,
      canonicalProjectionBytes: verifiedBundle.canonicalProjectionBytes,
      projectionQuads: verifiedBundle.projectionQuads,
      ownedSubjectTable,
      verifiedAuthoritySummary,
    });
    let dispatched = false;
    return Object.freeze({
      async apply(
        admittedContext: AgentProfileAdmittedSliceContextV1,
        applySignal: AbortSignal,
      ): Promise<SystemRecordApplyOutcomeV1> {
        if (dispatched) throw new Error('active profile receiver apply was already dispatched');
        applySignal.throwIfAborted();
        dispatched = true;
        // Atomic apply is the point of no return. A cancellation that arrives
        // after dispatch must not detach the operation or hide a committed outcome.
        return consumeCandidate(candidate, admittedContext, applySignal);
      },
    });
  }
}

interface VerifiedActiveProfileClosureV1 {
  readonly envelope: SignedAgentProfileActiveHeadEnvelopeV1;
  readonly verifiedBundle: Readonly<{
    readonly projectionQuads: readonly Readonly<Quad>[];
    readonly canonicalProjectionBytes: Uint8Array;
  }>;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
}

interface VerifyActiveProfileClosureOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly row: SystemRecordInventoryRowV1;
  readonly signal: AbortSignal;
  readonly nowMs: number;
  readonly resolveArtifact: SystemRecordArtifactRepositoryV1['resolve'];
  readonly verifyAuthorityEnvelope: NonNullable<
    CreateAgentProfileReceiverOptionsV1['verifyAuthorityEnvelope']
  >;
  readonly verifyCurrentBundle: CreateAgentProfileReceiverOptionsV1['verifyCurrentBundle'];
  readonly verifiedAuthorityEnvelopes: Set<Digest32V1>;
  readonly verifiedBundles: Map<string, VerifiedActiveProfileClosureV1['verifiedBundle']>;
}

async function verifyActiveProfileClosureForRowV1(
  options: VerifyActiveProfileClosureOptionsV1,
): Promise<VerifiedActiveProfileClosureV1> {
  const {
    networkId,
    row,
    signal,
    nowMs,
    resolveArtifact,
    verifyAuthorityEnvelope,
    verifyCurrentBundle,
    verifiedAuthorityEnvelopes,
    verifiedBundles,
  } = options;
  let verifiedBundle: VerifiedActiveProfileClosureV1['verifiedBundle'] | undefined;
  const closure =
    await buildAgentProfileVerificationClosureV1(row.headDigest, {
      nowMs,
      resolve: async (reference) => {
        signal.throwIfAborted();
        const artifact = await resolveArtifact({
          type: 'object',
          objectKind: reference.objectKind,
          objectDigest: reference.digest,
        }, signal);
        signal.throwIfAborted();
        if (artifact === null) return undefined;
        const owned = snapshotExpectedArtifactV1(
          artifact,
          reference.objectKind,
          reference.digest,
          'closure artifact',
        );
        if (reference.objectKind === 'agent-profile-head'
          && reference.digest === row.headDigest) {
          assertRowBindsHead(
            networkId,
            row,
            parseCanonicalSignedAgentProfileHeadEnvelopeV1(owned.canonicalBytes),
          );
        }
        return Object.freeze({
          objectKind: owned.objectKind,
          digest: owned.objectDigest,
          canonicalBytes: owned.canonicalBytes,
        });
      },
      verifyAuthorityEnvelope: async (envelope) => {
        const envelopeDigest = computeSignedSystemRecordEnvelopeDigestV1<
          AgentProfileHeadObjectV1
          | AgentProfileAuthorityTransitionV1
          | AgentProfileForkResolutionV1
        >(envelope);
        if (verifiedAuthorityEnvelopes.has(envelopeDigest)) return true;
        signal.throwIfAborted();
        const verified = await verifyAuthorityEnvelope(envelope, signal);
        signal.throwIfAborted();
        if (verified === true) verifiedAuthorityEnvelopes.add(envelopeDigest);
        return verified === true;
      },
      verifyCurrentBundle: async (head, canonicalBundleBytes) => {
        const headDigest = computeAgentProfileHeadObjectDigestV1(head);
        const memoKey = `${headDigest}\u0000${head.bundleDigest}`;
        const memoized = verifiedBundles.get(memoKey);
        if (memoized !== undefined) {
          verifiedBundle = memoized;
          return true;
        }
        signal.throwIfAborted();
        const result = await verifyCurrentBundle(
          head,
          Uint8Array.from(canonicalBundleBytes),
          signal,
        );
        signal.throwIfAborted();
        const decoded = decodeOpaqueKaBundleV1(canonicalBundleBytes);
        verifiedBundle = snapshotVerifiedBundle(result, decoded.projectionBytes);
        verifiedBundles.set(memoKey, verifiedBundle);
        return true;
      },
    });
  const currentHeadArtifact = closure.objects.find((artifact) =>
    artifact.objectKind === 'agent-profile-head' && artifact.digest === row.headDigest,
  );
  if (currentHeadArtifact === undefined)
    throw new Error('verification closure did not retain its current agent-profile head');
  const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
    currentHeadArtifact.canonicalBytes,
  );
  assertRowBindsHead(networkId, row, envelope);
  assertActiveHeadEnvelopeV1(envelope);
  if (verifiedBundle === undefined) {
    throw new Error('active profile receiver resolved a non-active verification closure');
  }
  return Object.freeze({
    envelope,
    verifiedBundle,
    verifiedAuthoritySummary: closure.authoritySummary,
  });
}

function assertActiveHeadEnvelopeV1(
  envelope: SignedAgentProfileHeadEnvelopeV1,
): asserts envelope is SignedAgentProfileActiveHeadEnvelopeV1 {
  if (envelope.object.state !== 'active') {
    throw new Error('active profile receiver resolved a non-active verification closure');
  }
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

function snapshotExpectedArtifactV1(
  input: SystemRecordArtifactV1,
  expectedKind: SystemRecordObjectKindV1,
  expectedDigest: Digest32V1,
  label: string,
): SystemRecordArtifactV1 {
  const objectKind = input.objectKind;
  const objectDigest = input.objectDigest;
  if (objectKind !== expectedKind || objectDigest !== expectedDigest) {
    throw new Error(`system-record repository returned a different ${label}`);
  }
  return Object.freeze({
    objectKind,
    objectDigest,
    canonicalBytes: copyBoundedSystemRecordBytesV1(
      input.canonicalBytes,
      SYSTEM_RECORD_OBJECT_CAPS_V1[expectedKind],
      label,
    ),
  });
}

function snapshotVerifiedBundle(
  value: AgentProfileReceiverVerifiedBundleV1,
  expectedProjectionBytes: Uint8Array,
): AgentProfileReceiverVerifiedBundleV1 {
  if (value === null || typeof value !== 'object'
    || !(value.canonicalProjectionBytes instanceof Uint8Array)
    || !Array.isArray(value.projectionQuads)) {
    throw new Error('bundle verifier returned an invalid projection');
  }
  const suppliedProjectionBytes = value.canonicalProjectionBytes;
  if (suppliedProjectionBytes.byteLength !== expectedProjectionBytes.byteLength
    || suppliedProjectionBytes.some((byte, index) => byte !== expectedProjectionBytes[index])) {
    throw new Error('bundle verifier projection does not bind the supplied bundle');
  }
  const projectionQuads = value.projectionQuads.map((quad) => Object.freeze({
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
    graph: quad.graph,
  }));
  return Object.freeze({
    canonicalProjectionBytes: Uint8Array.from(expectedProjectionBytes),
    projectionQuads: Object.freeze(projectionQuads),
  });
}

function receiverNowMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('agent-profile receiver clock returned an invalid value');
  }
  return value;
}
