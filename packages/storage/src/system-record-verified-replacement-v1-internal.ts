import { types as utilTypes } from 'node:util';

import {
  assertSafeIri,
  assertSafeRdfTerm,
  computeKaBundleProjectionDigestV1,
  decodeWorkspaceEncryptionKey,
  isSafeIri,
  keccak256,
  SENTINEL_NO_PRIVATE_V10,
  tripleContentV10,
  V10MerkleTree,
} from '@origintrail-official/dkg-core';
import {
  assertAgentProfileHeadObjectV1,
  assertDerivedAgentEncryptionSubjectV1,
  assertAgentProfileVerifiedAuthoritySummaryV1,
  assertNetworkIdV1,
  canonicalizeAgentProfileHeadObjectV1,
  canonicalizeOwnedSubjectTableObjectV1,
  AGENT_PROFILE_LINK_PREDICATES_V1,
  classifyAgentProfileOwnedSubjectV1,
  copyBoundedSystemRecordBytesV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  isAllowedAgentProfilePredicateV1,
  parseCanonicalAgentProfileHeadObjectV1,
  parseCanonicalOwnedSubjectTableObjectV1,
  SYSTEM_RECORD_MAX_ATOMIC_TRANSIENT_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_BYTES,
  SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type NetworkIdV1,
  type OwnedSubjectTableObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  isManagedOxigraphOwnershipLeaseV1,
  readManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphOwnershipLeaseV1,
} from './managed-oxigraph-ownership-v1-internal.js';
import {
  createSystemRecordLaneActivationRegistryV1,
  type SystemRecordLaneActivationIssuerV1,
  type SystemRecordLaneActivationReaderV1,
} from './system-record-lane-activation-v1-internal.js';
import type { Quad } from './triple-store.js';

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

/** Deep-owned immutable facts returned once to the storage-side consumer. */
export interface SystemRecordVerifiedReplacementFactsV1 {
  readonly networkId: NetworkIdV1;
  readonly kind: 'agents';
  readonly mode: SystemRecordMaterializationModeV1;
  readonly activationGeneration: string;
  readonly childGeneration: string;
  readonly materializationEpoch: string;
  readonly admittedDeadlineMs: number;
  /** Opaque accountant capability; it carries no mutable or inspectable data. */
  readonly reservationIdentity: object;
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly projectionDigest: ReturnType<typeof computeKaBundleProjectionDigestV1>;
  /** Graphless verified projection. The materializer derives its reserved graph URI. */
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
}

export interface SystemRecordVerifiedReplacementIssuerV1 {
  issueActive(input: SystemRecordActiveReplacementIssueV1): SystemRecordVerifiedReplacementHandleV1;
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
  readonly activationIssuer: SystemRecordLaneActivationIssuerV1;
  readonly activationReader: SystemRecordLaneActivationReaderV1;
}

interface RegisteredReplacementV1 {
  readonly registryIdentity: object;
  readonly bindings: SystemRecordVerifiedReplacementBindingsV1;
  readonly facts: SystemRecordVerifiedReplacementFactsV1;
  readonly reservation: RuntimeReservationV1;
  used: boolean;
}

type RuntimeReservationPhaseV1 = 'proof' | 'facts' | 'recovery' | 'released';

interface RuntimeReservationV1 {
  readonly registryIdentity: object;
  readonly accountantIdentity: object;
  readonly identity: object;
  readonly bytes: number;
  readonly admittedDeadlineMs: number;
  readonly charges: Record<SystemRecordAtomicChargeCategoryV1, number>;
  phase: RuntimeReservationPhaseV1;
  recoveryOwnership?: object;
}

interface SystemRecordRuntimeAccountantV1 {
  readonly identity: object;
  accountedBytes: number;
  liveAtomicReservation: RuntimeReservationV1 | null;
}

