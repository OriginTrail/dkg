import {
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import {
  assertAgentRootV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  type AgentProfileAppliedTransitionV1,
} from './system-record-objects-v1.js';
import { KA_BUNDLE_PROJECTION_DIGEST_DOMAIN_V1 } from './ka-bundle-v1.js';
import {
  assertCanonicalSystemRecordPeerIdV1,
  digestSystemRecordBytesV1,
} from './system-record-codec-primitives-v1.js';
import { computeSystemRecordStableKeyHashV1 } from './system-record-inventory-v1.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES,
  SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_QUADS,
  SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES,
  SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
  SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
  SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_MAX_PROJECTION_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_QUADS,
  SYSTEM_RECORD_MAX_ROOT_CLAIMS,
  SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
  SYSTEM_RECORD_MAX_TUPLE_JSON_DEPTH,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
} from './system-record-limits-v1.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import {
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  parseCanonicalDecimalU64,
  type DecimalU64V1,
  type Digest32V1,
} from './sync-wire-scalars.js';
import {
  hasOwnDataProperty,
  snapshotDataArray,
  snapshotDataRecord,
  snapshotExactDataRecord,
} from './sync-wire-objects.js';

export interface SystemRecordAppliedStateAbsentV1 {
  readonly objectType: 'system-record-applied-state';
  readonly state: 'absent';
}

export type SystemRecordAppliedStatusV1 = 'active' | 'quarantined' | 'tombstone' | 'dirty';
export type SystemRecordConflictIntentOperationV1 = 'publish' | 'remove' | 'deferred';

export interface SystemRecordAppliedStatePresentV1 {
  readonly objectType: 'system-record-applied-state';
  readonly state: 'present';
  readonly kind: typeof SYSTEM_RECORD_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly stableKeyHash: Digest32V1;
  readonly peerId: string;
  readonly stateRevision: DecimalU64V1;
  readonly status: SystemRecordAppliedStatusV1;
  readonly headDigest: Digest32V1;
  readonly transitionLineage: readonly AgentProfileAppliedTransitionV1[];
  readonly conflictEvidenceDigest?: Digest32V1;
  readonly projectionDigest: Digest32V1;
  readonly projectionBytes: DecimalU64V1;
  readonly projectionQuads: DecimalU64V1;
  readonly ownedSubjectTableDigest: Digest32V1;
  readonly ownedSubjectCount: DecimalU64V1;
  readonly ownedSubjectTableBytes: DecimalU64V1;
  readonly conflictSidecarIntentOperation?: SystemRecordConflictIntentOperationV1;
  readonly conflictSidecarIntentEvidenceDigest?: Digest32V1;
  readonly conflictSidecarIntentStateRevision?: DecimalU64V1;
  readonly pendingDeletionTableDigest?: Digest32V1;
  readonly pendingDeletionSubjectCount?: DecimalU64V1;
  readonly pendingDeletionTableBytes?: DecimalU64V1;
  readonly currentRoot: string;
  readonly historicalRoots: readonly string[];
  readonly conflictDigestSlots: readonly Digest32V1[];
  readonly conflictOverflow: boolean;
  readonly materializationEpoch: DecimalU64V1;
  readonly rootClaimSetDigest: Digest32V1;
  readonly accountedBytes: DecimalU64V1;
}

export type SystemRecordAppliedStateV1 =
  | SystemRecordAppliedStateAbsentV1
  | SystemRecordAppliedStatePresentV1;

export interface SystemRecordRootClaimSetV1 {
  readonly objectType: 'system-record-root-claim-set';
  readonly kind: typeof SYSTEM_RECORD_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly stableKeyHash: Digest32V1;
  readonly currentRoot: string;
  readonly historicalRoots: readonly string[];
}

export interface SystemRecordCapacityStateV1 {
  readonly objectType: 'system-record-capacity-state';
  readonly kind: typeof SYSTEM_RECORD_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly revision: DecimalU64V1;
  readonly liveRecordCount: DecimalU64V1;
  readonly stateBytes: DecimalU64V1;
  readonly tableBytes: DecimalU64V1;
  readonly projectionBytes: DecimalU64V1;
  readonly projectionQuads: DecimalU64V1;
}

