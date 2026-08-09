// SPDX-License-Identifier: Apache-2.0

import {
  decodeOpaqueKaBundleV1,
  parseCanonicalGraphlessProjectionStorageQuadsV1,
} from '@origintrail-official/dkg-core';
import {
  assertAgentProfileProjectionIdentityV1,
  assertAgentProfileProjectionSchemaV1,
  buildAgentProfileVerificationClosureV1,
  copyBoundedSystemRecordBytesV1,
  computeOwnedSubjectTableDigestV1,
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
  type SystemRecordVerificationClosureV1,
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
  /** Final graph-scoped publication/seal acceptance of the exact supplied bundle. */
  readonly verifyCurrentBundle: (
    head: AgentProfileActiveHeadObjectV1,
    canonicalBundleBytes: Uint8Array,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
  /**
   * Lifecycle-owned preparation for storage apply. After all asynchronous
   * preparation, it returns authenticated monotonic timing and the apply entry.
   * The receiver owns final freshness, deadline clamping, and the sole call to
   * apply; no replacement proof or prior apply outcome crosses this boundary.
   * Concrete lifecycle composition remains intentionally default-off; only the
   * injected bridge can authenticate and re-inspect the opaque admitted context.
   */
  readonly prepareCandidateApply: (
    input: AgentProfileReceiverCandidateV1,
    admittedContext: AgentProfileAdmittedSliceContextV1,
    signal: AbortSignal,
  ) => AgentProfileReceiverPreparedApplyV1
    | Promise<AgentProfileReceiverPreparedApplyV1>;
  /** Unix wall-clock milliseconds, injectable for deterministic verification. */
  readonly nowMs?: () => number;
}

export interface AgentProfileReceiverV1 {
  /**
   * Complete the abort-safe fetch/decode/verification phase. The returned apply
   * closure is one-shot and is the only boundary that may dispatch a mutation.
   */
  prepareActive(
    row: SystemRecordInventoryRowV1,
    signal: AbortSignal,
  ): Promise<AgentProfilePreparedActiveV1>;
  /** Convenience for direct callers that already own the admitted slice lifetime. */
  receiveActive(
    row: SystemRecordInventoryRowV1,
    admittedContext: AgentProfileAdmittedSliceContextV1,
    signal: AbortSignal,
  ): Promise<SystemRecordApplyOutcomeV1>;
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
  const prepareCandidateApply = options.prepareCandidateApply;
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

  const receiver: AgentProfileReceiverV1 = Object.freeze({
    async prepareActive(
      inputRow: SystemRecordInventoryRowV1,
      signal: AbortSignal,
    ): Promise<AgentProfilePreparedActiveV1> {
      signal.throwIfAborted();
      const row = canonicalInventoryRow(networkId, inputRow);
      if (!isOrdinaryActiveInventoryRowV1(row)) {
        throw new Error('active profile receiver requires an ordinary active inventory row');
      }

      const verificationNowMs = receiverNowMs(nowMs?.() ?? Date.now());
      const candidate = await buildVerifiedActiveCandidateFactsV1({
        networkId,
        row,
        signal,
        nowMs: verificationNowMs,
        resolveArtifact,
        verifyAuthorityEnvelope,
        verifyCurrentBundle,
      });
      signal.throwIfAborted();
      const validUntilUnixMs = Date.parse(candidate.head.validUntil);
      let dispatched = false;
      return Object.freeze({
        async apply(
          admittedContext: AgentProfileAdmittedSliceContextV1,
          applySignal: AbortSignal,
        ): Promise<SystemRecordApplyOutcomeV1> {
          if (dispatched) throw new Error('active profile receiver apply was already dispatched');
          applySignal.throwIfAborted();
          dispatched = true;
          const prepared = await prepareCandidateApply(
            candidate,
            admittedContext,
            applySignal,
          );
          applySignal.throwIfAborted();
          const apply = readPreparedApplyV1(prepared);
          applySignal.throwIfAborted();
          const remainingMs = assertActiveDeadlineFreshV1(
            validUntilUnixMs,
            receiverNowMs(nowMs?.() ?? Date.now()),
          );
          const translatedDeadlineMs = apply.monotonicNowMs + remainingMs;
          if (!Number.isSafeInteger(translatedDeadlineMs)) {
            throw new Error('agent-profile translated apply deadline is invalid');
          }
          const admittedDeadlineMs = Math.min(
            apply.existingMonotonicDeadlineMs,
            translatedDeadlineMs,
          );
          if (admittedDeadlineMs <= apply.monotonicNowMs) {
            throw new Error('agent-profile monotonic apply admission is expired');
          }
          // Atomic apply is the point of no return. A cancellation that arrives
          // after dispatch must not detach the operation or hide a committed outcome.
          return await apply.invoke(admittedDeadlineMs);
        },
      });
    },
    async receiveActive(
      row: SystemRecordInventoryRowV1,
      admittedContext: AgentProfileAdmittedSliceContextV1,
      signal: AbortSignal,
    ): Promise<SystemRecordApplyOutcomeV1> {
      const prepared = await receiver.prepareActive(row, signal);
      signal.throwIfAborted();
      return prepared.apply(admittedContext, signal);
    },
  });
  return receiver;
}

interface BuildVerifiedActiveCandidateFactsOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly row: SystemRecordInventoryRowV1;
  readonly signal: AbortSignal;
  readonly nowMs: number;
  readonly resolveArtifact: SystemRecordArtifactRepositoryV1['resolve'];
  readonly verifyAuthorityEnvelope: NonNullable<
    CreateAgentProfileReceiverOptionsV1['verifyAuthorityEnvelope']
  >;
  readonly verifyCurrentBundle: CreateAgentProfileReceiverOptionsV1['verifyCurrentBundle'];
}

