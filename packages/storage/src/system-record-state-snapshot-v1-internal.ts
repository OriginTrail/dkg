import { types as utilTypes } from 'node:util';

import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import {
  assertCanonicalDigest,
  isSafeIri,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import {
  assertNetworkIdV1,
  canonicalizeOwnedSubjectTableObjectV1,
  computeSystemRecordAppliedStateDigestV1,
  computeSystemRecordCapacityStateDigestV1,
  computeSystemRecordMaterializationReceiptDigestV1,
  computeSystemRecordRootClaimSetDigestV1,
  parseCanonicalOwnedSubjectTableObjectV1,
  parseCanonicalSystemRecordAppliedStateV1,
  parseCanonicalSystemRecordCapacityStateV1,
  parseCanonicalSystemRecordMaterializationReceiptV1,
  parseCanonicalSystemRecordRootClaimSetV1,
  SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES,
  SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES,
  SYSTEM_RECORD_MAX_ROOT_CLAIMS,
  systemRecordAppliedStateAbsentV1,
  type NetworkIdV1,
  type OwnedSubjectTableObjectV1,
  type SystemRecordAppliedStateAbsentV1,
  type SystemRecordAppliedStatePresentV1,
  type SystemRecordCapacityStateV1,
  type SystemRecordMaterializationReceiptV1,
  type SystemRecordRootClaimSetV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { Quad } from './triple-store.js';
import {
  buildSystemRecordMaterializationEpochQuadsV1,
  buildSystemRecordReservedStateQuadsV1,
  systemRecordCapacitySubjectV1,
  systemRecordEpochSubjectV1,
  systemRecordReceiptSubjectV1,
  systemRecordRecordSubjectV1,
  SYSTEM_RECORD_V1_JSON_DATATYPE,
  SYSTEM_RECORD_V1_PREDICATES,
} from './system-record-rdf-schema-v1-internal.js';
import { SYSTEM_RECORD_V1_STATE_GRAPH } from './internal-graph-policy.js';

export interface SystemRecordAbsentSnapshotV1 {
  readonly state: 'absent';
  readonly appliedState: SystemRecordAppliedStateAbsentV1;
  readonly capacityState: SystemRecordCapacityStateV1;
  readonly materializationEpoch: string;
  readonly previousReservedQuads: readonly Readonly<Quad>[];
  readonly requiredAbsentReservedSubjects: readonly string[];
}

export interface SystemRecordPresentSnapshotV1 {
  readonly state: 'present';
  readonly appliedState: SystemRecordAppliedStatePresentV1;
  /** Storage-local frontier kept outside the frozen B1 applied-state object. */
  readonly headVersion: string;
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly rootClaimSet: SystemRecordRootClaimSetV1;
  readonly capacityState: SystemRecordCapacityStateV1;
  readonly receipt: SystemRecordMaterializationReceiptV1;
  /** Current durable epoch read from the global epoch row. */
  readonly materializationEpoch: string;
  /** Epoch bound by the exact persisted applied-state/receipt tuple. */
  readonly appliedTupleEpoch: string;
  readonly previousReservedQuads: readonly Readonly<Quad>[];
  readonly expectedRootClaimQuads: readonly Readonly<Quad>[];
  readonly requiredAbsentReservedSubjects: readonly string[];
}

export type SystemRecordAppliedSnapshotV1 =
  | SystemRecordAbsentSnapshotV1
  | SystemRecordPresentSnapshotV1;

const AUTHENTIC_APPLIED_SNAPSHOTS = new WeakSet<object>();

/**
 * Decode the first exact reserved-state read. The result is accepted only when
 * it is byte-for-byte the fixed RDF encoding of one canonical object tuple.
 */
export function decodeSystemRecordAppliedSnapshotV1(input: {
  readonly networkId: string;
  readonly stableKeyHash: string;
  readonly materializationEpoch: string;
  readonly quads: readonly Readonly<Quad>[];
}): SystemRecordAppliedSnapshotV1 {
  const owned = snapshotDecoderInput(input);
  assertNetworkIdV1(owned.networkId);
  assertCanonicalDigest(owned.stableKeyHash);
  assertCanonicalU64(owned.materializationEpoch, 'expected materialization epoch');
  const networkId = owned.networkId as NetworkIdV1;
  const stableKeyHash = owned.stableKeyHash as Digest32V1;
  const recordSubject = systemRecordRecordSubjectV1(networkId, stableKeyHash);
  const capacitySubject = systemRecordCapacitySubjectV1(networkId);
  const epochSubject = systemRecordEpochSubjectV1(networkId);
  const receiptSubject = systemRecordReceiptSubjectV1(networkId, stableKeyHash);
  const allowedSubjects = new Set([recordSubject, capacitySubject, epochSubject, receiptSubject]);
  const quads = snapshotQuads(owned.quads, allowedSubjects);
  const grouped = groupBySubject(quads);
  const recordRows = grouped.get(recordSubject) ?? [];
  const capacityRows = grouped.get(capacitySubject) ?? [];
  const epochRows = grouped.get(epochSubject) ?? [];
  const receiptRows = grouped.get(receiptSubject) ?? [];

  const epoch = exactPlainValue(
    epochRows,
    SYSTEM_RECORD_V1_PREDICATES.materializationEpoch,
    'materialization epoch',
  );
  assertCanonicalU64(epoch, 'materialization epoch');
  if (epoch !== owned.materializationEpoch) {
    throw new Error('system-record materialization epoch changed during inspection');
  }
  const canonicalEpochRows = buildSystemRecordMaterializationEpochQuadsV1(networkId, epoch);

  const decodedCapacity = decodeCapacityState(networkId, capacityRows);

  if (recordRows.length === 0) {
    if (receiptRows.length !== 0) {
      throw new Error('absent system-record state retained receipt rows');
    }
    const expectedFirstRead = Object.freeze([
      ...capacityRows,
      ...canonicalEpochRows,
    ]);
    assertExactQuadSet(quads, expectedFirstRead, 'absent reserved state');
    return markAuthenticSnapshot(Object.freeze({
      state: 'absent',
      appliedState: systemRecordAppliedStateAbsentV1(),
      capacityState: decodedCapacity.state,
      materializationEpoch: epoch,
      previousReservedQuads: expectedFirstRead,
      requiredAbsentReservedSubjects: canonicalSortedSubjects([
        recordSubject,
        ...(decodedCapacity.persisted ? [] : [capacitySubject]),
        receiptSubject,
      ]),
    }));
  }

  const appliedState = parseCanonicalSystemRecordAppliedStateV1(exactJsonValue(
    recordRows,
    SYSTEM_RECORD_V1_PREDICATES.appliedState,
    'applied state',
  ));
  if (appliedState.state !== 'present') {
    throw new Error('persisted system-record state cannot encode the absent sentinel');
  }
  const headVersion = exactPlainValue(
    recordRows,
    SYSTEM_RECORD_V1_PREDICATES.headVersion,
    'head version',
  );
  assertCanonicalU64(headVersion, 'head version');
  const table = parseCanonicalOwnedSubjectTableObjectV1(
    appliedState.currentRoot,
    exactJsonValue(recordRows, SYSTEM_RECORD_V1_PREDICATES.ownedSubjectTable, 'owned table'),
  );
  const claims = parseCanonicalSystemRecordRootClaimSetV1(exactJsonValue(
    recordRows,
    SYSTEM_RECORD_V1_PREDICATES.rootClaimSet,
    'root claim set',
  ));
  if (!decodedCapacity.persisted) {
    throw new Error('present system-record state requires the global capacity tuple');
  }
  const capacity = decodedCapacity.state;
  const receipt = parseCanonicalSystemRecordMaterializationReceiptV1(exactJsonValue(
    receiptRows,
    SYSTEM_RECORD_V1_PREDICATES.receipt,
    'materialization receipt',
  ));

  const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(appliedState);
  const digests = [
    [recordRows, SYSTEM_RECORD_V1_PREDICATES.appliedStateDigest,
      appliedStateDigest, 'applied-state digest'],
    [recordRows, SYSTEM_RECORD_V1_PREDICATES.ownedSubjectTableDigest,
      appliedState.ownedSubjectTableDigest, 'owned-table digest'],
    [recordRows, SYSTEM_RECORD_V1_PREDICATES.rootClaimSetDigest,
      computeSystemRecordRootClaimSetDigestV1(claims), 'root-claim digest'],
    [capacityRows, SYSTEM_RECORD_V1_PREDICATES.capacityStateDigest,
      computeSystemRecordCapacityStateDigestV1(capacity), 'capacity digest'],
    [receiptRows, SYSTEM_RECORD_V1_PREDICATES.receiptDigest,
      computeSystemRecordMaterializationReceiptDigestV1(receipt), 'receipt digest'],
  ] as const;
  for (const [rows, predicate, expected, label] of digests) {
    if (exactPlainValue(rows, predicate, label) !== expected) {
      throw new Error(`${label} does not match its canonical object`);
    }
  }
  if (appliedState.networkId !== networkId || appliedState.stableKeyHash !== stableKeyHash
      || claims.networkId !== networkId || claims.stableKeyHash !== stableKeyHash
      || capacity.networkId !== networkId || receipt.networkId !== networkId
      || receipt.stableKeyHash !== stableKeyHash
      || receipt.materializationEpoch !== appliedState.materializationEpoch
      || receipt.stateRevision !== appliedState.stateRevision
      || receipt.appliedStateDigest !== appliedStateDigest
      || receipt.headDigest !== appliedState.headDigest
      || BigInt(appliedState.materializationEpoch) > BigInt(epoch)) {
    throw new Error('persisted system-record tuple crosses its network, key, or epoch binding');
  }
  const canonicalTableBytes = canonicalizeOwnedSubjectTableObjectV1(
    appliedState.currentRoot,
    table,
  ).byteLength;
  const persistedTableBytes = BigInt(appliedState.ownedSubjectTableBytes);
  if (BigInt(table.length) !== BigInt(appliedState.ownedSubjectCount)
      || (table.length === 0
        ? persistedTableBytes !== 0n
        : BigInt(canonicalTableBytes) !== persistedTableBytes)) {
    throw new Error('persisted owned-subject table does not match its count or byte binding');
  }
  const pendingTableBytes = 'pendingDeletionTableBytes' in appliedState
    ? BigInt(appliedState.pendingDeletionTableBytes as string)
    : 0n;
  if (BigInt(capacity.liveRecordCount) < 1n
      || BigInt(capacity.stateBytes) < BigInt(SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES)
      || BigInt(capacity.tableBytes) < persistedTableBytes + pendingTableBytes
      || BigInt(capacity.projectionBytes) < BigInt(appliedState.projectionBytes)
      || BigInt(capacity.projectionQuads) < BigInt(appliedState.projectionQuads)) {
    throw new Error('global capacity tuple does not account for the persisted record');
  }

  const canonical = buildSystemRecordReservedStateQuadsV1({
    appliedState,
    headVersion,
    ownedSubjectTable: table,
    rootClaimSet: claims,
    capacityState: capacity,
    receipt,
  });
  const expectedFirstRead = Object.freeze([
    ...canonical.record,
    ...canonical.capacity,
    ...canonicalEpochRows,
    ...canonical.receipt,
  ]);
  assertExactQuadSet(quads, expectedFirstRead, 'reserved state');
  return markAuthenticSnapshot(Object.freeze({
    state: 'present',
    appliedState,
    headVersion,
    ownedSubjectTable: table,
    rootClaimSet: claims,
    capacityState: capacity,
    receipt,
    materializationEpoch: epoch,
    appliedTupleEpoch: appliedState.materializationEpoch,
    previousReservedQuads: expectedFirstRead,
    expectedRootClaimQuads: canonical.rootClaims,
    requiredAbsentReservedSubjects: Object.freeze([]),
  }));
}

export function requiresSystemRecordSnapshotRematerializationV1(
  snapshot: SystemRecordPresentSnapshotV1,
): boolean {
  return snapshot.appliedTupleEpoch !== snapshot.materializationEpoch;
}

export function assertAuthenticSystemRecordAppliedSnapshotV1(
  value: unknown,
): asserts value is SystemRecordAppliedSnapshotV1 {
  if (value === null || typeof value !== 'object'
      || !AUTHENTIC_APPLIED_SNAPSHOTS.has(value)) {
    throw new Error('system-record applied snapshot was not produced by the exact decoder');
  }
}

export function assertSystemRecordRootClaimSnapshotV1(
  actual: readonly Readonly<Quad>[],
  expected: readonly Readonly<Quad>[],
  requiredAbsentSubjects: readonly string[] = [],
): readonly Readonly<Quad>[] {
  if (!Array.isArray(requiredAbsentSubjects) || utilTypes.isProxy(requiredAbsentSubjects)
      || requiredAbsentSubjects.length > SYSTEM_RECORD_MAX_ROOT_CLAIMS
      || requiredAbsentSubjects.some((subject) => typeof subject !== 'string' || !isSafeIri(subject))
      || new Set(requiredAbsentSubjects).size !== requiredAbsentSubjects.length) {
    throw new Error('required-absent root-claim subjects are invalid');
  }
  const expectedSubjects = new Set(expected.map((quad) => quad.subject));
  if (requiredAbsentSubjects.some((subject) => expectedSubjects.has(subject))) {
    throw new Error('one root claim cannot be expected present and absent');
  }
  const subjects = new Set([...expectedSubjects, ...requiredAbsentSubjects]);
  const snapshot = snapshotQuads(actual, subjects);
  assertExactQuadSet(snapshot, expected, 'root-claim state');
  return snapshot;
}

function decodeCapacityState(
  networkId: NetworkIdV1,
  rows: readonly Readonly<Quad>[],
): Readonly<{ readonly state: SystemRecordCapacityStateV1; readonly persisted: boolean }> {
  if (rows.length === 0) {
    return Object.freeze({ state: zeroCapacityState(networkId), persisted: false });
  }
  const state = parseCanonicalSystemRecordCapacityStateV1(exactJsonValue(
    rows,
    SYSTEM_RECORD_V1_PREDICATES.capacityState,
    'capacity state',
  ));
  const liveRecordCount = BigInt(state.liveRecordCount);
  if (BigInt(state.stateBytes)
      !== liveRecordCount * BigInt(SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES)) {
    throw new Error('private capacity state does not use the fixed per-record precharge');
  }
  if (liveRecordCount === 0n
      && (state.tableBytes !== '0' || state.projectionBytes !== '0'
        || state.projectionQuads !== '0')) {
    throw new Error('private empty capacity state has nonzero dimensions');
  }
  if (exactPlainValue(
    rows,
    SYSTEM_RECORD_V1_PREDICATES.capacityStateDigest,
    'capacity digest',
  ) !== computeSystemRecordCapacityStateDigestV1(state)) {
    throw new Error('capacity digest does not match its canonical object');
  }
  if (rows.length !== 2 || state.networkId !== networkId) {
    throw new Error('capacity tuple does not match the fixed network schema');
  }
  return Object.freeze({ state, persisted: true });
}

function zeroCapacityState(networkId: NetworkIdV1): SystemRecordCapacityStateV1 {
  return Object.freeze({
    objectType: 'system-record-capacity-state',
    kind: 'agents',
    networkId,
    revision: '0',
    liveRecordCount: '0',
    stateBytes: '0',
    tableBytes: '0',
    projectionBytes: '0',
    projectionQuads: '0',
  }) as SystemRecordCapacityStateV1;
}

function snapshotDecoderInput(value: unknown): Readonly<{
  readonly networkId: string;
  readonly stableKeyHash: string;
  readonly materializationEpoch: string;
  readonly quads: readonly Readonly<Quad>[];
}> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('system-record snapshot decoder input must be a plain data object');
  }
  const expected = ['networkId', 'stableKeyHash', 'materializationEpoch', 'quads'] as const;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length
      || keys.some((key) => typeof key !== 'string' || !expected.includes(key as typeof expected[number]))) {
    throw new Error('system-record snapshot decoder input has unknown or missing fields');
  }
  const fields = Object.create(null) as Record<typeof expected[number], unknown>;
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('system-record snapshot decoder fields must be enumerable data properties');
    }
    fields[key] = descriptor.value;
  }
  if (typeof fields.networkId !== 'string'
      || typeof fields.stableKeyHash !== 'string'
      || typeof fields.materializationEpoch !== 'string'
      || !Array.isArray(fields.quads)) {
    throw new Error('system-record snapshot decoder fields have invalid scalar types');
  }
  return Object.freeze({
    networkId: fields.networkId,
    stableKeyHash: fields.stableKeyHash,
    materializationEpoch: fields.materializationEpoch,
    quads: fields.quads as readonly Readonly<Quad>[],
  });
}