export interface SystemRecordMaterializationReceiptV1 {
  readonly objectType: 'system-record-materialization-receipt';
  readonly kind: typeof SYSTEM_RECORD_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly stableKeyHash: Digest32V1;
  readonly stateRevision: DecimalU64V1;
  readonly appliedStateDigest: Digest32V1;
  readonly headDigest: Digest32V1;
  readonly materializationEpoch: DecimalU64V1;
}

const ABSENT: SystemRecordAppliedStateAbsentV1 = Object.freeze({
  objectType: 'system-record-applied-state',
  state: 'absent',
});

/** Projection digest committed by every terminal state with zero projection bytes. */
export const SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1 = digestSystemRecordBytesV1(
  KA_BUNDLE_PROJECTION_DIGEST_DOMAIN_V1,
  new Uint8Array(),
);

export function systemRecordAppliedStateAbsentV1(): SystemRecordAppliedStateAbsentV1 {
  return ABSENT;
}

export function assertSystemRecordAppliedStateV1(
  value: unknown,
): asserts value is SystemRecordAppliedStateV1 {
  validateAppliedState(value);
}

export function canonicalizeSystemRecordAppliedStateV1(
  value: SystemRecordAppliedStateV1,
): Uint8Array {
  return canonicalizeJsonBytes(validateAppliedState(value) as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES,
  });
}

export function parseCanonicalSystemRecordAppliedStateV1(
  input: string | Uint8Array,
): SystemRecordAppliedStateV1 {
  return validateAppliedState(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES, maxDepth: SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
  }));
}

export function computeSystemRecordAppliedStateDigestV1(
  value: SystemRecordAppliedStateV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.appliedState,
    canonicalizeSystemRecordAppliedStateV1(value),
  );
}

