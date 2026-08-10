// SPDX-License-Identifier: Apache-2.0

import {
  decodeOpaqueKaBundleV1,
  parseCanonicalGraphlessProjectionStorageQuadsV1,
} from '@origintrail-official/dkg-core';
import {
  assertAgentProfileProjectionIdentityV1,
  assertAgentProfileProjectionSchemaV1,
  buildAgentProfileForkEvidenceAuthorityClosureV1,
  buildAgentProfileVerificationClosureV1,
  copyBoundedSystemRecordBytesV1,
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
  type AgentProfileConflictEvidenceV1,
  type AgentProfileForkEvidenceClosureVerifierV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileTombstoneHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type Digest32V1,
  type NetworkIdV1,
  type OwnedSubjectTableObjectV1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileForkResolutionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordObjectKindV1,
  type SystemRecordVerificationClosureV1,
  type SystemRecordVerificationClosureObjectV1,
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
import {
  preflightAgentProfileConflictEvidenceV1,
  verifyAgentProfileConflictEvidenceV1,
  type AgentProfileVerifiedConflictArtifactV1,
} from './receiver-conflict-v1-internal.js';

export type SignedAgentProfileActiveHeadEnvelopeV1 = SignedAgentProfileHeadEnvelopeV1 & {
  readonly object: AgentProfileActiveHeadObjectV1;
};

/** Verified active-profile facts handed to the lifecycle-owned materializer bridge. */
export interface AgentProfileReceiverActiveCandidateV1 {
  readonly operation: 'active';
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly envelope: SignedAgentProfileActiveHeadEnvelopeV1;
  readonly canonicalProjectionBytes: Uint8Array;
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
}

export type SignedAgentProfileTombstoneHeadEnvelopeV1 = SignedAgentProfileHeadEnvelopeV1 & {
  readonly object: AgentProfileTombstoneHeadObjectV1;
};

export interface AgentProfileReceiverTombstoneCandidateV1 {
  readonly operation: 'tombstone';
  readonly head: AgentProfileTombstoneHeadObjectV1;
  readonly envelope: SignedAgentProfileTombstoneHeadEnvelopeV1;
  readonly deletionOwnedSubjectTable: OwnedSubjectTableObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
}

export interface AgentProfileReceiverQuarantineCandidateV1 {
  readonly operation: 'quarantine';
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly envelope: SignedAgentProfileActiveHeadEnvelopeV1;
  readonly canonicalProjectionBytes: Uint8Array;
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly conflictEvidence: AgentProfileConflictEvidenceV1;
  readonly conflictEvidenceDigest: Digest32V1;
  readonly canonicalConflictEvidenceBytes: Uint8Array;
  readonly conflictArtifacts: readonly AgentProfileVerifiedConflictArtifactV1[];
  readonly terminalTransitionConflict: boolean;
}

/** Compatibility alias retained for the active-only receiver constructor. */
export type AgentProfileReceiverCandidateV1 = AgentProfileReceiverActiveCandidateV1;

/** One fully verified candidate consumed by the lifecycle-owned atomic storage bridge. */
export type AgentProfileReceiverAnyCandidateV1 =
  | AgentProfileReceiverActiveCandidateV1
  | AgentProfileReceiverTombstoneCandidateV1
  | AgentProfileReceiverQuarantineCandidateV1;

/** Explicit artifact accounting domains consumed by one candidate preparation. */
export interface AgentProfileArtifactSourcesV1 {
  readonly closureArtifacts: SystemRecordArtifactRepositoryV1;
  readonly securitySidecarArtifacts: SystemRecordArtifactRepositoryV1;
}

/** Legacy single repository or the explicit closure/security source pair. */
export type AgentProfileArtifactInputV1 =
  | SystemRecordArtifactRepositoryV1
  | AgentProfileArtifactSourcesV1;

interface CreateAgentProfileReceiverCommonOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly artifacts: AgentProfileArtifactInputV1;
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
  /** Final graph-scoped publication/seal acceptance of the exact supplied bundle. */
  readonly verifyCurrentBundle: (
    head: AgentProfileActiveHeadObjectV1,
    canonicalBundleBytes: Uint8Array,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
  /** Unix wall-clock milliseconds, injectable for deterministic verification. */
  readonly nowMs?: () => number;
}

export interface AgentProfileReceiverPreparedApplyV1 {
  /** Existing authenticated Storage deadline in the bridge's monotonic clock domain. */
  readonly existingMonotonicDeadlineMs: number;
  /** `Math.floor(performance.now())` captured after bridge waits. */
  readonly monotonicNowMs: number;
  /**
   * Begin lifecycle proof issuance and atomic apply synchronously with the
   * receiver-admitted deadline. No Unix timestamp crosses this boundary.
   */
  readonly apply: (
    admittedDeadlineMs: number,
  ) => SystemRecordApplyOutcomeV1 | Promise<SystemRecordApplyOutcomeV1>;
}

export interface CreateAgentProfileReceiverOptionsV1
  extends CreateAgentProfileReceiverCommonOptionsV1 {
  /**
   * Lifecycle-owned preparation for storage apply. After all asynchronous
   * preparation, it returns authenticated monotonic timing and the apply entry.
   * The receiver owns final active-head freshness, active deadline clamping,
   * and the sole call to apply; no replacement proof or prior apply outcome
   * crosses this boundary.
   * Concrete lifecycle composition remains intentionally default-off; only the
   * injected bridge can authenticate and re-inspect the opaque admitted context.
   */
  readonly prepareCandidateApply: (
    input: AgentProfileReceiverCandidateV1,
    admittedContext: AgentProfileAdmittedSliceContextV1,
    signal: AbortSignal,
  ) => AgentProfileReceiverPreparedApplyV1
    | Promise<AgentProfileReceiverPreparedApplyV1>;
}

export interface CreateAgentProfileCandidateReceiverOptionsV1
  extends CreateAgentProfileReceiverCommonOptionsV1 {
  /**
   * Candidate-capable preparation for storage apply. Callers that opt into this
   * constructor must handle active, tombstone, and quarantine candidates.
   */
  readonly prepareCandidateApply: (
    input: AgentProfileReceiverAnyCandidateV1,
    admittedContext: AgentProfileAdmittedSliceContextV1,
    signal: AbortSignal,
  ) => AgentProfileReceiverPreparedApplyV1
    | Promise<AgentProfileReceiverPreparedApplyV1>;
}

export interface AgentProfileReceiverV1 {
  /** Active-only compatibility entry; tombstone and quarantined rows are rejected. */
  prepareActive(
    row: SystemRecordInventoryRowV1,
    signal: AbortSignal,
  ): Promise<AgentProfilePreparedCandidateV1>;
  /** Active-only compatibility entry for callers that own the admitted slice lifetime. */
  receiveActive(
    row: SystemRecordInventoryRowV1,
    admittedContext: AgentProfileAdmittedSliceContextV1,
    signal: AbortSignal,
  ): Promise<SystemRecordApplyOutcomeV1>;
}

/** Candidate-capable receiver for active, tombstone, and quarantine rows. */
export interface AgentProfileCandidateReceiverV1 extends AgentProfileReceiverV1 {
  /**
   * Complete the abort-safe fetch/decode/verification phase. The returned state
   * can prepare one admitted dispatch but cannot mutate storage by itself.
   */
  prepareCandidate(
    row: SystemRecordInventoryRowV1,
    signal: AbortSignal,
  ): Promise<AgentProfilePreparedCandidateV1>;
  /** Apply any verified active, tombstone, or quarantine candidate. */
  receiveCandidate(
    row: SystemRecordInventoryRowV1,
    admittedContext: AgentProfileAdmittedSliceContextV1,
    signal: AbortSignal,
  ): Promise<SystemRecordApplyOutcomeV1>;
}

/** Active-only compatibility extension for one resumable physical preparation. */
export interface AgentProfileContinuationReceiverV1 extends AgentProfileReceiverV1 {
  openPreparation(row: SystemRecordInventoryRowV1): AgentProfilePreparationV1;
}

/** Candidate-capable continuation receiver used by tombstone/quarantine reconciliation. */
export interface AgentProfileCandidateContinuationReceiverV1
  extends AgentProfileCandidateReceiverV1, AgentProfileContinuationReceiverV1 {
  openPreparation(row: SystemRecordInventoryRowV1): AgentProfilePreparationV1;
}

export interface AgentProfilePreparationV1 {
  prepare(
    artifacts: AgentProfileArtifactInputV1,
    signal: AbortSignal,
  ): Promise<AgentProfilePreparedCandidateV1>;
  release(): void;
}

/** Compatibility alias retained for the active-only parent API. */
export type AgentProfileActivePreparationV1 = AgentProfilePreparationV1;

export interface AgentProfilePreparedCandidateV1 {
  /**
   * Perform admitted bridge work exactly once and return the sole mutation
   * dispatch boundary. No opaque admitted authority escapes in the result.
   */
  prepareDispatch(
    admittedContext: AgentProfileAdmittedSliceContextV1,
    signal: AbortSignal,
  ): Promise<AgentProfilePreparedDispatchV1>;
}

/** Compatibility alias retained for the active-only parent API. */
export type AgentProfilePreparedActiveV1 = AgentProfilePreparedCandidateV1;

export interface AgentProfilePreparedDispatchV1 {
  /** Invoke the atomic materializer exactly once and await its physical settlement. */
  dispatch(): Promise<SystemRecordApplyOutcomeV1>;
}

function normalizeAgentProfileArtifactSourcesV1(
  input: AgentProfileArtifactInputV1,
): AgentProfileArtifactSourcesV1 {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('agent-profile artifact input must be a repository or source pair');
  }
  const candidate = input as unknown as Record<PropertyKey, unknown>;
  if (typeof candidate.resolve === 'function') {
    const repository = bindAgentProfileArtifactRepositoryV1(input, 'artifacts');
    return Object.freeze({
      closureArtifacts: repository,
      securitySidecarArtifacts: repository,
    });
  }
  const hasClosureArtifacts = 'closureArtifacts' in candidate;
  const hasSecuritySidecarArtifacts = 'securitySidecarArtifacts' in candidate;
  if (hasClosureArtifacts || hasSecuritySidecarArtifacts) {
    if (!hasClosureArtifacts || !hasSecuritySidecarArtifacts) {
      throw new TypeError('agent-profile artifact source pair must provide both repositories');
    }
    return Object.freeze({
      closureArtifacts: bindAgentProfileArtifactRepositoryV1(
        candidate.closureArtifacts,
        'closureArtifacts',
      ),
      securitySidecarArtifacts: bindAgentProfileArtifactRepositoryV1(
        candidate.securitySidecarArtifacts,
        'securitySidecarArtifacts',
      ),
    });
  }
  throw new TypeError('agent-profile artifact input must provide a repository resolver');
}

