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

export interface AgentProfileReceiverMonotonicApplyTimingV1 {
  /** Existing authenticated Storage deadline in the bridge's monotonic clock domain. */
  readonly existingMonotonicDeadlineMs: number;
  /** `Math.floor(performance.now())` captured after bridge waits. */
  readonly monotonicNowMs: number;
}

const FRESH_APPLY_OUTCOME_V1: unique symbol = Symbol('agent-profile-fresh-apply-outcome-v1');

interface AgentProfileReceiverFreshApplyResultV1 {
  readonly [FRESH_APPLY_OUTCOME_V1]: SystemRecordApplyOutcomeV1;
}

/** Receiver-owned one-shot entry into lifecycle proof issuance and atomic apply. */
export interface AgentProfileReceiverFreshApplyCapabilityV1 {
  /**
   * After its preparation waits, the lifecycle bridge supplies its authenticated
   * existing deadline and freshly captured monotonic time. The receiver checks
   * signed wall-clock freshness, clamps the monotonic deadline, and immediately
   * invokes apply. The callback receives no Unix timestamp and must begin proof
   * issuance/apply admission with the supplied deadline.
   */
  readonly admitFreshApply: (
    timing: AgentProfileReceiverMonotonicApplyTimingV1,
    apply: (
      admittedDeadlineMs: number,
    ) => SystemRecordApplyOutcomeV1 | Promise<SystemRecordApplyOutcomeV1>,
  ) => Promise<AgentProfileReceiverFreshApplyResultV1>;
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
   * Lifecycle-owned bridge into the storage runtime. It mints and consumes the
   * private replacement proof inside one structured call; no proof escapes.
   * Its return value must come from freshApply.admitFreshApply, so the receiver
   * owns the final freshness check and monotonic-deadline clamp.
   */
  readonly consumeCandidate: (
    input: AgentProfileReceiverCandidateV1,
    signal: AbortSignal,
    freshApply: AgentProfileReceiverFreshApplyCapabilityV1,
  ) => AgentProfileReceiverFreshApplyResultV1
    | Promise<AgentProfileReceiverFreshApplyResultV1>;
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
      assertActiveDeadlineFreshV1(
        validUntilUnixMs,
        receiverNowMs(nowMs?.() ?? Date.now()),
      );
      const freshApply = createFreshApplyCapabilityV1({
        validUntilUnixMs,
        signal,
        nowUnixMs: () => receiverNowMs(nowMs?.() ?? Date.now()),
      });
      const result = await consumeCandidate(candidate, signal, freshApply);
      // Atomic apply is the point of no return. A cancellation that arrives
      // after the storage closure returns must not hide a committed outcome and
      // make the caller retry it as if nothing happened.
      return unwrapFreshApplyResultV1(result);
    },
  });
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
  const projectionQuads = Object.freeze(
    deriveCanonicalProjectionQuadsV1(canonicalProjectionBytes),
  );
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

interface CreateFreshApplyCapabilityOptionsV1 {
  readonly validUntilUnixMs: number;
  readonly signal: AbortSignal;
  readonly nowUnixMs: () => number;
}

function createFreshApplyCapabilityV1(
  options: CreateFreshApplyCapabilityOptionsV1,
): AgentProfileReceiverFreshApplyCapabilityV1 {
  const { validUntilUnixMs, signal, nowUnixMs } = options;
  let used = false;
  return Object.freeze({
    admitFreshApply: async (
      timing: AgentProfileReceiverMonotonicApplyTimingV1,
      apply: (
        admittedDeadlineMs: number,
      ) => SystemRecordApplyOutcomeV1 | Promise<SystemRecordApplyOutcomeV1>,
    ): Promise<AgentProfileReceiverFreshApplyResultV1> => {
      if (used) throw new Error('agent-profile fresh-apply capability is one-shot');
      used = true;
      signal.throwIfAborted();
      if (timing === null || typeof timing !== 'object') {
        throw new Error('agent-profile monotonic apply timing is invalid');
      }
      const existingMonotonicDeadlineMs = monotonicApplyMsV1(
        timing.existingMonotonicDeadlineMs,
        'existing deadline',
      );
      const monotonicNowMs = monotonicApplyMsV1(
        timing.monotonicNowMs,
        'current time',
      );
      if (typeof apply !== 'function') {
        throw new Error('agent-profile fresh apply callback is invalid');
      }
      const remainingMs = assertActiveDeadlineFreshV1(validUntilUnixMs, nowUnixMs());
      const translatedDeadlineMs = monotonicNowMs + remainingMs;
      if (!Number.isSafeInteger(translatedDeadlineMs)) {
        throw new Error('agent-profile translated apply deadline is invalid');
      }
      const admittedDeadlineMs = Math.min(
        existingMonotonicDeadlineMs,
        translatedDeadlineMs,
      );
      if (admittedDeadlineMs <= monotonicNowMs) {
        throw new Error('agent-profile monotonic apply admission is expired');
      }
      const outcome = await apply(admittedDeadlineMs);
      return Object.freeze({ [FRESH_APPLY_OUTCOME_V1]: outcome });
    },
  });
}

function unwrapFreshApplyResultV1(
  value: AgentProfileReceiverFreshApplyResultV1,
): SystemRecordApplyOutcomeV1 {
  if (value === null || typeof value !== 'object'
    || !Object.prototype.hasOwnProperty.call(value, FRESH_APPLY_OUTCOME_V1)) {
    throw new Error('lifecycle bridge did not return a fresh-apply result');
  }
  return value[FRESH_APPLY_OUTCOME_V1];
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

function deriveCanonicalProjectionQuadsV1(
  canonicalProjectionBytes: Uint8Array,
): Readonly<Quad>[] {
  let projectionText: string;
  try {
    projectionText = new TextDecoder('utf-8', { fatal: true }).decode(canonicalProjectionBytes);
  } catch {
    throw new Error('profile bundle projection bytes are not valid UTF-8');
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
      throw new Error('profile bundle projection must be graphless');
    }
    const line = tripleContentV10(quad.subject, quad.predicate, quad.object);
    reconstructed.set(line, offset);
    offset += line.byteLength;
    reconstructed[offset] = 0x0a;
    offset += 1;
  }
  if (reconstructed.byteLength !== canonicalProjectionBytes.byteLength
    || reconstructed.some((byte, index) => byte !== canonicalProjectionBytes[index])) {
    throw new Error('profile bundle projection bytes do not encode exact canonical quads');
  }
  return quads;
}

function receiverNowMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('agent-profile receiver clock returned an invalid value');
  }
  return value;
}