function validateAppliedState(value: unknown): SystemRecordAppliedStateV1 {
  const probe = snapshotDataRecord(value, 'system-record applied state', {
    rejectNullValues: true,
  });
  if (probe.state === 'absent') {
    const absent = snapshotExactDataRecord(probe, ['objectType', 'state'], 'absent applied state');
    if (absent.objectType !== 'system-record-applied-state') throw new Error('absent applied-state tag is invalid');
    return ABSENT;
  }
  const optional = [
    'conflictEvidenceDigest',
    'conflictSidecarIntentOperation', 'conflictSidecarIntentEvidenceDigest',
    'conflictSidecarIntentStateRevision',
    'pendingDeletionTableDigest', 'pendingDeletionSubjectCount', 'pendingDeletionTableBytes',
  ].filter((key) => hasOwnDataProperty(probe, key));
  const state = snapshotExactDataRecord(
    probe,
    [
      'objectType', 'state', 'kind', 'networkId', 'stableKeyHash', 'peerId',
      'stateRevision', 'status', 'headDigest', ...optional,
      'transitionLineage',
      'projectionDigest', 'projectionBytes', 'projectionQuads',
      'ownedSubjectTableDigest', 'ownedSubjectCount', 'ownedSubjectTableBytes',
      'currentRoot', 'historicalRoots', 'conflictDigestSlots', 'conflictOverflow',
      'materializationEpoch', 'rootClaimSetDigest', 'accountedBytes',
    ],
    'present applied state',
  );
  if (state.objectType !== 'system-record-applied-state' || state.state !== 'present'
    || state.kind !== SYSTEM_RECORD_KIND_V1) {
    throw new Error('present applied-state tag is invalid');
  }
  assertNetworkIdV1(state.networkId);
  assertCanonicalDigest(state.stableKeyHash);
  assertCanonicalSystemRecordPeerIdV1(state.peerId);
  if (state.stableKeyHash !== computeSystemRecordStableKeyHashV1(
    state.networkId as NetworkIdV1,
    state.peerId as string,
  )) {
    throw new Error('applied-state stableKeyHash does not bind networkId/peerId');
  }
  assertCanonicalDecimalU64(state.stateRevision);
  if (!['active', 'quarantined', 'tombstone', 'dirty'].includes(state.status as string)) {
    throw new Error('applied-state status is invalid');
  }
  assertCanonicalDigest(state.headDigest);
  const transitionLineage = validateTransitionLineage(state.transitionLineage);
  if (hasOwnDataProperty(state, 'conflictEvidenceDigest')) {
    assertCanonicalDigest(state.conflictEvidenceDigest);
  }
  assertCanonicalDigest(state.projectionDigest);
  const projectionBytes = boundedU64(state.projectionBytes, SYSTEM_RECORD_MAX_PROJECTION_BYTES, 'projectionBytes');
  const projectionQuads = boundedU64(state.projectionQuads, SYSTEM_RECORD_MAX_PROJECTION_QUADS, 'projectionQuads');
  assertCanonicalDigest(state.ownedSubjectTableDigest);
  const ownedCount = boundedU64(state.ownedSubjectCount, SYSTEM_RECORD_MAX_OWNED_SUBJECTS, 'ownedSubjectCount');
  const ownedSubjectTableBytes = boundedU64(
    state.ownedSubjectTableBytes,
    SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'],
    'ownedSubjectTableBytes',
  );
  validateAllOrNoneGroup(state, [
    'conflictSidecarIntentOperation',
    'conflictSidecarIntentEvidenceDigest',
    'conflictSidecarIntentStateRevision',
  ], 'conflict sidecar intent');
  if (hasOwnDataProperty(state, 'conflictSidecarIntentOperation')) {
    if (!['publish', 'remove', 'deferred'].includes(state.conflictSidecarIntentOperation as string)) {
      throw new Error('conflict sidecar intent operation is invalid');
    }
    assertCanonicalDigest(state.conflictSidecarIntentEvidenceDigest);
    assertCanonicalDecimalU64(state.conflictSidecarIntentStateRevision);
    if (state.conflictSidecarIntentStateRevision !== state.stateRevision) {
      throw new Error('conflict sidecar intent must bind the authoritative state revision');
    }
    const operation = state.conflictSidecarIntentOperation;
    if (operation === 'remove') {
      if (state.status !== 'active'
        || state.conflictEvidenceDigest !== state.conflictSidecarIntentEvidenceDigest) {
        throw new Error('remove intent requires discoverable state retaining the installed evidence digest');
      }
    } else if (state.status !== 'quarantined'
      || hasOwnDataProperty(state, 'conflictEvidenceDigest')) {
      throw new Error('publish/deferred intent requires quarantine without installed evidence');
    }
  } else if (hasOwnDataProperty(state, 'conflictEvidenceDigest')
    && state.status !== 'quarantined') {
    throw new Error('installed conflict evidence requires quarantine or an active remove intent');
  }
  if (state.status === 'quarantined'
    && !hasOwnDataProperty(state, 'conflictEvidenceDigest')
    && !hasOwnDataProperty(state, 'conflictSidecarIntentOperation')) {
    throw new Error('quarantine requires installed conflict evidence or a resumable sidecar intent');
  }
  validateAllOrNoneGroup(state, [
    'pendingDeletionTableDigest', 'pendingDeletionSubjectCount', 'pendingDeletionTableBytes',
  ], 'pending deletion');
  if (hasOwnDataProperty(state, 'pendingDeletionTableDigest')) {
    if (state.status !== 'dirty') throw new Error('pending deletion is valid only on dirty shadow state');
    assertCanonicalDigest(state.pendingDeletionTableDigest);
    boundedU64(state.pendingDeletionSubjectCount, SYSTEM_RECORD_MAX_OWNED_SUBJECTS, 'pendingDeletionSubjectCount');
    boundedU64(
      state.pendingDeletionTableBytes,
      SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'],
      'pendingDeletionTableBytes',
    );
  }
  assertAgentRootV1(state.currentRoot as string);
  const historicalRoots = validateRootArray(state.historicalRoots, state.currentRoot as string);
  if (historicalRoots.length !== transitionLineage.length) {
    throw new Error('root history must match the retained authority-transition lineage');
  }
  const conflictDigestSlots = validateDigestSlots(state.conflictDigestSlots);
  if (typeof state.conflictOverflow !== 'boolean') throw new Error('conflictOverflow must be boolean');
  assertCanonicalDecimalU64(state.materializationEpoch);
  assertCanonicalDigest(state.rootClaimSetDigest);
  const expectedClaimDigest = computeSystemRecordRootClaimSetDigestV1({
    objectType: 'system-record-root-claim-set',
    kind: SYSTEM_RECORD_KIND_V1,
    networkId: state.networkId as NetworkIdV1,
    stableKeyHash: state.stableKeyHash as Digest32V1,
    currentRoot: state.currentRoot as string,
    historicalRoots,
  });
  if (state.rootClaimSetDigest !== expectedClaimDigest) {
    throw new Error('rootClaimSetDigest does not bind the applied roots and stable key');
  }
  const accountedBytes = boundedU64(
    state.accountedBytes,
    SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES,
    'accountedBytes',
  );
  const pendingBytes = hasOwnDataProperty(state, 'pendingDeletionTableBytes')
    ? parseCanonicalDecimalU64(state.pendingDeletionTableBytes)
    : 0n;
  const normalizedState = {
    ...state,
    historicalRoots,
    conflictDigestSlots,
    transitionLineage,
  } as unknown as CanonicalJsonValue;
  canonicalizeJsonBytes(normalizedState, {
    maxBytes: SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES,
  });
  const expectedAccounted = BigInt(computeSystemRecordAccountedBytesV1(
    Number(ownedSubjectTableBytes),
    Number(projectionBytes),
    Number(pendingBytes),
  ));
  if (accountedBytes !== expectedAccounted) {
    throw new Error('accountedBytes must equal the fixed state precharge plus exact persistent bytes');
  }
  if (state.status === 'tombstone' && (projectionBytes !== 0n || projectionQuads !== 0n
    || state.projectionDigest !== SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1
    || ownedCount !== 0n || state.ownedSubjectTableBytes !== '0'
    || state.ownedSubjectTableDigest !== EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1)) {
    throw new Error('tombstone applied state must commit the canonical empty projection/table');
  }
  if (state.status === 'active' && (projectionBytes === 0n || projectionQuads === 0n || ownedCount === 0n
    || ownedSubjectTableBytes === 0n
    || state.projectionDigest === SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1
    || state.ownedSubjectTableDigest === EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1)) {
    throw new Error('active applied state must commit a nonempty projection/table');
  }
  return Object.freeze(normalizedState) as unknown as SystemRecordAppliedStatePresentV1;
}