function bindAgentProfileArtifactRepositoryV1(
  input: unknown,
  label: string,
): SystemRecordArtifactRepositoryV1 {
  if (input === null || typeof input !== 'object') {
    throw new TypeError(`agent-profile ${label} must be an artifact repository`);
  }
  const repository = input as SystemRecordArtifactRepositoryV1;
  const resolve = repository.resolve;
  if (typeof resolve !== 'function') {
    throw new TypeError(`agent-profile ${label}.resolve must be a function`);
  }
  return Object.freeze({ resolve: resolve.bind(repository) });
}

/**
 * Default-unused exact active Agent Profile receiver. Mutable state is scoped
 * to one call, so abort and shutdown cannot strand a background operation.
 */
export function createAgentProfileReceiverV1(
  options: CreateAgentProfileReceiverOptionsV1,
): AgentProfileContinuationReceiverV1 {
  const { networkId, prepareCandidateApply, ...receiverOptions } = options;
  const candidateReceiver = createAgentProfileCandidateReceiverInternalV1({
    networkId,
    ...receiverOptions,
    prepareCandidateApply: (candidate, admittedContext, signal) => {
      if (candidate.operation !== 'active') {
        throw new Error('active-only agent-profile receiver rejected a non-active candidate');
      }
      return prepareCandidateApply(candidate, admittedContext, signal);
    },
  });
  return Object.freeze({
    openPreparation(row: SystemRecordInventoryRowV1): AgentProfilePreparationV1 {
      assertActiveOnlyInventoryRowV1(networkId, row);
      return candidateReceiver.openPreparation(row);
    },
    prepareActive: candidateReceiver.prepareActive.bind(candidateReceiver),
    receiveActive: candidateReceiver.receiveActive.bind(candidateReceiver),
  });
}