function markAuthenticSnapshot<T extends SystemRecordAppliedSnapshotV1>(value: T): T {
  AUTHENTIC_APPLIED_SNAPSHOTS.add(value);
  return value;
}

function snapshotQuads(
  value: readonly Readonly<Quad>[],
  allowedSubjects: ReadonlySet<string>,
): readonly Readonly<Quad>[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new Error('system-record reserved state exceeds its row bound');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || lengthDescriptor.enumerable || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || lengthDescriptor.value > 128) {
    throw new Error('system-record reserved state exceeds its row bound');
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) {
    throw new Error('system-record reserved state must be a dense data array');
  }
  const entries = new Array<Readonly<Quad>>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index.toString());
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('system-record reserved state must be a dense data array');
    }
    entries[index] = descriptor.value as Readonly<Quad>;
  }
  let decodedBytes = 0;
  const copied = entries.map((quad) => {
    if (quad === null || typeof quad !== 'object' || Array.isArray(quad) || utilTypes.isProxy(quad)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(quad))) {
      throw new Error('system-record reserved state contains a non-data quad');
    }
    const keys = Reflect.ownKeys(quad);
    if (keys.length !== 4 || !['subject', 'predicate', 'object', 'graph'].every((key) => keys.includes(key))) {
      throw new Error('system-record reserved state quad has unknown or missing fields');
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(quad, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error('system-record reserved state quad fields must be data properties');
      }
    }
    if (quad.graph !== SYSTEM_RECORD_V1_STATE_GRAPH || !allowedSubjects.has(quad.subject)
        || !Object.values(SYSTEM_RECORD_V1_PREDICATES).includes(
          quad.predicate as (typeof SYSTEM_RECORD_V1_PREDICATES)[keyof typeof SYSTEM_RECORD_V1_PREDICATES],
        ) || typeof quad.object !== 'string') {
      throw new Error('system-record reserved state contains an out-of-scope quad');
    }
    decodedBytes += Buffer.byteLength(quad.subject, 'utf8')
      + Buffer.byteLength(quad.predicate, 'utf8')
      + Buffer.byteLength(quad.object, 'utf8')
      + Buffer.byteLength(quad.graph, 'utf8');
    if (decodedBytes > SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES) {
      throw new Error('system-record reserved state exceeds its decoded byte bound');
    }
    return Object.freeze({ ...quad });
  });
  copied.sort(compareQuad);
  for (let index = 1; index < copied.length; index += 1) {
    if (compareQuad(copied[index - 1], copied[index]) === 0) {
      throw new Error('system-record reserved state contains a duplicate quad');
    }
  }
  return Object.freeze(copied);
}