export function assertSystemRecordRootClaimSetV1(
  value: unknown,
): asserts value is SystemRecordRootClaimSetV1 {
  validateRootClaimSet(value);
}

export function canonicalizeSystemRecordRootClaimSetV1(
  value: SystemRecordRootClaimSetV1,
): Uint8Array {
  return canonicalizeJsonBytes(validateRootClaimSet(value) as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES,
  });
}

export function parseCanonicalSystemRecordRootClaimSetV1(
  input: string | Uint8Array,
): SystemRecordRootClaimSetV1 {
  return validateRootClaimSet(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES, maxDepth: SYSTEM_RECORD_MAX_FLAT_JSON_DEPTH,
  }));
}

export function computeSystemRecordRootClaimSetDigestV1(
  value: SystemRecordRootClaimSetV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.rootClaimSet,
    canonicalizeSystemRecordRootClaimSetV1(value),
  );
}

function validateRootClaimSet(value: unknown): SystemRecordRootClaimSetV1 {
  const claims = snapshotExactDataRecord(
    value,
    ['objectType', 'kind', 'networkId', 'stableKeyHash', 'currentRoot', 'historicalRoots'],
    'root claim set',
  );
  if (claims.objectType !== 'system-record-root-claim-set' || claims.kind !== SYSTEM_RECORD_KIND_V1) {
    throw new Error('root claim set tag is invalid');
  }
  assertNetworkIdV1(claims.networkId);
  assertCanonicalDigest(claims.stableKeyHash);
  assertAgentRootV1(claims.currentRoot as string);
  const historicalRoots = validateRootArray(claims.historicalRoots, claims.currentRoot as string);
  return Object.freeze({ ...claims, historicalRoots }) as unknown as SystemRecordRootClaimSetV1;
}