/**
 * Opt-in candidate receiver for active, tombstone, and quarantine rows.
 */
export function createAgentProfileCandidateReceiverV1(
  options: CreateAgentProfileCandidateReceiverOptionsV1,
): AgentProfileCandidateContinuationReceiverV1 {
  return createAgentProfileCandidateReceiverInternalV1(options);
}

function createAgentProfileCandidateReceiverInternalV1(
  options: CreateAgentProfileCandidateReceiverOptionsV1,
): AgentProfileCandidateContinuationReceiverV1 {
  const networkId = options.networkId;
  const defaultArtifacts = normalizeAgentProfileArtifactSourcesV1(options.artifacts);
  const verifyCurrentBundle = options.verifyCurrentBundle;
  const prepareCandidateApply = options.prepareCandidateApply;
  const nowMs = options.nowMs;
  const memoizeAuthorityVerification = options.verifyAuthorityEnvelope === undefined;
  const verifyAuthorityEnvelope = options.verifyAuthorityEnvelope
    ?? ((envelope: SignedAgentProfileHeadEnvelopeV1
      | SignedAgentProfileAuthorityTransitionEnvelopeV1
      | SignedAgentProfileForkResolutionEnvelopeV1) =>
      verifySignedSystemRecordEnvelopeV1<
        AgentProfileHeadObjectV1
        | AgentProfileAuthorityTransitionV1
        | AgentProfileForkResolutionV1
      >(envelope));

  const receiver: AgentProfileCandidateContinuationReceiverV1 = Object.freeze({
    openPreparation(inputRow: SystemRecordInventoryRowV1): AgentProfilePreparationV1 {
      const row = canonicalInventoryRow(networkId, inputRow);
      const verifiedPureAuthorityEnvelopes = new Set<Digest32V1>();
      let released = false;
      return Object.freeze({ prepare, release });

      function prepare(
        artifacts: AgentProfileArtifactInputV1,
        signal: AbortSignal,
      ): Promise<AgentProfilePreparedCandidateV1> {
        if (released) throw new Error('agent-profile receiver preparation is released');
        const normalizedArtifacts = normalizeAgentProfileArtifactSourcesV1(artifacts);
        const resolveForCall = normalizedArtifacts.closureArtifacts.resolve;
        const resolveSidecarForCall = normalizedArtifacts.securitySidecarArtifacts.resolve;
        const verifiedAuthorityEnvelopesThisCall = new Set<Digest32V1>();
        const verifyForCall = async (
          envelope:
            | SignedAgentProfileHeadEnvelopeV1
            | SignedAgentProfileAuthorityTransitionEnvelopeV1
            | SignedAgentProfileForkResolutionEnvelopeV1,
          verifySignal: AbortSignal,
        ): Promise<boolean> => {
          const envelopeDigest = computeSignedSystemRecordEnvelopeDigestV1<
            AgentProfileHeadObjectV1
            | AgentProfileAuthorityTransitionV1
            | AgentProfileForkResolutionV1
          >(envelope);
          if (verifiedAuthorityEnvelopesThisCall.has(envelopeDigest)
              || (memoizeAuthorityVerification
                && verifiedPureAuthorityEnvelopes.has(envelopeDigest))) return true;
          verifySignal.throwIfAborted();
          const verified = await verifyAuthorityEnvelope(envelope, verifySignal);
          verifySignal.throwIfAborted();
          if (verified === true) {
            verifiedAuthorityEnvelopesThisCall.add(envelopeDigest);
            if (memoizeAuthorityVerification) {
              verifiedPureAuthorityEnvelopes.add(envelopeDigest);
            }
          }
          return verified === true;
        };
        return prepareFromResolvers(
          row,
          resolveForCall,
          resolveSidecarForCall,
          signal,
          receiverNowMs(nowMs?.() ?? Date.now()),
          verifyForCall,
        );
      }

      function release(): void {
        if (released) return;
        released = true;
        verifiedPureAuthorityEnvelopes.clear();
      }
    },
    async prepareCandidate(
      row: SystemRecordInventoryRowV1,
      signal: AbortSignal,
    ): Promise<AgentProfilePreparedCandidateV1> {
      signal.throwIfAborted();
      const preparation = receiver.openPreparation(row);
      try {
        return await preparation.prepare(defaultArtifacts, signal);
      } finally {
        preparation.release();
      }
    },
    async receiveCandidate(
      row: SystemRecordInventoryRowV1,
      admittedContext: AgentProfileAdmittedSliceContextV1,
      signal: AbortSignal,
    ): Promise<SystemRecordApplyOutcomeV1> {
      const prepared = await receiver.prepareCandidate(row, signal);
      signal.throwIfAborted();
      const dispatch = await prepared.prepareDispatch(admittedContext, signal);
      signal.throwIfAborted();
      return dispatch.dispatch();
    },
    async prepareActive(
      row: SystemRecordInventoryRowV1,
      signal: AbortSignal,
    ): Promise<AgentProfilePreparedCandidateV1> {
      signal.throwIfAborted();
      assertActiveOnlyInventoryRowV1(networkId, row);
      return receiver.prepareCandidate(row, signal);
    },
    async receiveActive(
      row: SystemRecordInventoryRowV1,
      admittedContext: AgentProfileAdmittedSliceContextV1,
      signal: AbortSignal,
    ): Promise<SystemRecordApplyOutcomeV1> {
      signal.throwIfAborted();
      assertActiveOnlyInventoryRowV1(networkId, row);
      return receiver.receiveCandidate(row, admittedContext, signal);
    },
  });
  return receiver;

  async function prepareFromResolvers(
    row: SystemRecordInventoryRowV1,
    resolveForCall: SystemRecordArtifactRepositoryV1['resolve'],
    resolveSidecarForCall: SystemRecordArtifactRepositoryV1['resolve'],
    signal: AbortSignal,
    verificationNowMs: number,
    verifyForCall: NonNullable<CreateAgentProfileReceiverOptionsV1['verifyAuthorityEnvelope']>,
  ): Promise<AgentProfilePreparedCandidateV1> {
    signal.throwIfAborted();
    const candidate = await buildVerifiedCandidateFactsV1({
      networkId,
      row,
      signal,
      nowMs: verificationNowMs,
      resolveArtifact: resolveForCall,
      resolveSecuritySidecar: resolveSidecarForCall,
      verifyAuthorityEnvelope: verifyForCall,
      verifyCurrentBundle,
    });
    signal.throwIfAborted();
    let dispatchPrepared = false;
    return Object.freeze({
      async prepareDispatch(
        admittedContext: AgentProfileAdmittedSliceContextV1,
        applySignal: AbortSignal,
      ): Promise<AgentProfilePreparedDispatchV1> {
        if (dispatchPrepared) {
          throw new Error('agent-profile receiver dispatch was already prepared');
        }
        applySignal.throwIfAborted();
        dispatchPrepared = true;
        const prepared = await prepareCandidateApply(candidate, admittedContext, applySignal);
        applySignal.throwIfAborted();
        const apply = readPreparedApplyV1(prepared);
        applySignal.throwIfAborted();
        const admittedDeadlineMs = candidate.operation === 'active'
          ? clampActiveApplyDeadlineV1(
            apply,
            Date.parse(candidate.head.validUntil),
            receiverNowMs(nowMs?.() ?? Date.now()),
          )
          : apply.existingMonotonicDeadlineMs;
        if (admittedDeadlineMs <= apply.monotonicNowMs) {
          throw new Error('agent-profile monotonic apply admission is expired');
        }
        let dispatched = false;
        return Object.freeze({
          async dispatch(): Promise<SystemRecordApplyOutcomeV1> {
            if (dispatched) {
              throw new Error('agent-profile receiver dispatch was already invoked');
            }
            dispatched = true;
            // This call is the point of no return. Its promise is the physical
            // settlement boundary and must never be raced or reclassified.
            return await apply.invoke(admittedDeadlineMs);
          },
        });
      },
    });
  }
}

interface BuildVerifiedCandidateFactsOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly row: SystemRecordInventoryRowV1;
  readonly signal: AbortSignal;
  readonly nowMs: number;
  readonly resolveArtifact: SystemRecordArtifactRepositoryV1['resolve'];
  readonly resolveSecuritySidecar: SystemRecordArtifactRepositoryV1['resolve'];
  readonly verifyAuthorityEnvelope: NonNullable<
    CreateAgentProfileReceiverOptionsV1['verifyAuthorityEnvelope']
  >;
  readonly verifyCurrentBundle: CreateAgentProfileReceiverOptionsV1['verifyCurrentBundle'];
}

interface VerifiedProfileClosureV1 {
  readonly envelope: SignedAgentProfileHeadEnvelopeV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly closureObjects: readonly SystemRecordVerificationClosureObjectV1[];
}

interface VerifyProfileClosureOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly headDigest: Digest32V1;
  readonly row?: SystemRecordInventoryRowV1;
  readonly signal: AbortSignal;
  readonly nowMs: number;
  readonly resolveArtifact: SystemRecordArtifactRepositoryV1['resolve'];
  readonly verifyAuthorityEnvelope: NonNullable<
    CreateAgentProfileReceiverOptionsV1['verifyAuthorityEnvelope']
  >;
  readonly verifyCurrentBundle: CreateAgentProfileReceiverOptionsV1['verifyCurrentBundle'];
}