async function buildVerifiedActiveCandidateFactsV1(
  options: BuildVerifiedActiveCandidateFactsOptionsV1,
): Promise<AgentProfileReceiverCandidateV1> {
  const {
    networkId,
    row,
    signal,
    nowMs,
    resolveArtifact,
    verifyAuthorityEnvelope,
    verifyCurrentBundle,
  } = options;
  signal.throwIfAborted();
  const resolvedCurrentHeadArtifact = await resolveArtifact({
    type: 'object',
    objectKind: 'agent-profile-head',
    objectDigest: row.headDigest,
  }, signal);
  signal.throwIfAborted();
  if (resolvedCurrentHeadArtifact === null) {
    throw new Error('verification closure is missing its current agent-profile head');
  }
  const currentHeadArtifact = snapshotExpectedArtifactV1(
    resolvedCurrentHeadArtifact,
    'agent-profile-head',
    row.headDigest,
    'closure artifact',
  );
  const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
    currentHeadArtifact.canonicalBytes,
  );
  assertRowBindsHead(networkId, row, envelope);
  assertActiveHeadEnvelopeV1(envelope);
  assertActiveHeadFreshV1(envelope.object, nowMs);

  const closure = await verifyActiveProfileClosureForRowV1({
    row,
    signal,
    nowMs,
    currentHeadArtifact,
    resolveArtifact,
    verifyAuthorityEnvelope,
    verifyCurrentBundle,
  });
  signal.throwIfAborted();
  const head = envelope.object;
  requiredClosureArtifactV1(
    closure,
    'agent-profile-head',
    row.headDigest,
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
  const ownedSubjectTable = parseCanonicalOwnedSubjectTableObjectV1(
    head.rootSubject,
    subjectTableArtifact.canonicalBytes,
  );
  if (computeOwnedSubjectTableDigestV1(head.rootSubject, ownedSubjectTable)
      !== head.ownedSubjectTableDigest
    || BigInt(ownedSubjectTable.length) !== BigInt(head.ownedSubjectCount)) {
    throw new Error('active profile owned-subject table does not bind the verified head');
  }
  assertAgentProfileProjectionSchemaV1(
    head.rootSubject,
    ownedSubjectTable,
    projectionQuads,
  );
  assertAgentProfileProjectionIdentityV1(head, projectionQuads);

  return Object.freeze({
    head,
    envelope,
    canonicalProjectionBytes,
    projectionQuads,
    ownedSubjectTable,
    verifiedAuthoritySummary: closure.authoritySummary,
  });
}

interface VerifyActiveProfileClosureOptionsV1
  extends Omit<BuildVerifiedActiveCandidateFactsOptionsV1, 'networkId'> {
  readonly currentHeadArtifact: SystemRecordArtifactV1;
}

async function verifyActiveProfileClosureForRowV1(
  options: VerifyActiveProfileClosureOptionsV1,
): Promise<SystemRecordVerificationClosureV1> {
  const {
    row,
    signal,
    nowMs,
    currentHeadArtifact,
    resolveArtifact,
    verifyAuthorityEnvelope,
    verifyCurrentBundle,
  } = options;
  return buildAgentProfileVerificationClosureV1(row.headDigest, {
    nowMs,
    resolve: async (reference) => {
      signal.throwIfAborted();
      const owned = reference.objectKind === 'agent-profile-head'
        && reference.digest === row.headDigest
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
    verifyAuthorityEnvelope: async (envelope) => {
      signal.throwIfAborted();
      const verified = await verifyAuthorityEnvelope(envelope, signal);
      signal.throwIfAborted();
      return verified === true;
    },
    verifyCurrentBundle: async (head, canonicalBundleBytes) => {
      signal.throwIfAborted();
      const verified = await verifyCurrentBundle(
        head,
        Uint8Array.from(canonicalBundleBytes),
        signal,
      );
      signal.throwIfAborted();
      return verified === true;
    },
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

function requiredClosureArtifactV1(
  closure: SystemRecordVerificationClosureV1,
  objectKind: SystemRecordObjectKindV1,
  digest: Digest32V1,
  label: string,
): SystemRecordVerificationClosureV1['objects'][number] {
  const artifact = closure.objects.find((candidate) =>
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
