// SPDX-License-Identifier: Apache-2.0

import {
  decodeOpaqueKaBundleV1,
  tripleContentV10,
} from '@origintrail-official/dkg-core';
import {
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
import { parseNQuads } from '../dkg-agent-utils.js';

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

/** Expiry admission for translation onto the lifecycle bridge's monotonic clock. */
export interface AgentProfileReceiverApplyAdmissionV1 {
  /** Signed-head expiry as Unix wall-clock milliseconds; not a storage deadline. */
  readonly validUntilUnixMs: number;
  /**
   * Re-read the wall clock, reject expiry, and return the positive remaining
   * lifetime in milliseconds. After its waits, the lifecycle bridge must first
   * capture its monotonic clock, call this method, and clamp its existing
   * monotonic deadline to `monotonicNow + remainingMs` immediately before proof
   * issuance/apply admission. It must never pass validUntilUnixMs to storage.
   */
  readonly assertFreshAtApply: () => number;
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
   * After any internal await, it must translate admission's remaining wall-clock
   * lifetime onto its monotonic deadline immediately before proof issuance/apply
   * admission, as specified by AgentProfileReceiverApplyAdmissionV1.
   */
  readonly consumeCandidate: (
    input: AgentProfileReceiverCandidateV1,
    signal: AbortSignal,
    admission: AgentProfileReceiverApplyAdmissionV1,
  ) => SystemRecordApplyOutcomeV1 | Promise<SystemRecordApplyOutcomeV1>;
  /** Unix wall-clock milliseconds, injectable for deterministic verification. */
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
      const admission: AgentProfileReceiverApplyAdmissionV1 = Object.freeze({
        validUntilUnixMs,
        assertFreshAtApply: () => assertActiveDeadlineFreshV1(
          validUntilUnixMs,
          receiverNowMs(nowMs?.() ?? Date.now()),
        ),
      });
      admission.assertFreshAtApply();
      const outcome = await consumeCandidate(candidate, signal, admission);
      // Atomic apply is the point of no return. A cancellation that arrives
      // after the storage closure returns must not hide a committed outcome and
      // make the caller retry it as if nothing happened.
      return outcome;
    },
  });
}

interface VerifiedActiveProfileClosureV1 {
  readonly closure: SystemRecordVerificationClosureV1;
  readonly verifiedBundle: Readonly<{
    readonly projectionQuads: readonly Readonly<Quad>[];
    readonly canonicalProjectionBytes: Uint8Array;
  }>;
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

  const { closure, verifiedBundle } = await verifyActiveProfileClosureForRowV1({
    row,
    signal,
    nowMs,
    currentHeadArtifact,
    resolveArtifact,
    verifyAuthorityEnvelope,
    verifyCurrentBundle,
  });
  signal.throwIfAborted();
  if (!closure.objects.some((artifact) =>
    artifact.objectKind === 'agent-profile-head' && artifact.digest === row.headDigest)) {
    throw new Error('verification closure did not retain its current agent-profile head');
  }

  const head = envelope.object;
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