async function buildVerifiedCandidateFactsV1(
  options: BuildVerifiedCandidateFactsOptionsV1,
): Promise<AgentProfileReceiverAnyCandidateV1> {
  const {
    networkId,
    row,
    signal,
    nowMs,
    resolveArtifact,
    resolveSecuritySidecar,
    verifyAuthorityEnvelope,
    verifyCurrentBundle,
  } = options;
  const closureOptions: VerifyProfileClosureOptionsV1 = Object.freeze({
    networkId,
    headDigest: row.headDigest,
    row,
    signal,
    nowMs,
    resolveArtifact,
    verifyAuthorityEnvelope,
    verifyCurrentBundle,
  });
  if (!row.quarantined) {
    return candidateFromVerifiedClosureV1(
      await verifyProfileClosureForHeadV1(closureOptions),
      resolveArtifact,
      signal,
      nowMs,
    );
  }

  const evidenceDigest = row.conflictEvidenceDigest;
  if (evidenceDigest === undefined) {
    throw new Error('quarantined inventory row is missing conflict evidence');
  }
  const conflictPreflight = await preflightAgentProfileConflictEvidenceV1({
    networkId,
    row,
    evidenceDigest,
    artifacts: Object.freeze({ resolve: resolveSecuritySidecar }),
    signal,
  });
  signal.throwIfAborted();
  const authorityClosure = await verifyProfileAuthorityClosureForHeadV1(closureOptions);
  assertActiveHeadEnvelopeV1(authorityClosure.envelope);
  const verifiedConflict = await verifyAgentProfileConflictEvidenceV1({
    networkId,
    currentHead: authorityClosure.envelope.object,
    currentHeadDigest: row.headDigest,
    verifiedAuthoritySummary: authorityClosure.verifiedAuthoritySummary,
    preflight: conflictPreflight,
    authorityArtifacts: Object.freeze({ resolve: resolveArtifact }),
    seedArtifacts: authorityClosure.closureObjects,
    signal,
    nowMs,
    verifyAuthorityEnvelope,
  });
  signal.throwIfAborted();
  const closure = await verifyProfileClosureForHeadV1(closureOptions);
  signal.throwIfAborted();
  const activeCandidate = await activeCandidateFromClosureV1(
    closure,
    resolveArtifact,
    signal,
    nowMs,
    false,
  );
  return Object.freeze({
    ...activeCandidate,
    operation: 'quarantine',
    conflictEvidence: verifiedConflict.evidence,
    conflictEvidenceDigest: verifiedConflict.evidenceDigest,
    canonicalConflictEvidenceBytes: verifiedConflict.canonicalEvidenceBytes,
    conflictArtifacts: verifiedConflict.artifacts,
    terminalTransitionConflict: verifiedConflict.terminalTransitionConflict,
  });
}