export function assertSystemRecordCapacityStateV1(
  value: unknown,
): asserts value is SystemRecordCapacityStateV1 {
  validateCapacityState(value);
}

export function canonicalizeSystemRecordCapacityStateV1(
  value: SystemRecordCapacityStateV1,
): Uint8Array {
  return canonicalizeJsonBytes(validateCapacityState(value) as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES,
  });
}

export function parseCanonicalSystemRecordCapacityStateV1(
  input: string | Uint8Array,
): SystemRecordCapacityStateV1 {
  return validateCapacityState(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES, maxDepth: SYSTEM_RECORD_MAX_TUPLE_JSON_DEPTH,
  }));
}

export function computeSystemRecordCapacityStateDigestV1(
  value: SystemRecordCapacityStateV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.capacityState,
    canonicalizeSystemRecordCapacityStateV1(value),
  );
}

function validateCapacityState(value: unknown): SystemRecordCapacityStateV1 {
  const state = snapshotExactDataRecord(
    value,
    [
      'objectType', 'kind', 'networkId', 'revision', 'liveRecordCount',
      'stateBytes', 'tableBytes', 'projectionBytes', 'projectionQuads',
    ],
    'system-record capacity state',
  );
  if (state.objectType !== 'system-record-capacity-state' || state.kind !== SYSTEM_RECORD_KIND_V1) {
    throw new Error('capacity-state tag is invalid');
  }
  assertNetworkIdV1(state.networkId);
  assertCanonicalDecimalU64(state.revision);
  boundedU64(state.liveRecordCount, SYSTEM_RECORD_MAX_INVENTORY_RECORDS, 'liveRecordCount');
  const stateBytes = boundedU64(state.stateBytes, SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES, 'stateBytes');
  const tableBytes = boundedU64(state.tableBytes, SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES, 'tableBytes');
  const projectionBytes = boundedU64(
    state.projectionBytes,
    SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES,
    'projectionBytes',
  );
  boundedU64(state.projectionQuads, SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_QUADS, 'projectionQuads');
  if (stateBytes + tableBytes + projectionBytes > BigInt(SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES)) {
    throw new Error('capacity-state combined bytes exceed the aggregate bound');
  }
  return Object.freeze({ ...state }) as unknown as SystemRecordCapacityStateV1;
}

export function assertSystemRecordMaterializationReceiptV1(
  value: unknown,
): asserts value is SystemRecordMaterializationReceiptV1 {
  validateReceipt(value);
}

export function canonicalizeSystemRecordMaterializationReceiptV1(
  value: SystemRecordMaterializationReceiptV1,
): Uint8Array {
  return canonicalizeJsonBytes(validateReceipt(value) as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES,
  });
}

export function parseCanonicalSystemRecordMaterializationReceiptV1(
  input: string | Uint8Array,
): SystemRecordMaterializationReceiptV1 {
  return validateReceipt(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES,
    maxDepth: SYSTEM_RECORD_MAX_TUPLE_JSON_DEPTH,
  }));
}

export function computeSystemRecordMaterializationReceiptDigestV1(
  value: SystemRecordMaterializationReceiptV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.materializationReceipt,
    canonicalizeSystemRecordMaterializationReceiptV1(value),
  );
}