interface SystemRecordVerifiedReplacementRegistryDepsV1 {
  readonly accountant: SystemRecordRuntimeAccountantV1;
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

const createSystemRecordRuntimeAccountantV1 = (): SystemRecordRuntimeAccountantV1 => ({
  identity: Object.freeze(Object.create(null) as object),
  accountedBytes: 0,
  liveAtomicReservation: null,
});

/**
 * Production reservations are process-wide, not per adapter or per ownership lease.
 * Test-only registries created directly below receive an isolated accountant so suites
 * cannot leak mutable process state into one another.
 */
const PRODUCTION_RUNTIME_ACCOUNTANT = createSystemRecordRuntimeAccountantV1();
const PRODUCTION_REGISTRIES = new WeakMap<
  ManagedOxigraphOwnershipLeaseV1,
  SystemRecordVerifiedReplacementRegistryV1
>();

/** Refuse structural facts even when they embed a separately valid authority capability. */
export function assertAuthenticSystemRecordVerifiedReplacementFactsV1(
  value: unknown,
): asserts value is SystemRecordVerifiedReplacementFactsV1 {
  if (value === null || typeof value !== 'object'
      || !AUTHENTIC_VERIFIED_REPLACEMENT_FACTS.has(value)) {
    throw new Error('verified replacement facts were not produced by this registry');
  }
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG = 'https://dkg.network/ontology#';
const ERC8004 = 'https://eips.ethereum.org/erc-8004#';
const PROV = 'http://www.w3.org/ns/prov#';
const SKILL = 'https://dkg.origintrail.io/skill#';
const IRI_OBJECT_PREDICATES = new Set<string>([
  RDF_TYPE,
  ...Object.values(AGENT_PROFILE_LINK_PREDICATES_V1),
  `${SKILL}skill`,
  `${SKILL}pricing`,
  `${DKG}revokedBy`,
]);
const PUBLIC_ENCRYPTION_KEY = `${DKG}publicEncryptionKey`;
const ALLOWED_TYPE_OBJECTS = Object.freeze({
  root: new Set([`${DKG}Agent`, `${DKG}CoreNode`, `${DKG}EdgeNode`]),
  capability: new Set([`${ERC8004}Capability`]),
  offering: new Set([`${SKILL}SkillOffering`]),
  registration: new Set([`${PROV}Activity`]),
  hosting: new Set([`${SKILL}HostingProfile`]),
  x25519: new Set<string>(),
});

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

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
  label: string,
): Readonly<Record<Keys[number], unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  if (utilTypes.isProxy(value)) throw new Error(`${label} must not be a Proxy`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) throw new Error(`${label} has unknown or missing fields`);
  const expected = new Set<string>(keys);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} has unknown or missing fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result) as Readonly<Record<Keys[number], unknown>>;
}