async function candidateFromVerifiedClosureV1(
  closure: VerifiedProfileClosureV1,
  resolveArtifact: SystemRecordArtifactRepositoryV1['resolve'],
  signal: AbortSignal,
  nowMs: number,
): Promise<AgentProfileReceiverActiveCandidateV1 | AgentProfileReceiverTombstoneCandidateV1> {
  return closure.envelope.object.state === 'tombstone'
    ? tombstoneCandidateFromClosureV1(closure)
    : activeCandidateFromClosureV1(closure, resolveArtifact, signal, nowMs);
}

function tombstoneCandidateFromClosureV1(
  closure: VerifiedProfileClosureV1,
): AgentProfileReceiverTombstoneCandidateV1 {
  const { envelope, verifiedAuthoritySummary, closureObjects } = closure;
  assertTombstoneHeadEnvelopeV1(envelope);
  const predecessor = verifiedAuthoritySummary.tombstonePredecessor;
  const deletionTableDigest = verifiedAuthoritySummary.deletionTableDigest;
  if (predecessor === undefined || deletionTableDigest === undefined) {
    throw new Error('verified tombstone closure is missing its active predecessor');
  }
  return Object.freeze({
    operation: 'tombstone',
    head: envelope.object,
    envelope,
    deletionOwnedSubjectTable: subjectTableFromClosureV1(
      closureObjects,
      predecessor.rootSubject,
      deletionTableDigest,
      predecessor.ownedSubjectCount,
      'tombstone deletion table',
    ),
    verifiedAuthoritySummary,
  });
}