function validateReceipt(value: unknown): SystemRecordMaterializationReceiptV1 {
  const receipt = snapshotExactDataRecord(
    value,
    [
      'objectType', 'kind', 'networkId', 'stableKeyHash', 'stateRevision',
      'appliedStateDigest', 'headDigest', 'materializationEpoch',
    ],
    'materialization receipt',
  );
  if (receipt.objectType !== 'system-record-materialization-receipt'
    || receipt.kind !== SYSTEM_RECORD_KIND_V1) {
    throw new Error('materialization receipt tag is invalid');
  }
  assertNetworkIdV1(receipt.networkId);
  assertCanonicalDigest(receipt.stableKeyHash);
  assertCanonicalDecimalU64(receipt.stateRevision);
  assertCanonicalDigest(receipt.appliedStateDigest);
  assertCanonicalDigest(receipt.headDigest);
  assertCanonicalDecimalU64(receipt.materializationEpoch);
  return Object.freeze({ ...receipt }) as unknown as SystemRecordMaterializationReceiptV1;
}

export function computeSystemRecordAccountedBytesV1(
  ownedSubjectTableBytes: number,
  projectionBytes: number,
  pendingDeletionTableBytes = 0,
): number {
  const values = [ownedSubjectTableBytes, projectionBytes, pendingDeletionTableBytes];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('accounted bytes must be non-negative safe integers');
  }
  const total = SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES
    + ownedSubjectTableBytes
    + projectionBytes
    + pendingDeletionTableBytes;
  if (!Number.isSafeInteger(total)) throw new Error('accounted byte sum overflows safe integer range');
  if (total > SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES) {
    throw new Error('record accounting exceeds the aggregate byte cap');
  }
  return total;
}

function validateTransitionLineage(value: unknown): readonly AgentProfileAppliedTransitionV1[] {
  const lineage = snapshotDataArray(value, 'transition lineage', {
    maxLength: Number(SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX),
  });
  let expectedPrior = 0n;
  return Object.freeze(lineage.map((candidate) => {
    const entry = snapshotExactDataRecord(
      candidate,
      ['priorAuthoritySequence', 'nextAuthoritySequence', 'transitionDigest'],
      'applied transition lineage entry',
    );
    const prior = parseCanonicalDecimalU64(entry.priorAuthoritySequence);
    const next = parseCanonicalDecimalU64(entry.nextAuthoritySequence);
    assertCanonicalDigest(entry.transitionDigest);
    if (prior !== expectedPrior || next !== prior + 1n) {
      throw new Error('transition lineage must be contiguous from authority sequence zero');
    }
    expectedPrior = next;
    return Object.freeze({ ...entry }) as unknown as AgentProfileAppliedTransitionV1;
  }));
}

function validateRootArray(value: unknown, currentRoot: string): readonly string[] {
  const values = snapshotDataArray(value, 'historical roots', {
    maxLength: SYSTEM_RECORD_MAX_ROOT_CLAIMS - 1,
  });
  const seen = new Set([currentRoot]);
  const roots = values.map((candidate) => {
    assertAgentRootV1(candidate as string);
    if (seen.has(candidate as string)) throw new Error('root claims must be duplicate-free');
    seen.add(candidate as string);
    return candidate as string;
  });
  return Object.freeze(roots);
}

function validateDigestSlots(value: unknown): readonly Digest32V1[] {
  const values = snapshotDataArray(value, 'conflict digest slots', {
    maxLength: SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
  });
  const slots = values.map((candidate, index) => {
    assertCanonicalDigest(candidate);
    if (index > 0 && (values[index - 1] as string) >= candidate) {
      throw new Error('conflict digest slots must be sorted and duplicate-free');
    }
    return candidate;
  });
  return Object.freeze(slots) as readonly Digest32V1[];
}

function validateAllOrNoneGroup(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const present = keys.filter((key) => hasOwnDataProperty(record, key)).length;
  if (present !== 0 && present !== keys.length) throw new Error(`${label} fields must be all present or all omitted`);
}

function boundedU64(value: unknown, maximum: number, label: string): bigint {
  const parsed = parseCanonicalDecimalU64(value, label);
  if (parsed > BigInt(maximum)) throw new Error(`${label} exceeds its V1 bound`);
  return parsed;
}