function denseArray(value: unknown, maxLength: number, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (utilTypes.isProxy(value)) throw new Error(`${label} must not be a Proxy`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || lengthDescriptor.enumerable === true
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 1
    || lengthDescriptor.value > maxLength) {
    throw new Error(`${label} length is outside its bound`);
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) throw new Error(`${label} must be a dense closed array`);
  const result = new Array<unknown>(length);
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) {
      throw new Error(`${label} must contain only array indexes`);
    }
    const index = Number(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Number.isSafeInteger(index) || index >= length || !descriptor?.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must contain only enumerable data elements`);
    }
    result[index] = descriptor.value;
  }
  return Object.freeze(result);
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
  if (value === null || typeof value !== 'object') {
    throw new Error(`${label} must be an opaque object identity`);
  }
  if (utilTypes.isProxy(value)) throw new Error(`${label} must not be a Proxy`);
  if (Object.getPrototypeOf(value) !== null || !Object.isFrozen(value)
    || Reflect.ownKeys(value).length !== 0) {
    throw new Error(`${label} must be a frozen propertyless null-prototype capability`);
  }
  return value;
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

function validateProjectionSchema(
  rootSubject: string,
  ownedSubjectTable: OwnedSubjectTableObjectV1,
  quads: readonly Readonly<Quad>[],
): void {
  const linked = new Set<string>();
  const seenSubjects = new Set<string>();
  const ownedSubjects = new Set(ownedSubjectTable);
  const publicKeys: Uint8Array[] = [];
  for (const quad of quads) {
    seenSubjects.add(quad.subject);
    const subjectKind = classifyAgentProfileOwnedSubjectV1(rootSubject, quad.subject);
    if (subjectKind === null) throw new Error('verified projection contains an unknown subject kind');
    const objectIsLiteral = quad.object.startsWith('"');
    if (IRI_OBJECT_PREDICATES.has(quad.predicate) === objectIsLiteral) {
      throw new Error('verified projection predicate has an invalid object term kind');
    }
    if (quad.predicate === RDF_TYPE && !ALLOWED_TYPE_OBJECTS[subjectKind].has(quad.object)) {
      throw new Error('verified projection rdf:type object is outside the frozen profile schema');
    }
    if (quad.subject === rootSubject) {
      const linkKind = Object.entries(AGENT_PROFILE_LINK_PREDICATES_V1)
        .find(([, predicate]) => predicate === quad.predicate)?.[0];
      if (linkKind !== undefined) {
        if (objectIsLiteral || !ownedSubjects.has(quad.object)
          || classifyAgentProfileOwnedSubjectV1(rootSubject, quad.object) !== linkKind) {
          throw new Error('verified profile link does not target its exact derived-subject kind');
        }
        linked.add(quad.object);
      }
      if (quad.predicate === PUBLIC_ENCRYPTION_KEY) {
        const match = /^"([A-Za-z0-9_-]{43})"$/.exec(quad.object);
        if (match === null) throw new Error('verified profile public encryption key is not canonical');
        try {
          publicKeys.push(decodeWorkspaceEncryptionKey(match[1]));
        } catch (cause) {
          throw new Error('verified profile public encryption key is invalid', { cause });
        }
      }
    }
    if (subjectKind === 'x25519' && quad.predicate === `${DKG}revokedBy`
      && quad.object !== rootSubject) {
      throw new Error('verified x25519 revocation does not bind the profile root');
    }
  }
  for (const subject of ownedSubjectTable) {
    if (!seenSubjects.has(subject)) {
      throw new Error('owned-subject table contains a subject absent from the projection');
    }
    const kind = classifyAgentProfileOwnedSubjectV1(rootSubject, subject);
    if (kind === 'capability' || kind === 'offering' || kind === 'registration' || kind === 'hosting') {
      if (!linked.has(subject)) throw new Error('verified derived profile subject is not linked from the root');
    } else if (kind === 'x25519') {
      const derived = publicKeys.some((key) => {
        try {
          assertDerivedAgentEncryptionSubjectV1(rootSubject, subject, key);
          return true;
        } catch {
          return false;
        }
      });
      if (!derived) throw new Error('verified x25519 subject is not derived from a profile public key');
    }
  }
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

/**
 * Create one non-interchangeable issuer/consumer pair. Only the consumer half belongs
 * in the storage executor; only the issuer half belongs in the verifier closure.
 */
function createSystemRecordVerifiedReplacementRegistryWithDepsV1(
  deps: SystemRecordVerifiedReplacementRegistryDepsV1,
): SystemRecordVerifiedReplacementRegistryV1 {
  const registryIdentity = Object.freeze(Object.create(null) as object);
  const { accountant } = deps;
  const activation = createSystemRecordLaneActivationRegistryV1(deps.assertAvailable);

  const reserveAtomic = (
    admittedDeadlineMs: number,
    decodedBytes: number,
  ): RuntimeReservationV1 => {
    deps.assertAvailable?.();
    if (accountant.liveAtomicReservation !== null
        || accountant.accountedBytes + SYSTEM_RECORD_MAX_ATOMIC_TRANSIENT_BYTES
          > SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES) {
      throw new Error('system-record atomic transient reservation is already live');
    }
    const reservation: RuntimeReservationV1 = {
      registryIdentity,
      accountantIdentity: accountant.identity,
      identity: Object.freeze(Object.create(null) as object),
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
    accountant.accountedBytes += reservation.bytes;
    accountant.liveAtomicReservation = reservation;
    return reservation;
  };

  const releaseReservation = (reservation: RuntimeReservationV1): void => {
    if (reservation.registryIdentity !== registryIdentity || reservation.phase === 'released') {
      throw new Error('system-record atomic transient reservation was already released');
    }
    if (reservation.accountantIdentity !== accountant.identity
        || accountant.liveAtomicReservation !== reservation
        || accountant.accountedBytes < reservation.bytes) {
      throw new Error('system-record atomic transient accountant state is inconsistent');
    }
    reservation.phase = 'released';
    reservation.charges.decoded = 0;
    reservation.charges.request = 0;
    reservation.charges.response = 0;
    reservation.charges.prepared = 0;
    reservation.recoveryOwnership = undefined;
    accountant.accountedBytes -= reservation.bytes;
    accountant.liveAtomicReservation = null;
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
      validateProjectionSchema(head.rootSubject, subjectTable, projection);
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

  return Object.freeze({
    issuer,
    consumer,
    activationIssuer: activation.issuer,
    activationReader: activation.reader,
  });
}

/**
 * Isolated registry for storage-internal tests and pure transaction composition.
 * Production code must resolve the ownership-lease runtime below so every managed
 * adapter and future lifecycle verifier shares one process-wide accountant.
 */
export function createSystemRecordVerifiedReplacementRegistryV1(): SystemRecordVerifiedReplacementRegistryV1 {
  return createSystemRecordVerifiedReplacementRegistryWithDepsV1({
    accountant: createSystemRecordRuntimeAccountantV1(),
  });
}

/**
 * Resolve the single runtime bound to an authentic daemon ownership lease.
 *
 * A persisted option, copied object, or structural look-alike cannot create a runtime.
 * The returned pair is intentionally internal to the package: storage retains only the
 * consumer while the later agent lifecycle captures the issuer in its verifier closure.
 */
export function resolveOwnedSystemRecordVerifiedReplacementRuntimeV1(
  lease: ManagedOxigraphOwnershipLeaseV1,
): SystemRecordVerifiedReplacementRegistryV1 {
  if (!isManagedOxigraphOwnershipLeaseV1(lease)) {
    throw new Error('system-record runtime requires an authentic managed Oxigraph ownership lease');
  }
  const ownership = readManagedOxigraphOwnershipSnapshotV1(lease);
  if (ownership?.queryEndpoint === undefined || ownership.updateEndpoint === undefined) {
    throw new Error('system-record runtime requires an endpoint-bound managed Oxigraph ownership lease');
  }
  const existing = PRODUCTION_REGISTRIES.get(lease);
  if (existing !== undefined) return existing;

  const runtime = createSystemRecordVerifiedReplacementRegistryWithDepsV1({
    accountant: PRODUCTION_RUNTIME_ACCOUNTANT,
    assertAvailable: () => {
      const snapshot = readManagedOxigraphOwnershipSnapshotV1(lease);
      if (!snapshot?.ready || snapshot.terminal
          || snapshot.queryEndpoint !== ownership.queryEndpoint
          || snapshot.updateEndpoint !== ownership.updateEndpoint) {
        throw new Error('system-record runtime ownership lease is not ready');
      }
    },
  });
  PRODUCTION_REGISTRIES.set(lease, runtime);
  return runtime;
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