function groupBySubject(quads: readonly Readonly<Quad>[]): ReadonlyMap<string, readonly Readonly<Quad>[]> {
  const grouped = new Map<string, Readonly<Quad>[]>();
  for (const quad of quads) {
    const rows = grouped.get(quad.subject) ?? [];
    rows.push(quad);
    grouped.set(quad.subject, rows);
  }
  return grouped;
}

function exactJsonValue(rows: readonly Readonly<Quad>[], predicate: string, label: string): string {
  const parsed = exactLiteral(rows, predicate, label);
  if (parsed.kind !== 'typed' || parsed.datatype !== SYSTEM_RECORD_V1_JSON_DATATYPE) {
    throw new Error(`${label} must use the fixed canonical-JSON datatype`);
  }
  return parsed.value;
}

function exactPlainValue(rows: readonly Readonly<Quad>[], predicate: string, label: string): string {
  const parsed = exactLiteral(rows, predicate, label);
  if (parsed.kind !== 'plain') throw new Error(`${label} must be a plain RDF literal`);
  return parsed.value;
}

function exactLiteral(rows: readonly Readonly<Quad>[], predicate: string, label: string) {
  const matches = rows.filter((quad) => quad.predicate === predicate);
  if (matches.length !== 1) throw new Error(`${label} must have exactly one reserved row`);
  const parsed = parseRdfLiteralTerm(matches[0].object);
  if (parsed === null) throw new Error(`${label} is not a canonical RDF literal`);
  return parsed;
}

function assertExactQuadSet(
  actual: readonly Readonly<Quad>[],
  expected: readonly Readonly<Quad>[],
  label: string,
): void {
  const left = [...actual].sort(compareQuad);
  const right = [...expected].sort(compareQuad);
  if (left.length !== right.length
      || left.some((quad, index) => compareQuad(quad, right[index]) !== 0)) {
    throw new Error(`${label} does not match the fixed canonical RDF schema`);
  }
}

function assertCanonicalU64(value: string, label: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20
      || BigInt(value) > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${label} must be a canonical decimal u64`);
  }
}

function canonicalSortedSubjects(subjects: readonly string[]): readonly string[] {
  return Object.freeze([...subjects].sort((left, right) => Buffer.compare(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8'),
  )));
}

function compareQuad(left: Readonly<Quad>, right: Readonly<Quad>): number {
  return left.graph.localeCompare(right.graph)
    || left.subject.localeCompare(right.subject)
    || left.predicate.localeCompare(right.predicate)
    || left.object.localeCompare(right.object);
}