async function activeCandidateFromClosureV1(
  closure: VerifiedProfileClosureV1,
  resolveArtifact: SystemRecordArtifactRepositoryV1['resolve'],
  signal: AbortSignal,
  nowMs: number,
  requireFreshness = true,
): Promise<AgentProfileReceiverActiveCandidateV1> {
  const { envelope, verifiedAuthoritySummary } = closure;
  assertActiveHeadEnvelopeV1(envelope);
  if (requireFreshness) assertActiveHeadFreshV1(envelope.object, nowMs);
  const head = envelope.object;
  requiredClosureArtifactV1(
    closure,
    'agent-profile-head',
    envelope.objectDigest,
    'current agent-profile head',
  );
  const bundleArtifact = requiredClosureArtifactV1(
    closure,
    'profile-bundle',
    head.bundleDigest,
    'current profile bundle',
  );
  const decodedBundle = decodeOpaqueKaBundleV1(bundleArtifact.canonicalBytes);
  const canonicalProjectionBytes = Uint8Array.from(decodedBundle.projectionBytes);
  const projectionQuads = parseCanonicalGraphlessProjectionStorageQuadsV1(
    canonicalProjectionBytes,
  );
  if (BigInt(canonicalProjectionBytes.byteLength) !== BigInt(head.projectionBytes)) {
    throw new Error('profile bundle projection byte count does not bind the verified head');
  }
  if (BigInt(projectionQuads.length) !== BigInt(head.projectionQuads)) {
    throw new Error('profile bundle projection quad count does not bind the verified head');
  }
  const resolvedSubjectTableArtifact = await resolveArtifact({
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
  const ownedSubjectTable = parseBoundSubjectTableV1(
    subjectTableArtifact.canonicalBytes,
    head.rootSubject,
    head.ownedSubjectTableDigest,
    head.ownedSubjectCount,
    'active profile owned-subject table',
  );
  assertAgentProfileProjectionSchemaV1(head.rootSubject, ownedSubjectTable, projectionQuads);
  assertAgentProfileProjectionIdentityV1(head, projectionQuads);
  return Object.freeze({
    operation: 'active',
    head,
    envelope,
    canonicalProjectionBytes,
    projectionQuads,
    ownedSubjectTable,
    verifiedAuthoritySummary,
  });
}

async function verifyProfileClosureForHeadV1(
  options: VerifyProfileClosureOptionsV1,
): Promise<VerifiedProfileClosureV1> {
  const currentHeadArtifact = await resolveCurrentHeadArtifactV1(options);
  const closure = await buildAgentProfileVerificationClosureV1(options.headDigest, {
    ...createClosureVerifierV1(options, currentHeadArtifact),
    verifyCurrentBundle: async (head, canonicalBundleBytes) => {
      options.signal.throwIfAborted();
      const verified = await options.verifyCurrentBundle(
        head,
        Uint8Array.from(canonicalBundleBytes),
        options.signal,
      );
      options.signal.throwIfAborted();
      return verified === true;
    },
  });
  return verifiedProfileClosureV1(options, closure);
}

async function verifyProfileAuthorityClosureForHeadV1(
  options: VerifyProfileClosureOptionsV1,
): Promise<VerifiedProfileClosureV1> {
  const currentHeadArtifact = await resolveCurrentHeadArtifactV1(options);
  const closure = await buildAgentProfileForkEvidenceAuthorityClosureV1(
    options.headDigest,
    createClosureVerifierV1(options, currentHeadArtifact),
  );
  return verifiedProfileClosureV1(options, closure);
}

async function resolveCurrentHeadArtifactV1(
  options: VerifyProfileClosureOptionsV1,
): Promise<SystemRecordArtifactV1> {
  options.signal.throwIfAborted();
  const artifact = await options.resolveArtifact({
    type: 'object',
    objectKind: 'agent-profile-head',
    objectDigest: options.headDigest,
  }, options.signal);
  options.signal.throwIfAborted();
  if (artifact === null) {
    throw new Error('verification closure is missing its current agent-profile head');
  }
  const currentHeadArtifact = snapshotExpectedArtifactV1(
    artifact,
    'agent-profile-head',
    options.headDigest,
    'closure artifact',
  );
  const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
    currentHeadArtifact.canonicalBytes,
  );
  if (options.row !== undefined) assertRowBindsHead(options.networkId, options.row, envelope);
  if (envelope.object.state === 'active' && options.row?.quarantined !== true) {
    assertActiveHeadFreshV1(envelope.object, options.nowMs);
  }
  return currentHeadArtifact;
}

function createClosureVerifierV1(
  options: VerifyProfileClosureOptionsV1,
  currentHeadArtifact: SystemRecordArtifactV1,
): AgentProfileForkEvidenceClosureVerifierV1 {
  const {
    signal,
    resolveArtifact,
    verifyAuthorityEnvelope,
  } = options;
  return Object.freeze({
    nowMs: options.nowMs,
    resolve: async (
      reference: Parameters<AgentProfileForkEvidenceClosureVerifierV1['resolve']>[0],
    ) => {
      signal.throwIfAborted();
      const owned = reference.objectKind === 'agent-profile-head'
        && reference.digest === options.headDigest
        ? currentHeadArtifact
        : await resolveClosureArtifactV1(reference, resolveArtifact, signal);
      signal.throwIfAborted();
      if (owned === undefined) return undefined;
      return Object.freeze({
        objectKind: owned.objectKind,
        digest: owned.objectDigest,
        canonicalBytes: owned.canonicalBytes,
      });
    },
    verifyAuthorityEnvelope: async (
      envelope: Parameters<
        AgentProfileForkEvidenceClosureVerifierV1['verifyAuthorityEnvelope']
      >[0],
    ) => {
      signal.throwIfAborted();
      const verified = await verifyAuthorityEnvelope(envelope, signal);
      signal.throwIfAborted();
      return verified === true;
    },
  });
}

function verifiedProfileClosureV1(
  options: VerifyProfileClosureOptionsV1,
  closure: SystemRecordVerificationClosureV1,
): VerifiedProfileClosureV1 {
  const currentHeadArtifact = requiredClosureArtifactV1(
    closure,
    'agent-profile-head',
    options.headDigest,
    'current agent-profile head',
  );
  const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
    currentHeadArtifact.canonicalBytes,
  );
  if (options.row !== undefined) assertRowBindsHead(options.networkId, options.row, envelope);
  return Object.freeze({
    envelope,
    verifiedAuthoritySummary: closure.authoritySummary,
    closureObjects: closure.objects,
  });
}

async function resolveClosureArtifactV1(
  reference: Readonly<{ objectKind: SystemRecordObjectKindV1; digest: Digest32V1 }>,
  resolveArtifact: SystemRecordArtifactRepositoryV1['resolve'],
  signal: AbortSignal,
): Promise<SystemRecordArtifactV1 | undefined> {
  const artifact = await resolveArtifact({
    type: 'object',
    objectKind: reference.objectKind,
    objectDigest: reference.digest,
  }, signal);
  if (artifact === null) return undefined;
  return snapshotExpectedArtifactV1(
    artifact,
    reference.objectKind,
    reference.digest,
    'closure artifact',
  );
}

function assertActiveHeadEnvelopeV1(
  envelope: SignedAgentProfileHeadEnvelopeV1,
): asserts envelope is SignedAgentProfileActiveHeadEnvelopeV1 {
  if (envelope.object.state !== 'active') {
    throw new Error('active profile receiver resolved a non-active verification closure');
  }
}

