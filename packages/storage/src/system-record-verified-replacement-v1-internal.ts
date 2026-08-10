import { types as utilTypes } from 'node:util';

import {
  assertSafeIri,
  assertSafeRdfTerm,
  computeKaBundleProjectionDigestV1,
  isSafeIri,
  keccak256,
  SENTINEL_NO_PRIVATE_V10,
  tripleContentV10,
  V10MerkleTree,
} from '@origintrail-official/dkg-core';
import {
  assertAgentProfileHeadObjectV1,
  assertAgentProfileProjectionIdentityV1,
  assertAgentProfileProjectionSchemaV1,
  assertAgentProfileVerifiedAuthoritySummaryV1,
  canonicalizeAgentProfileConflictEvidenceV1,
  assertNetworkIdV1,
  canonicalizeAgentProfileHeadObjectV1,
  canonicalizeOwnedSubjectTableObjectV1,
  classifyAgentProfileOwnedSubjectV1,
  copyBoundedSystemRecordBytesV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  isAllowedAgentProfilePredicateV1,
  parseCanonicalAgentProfileConflictEvidenceV1,
  parseCanonicalAgentProfileHeadObjectV1,
  parseCanonicalOwnedSubjectTableObjectV1,
  SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
  SYSTEM_RECORD_MAX_ATOMIC_TRANSIENT_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_BYTES,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileConflictEvidenceV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileTombstoneHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type Digest32V1,
  type NetworkIdV1,
  type OwnedSubjectTableObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { Quad } from './triple-store.js';
import {
  assertSystemRecordOpaqueIdentityV1,
  snapshotSystemRecordDenseArrayV1,
  snapshotSystemRecordExactDataRecordV1 as exactRecord,
} from './system-record-input-guards-v1-internal.js';
import {
  createSystemRecordNonQueuedReservationGateV1,
  type SystemRecordRuntimeReservationLeaseV1,
  type SystemRecordRuntimeReservationGateV1,
} from './system-record-reservation-gate-v1-internal.js';

declare const VERIFIED_REPLACEMENT_HANDLE_BRAND: unique symbol;

/**
 * Process-local, non-serializable authority to one verified active replacement.
 * The object is deliberately empty; all facts live in the private table below.
 */
export type SystemRecordVerifiedReplacementHandleV1 = {
  readonly [VERIFIED_REPLACEMENT_HANDLE_BRAND]: 'system-record-verified-replacement-v1';
};

export type SystemRecordMaterializationModeV1 = 'shadow' | 'authoritative';

/** Every fact that prevents a verified replacement from crossing lifecycle boundaries. */
export interface SystemRecordVerifiedReplacementLaneBindingV1 {
  readonly networkId: NetworkIdV1;
  readonly kind: 'agents';
  readonly mode: SystemRecordMaterializationModeV1;
  readonly sessionIdentity: object;
  readonly activationGeneration: string;
  readonly childGeneration: string;
  readonly materializationEpoch: string;
}

export interface SystemRecordVerifiedReplacementBindingsV1
  extends SystemRecordVerifiedReplacementLaneBindingV1 {
  readonly admittedDeadlineMs: number;
}

/**
 * Verifier-side input. The issuer must only be captured by the structured verifier;
 * handing it to an arbitrary caller would turn that caller into a proof authority.
 */
export interface SystemRecordActiveReplacementIssueV1
  extends SystemRecordVerifiedReplacementBindingsV1 {
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  /** Exact canonical graphless N-Triples bytes verified from the signed profile bundle. */
  readonly canonicalProjectionBytes: Uint8Array;
  readonly projectionQuads: readonly Quad[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
}

export interface SystemRecordTombstoneReplacementIssueV1
  extends SystemRecordVerifiedReplacementBindingsV1 {
  readonly head: AgentProfileTombstoneHeadObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  /** Exact deletion-only table authenticated by the predecessor closure. */
  readonly deletionOwnedSubjectTable: OwnedSubjectTableObjectV1;
}

export interface SystemRecordQuarantineReplacementIssueV1
  extends SystemRecordActiveReplacementIssueV1 {
  readonly conflictEvidenceDigest: Digest32V1;
  readonly canonicalConflictEvidenceBytes: Uint8Array;
  readonly terminalTransitionConflict: boolean;
}

export type SystemRecordVerifiedCandidateIssueV1 =
  | Readonly<{ readonly operation: 'active' } & SystemRecordActiveReplacementIssueV1>
  | Readonly<{ readonly operation: 'tombstone' } & SystemRecordTombstoneReplacementIssueV1>
  | Readonly<{ readonly operation: 'quarantine' } & SystemRecordQuarantineReplacementIssueV1>;

/** Deep-owned immutable facts returned once to the storage-side consumer. */
interface SystemRecordVerifiedReplacementCommonFactsV1 {
  readonly networkId: NetworkIdV1;
  readonly kind: 'agents';
  readonly mode: SystemRecordMaterializationModeV1;
  readonly activationGeneration: string;
  readonly childGeneration: string;
  readonly materializationEpoch: string;
  readonly admittedDeadlineMs: number;
  /** Opaque accountant capability; it carries no mutable or inspectable data. */
  readonly reservationIdentity: object;
}

export interface SystemRecordVerifiedActiveReplacementFactsV1
  extends SystemRecordVerifiedReplacementCommonFactsV1 {
  readonly operation: 'active';
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly projectionDigest: ReturnType<typeof computeKaBundleProjectionDigestV1>;
  /** Graphless verified projection. The materializer derives its reserved graph URI. */
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
}

export interface SystemRecordVerifiedTombstoneReplacementFactsV1
  extends SystemRecordVerifiedReplacementCommonFactsV1 {
  readonly operation: 'tombstone';
  readonly head: AgentProfileTombstoneHeadObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly projectionDigest: typeof SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1;
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly deletionOwnedSubjectTable: OwnedSubjectTableObjectV1;
}

export interface SystemRecordVerifiedQuarantineReplacementFactsV1
  extends SystemRecordVerifiedReplacementCommonFactsV1 {
  readonly operation: 'quarantine';
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly projectionDigest: ReturnType<typeof computeKaBundleProjectionDigestV1>;
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly conflictEvidence: AgentProfileConflictEvidenceV1;
  readonly conflictEvidenceDigest: Digest32V1;
  readonly terminalTransitionConflict: boolean;
}

export type SystemRecordVerifiedReplacementFactsV1 =
  | SystemRecordVerifiedActiveReplacementFactsV1
  | SystemRecordVerifiedTombstoneReplacementFactsV1
  | SystemRecordVerifiedQuarantineReplacementFactsV1;

export interface SystemRecordVerifiedReplacementIssuerV1 {
  issueActive(input: SystemRecordActiveReplacementIssueV1): SystemRecordVerifiedReplacementHandleV1;
  issueCandidate(input: SystemRecordVerifiedCandidateIssueV1): SystemRecordVerifiedReplacementHandleV1;
}

export interface SystemRecordVerifiedReplacementConsumerV1 {
  /** Validate lifecycle binding and reveal only the issuer-bound monotonic deadline. */
  inspectDeadline(
    handle: unknown,
    expected: SystemRecordVerifiedReplacementLaneBindingV1,
  ): number;
  /** Release only an authentic proof that has not been consumed into facts. */
  discardProof(handle: unknown): void;
  consume(
    handle: unknown,
    expected: SystemRecordVerifiedReplacementLaneBindingV1,
  ): SystemRecordVerifiedReplacementFactsV1;
  /** Replace one weighted retained-buffer charge inside the live 12-MiB lease. */
  replaceCharge(
    facts: unknown,
    category: SystemRecordAtomicChargeCategoryV1,
    bytes: number,
  ): void;
  /** Release an issued handle or consumed facts exactly once. */
  release(value: unknown): void;
  /** Atomically retain the charge until the accepted recovery settles. */
  transferToRecovery(
    facts: unknown,
    ownership: object,
    completion: Promise<unknown>,
  ): void;
}

export type SystemRecordAtomicChargeCategoryV1 =
  | 'decoded'
  | 'request'
  | 'response'
  | 'prepared';

export interface SystemRecordVerifiedReplacementRegistryV1 {
  readonly issuer: SystemRecordVerifiedReplacementIssuerV1;
  readonly consumer: SystemRecordVerifiedReplacementConsumerV1;
}

interface RegisteredReplacementV1 {
  readonly registryIdentity: object;
  readonly bindings: SystemRecordVerifiedReplacementBindingsV1;
  facts: SystemRecordVerifiedReplacementFactsV1;
  readonly reservation: RuntimeReservationV1;
  used: boolean;
}

type RuntimeReservationPhaseV1 = 'proof' | 'facts' | 'recovery' | 'released';

interface RuntimeReservationV1 {
  readonly registryIdentity: object;
  readonly identity: object;
  readonly gateLease: SystemRecordRuntimeReservationLeaseV1;
  readonly bytes: number;
  readonly admittedDeadlineMs: number;
  readonly charges: Record<SystemRecordAtomicChargeCategoryV1, number>;
  phase: RuntimeReservationPhaseV1;
  recoveryOwnership?: object;
}

export interface SystemRecordVerifiedReplacementRegistryDepsV1 {
  readonly reservationGate: SystemRecordRuntimeReservationGateV1;
  readonly assertAvailable?: () => void;
}

/** Module-private and non-enumerable by construction. Handle identity is the only lookup key. */
const REGISTERED_REPLACEMENTS = new WeakMap<object, RegisteredReplacementV1>();
const AUTHENTIC_VERIFIED_REPLACEMENT_FACTS = new WeakSet<object>();
const FACT_RESERVATIONS = new WeakMap<object, RuntimeReservationV1>();
const ATOMIC_CHARGE_CATEGORIES = new Set<SystemRecordAtomicChargeCategoryV1>([
  'decoded',
  'request',
  'response',
  'prepared',
]);

/** Refuse structural facts even when they embed a separately valid authority capability. */
export function assertAuthenticSystemRecordVerifiedReplacementFactsV1(
  value: unknown,
): asserts value is SystemRecordVerifiedReplacementFactsV1 {
  if (value === null || typeof value !== 'object'
      || !AUTHENTIC_VERIFIED_REPLACEMENT_FACTS.has(value)) {
    throw new Error('verified replacement facts were not produced by this registry');
  }
}

const ISSUE_KEYS = [
  'networkId',
  'kind',
  'mode',
  'sessionIdentity',
  'activationGeneration',
  'childGeneration',
  'materializationEpoch',
  'admittedDeadlineMs',
  'head',
  'verifiedAuthoritySummary',
  'canonicalProjectionBytes',
  'projectionQuads',
  'ownedSubjectTable',
] as const;

const TAGGED_ACTIVE_ISSUE_KEYS = ['operation', ...ISSUE_KEYS] as const;
const TOMBSTONE_ISSUE_KEYS = [
  'operation',
  'networkId',
  'kind',
  'mode',
  'sessionIdentity',
  'activationGeneration',
  'childGeneration',
  'materializationEpoch',
  'admittedDeadlineMs',
  'head',
  'verifiedAuthoritySummary',
  'deletionOwnedSubjectTable',
] as const;
const QUARANTINE_ISSUE_KEYS = [
  'operation',
  ...ISSUE_KEYS,
  'conflictEvidenceDigest',
  'canonicalConflictEvidenceBytes',
  'terminalTransitionConflict',
] as const;

const BINDING_KEYS = [
  'networkId',
  'kind',
  'mode',
  'sessionIdentity',
  'activationGeneration',
  'childGeneration',
  'materializationEpoch',
  'admittedDeadlineMs',
] as const;

const LANE_BINDING_KEYS = [
  'networkId',
  'kind',
  'mode',
  'sessionIdentity',
  'activationGeneration',
  'childGeneration',
  'materializationEpoch',
] as const;

function denseArray(value: unknown, maxLength: number, label: string): readonly unknown[] {
  return snapshotSystemRecordDenseArrayV1(value, { label, minLength: 1, maxLength });
}

function canonicalU64(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical decimal u64`);
  }
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error(`${label} exceeds u64`);
  return value;
}

function identity(value: unknown, label: string): object {
  return assertSystemRecordOpaqueIdentityV1(value, label);
}

function snapshotLaneBinding(value: unknown): SystemRecordVerifiedReplacementLaneBindingV1 {
  const input = exactRecord(value, LANE_BINDING_KEYS, 'verified replacement lane binding');
  assertNetworkIdV1(input.networkId);
  if (input.kind !== 'agents') throw new Error('verified replacement kind must be agents');
  if (input.mode !== 'shadow' && input.mode !== 'authoritative') {
    throw new Error('verified replacement mode is invalid');
  }
  return Object.freeze({
    networkId: input.networkId,
    kind: 'agents',
    mode: input.mode,
    sessionIdentity: identity(input.sessionIdentity, 'sessionIdentity'),
    activationGeneration: canonicalU64(input.activationGeneration, 'activationGeneration'),
    childGeneration: canonicalU64(input.childGeneration, 'childGeneration'),
    materializationEpoch: canonicalU64(input.materializationEpoch, 'materializationEpoch'),
  });
}

function snapshotBindings(value: unknown): SystemRecordVerifiedReplacementBindingsV1 {
  const input = exactRecord(value, BINDING_KEYS, 'verified replacement bindings');
  assertNetworkIdV1(input.networkId);
  if (input.kind !== 'agents') throw new Error('verified replacement kind must be agents');
  if (input.mode !== 'shadow' && input.mode !== 'authoritative') {
    throw new Error('verified replacement mode is invalid');
  }
  if (!Number.isSafeInteger(input.admittedDeadlineMs) || (input.admittedDeadlineMs as number) < 0) {
    throw new Error('admittedDeadlineMs must be a non-negative safe integer');
  }
  return Object.freeze({
    networkId: input.networkId as NetworkIdV1,
    kind: 'agents',
    mode: input.mode,
    sessionIdentity: identity(input.sessionIdentity, 'sessionIdentity'),
    activationGeneration: canonicalU64(input.activationGeneration, 'activationGeneration'),
    childGeneration: canonicalU64(input.childGeneration, 'childGeneration'),
    materializationEpoch: canonicalU64(input.materializationEpoch, 'materializationEpoch'),
    admittedDeadlineMs: input.admittedDeadlineMs as number,
  });
}

function assertCanonicalProjectionBytesForQuads(
  quads: readonly Readonly<Quad>[],
  bytes: Uint8Array,
  expectedContentDigest: string,
): void {
  let cursor = 0;
  let previousStart = -1;
  let previousEnd = -1;
  const leaves: Uint8Array[] = [];
  for (const quad of quads) {
    const line = tripleContentV10(quad.subject, quad.predicate, quad.object);
    if (cursor + line.byteLength + 1 > bytes.byteLength) {
      throw new Error('verified projection quads exceed their canonical bytes');
    }
    for (let index = 0; index < line.byteLength; index += 1) {
      if (bytes[cursor + index] !== line[index]) {
        throw new Error('verified projection quads do not exactly match their canonical bytes');
      }
    }
    if (bytes[cursor + line.byteLength] !== 0x0a) {
      throw new Error('canonical verified projection lines must end with one LF');
    }
    if (previousStart >= 0) {
      const previousLength = previousEnd - previousStart;
      const sharedLength = Math.min(previousLength, line.byteLength);
      let order = 0;
      for (let index = 0; index < sharedLength; index += 1) {
        if (bytes[previousStart + index] !== line[index]) {
          order = bytes[previousStart + index] < line[index] ? -1 : 1;
          break;
        }
      }
      if (order === 0) order = previousLength < line.byteLength ? -1 : previousLength === line.byteLength ? 0 : 1;
      if (order >= 0) throw new Error('verified projection must be UTF-8 sorted and duplicate-free');
    }
    leaves.push(keccak256(line));
    previousStart = cursor;
    previousEnd = cursor + line.byteLength;
    cursor = previousEnd + 1;
  }
  if (cursor !== bytes.byteLength) {
    throw new Error('canonical verified projection contains bytes not represented by its quads');
  }
  const publicRoot = new V10MerkleTree(leaves).root;
  const contentRoot = V10MerkleTree.computeKARoot(publicRoot, SENTINEL_NO_PRIVATE_V10);
  if (`0x${Buffer.from(contentRoot).toString('hex')}` !== expectedContentDigest) {
    throw new Error('verified projection does not reproduce the active head content digest');
  }
}

function snapshotProjection(
  value: unknown,
  rootSubject: string,
  ownedSubjects: ReadonlySet<string>,
  expectedCount: bigint,
  expectedBytes: bigint,
): readonly Readonly<Quad>[] {
  if (expectedCount > BigInt(Number.MAX_SAFE_INTEGER)
    || expectedBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('projection dimensions are outside local bounds');
  }
  const input = denseArray(value, Number(expectedCount), 'verified projection');
  if (input.length !== Number(expectedCount)) {
    throw new Error('verified projection does not match the active head quad count');
  }
  let observedUtf8Bytes = 0;
  const maxUtf8Bytes = Number(expectedBytes);
  const copied = input.map((candidate, index) => {
    const quad = exactRecord(
      candidate,
      ['subject', 'predicate', 'object', 'graph'] as const,
      `verified projection quad ${index}`,
    );
    if (typeof quad.subject !== 'string' || quad.subject.length > maxUtf8Bytes
      || !isSafeIri(quad.subject)) {
      throw new Error(`verified projection quad ${index} has an invalid subject IRI`);
    }
    if (typeof quad.predicate !== 'string' || quad.predicate.length > maxUtf8Bytes
      || !isSafeIri(quad.predicate)) {
      throw new Error(`verified projection quad ${index} has an invalid predicate IRI`);
    }
    assertSafeIri(quad.subject);
    assertSafeIri(quad.predicate);
    if (!ownedSubjects.has(quad.subject)) {
      throw new Error(`verified projection quad ${index} has an unowned subject`);
    }
    const subjectKind = classifyAgentProfileOwnedSubjectV1(rootSubject, quad.subject);
    if (subjectKind === null || !isAllowedAgentProfilePredicateV1(subjectKind, quad.predicate)) {
      throw new Error(`verified projection quad ${index} uses a disallowed profile predicate`);
    }
    if (typeof quad.object !== 'string' || quad.object.length > maxUtf8Bytes) {
      throw new Error(`verified projection quad ${index} has an invalid object`);
    }
    observedUtf8Bytes += Buffer.byteLength(quad.subject, 'utf8')
      + Buffer.byteLength(quad.predicate, 'utf8')
      + Buffer.byteLength(quad.object, 'utf8')
      + (quad.object.startsWith('"') ? 9 : 11);
    if (observedUtf8Bytes > maxUtf8Bytes) {
      throw new Error('verified projection terms exceed the active head byte count');
    }
    if (quad.object.startsWith('"')) assertSafeRdfTerm(quad.object);
    else if (!isSafeIri(quad.object)) {
      throw new Error(`verified projection quad ${index} has a noncanonical object IRI`);
    } else assertSafeIri(quad.object);
    if (quad.graph !== '') {
      throw new Error('verified projections must be graphless; the materializer derives graph scope');
    }
    return Object.freeze({
      subject: quad.subject,
      predicate: quad.predicate,
      object: quad.object,
      graph: '',
    });
  });
  return Object.freeze(copied);
}

function bindingsEqual(
  actual: SystemRecordVerifiedReplacementBindingsV1,
  expected: SystemRecordVerifiedReplacementLaneBindingV1,
): boolean {
  return actual.networkId === expected.networkId
    && actual.kind === expected.kind
    && actual.mode === expected.mode
    && actual.sessionIdentity === expected.sessionIdentity
    && actual.activationGeneration === expected.activationGeneration
    && actual.childGeneration === expected.childGeneration
    && actual.materializationEpoch === expected.materializationEpoch;
}

function candidateIssueKeys(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
    throw new Error('verified replacement candidate must be a non-Proxy data object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'operation');
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new Error('verified replacement candidate operation must be an enumerable data property');
  }
  if (descriptor.value === 'active') return TAGGED_ACTIVE_ISSUE_KEYS;
  if (descriptor.value === 'tombstone') return TOMBSTONE_ISSUE_KEYS;
  if (descriptor.value === 'quarantine') return QUARANTINE_ISSUE_KEYS;
  throw new Error('verified replacement candidate operation is invalid');
}

function stripOperation(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function tombstoneBindsPredecessor(
  tombstone: AgentProfileTombstoneHeadObjectV1,
  predecessor: AgentProfileActiveHeadObjectV1,
): boolean {
  return tombstone.previousHeadDigest === computeAgentProfileHeadObjectDigestV1(predecessor)
    && tombstone.networkId === predecessor.networkId
    && tombstone.peerId === predecessor.peerId
    && tombstone.peerPublicKey === predecessor.peerPublicKey
    && tombstone.authoritySequence === predecessor.authoritySequence
    && tombstone.acceptedTransitionDigest === predecessor.acceptedTransitionDigest
    && tombstone.evmIssuer === predecessor.evmIssuer
    && tombstone.rootSubject === predecessor.rootSubject
    && tombstone.projectionSchemaDigest === predecessor.projectionSchemaDigest
    && BigInt(tombstone.version) > BigInt(predecessor.version);
}

/**
 * Create one non-interchangeable issuer/consumer pair. Only the consumer half belongs
 * in the storage executor; only the issuer half belongs in the verifier closure.
 */
export function createSystemRecordVerifiedReplacementRegistryForRuntimeV1(
  deps: SystemRecordVerifiedReplacementRegistryDepsV1,
): SystemRecordVerifiedReplacementRegistryV1 {
  const registryIdentity = Object.freeze(Object.create(null) as object);
  const { reservationGate } = deps;

  const reserveAtomic = (
    admittedDeadlineMs: number,
    decodedBytes: number,
  ): RuntimeReservationV1 => {
    deps.assertAvailable?.();
    const reservation: RuntimeReservationV1 = {
      registryIdentity,
      identity: Object.freeze(Object.create(null) as object),
      gateLease: reservationGate.acquire(SYSTEM_RECORD_MAX_ATOMIC_TRANSIENT_BYTES),
      bytes: SYSTEM_RECORD_MAX_ATOMIC_TRANSIENT_BYTES,
      admittedDeadlineMs,
      charges: {
        decoded: decodedBytes,
        request: 0,
        response: 0,
        prepared: 0,
      },
      phase: 'proof',
    };
    return reservation;
  };

  const releaseReservation = (reservation: RuntimeReservationV1): void => {
    if (reservation.registryIdentity !== registryIdentity || reservation.phase === 'released') {
      throw new Error('system-record atomic transient reservation was already released');
    }
    reservation.gateLease.release();
    reservation.phase = 'released';
    reservation.charges.decoded = 0;
    reservation.charges.request = 0;
    reservation.charges.response = 0;
    reservation.charges.prepared = 0;
    reservation.recoveryOwnership = undefined;
  };

  const registeredHandle = (handle: unknown): RegisteredReplacementV1 => {
    if (handle === null || typeof handle !== 'object') {
      throw new Error('verified replacement handle is invalid');
    }
    const registered = REGISTERED_REPLACEMENTS.get(handle);
    if (registered === undefined || registered.registryIdentity !== registryIdentity) {
      throw new Error('verified replacement handle is invalid or belongs to another registry');
    }
    return registered;
  };

  const reservationForFacts = (facts: unknown): RuntimeReservationV1 => {
    if (facts === null || typeof facts !== 'object') {
      throw new Error('verified replacement facts are invalid');
    }
    const reservation = FACT_RESERVATIONS.get(facts);
    if (reservation === undefined || reservation.registryIdentity !== registryIdentity) {
      throw new Error('verified replacement facts belong to another registry');
    }
    return reservation;
  };

  const issuer: SystemRecordVerifiedReplacementIssuerV1 = Object.freeze({
    issueActive(value: SystemRecordActiveReplacementIssueV1): SystemRecordVerifiedReplacementHandleV1 {
      const input = exactRecord(value, ISSUE_KEYS, 'active verified replacement');
      const bindings = snapshotBindings(Object.fromEntries(
        BINDING_KEYS.map((key) => [key, input[key]]),
      ));
      // Reserve before any head/projection decode or snapshot allocation. A
      // concurrent verifier cannot build a second maximum object graph and only
      // then discover that the single nonqueued lease was unavailable.
      const reservation = reserveAtomic(bindings.admittedDeadlineMs, 0);

      try {
      if (input.head !== null && typeof input.head === 'object' && utilTypes.isProxy(input.head)) {
        throw new Error('verified replacement head must not be a Proxy');
      }
      if (input.head !== null && typeof input.head === 'object') {
        const sealDescriptor = Object.getOwnPropertyDescriptor(input.head, 'graphScopedAuthorSeal');
        if (sealDescriptor && Object.prototype.hasOwnProperty.call(sealDescriptor, 'value')
          && sealDescriptor.value !== null && typeof sealDescriptor.value === 'object'
          && utilTypes.isProxy(sealDescriptor.value)) {
          throw new Error('verified replacement graph-scoped author seal must not be a Proxy');
        }
      }
      assertAgentProfileHeadObjectV1(input.head);
      const head = parseCanonicalAgentProfileHeadObjectV1(
        canonicalizeAgentProfileHeadObjectV1(input.head),
      );
      if (head.state !== 'active') throw new Error('verified replacement head must be active');
      if (head.networkId !== bindings.networkId) {
        throw new Error('verified replacement head does not bind networkId');
      }

      assertAgentProfileVerifiedAuthoritySummaryV1(input.verifiedAuthoritySummary);
      const authority = input.verifiedAuthoritySummary;
      if (authority.candidateHeadDigest !== computeAgentProfileHeadObjectDigestV1(head)) {
        throw new Error('verified authority summary does not bind the active head');
      }

      if (utilTypes.isProxy(input.ownedSubjectTable)) {
        throw new Error('owned-subject table must not be a Proxy');
      }
      const subjectTable = parseCanonicalOwnedSubjectTableObjectV1(
        head.rootSubject,
        canonicalizeOwnedSubjectTableObjectV1(
          head.rootSubject,
          input.ownedSubjectTable as OwnedSubjectTableObjectV1,
        ),
      );
      if (BigInt(subjectTable.length) !== BigInt(head.ownedSubjectCount)
        || computeOwnedSubjectTableDigestV1(head.rootSubject, subjectTable)
          !== head.ownedSubjectTableDigest) {
        throw new Error('owned-subject table does not match the active head');
      }
      if (input.canonicalProjectionBytes !== null
        && typeof input.canonicalProjectionBytes === 'object'
        && utilTypes.isProxy(input.canonicalProjectionBytes)) {
        throw new Error('canonical verified projection must not be a Proxy');
      }
      const canonicalProjectionBytes = copyBoundedSystemRecordBytesV1(
        input.canonicalProjectionBytes,
        SYSTEM_RECORD_MAX_PROJECTION_BYTES,
        'canonical verified projection',
      );
      if (BigInt(canonicalProjectionBytes.byteLength) !== BigInt(head.projectionBytes)) {
        throw new Error('canonical verified projection does not match the active head byte count');
      }
      const projection = snapshotProjection(
        input.projectionQuads,
        head.rootSubject,
        new Set(subjectTable),
        BigInt(head.projectionQuads),
        BigInt(canonicalProjectionBytes.byteLength),
      );
      assertAgentProfileProjectionSchemaV1(head.rootSubject, subjectTable, projection);
      assertAgentProfileProjectionIdentityV1(head, projection);
      assertCanonicalProjectionBytesForQuads(
        projection,
        canonicalProjectionBytes,
        head.contentDigest,
      );
      const projectionDigest = computeKaBundleProjectionDigestV1(canonicalProjectionBytes);

      const decodedBytes = retainedVerifiedFactsBytes(
        head,
        authority,
        subjectTable,
        projection,
      );
      if (decodedBytes > reservation.bytes) {
        throw new Error('verified replacement decoded state exceeds its transient lease');
      }
      reservation.charges.decoded = decodedBytes;

      const facts: SystemRecordVerifiedReplacementFactsV1 = Object.freeze({
        operation: 'active',
        networkId: bindings.networkId,
        kind: bindings.kind,
        mode: bindings.mode,
        activationGeneration: bindings.activationGeneration,
        childGeneration: bindings.childGeneration,
        materializationEpoch: bindings.materializationEpoch,
        admittedDeadlineMs: bindings.admittedDeadlineMs,
        reservationIdentity: reservation.identity,
        head,
        verifiedAuthoritySummary: authority,
        projectionDigest,
        projectionQuads: projection,
        ownedSubjectTable: subjectTable,
      });
      AUTHENTIC_VERIFIED_REPLACEMENT_FACTS.add(facts);
      FACT_RESERVATIONS.set(facts, reservation);
      const handle = Object.freeze(
        Object.create(null) as object,
      ) as SystemRecordVerifiedReplacementHandleV1;
      REGISTERED_REPLACEMENTS.set(handle, {
        registryIdentity,
        bindings,
        facts,
        reservation,
        used: false,
      });
      return handle;
      } catch (error) {
        if (reservation.phase !== 'released') releaseReservation(reservation);
        throw error;
      }
    },
    issueCandidate(value: SystemRecordVerifiedCandidateIssueV1): SystemRecordVerifiedReplacementHandleV1 {
      const tagged = exactRecord(
        value,
        candidateIssueKeys(value),
        'verified replacement candidate',
      );
      if (tagged.operation === 'active') {
        return issuer.issueActive(
          stripOperation(tagged, ISSUE_KEYS) as unknown as SystemRecordActiveReplacementIssueV1,
        );
      }
      if (tagged.operation === 'quarantine') {
        const activeInput = stripOperation(
          tagged,
          ISSUE_KEYS,
        ) as unknown as SystemRecordActiveReplacementIssueV1;
        const handle = issuer.issueActive(activeInput);
        const registered = registeredHandle(handle);
        try {
          const canonicalEvidenceBytes = copyBoundedSystemRecordBytesV1(
            tagged.canonicalConflictEvidenceBytes,
            SYSTEM_RECORD_OBJECT_CAPS_V1['conflict-evidence'],
            'canonical conflict evidence',
          );
          const evidence = parseCanonicalAgentProfileConflictEvidenceV1(canonicalEvidenceBytes);
          const canonicalEvidence = canonicalizeAgentProfileConflictEvidenceV1(evidence);
          if (!Buffer.from(canonicalEvidence).equals(Buffer.from(canonicalEvidenceBytes))) {
            throw new Error('conflict evidence bytes are not the canonical evidence object');
          }
          const evidenceDigest = computeAgentProfileConflictEvidenceDigestV1(evidence);
          if (evidenceDigest !== tagged.conflictEvidenceDigest
              || evidence.networkId !== registered.facts.networkId
              || evidence.peerId !== registered.facts.head.peerId) {
            throw new Error('conflict evidence does not bind the verified active candidate');
          }
          const terminalTransitionConflict = evidence.entries.some((entry) =>
            entry.type === 'transition');
          if (tagged.terminalTransitionConflict !== terminalTransitionConflict) {
            throw new Error('conflict evidence terminal classification is inconsistent');
          }
          const headDigest = computeAgentProfileHeadObjectDigestV1(registered.facts.head);
          for (const entry of evidence.entries) {
            if (entry.type === 'fork'
                && (entry.authoritySequence !== registered.facts.head.authoritySequence
                  || entry.version !== registered.facts.head.version
                  || !entry.objectDigests.includes(headDigest))) {
              throw new Error('fork evidence does not bind the verified active candidate frontier');
            }
          }
          if (registered.facts.operation !== 'active') {
            throw new Error('quarantine candidate did not produce active verified facts');
          }
          const decodedBytes = registered.reservation.charges.decoded
            + retainedVerifiedConflictEvidenceBytes(evidence);
          if (decodedBytes > registered.reservation.bytes) {
            throw new Error('verified replacement decoded state exceeds its transient lease');
          }
          registered.reservation.charges.decoded = decodedBytes;
          const facts: SystemRecordVerifiedQuarantineReplacementFactsV1 = Object.freeze({
            ...registered.facts,
            operation: 'quarantine',
            conflictEvidence: evidence,
            conflictEvidenceDigest: evidenceDigest,
            terminalTransitionConflict,
          });
          AUTHENTIC_VERIFIED_REPLACEMENT_FACTS.add(facts);
          FACT_RESERVATIONS.set(facts, registered.reservation);
          registered.facts = facts;
          return handle;
        } catch (error) {
          if (registered.reservation.phase !== 'released') releaseReservation(registered.reservation);
          throw error;
        }
      }

      const bindings = snapshotBindings(stripOperation(tagged, BINDING_KEYS));
      const reservation = reserveAtomic(bindings.admittedDeadlineMs, 0);
      try {
        if (tagged.head !== null && typeof tagged.head === 'object' && utilTypes.isProxy(tagged.head)) {
          throw new Error('verified replacement head must not be a Proxy');
        }
        assertAgentProfileHeadObjectV1(tagged.head);
        const parsedHead = parseCanonicalAgentProfileHeadObjectV1(
          canonicalizeAgentProfileHeadObjectV1(tagged.head as AgentProfileHeadObjectV1),
        );
        if (parsedHead.state !== 'tombstone') {
          throw new Error('verified tombstone replacement head must be tombstone');
        }
        if (parsedHead.networkId !== bindings.networkId) {
          throw new Error('verified tombstone replacement head does not bind networkId');
        }
        assertAgentProfileVerifiedAuthoritySummaryV1(tagged.verifiedAuthoritySummary);
        const authority = tagged.verifiedAuthoritySummary;
        const predecessor = authority.tombstonePredecessor;
        if (authority.candidateHeadDigest !== computeAgentProfileHeadObjectDigestV1(parsedHead)
            || predecessor === undefined
            || authority.deletionTableDigest !== predecessor.ownedSubjectTableDigest
            || !tombstoneBindsPredecessor(parsedHead, predecessor)) {
          throw new Error('verified tombstone authority summary lacks its exact predecessor');
        }
        if (utilTypes.isProxy(tagged.deletionOwnedSubjectTable)) {
          throw new Error('tombstone deletion table must not be a Proxy');
        }
        const deletionTable = parseCanonicalOwnedSubjectTableObjectV1(
          predecessor.rootSubject,
          canonicalizeOwnedSubjectTableObjectV1(
            predecessor.rootSubject,
            tagged.deletionOwnedSubjectTable as OwnedSubjectTableObjectV1,
          ),
        );
        if (computeOwnedSubjectTableDigestV1(predecessor.rootSubject, deletionTable)
              !== predecessor.ownedSubjectTableDigest
            || BigInt(deletionTable.length) !== BigInt(predecessor.ownedSubjectCount)) {
          throw new Error('tombstone deletion table does not bind the verified predecessor');
        }
        const emptyTable = Object.freeze([]) as unknown as OwnedSubjectTableObjectV1;
        const emptyProjection = Object.freeze([]) as readonly Readonly<Quad>[];
        const decodedBytes = retainedVerifiedTerminalFactsBytes(
          parsedHead,
          authority,
          deletionTable,
        );
        if (decodedBytes > reservation.bytes) {
          throw new Error('verified replacement decoded state exceeds its transient lease');
        }
        reservation.charges.decoded = decodedBytes;
        const facts: SystemRecordVerifiedTombstoneReplacementFactsV1 = Object.freeze({
          operation: 'tombstone',
          networkId: bindings.networkId,
          kind: bindings.kind,
          mode: bindings.mode,
          activationGeneration: bindings.activationGeneration,
          childGeneration: bindings.childGeneration,
          materializationEpoch: bindings.materializationEpoch,
          admittedDeadlineMs: bindings.admittedDeadlineMs,
          reservationIdentity: reservation.identity,
          head: parsedHead,
          verifiedAuthoritySummary: authority,
          projectionDigest: SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
          projectionQuads: emptyProjection,
          ownedSubjectTable: emptyTable,
          deletionOwnedSubjectTable: deletionTable,
        });
        AUTHENTIC_VERIFIED_REPLACEMENT_FACTS.add(facts);
        FACT_RESERVATIONS.set(facts, reservation);
        const handle = Object.freeze(
          Object.create(null) as object,
        ) as SystemRecordVerifiedReplacementHandleV1;
        REGISTERED_REPLACEMENTS.set(handle, {
          registryIdentity,
          bindings,
          facts,
          reservation,
          used: false,
        });
        return handle;
      } catch (error) {
        if (reservation.phase !== 'released') releaseReservation(reservation);
        throw error;
      }
    },
  });

  const consumer: SystemRecordVerifiedReplacementConsumerV1 = Object.freeze({
    inspectDeadline(
      handle: unknown,
      expectedValue: SystemRecordVerifiedReplacementLaneBindingV1,
    ): number {
      const registered = registeredHandle(handle);
      if (registered.used) throw new Error('verified replacement handle was already consumed');
      if (registered.reservation.phase !== 'proof') {
        throw new Error('verified replacement reservation is no longer live');
      }
      const expected = snapshotLaneBinding(expectedValue);
      if (!bindingsEqual(registered.bindings, expected)) {
        throw new Error('verified replacement handle does not match the active lifecycle binding');
      }
      return registered.reservation.admittedDeadlineMs;
    },
    discardProof(handle: unknown): void {
      const registered = registeredHandle(handle);
      if (registered.used || registered.reservation.phase !== 'proof') {
        throw new Error('verified replacement proof is no longer live and unconsumed');
      }
      releaseReservation(registered.reservation);
    },
    consume(
      handle: unknown,
      expectedValue: SystemRecordVerifiedReplacementLaneBindingV1,
    ): SystemRecordVerifiedReplacementFactsV1 {
      const registered = registeredHandle(handle);
      if (registered.used) throw new Error('verified replacement handle was already consumed');
      if (registered.reservation.phase !== 'proof') {
        throw new Error('verified replacement reservation is no longer live');
      }
      const expected = snapshotLaneBinding(expectedValue);
      if (!bindingsEqual(registered.bindings, expected)) {
        throw new Error('verified replacement handle does not match the active lifecycle binding');
      }

      // Consume before exposing facts. No callback or await can interleave this transition.
      registered.used = true;
      registered.reservation.phase = 'facts';
      return registered.facts;
    },
    replaceCharge(
      facts: unknown,
      category: SystemRecordAtomicChargeCategoryV1,
      bytes: number,
    ): void {
      const reservation = reservationForFacts(facts);
      if (reservation.phase !== 'facts' && reservation.phase !== 'recovery') {
        throw new Error('system-record atomic transient reservation is not live');
      }
      if (!ATOMIC_CHARGE_CATEGORIES.has(category)) {
        throw new Error('system-record atomic transient charge category is invalid');
      }
      if (!Number.isSafeInteger(bytes) || bytes < 0
          || bytes > SYSTEM_RECORD_MAX_ATOMIC_TRANSIENT_BYTES) {
        throw new Error('system-record atomic transient charge is outside its bound');
      }
      const previous = reservation.charges[category];
      const nextTotal = Object.values(reservation.charges)
        .reduce((total, charge) => total + charge, 0) - previous + bytes;
      if (nextTotal > reservation.bytes) {
        throw new Error('system-record atomic transient lease capacity exceeded');
      }
      reservation.charges[category] = bytes;
    },
    release(value: unknown): void {
      let reservation: RuntimeReservationV1;
      if (value !== null && typeof value === 'object'
          && REGISTERED_REPLACEMENTS.has(value)) {
        reservation = registeredHandle(value).reservation;
      } else {
        reservation = reservationForFacts(value);
      }
      if (reservation.phase === 'recovery') {
        throw new Error('system-record atomic transient reservation belongs to recovery');
      }
      releaseReservation(reservation);
    },
    transferToRecovery(
      facts: unknown,
      ownership: object,
      completion: Promise<unknown>,
    ): void {
      const reservation = reservationForFacts(facts);
      if (reservation.phase !== 'facts') {
        throw new Error('system-record atomic transient reservation is not consumer-owned');
      }
      const recoveryOwnership = identity(ownership, 'recovery ownership');
      if (!(completion instanceof Promise)) {
        throw new Error('system-record recovery completion must be a Promise');
      }
      reservation.phase = 'recovery';
      reservation.recoveryOwnership = recoveryOwnership;
      void completion.then(
        () => {
          if (reservation.phase === 'recovery'
              && reservation.recoveryOwnership === recoveryOwnership) {
            releaseReservation(reservation);
          }
        },
        () => {
          if (reservation.phase === 'recovery'
              && reservation.recoveryOwnership === recoveryOwnership) {
            releaseReservation(reservation);
          }
        },
      );
    },
  });

  return Object.freeze({ issuer, consumer });
}

/**
 * Isolated registry for storage-internal tests and pure transaction composition.
 * Production code must resolve the ownership-lease runtime below so every managed
 * adapter and future lifecycle verifier shares one process-wide accountant.
 */
export function createSystemRecordVerifiedReplacementRegistryV1(): SystemRecordVerifiedReplacementRegistryV1 {
  return createSystemRecordVerifiedReplacementRegistryForRuntimeV1({
    reservationGate: createSystemRecordNonQueuedReservationGateV1(),
  });
}

function retainedVerifiedFactsBytes(
  head: AgentProfileActiveHeadObjectV1,
  authority: AgentProfileVerifiedAuthoritySummaryV1,
  subjectTable: OwnedSubjectTableObjectV1,
  projection: readonly Readonly<Quad>[],
): number {
  // The ADR weights retained JS strings at two bytes/code unit and Quad/
  // container entries at 128 bytes. JSON here is already verifier-produced,
  // deeply frozen plain data, so serialization invokes no caller accessors.
  let bytes = 2 * Buffer.byteLength(JSON.stringify(head), 'utf8')
    + 2 * Buffer.byteLength(JSON.stringify(authority), 'utf8')
    + 2 * Buffer.byteLength(JSON.stringify(subjectTable), 'utf8');
  for (const quad of projection) {
    bytes += 2 * (
      Buffer.byteLength(quad.subject, 'utf8')
      + Buffer.byteLength(quad.predicate, 'utf8')
      + Buffer.byteLength(quad.object, 'utf8')
    ) + 128;
    if (!Number.isSafeInteger(bytes)) return Number.MAX_SAFE_INTEGER;
  }
  return bytes;
}

function retainedVerifiedTerminalFactsBytes(
  head: AgentProfileTombstoneHeadObjectV1,
  authority: AgentProfileVerifiedAuthoritySummaryV1,
  deletionTable: OwnedSubjectTableObjectV1,
): number {
  return 2 * (
    Buffer.byteLength(JSON.stringify(head), 'utf8')
    + Buffer.byteLength(JSON.stringify(authority), 'utf8')
    + Buffer.byteLength(JSON.stringify(deletionTable), 'utf8')
  );
}

function retainedVerifiedConflictEvidenceBytes(
  evidence: AgentProfileConflictEvidenceV1,
): number {
  return 2 * Buffer.byteLength(JSON.stringify(evidence), 'utf8');
}