  return Object.freeze({
    head,
    envelope,
    canonicalProjectionBytes: verifiedBundle.canonicalProjectionBytes,
    projectionQuads: verifiedBundle.projectionQuads,
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
): Promise<VerifiedActiveProfileClosureV1> {
  const {
    row,
    signal,
    nowMs,
    currentHeadArtifact,
    resolveArtifact,
    verifyAuthorityEnvelope,
    verifyCurrentBundle,
  } = options;
  const bundleVerification = createExactOnceBundleVerificationResultV1(
    verifyCurrentBundle,
    signal,
  );
  const closure = await buildAgentProfileVerificationClosureV1(row.headDigest, {
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
    verifyCurrentBundle: bundleVerification.verify,
  });
  return bundleVerification.complete(closure);
}

interface ExactOnceBundleVerificationResultV1 {
  readonly verify: (
    head: AgentProfileActiveHeadObjectV1,
    canonicalBundleBytes: Uint8Array,
  ) => Promise<boolean>;
  readonly complete: (
    closure: SystemRecordVerificationClosureV1,
  ) => VerifiedActiveProfileClosureV1;
}

function createExactOnceBundleVerificationResultV1(
  verifyCurrentBundle: CreateAgentProfileReceiverOptionsV1['verifyCurrentBundle'],
  signal: AbortSignal,
): ExactOnceBundleVerificationResultV1 {
  let invoked = false;
  let verifiedBundle: VerifiedActiveProfileClosureV1['verifiedBundle'] | undefined;
  return Object.freeze({
    verify: async (
      head: AgentProfileActiveHeadObjectV1,
      canonicalBundleBytes: Uint8Array,
    ) => {
      if (invoked) throw new Error('active profile bundle verification must run exactly once');
      invoked = true;
      signal.throwIfAborted();
      const result = await verifyCurrentBundle(
        head,
        Uint8Array.from(canonicalBundleBytes),
        signal,
      );
      signal.throwIfAborted();
      const decoded = decodeOpaqueKaBundleV1(canonicalBundleBytes);
      verifiedBundle = snapshotVerifiedBundle(result, decoded.projectionBytes);
      return true;
    },
    complete: (closure: SystemRecordVerificationClosureV1) => {
      if (!invoked || verifiedBundle === undefined) {
        throw new Error('active profile receiver resolved a non-active verification closure');
      }
      return Object.freeze({ closure, verifiedBundle });
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
  const suppliedProjectionQuads = value.projectionQuads.map((quad) => Object.freeze({
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
    graph: quad.graph,
  }));
  const projectionQuads = deriveCanonicalProjectionQuadsV1(expectedProjectionBytes);
  if (!equalQuadMultisetsV1(suppliedProjectionQuads, projectionQuads)) {
    throw new Error('bundle verifier projection quads do not bind the supplied bundle');
  }
  return Object.freeze({
    canonicalProjectionBytes: Uint8Array.from(expectedProjectionBytes),
    projectionQuads: Object.freeze(projectionQuads),
  });
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

function deriveCanonicalProjectionQuadsV1(
  canonicalProjectionBytes: Uint8Array,
): Readonly<Quad>[] {
  let projectionText: string;
  try {
    projectionText = new TextDecoder('utf-8', { fatal: true }).decode(canonicalProjectionBytes);
  } catch {
    throw new Error('bundle verifier projection bytes are not valid UTF-8');
  }
  const quads = parseNQuads(projectionText).map((quad) => Object.freeze({
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
    graph: quad.graph,
  }));
  const reconstructed = new Uint8Array(
    quads.reduce((total, quad) => total + tripleContentV10(
      quad.subject,
      quad.predicate,
      quad.object,
    ).byteLength + 1, 0),
  );
  let offset = 0;
  for (const quad of quads) {
    if (quad.graph !== '') {
      throw new Error('bundle verifier projection must be graphless');
    }
    const line = tripleContentV10(quad.subject, quad.predicate, quad.object);
    reconstructed.set(line, offset);
    offset += line.byteLength;
    reconstructed[offset] = 0x0a;
    offset += 1;
  }
  if (reconstructed.byteLength !== canonicalProjectionBytes.byteLength
    || reconstructed.some((byte, index) => byte !== canonicalProjectionBytes[index])) {
    throw new Error('bundle verifier projection bytes do not encode exact canonical quads');
  }
  return quads;
}

function equalQuadMultisetsV1(
  left: readonly Readonly<Quad>[],
  right: readonly Readonly<Quad>[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareQuadsV1);
  const sortedRight = [...right].sort(compareQuadsV1);
  return sortedLeft.every((quad, index) => compareQuadsV1(quad, sortedRight[index]!) === 0);
}

function compareQuadsV1(left: Readonly<Quad>, right: Readonly<Quad>): number {
  return compareStringsV1(left.subject, right.subject)
    || compareStringsV1(left.predicate, right.predicate)
    || compareStringsV1(left.object, right.object)
    || compareStringsV1(left.graph, right.graph);
}

function compareStringsV1(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function receiverNowMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('agent-profile receiver clock returned an invalid value');
  }
  return value;
}