function assertTombstoneHeadEnvelopeV1(
  envelope: SignedAgentProfileHeadEnvelopeV1,
): asserts envelope is SignedAgentProfileTombstoneHeadEnvelopeV1 {
  if (envelope.object.state !== 'tombstone') {
    throw new Error('tombstone profile receiver resolved a non-tombstone verification closure');
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

function assertActiveOnlyInventoryRowV1(
  networkId: NetworkIdV1,
  input: SystemRecordInventoryRowV1,
): void {
  const row = canonicalInventoryRow(networkId, input);
  if (row.tombstone || row.quarantined) {
    throw new Error('active-only agent-profile receiver rejected a non-active inventory row');
  }
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

function subjectTableFromClosureV1(
  closureObjects: readonly SystemRecordVerificationClosureObjectV1[],
  rootSubject: string,
  expectedDigest: Digest32V1,
  expectedCount: string,
  label: string,
): OwnedSubjectTableObjectV1 {
  const artifact = closureObjects.find((value) =>
    value.objectKind === 'owned-subject-table' && value.digest === expectedDigest);
  if (artifact === undefined) throw new Error(`${label} is missing from the verified closure`);
  return parseBoundSubjectTableV1(
    artifact.canonicalBytes,
    rootSubject,
    expectedDigest,
    expectedCount,
    label,
  );
}

function parseBoundSubjectTableV1(
  canonicalBytes: Uint8Array,
  rootSubject: string,
  expectedDigest: Digest32V1,
  expectedCount: string,
  label: string,
): OwnedSubjectTableObjectV1 {
  const table = parseCanonicalOwnedSubjectTableObjectV1(rootSubject, canonicalBytes);
  if (computeOwnedSubjectTableDigestV1(rootSubject, table) !== expectedDigest
      || BigInt(table.length) !== BigInt(expectedCount)) {
    throw new Error(`${label} does not bind the verified head`);
  }
  return table;
}

function requiredClosureArtifactV1(
  closure: SystemRecordVerificationClosureV1 | VerifiedProfileClosureV1,
  objectKind: SystemRecordObjectKindV1,
  digest: Digest32V1,
  label: string,
): SystemRecordVerificationClosureObjectV1 {
  const objects = 'objects' in closure ? closure.objects : closure.closureObjects;
  const artifact = objects.find((candidate) =>
    candidate.objectKind === objectKind && candidate.digest === digest);
  if (artifact === undefined) {
    throw new Error(`verification closure did not retain its ${label}`);
  }
  return artifact;
}

function readPreparedApplyV1(value: AgentProfileReceiverPreparedApplyV1): {
  readonly existingMonotonicDeadlineMs: number;
  readonly monotonicNowMs: number;
  readonly invoke: AgentProfileReceiverPreparedApplyV1['apply'];
} {
  if (value === null || typeof value !== 'object') {
    throw new Error('lifecycle bridge did not return prepared apply state');
  }
  const existingMonotonicDeadlineMs = monotonicApplyMsV1(
    value.existingMonotonicDeadlineMs,
    'existing deadline',
  );
  const monotonicNowMs = monotonicApplyMsV1(value.monotonicNowMs, 'current time');
  const invoke = value.apply;
  if (typeof invoke !== 'function') {
    throw new Error('agent-profile prepared apply callback is invalid');
  }
  return Object.freeze({ existingMonotonicDeadlineMs, monotonicNowMs, invoke });
}

function monotonicApplyMsV1(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`agent-profile monotonic apply ${label} is invalid`);
  }
  return value;
}

function clampActiveApplyDeadlineV1(
  apply: Readonly<{ existingMonotonicDeadlineMs: number; monotonicNowMs: number }>,
  validUntilUnixMs: number,
  nowUnixMs: number,
): number {
  const remainingMs = assertActiveDeadlineFreshV1(validUntilUnixMs, nowUnixMs);
  const translatedDeadlineMs = apply.monotonicNowMs + remainingMs;
  if (!Number.isSafeInteger(translatedDeadlineMs)) {
    throw new Error('agent-profile translated apply deadline is invalid');
  }
  return Math.min(apply.existingMonotonicDeadlineMs, translatedDeadlineMs);
}

function assertActiveHeadFreshV1(head: AgentProfileActiveHeadObjectV1, nowMs: number): void {
  assertActiveDeadlineFreshV1(Date.parse(head.validUntil), nowMs);
}

function assertActiveDeadlineFreshV1(validUntilUnixMs: number, nowUnixMs: number): number {
  const remainingMs = validUntilUnixMs - nowUnixMs;
  if (remainingMs <= 0) {
    throw new Error('active profile receiver resolved an expired agent-profile head');
  }
  return remainingMs;
}

function receiverNowMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('agent-profile receiver clock returned an invalid value');
  }
  return value;
}
