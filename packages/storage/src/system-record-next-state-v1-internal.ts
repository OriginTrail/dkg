import { types as utilTypes } from 'node:util';

import {
  assertCanonicalDigest,
  isSafeIri,
  MAX_DECIMAL_U64,
  parseCanonicalDecimalU64,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import {
  assertAgentProfileHeadObjectV1,
  assertAgentProfileVerifiedAuthoritySummaryV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSystemRecordAppliedStateV1,
  canonicalizeSystemRecordCapacityStateV1,
  canonicalizeSystemRecordMaterializationReceiptV1,
  canonicalizeSystemRecordRootClaimSetV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordAccountedBytesV1,
  computeSystemRecordAppliedStateDigestV1,
  computeSystemRecordMaterializationReceiptDigestV1,
  computeSystemRecordRootClaimSetDigestV1,
  computeSystemRecordStableKeyHashV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  parseCanonicalOwnedSubjectTableObjectV1,
  parseCanonicalSystemRecordAppliedStateV1,
  parseCanonicalSystemRecordCapacityStateV1,
  parseCanonicalSystemRecordMaterializationReceiptV1,
  parseCanonicalSystemRecordRootClaimSetV1,
  SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES,
  SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_QUADS,
  SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES,
  SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
  SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
  type AgentProfileAppliedTransitionV1,
  type OwnedSubjectTableObjectV1,
  type SystemRecordAppliedStatePresentV1,
  type SystemRecordCapacityStateV1,
  type SystemRecordMaterializationReceiptV1,
  type SystemRecordRootClaimSetV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { Quad } from './triple-store.js';
import {
  buildSystemRecordReservedStateQuadsV1,
  SYSTEM_RECORD_V1_PREDICATES,
  systemRecordProjectionGraphV1,
  systemRecordRecordSubjectV1,
  systemRecordRootClaimSubjectV1,
} from './system-record-rdf-schema-v1-internal.js';
import {
  assertAuthenticSystemRecordAppliedSnapshotV1,
  assertSystemRecordRootClaimSnapshotV1,
  requiresSystemRecordSnapshotRematerializationV1,
  type SystemRecordAppliedSnapshotV1,
} from './system-record-state-snapshot-v1-internal.js';
import {
  assertAuthenticSystemRecordVerifiedReplacementFactsV1,
  type SystemRecordVerifiedQuarantineReplacementFactsV1,
  type SystemRecordVerifiedReplacementFactsV1,
  type SystemRecordVerifiedTombstoneReplacementFactsV1,
} from './system-record-verified-replacement-v1-internal.js';

export type SystemRecordActiveDerivationDeferredReasonV1 =
  | 'non-active-state'
  | 'authority-fork'
  | 'authority-history-mismatch'
  | 'verified-state-mismatch'
  | 'root-state-changed';

export type SystemRecordActiveDerivationCapacityReasonV1 =
  | 'state-revision-overflow'
  | 'capacity-revision-overflow'
  | 'record-count-cap'
  | 'aggregate-cap'
  | 'subject-union-cap';

export interface SystemRecordPriorMaterializationV1 {
  readonly appliedState: SystemRecordAppliedSnapshotV1['appliedState'];
  readonly headVersion?: string;
  readonly capacityState: SystemRecordCapacityStateV1;
  readonly materializationEpoch: string;
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly pendingDeletionTable?: OwnedSubjectTableObjectV1;
  readonly rootClaimSet?: SystemRecordRootClaimSetV1;
  readonly receipt?: SystemRecordMaterializationReceiptV1;
  readonly rootClaimQuads: readonly Readonly<Quad>[];
  readonly reservedQuads: readonly Readonly<Quad>[];
  readonly requiredAbsentReservedSubjects: readonly string[];
}

export interface SystemRecordNextMaterializationV1 {
  readonly appliedState: SystemRecordAppliedStatePresentV1;
  readonly headVersion: string;
  readonly appliedStateDigest: Digest32V1;
  readonly capacityState: SystemRecordCapacityStateV1;
  readonly materializationEpoch: string;
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly pendingDeletionTable?: OwnedSubjectTableObjectV1;
  readonly rootClaimSet: SystemRecordRootClaimSetV1;
  readonly receipt: SystemRecordMaterializationReceiptV1;
  readonly receiptDigest: Digest32V1;
  readonly rootClaimQuads: readonly Readonly<Quad>[];
  readonly reservedQuads: readonly Readonly<Quad>[];
  readonly projectionQuads: readonly Readonly<Quad>[];
}

export interface SystemRecordRootClaimGuardV1 {
  readonly claimSubject: string;
  readonly recordSubject: string;
}

export interface SystemRecordMaterializationPlanV1 {
  readonly stableKeyHash: Digest32V1;
  readonly projectionGraph: string;
  /** Extra verified subjects that must be deleted but never become next projection. */
  readonly projectionDeletionTable?: OwnedSubjectTableObjectV1;
  readonly prior: SystemRecordPriorMaterializationV1;
  readonly next: SystemRecordNextMaterializationV1;
  readonly rootClaimGuards: readonly SystemRecordRootClaimGuardV1[];
  readonly success: Readonly<{
    readonly stateRevision: string;
    readonly appliedStateDigest: Digest32V1;
  }>;
}

export interface SystemRecordActiveReplacementCompleteV1<
  Outcome extends 'ready' | 'already-applied' = 'ready' | 'already-applied',
> {
  readonly outcome: Outcome;
  readonly plan: SystemRecordMaterializationPlanV1;
}

export type SystemRecordActiveReplacementReadyV1 =
  SystemRecordActiveReplacementCompleteV1<'ready'>;
export type SystemRecordActiveReplacementAlreadyAppliedV1 =
  SystemRecordActiveReplacementCompleteV1<'already-applied'>;

const AUTHENTIC_COMPLETE_DERIVATIONS = new WeakSet<object>();

export type SystemRecordActiveReplacementDerivationV1 =
  | SystemRecordActiveReplacementReadyV1
  | SystemRecordActiveReplacementAlreadyAppliedV1
  | Readonly<{ readonly outcome: 'stale' }>
  | Readonly<{
      readonly outcome: 'deferred';
      readonly reason: SystemRecordActiveDerivationDeferredReasonV1;
    }>
  | Readonly<{
      readonly outcome: 'root-collision';
      readonly claimSubjects: readonly string[];
    }>
  | Readonly<{
      readonly outcome: 'capacity-exhausted';
      readonly reason: SystemRecordActiveDerivationCapacityReasonV1;
    }>;

export type SystemRecordReplacementDerivationV1 = SystemRecordActiveReplacementDerivationV1;

/** Closed verified candidate transition; every complete variant uses the same CAS plan. */
export function deriveSystemRecordReplacementV1(input: {
  readonly facts: SystemRecordVerifiedReplacementFactsV1;
  readonly snapshot: SystemRecordAppliedSnapshotV1;
  readonly observedRootClaimQuads: readonly Readonly<Quad>[];
}): SystemRecordReplacementDerivationV1 {
  assertAuthenticSystemRecordVerifiedReplacementFactsV1(input.facts);
  if (input.facts.operation === 'tombstone') {
    return deriveSystemRecordTombstoneReplacementV1({
      facts: input.facts,
      snapshot: input.snapshot,
      observedRootClaimQuads: input.observedRootClaimQuads,
    });
  }
  const active = deriveSystemRecordActiveReplacementV1(input);
  return input.facts.operation === 'quarantine'
    ? quarantineSystemRecordDerivationV1(active, input.facts)
    : active;
}

/**
 * Pure active-only state transition. Its `ready` variant is complete: callers
 * cannot fill in graphs, CAS rows, capacity values, roots, or receipt fields.
 */
export function deriveSystemRecordActiveReplacementV1(input: {
  readonly facts: SystemRecordVerifiedReplacementFactsV1;
  readonly snapshot: SystemRecordAppliedSnapshotV1;
  readonly observedRootClaimQuads: readonly Readonly<Quad>[];
}): SystemRecordActiveReplacementDerivationV1 {
  const { facts, snapshot } = input;
  assertAuthenticSystemRecordAppliedSnapshotV1(snapshot);
  assertTrustedReplacement(facts, snapshot);
  const head = facts.head;
  const summary = facts.verifiedAuthoritySummary;
  const headDigest = computeAgentProfileHeadObjectDigestV1(head);
  const stableKeyHash = computeSystemRecordStableKeyHashV1(head.networkId, head.peerId);
  const candidateVersion = parseCanonicalDecimalU64(head.version);

  const authority = classifyAuthorityAdvance(snapshot, facts, headDigest);
  if (authority.outcome !== 'advance') return authority;

  const rootClaimSet = canonicalRootClaimSet({
    objectType: 'system-record-root-claim-set',
    kind: 'agents',
    networkId: head.networkId,
    stableKeyHash,
    currentRoot: head.rootSubject,
    historicalRoots: summary.historicalRoots,
  });
  const recordSubject = systemRecordRecordSubjectV1(head.networkId, stableKeyHash);
  const priorRootQuads = snapshot.state === 'present'
    ? snapshot.expectedRootClaimQuads
    : Object.freeze([]);
  const priorRootSubjects = new Set(priorRootQuads.map((quad) => quad.subject));
  const nextRootSubjects = [rootClaimSet.currentRoot, ...rootClaimSet.historicalRoots]
    .map((root) => systemRecordRootClaimSubjectV1(head.networkId, root));
  const requiredAbsentRootSubjects = canonicalSubjects(
    nextRootSubjects.filter((subject) => !priorRootSubjects.has(subject)),
  );
  const rootSnapshot = classifyRootSnapshot(
    input.observedRootClaimQuads,
    priorRootQuads,
    requiredAbsentRootSubjects,
    facts.networkId,
    recordSubject,
  );
  if (rootSnapshot.outcome !== 'match') return rootSnapshot;

  const nextTable = parseCanonicalOwnedSubjectTableObjectV1(
    head.rootSubject,
    canonicalizeOwnedSubjectTableObjectV1(head.rootSubject, facts.ownedSubjectTable),
  );
  const priorTable = snapshot.state === 'present'
    ? snapshot.ownedSubjectTable
    : Object.freeze([]) as OwnedSubjectTableObjectV1;

  if (authority.materialization === 'reuse') {
    if (snapshot.state !== 'present') {
      throw new Error('equal system-record head cannot exist in absent state');
    }
    if (!persistedStateMatchesVerifiedHead(
      snapshot,
      facts,
      nextTable,
      rootClaimSet,
      headDigest,
    )) {
      return Object.freeze({ outcome: 'deferred', reason: 'verified-state-mismatch' });
    }
    const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(snapshot.appliedState);
    const previousReservedQuads = Object.freeze([
      ...snapshot.previousReservedQuads,
      ...priorRootQuads,
    ]);
    const requiredAbsentReservedSubjects = canonicalSubjects([
      ...snapshot.requiredAbsentReservedSubjects,
      ...requiredAbsentRootSubjects,
    ]);
    const projectionGraph = systemRecordProjectionGraphV1(facts.mode);
    const rootClaimGuards = rootGuards(nextRootSubjects, recordSubject);
    const success = Object.freeze({
      stateRevision: snapshot.appliedState.stateRevision,
      appliedStateDigest,
    });
    const prior = Object.freeze({
      appliedState: snapshot.appliedState,
      headVersion: snapshot.headVersion,
      capacityState: snapshot.capacityState,
      materializationEpoch: snapshot.materializationEpoch,
      ownedSubjectTable: priorTable,
      rootClaimSet: snapshot.rootClaimSet,
      receipt: snapshot.receipt,
      rootClaimQuads: priorRootQuads,
      reservedQuads: previousReservedQuads,
      requiredAbsentReservedSubjects,
    });
    const next = Object.freeze({
      appliedState: snapshot.appliedState,
      headVersion: snapshot.headVersion,
      appliedStateDigest,
      capacityState: snapshot.capacityState,
      materializationEpoch: snapshot.materializationEpoch,
      ownedSubjectTable: nextTable,
      rootClaimSet: snapshot.rootClaimSet,
      receipt: snapshot.receipt,
      receiptDigest: computeSystemRecordMaterializationReceiptDigestV1(snapshot.receipt),
      rootClaimQuads: priorRootQuads,
      reservedQuads: previousReservedQuads,
      projectionQuads: facts.projectionQuads,
    });
    return markComplete(Object.freeze({
      outcome: 'already-applied',
      plan: Object.freeze({
        stableKeyHash,
        projectionGraph,
        prior,
        next,
        rootClaimGuards,
        success,
      }),
    }));
  }

  if (mergedSubjectCount(priorTable, nextTable) > SYSTEM_RECORD_MAX_OWNED_SUBJECTS) {
    return Object.freeze({ outcome: 'capacity-exhausted', reason: 'subject-union-cap' });
  }

  const nextStateRevision = incrementU64(
    snapshot.state === 'present' ? snapshot.appliedState.stateRevision : '0',
  );
  if (nextStateRevision === null) {
    return Object.freeze({ outcome: 'capacity-exhausted', reason: 'state-revision-overflow' });
  }
  const capacityRevision = incrementU64(snapshot.capacityState.revision);
  if (capacityRevision === null) {
    return Object.freeze({ outcome: 'capacity-exhausted', reason: 'capacity-revision-overflow' });
  }

  const tableBytes = canonicalizeOwnedSubjectTableObjectV1(head.rootSubject, nextTable).byteLength;
  const rootClaimSetDigest = computeSystemRecordRootClaimSetDigestV1(rootClaimSet);
  const appliedState = canonicalAppliedState({
    objectType: 'system-record-applied-state',
    state: 'present',
    kind: 'agents',
    networkId: head.networkId,
    stableKeyHash,
    peerId: head.peerId,
    stateRevision: nextStateRevision,
    status: 'active',
    headDigest,
    transitionLineage: summary.transitionLineage,
    projectionDigest: facts.projectionDigest,
    projectionBytes: head.projectionBytes,
    projectionQuads: head.projectionQuads,
    ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(head.rootSubject, nextTable),
    ownedSubjectCount: nextTable.length.toString(),
    ownedSubjectTableBytes: tableBytes.toString(),
    currentRoot: head.rootSubject,
    historicalRoots: summary.historicalRoots,
    conflictDigestSlots: snapshot.state === 'present'
      ? snapshot.appliedState.conflictDigestSlots
      : Object.freeze([]),
    conflictOverflow: snapshot.state === 'present'
      ? snapshot.appliedState.conflictOverflow
      : false,
    materializationEpoch: facts.materializationEpoch,
    rootClaimSetDigest,
    accountedBytes: computeSystemRecordAccountedBytesV1(
      tableBytes,
      Number(parseCanonicalDecimalU64(head.projectionBytes)),
    ).toString(),
  });
  const nextCapacity = deriveCapacity(
    snapshot,
    appliedState,
    tableBytes,
    capacityRevision,
  );
  if (nextCapacity.outcome !== 'capacity') return nextCapacity;

  const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(appliedState);
  const receipt = canonicalReceipt({
    objectType: 'system-record-materialization-receipt',
    kind: 'agents',
    networkId: head.networkId,
    stableKeyHash,
    stateRevision: nextStateRevision,
    appliedStateDigest,
    headDigest,
    materializationEpoch: facts.materializationEpoch,
  });
  const nextReserved = buildSystemRecordReservedStateQuadsV1({
    appliedState,
    headVersion: candidateVersion.toString(),
    ownedSubjectTable: nextTable,
    rootClaimSet,
    capacityState: nextCapacity.state,
    receipt,
  });
  const priorReservedQuads = Object.freeze([
    ...snapshot.previousReservedQuads,
    ...priorRootQuads,
  ]);
  const nextReservedQuads = Object.freeze([
    ...nextReserved.record,
    ...nextReserved.capacity,
    ...nextReserved.epoch,
    ...nextReserved.receipt,
    ...nextReserved.rootClaims,
  ]);
  const requiredAbsentReservedSubjects = canonicalSubjects([
    ...snapshot.requiredAbsentReservedSubjects,
    ...requiredAbsentRootSubjects,
  ]);
  const projectionGraph = systemRecordProjectionGraphV1(facts.mode);
  const rootClaimGuards = rootGuards(nextRootSubjects, recordSubject);
  const success = Object.freeze({ stateRevision: nextStateRevision, appliedStateDigest });
  const prior = Object.freeze({
    appliedState: snapshot.appliedState,
    ...(snapshot.state === 'present' ? { headVersion: snapshot.headVersion } : {}),
    capacityState: snapshot.capacityState,
    materializationEpoch: snapshot.materializationEpoch,
    ownedSubjectTable: priorTable,
    ...(snapshot.state === 'present' ? {
      rootClaimSet: snapshot.rootClaimSet,
      receipt: snapshot.receipt,
    } : {}),
    rootClaimQuads: priorRootQuads,
    reservedQuads: priorReservedQuads,
    requiredAbsentReservedSubjects,
  });
  const next = Object.freeze({
    appliedState,
    headVersion: candidateVersion.toString(),
    appliedStateDigest,
    capacityState: nextCapacity.state,
    materializationEpoch: facts.materializationEpoch,
    ownedSubjectTable: nextTable,
    rootClaimSet,
    receipt,
    receiptDigest: computeSystemRecordMaterializationReceiptDigestV1(receipt),
    rootClaimQuads: nextReserved.rootClaims,
    reservedQuads: nextReservedQuads,
    projectionQuads: facts.projectionQuads,
  });
  return markComplete(Object.freeze({
    outcome: 'ready',
    plan: Object.freeze({
      stableKeyHash,
      projectionGraph,
      prior,
      next,
      rootClaimGuards,
      success,
    }),
  }));
}

function quarantineSystemRecordDerivationV1(
  derived: SystemRecordActiveReplacementDerivationV1,
  facts: SystemRecordVerifiedQuarantineReplacementFactsV1,
): SystemRecordActiveReplacementDerivationV1 {
  if (derived.outcome !== 'ready' && derived.outcome !== 'already-applied') return derived;
  if (derived.outcome === 'already-applied'
      && derived.plan.next.appliedState.status === 'quarantined'
      && derived.plan.next.appliedState.conflictEvidenceDigest === facts.conflictEvidenceDigest) {
    return derived;
  }
  if (derived.outcome !== 'ready') {
    return Object.freeze({ outcome: 'deferred', reason: 'verified-state-mismatch' });
  }

  const currentSlots = derived.plan.next.appliedState.conflictDigestSlots;
  const terminalDigests = facts.terminalTransitionConflict
    ? facts.conflictEvidence.entries.flatMap((entry) =>
        entry.type === 'transition' ? [...entry.objectDigests] : [])
    : [];
  const allSlots = canonicalDigests([...currentSlots, ...terminalDigests]);
  const conflictOverflow = derived.plan.next.appliedState.conflictOverflow
    || allSlots.length > SYSTEM_RECORD_MAX_CONFLICT_DIGESTS;
  const conflictDigestSlots = Object.freeze(allSlots.slice(0, SYSTEM_RECORD_MAX_CONFLICT_DIGESTS));
  const appliedState = canonicalAppliedState({
    ...withoutConflictSaga(derived.plan.next.appliedState),
    status: 'quarantined',
    conflictEvidenceDigest: facts.conflictEvidenceDigest,
    conflictDigestSlots,
    conflictOverflow,
  });
  const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(appliedState);
  const receipt = canonicalReceipt({
    ...derived.plan.next.receipt,
    appliedStateDigest,
    headDigest: appliedState.headDigest,
  });
  const reserved = buildSystemRecordReservedStateQuadsV1({
    appliedState,
    headVersion: derived.plan.next.headVersion,
    ownedSubjectTable: derived.plan.next.ownedSubjectTable,
    rootClaimSet: derived.plan.next.rootClaimSet,
    capacityState: derived.plan.next.capacityState,
    receipt,
  });
  const next = Object.freeze({
    ...derived.plan.next,
    appliedState,
    appliedStateDigest,
    receipt,
    receiptDigest: computeSystemRecordMaterializationReceiptDigestV1(receipt),
    reservedQuads: Object.freeze([
      ...reserved.record,
      ...reserved.capacity,
      ...reserved.epoch,
      ...reserved.receipt,
      ...reserved.rootClaims,
    ]),
  });
  return markComplete(Object.freeze({
    outcome: 'ready',
    plan: Object.freeze({
      ...derived.plan,
      next,
      success: Object.freeze({
        stateRevision: appliedState.stateRevision,
        appliedStateDigest,
      }),
    }),
  }));
}

function deriveSystemRecordTombstoneReplacementV1(input: {
  readonly facts: SystemRecordVerifiedTombstoneReplacementFactsV1;
  readonly snapshot: SystemRecordAppliedSnapshotV1;
  readonly observedRootClaimQuads: readonly Readonly<Quad>[];
}): SystemRecordActiveReplacementDerivationV1 {
  const { facts, snapshot } = input;
  assertAuthenticSystemRecordAppliedSnapshotV1(snapshot);
  assertTrustedTombstoneReplacement(facts, snapshot);
  const { head, verifiedAuthoritySummary: summary } = facts;
  const headDigest = computeAgentProfileHeadObjectDigestV1(head);
  const stableKeyHash = computeSystemRecordStableKeyHashV1(head.networkId, head.peerId);
  const authority = classifyTombstoneAdvance(snapshot, facts, headDigest);
  if (authority.outcome !== 'advance') return authority;

  const rootClaimSet = canonicalRootClaimSet({
    objectType: 'system-record-root-claim-set',
    kind: 'agents',
    networkId: head.networkId,
    stableKeyHash,
    currentRoot: head.rootSubject,
    historicalRoots: summary.historicalRoots,
  });
  const recordSubject = systemRecordRecordSubjectV1(head.networkId, stableKeyHash);
  const priorRootQuads = snapshot.state === 'present'
    ? snapshot.expectedRootClaimQuads
    : Object.freeze([]);
  const priorRootSubjects = new Set(priorRootQuads.map((quad) => quad.subject));
  const nextRootSubjects = [rootClaimSet.currentRoot, ...rootClaimSet.historicalRoots]
    .map((root) => systemRecordRootClaimSubjectV1(head.networkId, root));
  const requiredAbsentRootSubjects = canonicalSubjects(
    nextRootSubjects.filter((subject) => !priorRootSubjects.has(subject)),
  );
  const rootSnapshot = classifyRootSnapshot(
    input.observedRootClaimQuads,
    priorRootQuads,
    requiredAbsentRootSubjects,
    facts.networkId,
    recordSubject,
  );
  if (rootSnapshot.outcome !== 'match') return rootSnapshot;

  const emptyTable = Object.freeze([]) as unknown as OwnedSubjectTableObjectV1;
  const priorTable = snapshot.state === 'present'
    ? snapshot.ownedSubjectTable
    : emptyTable;
  const pendingDeletionTable = facts.mode === 'shadow'
    ? facts.deletionOwnedSubjectTable
    : undefined;
  const pendingTableBytes = pendingDeletionTable === undefined
    ? 0
    : canonicalizeOwnedSubjectTableObjectV1(
        head.rootSubject,
        pendingDeletionTable,
      ).byteLength;
  const rootClaimSetDigest = computeSystemRecordRootClaimSetDigestV1(rootClaimSet);

  if (snapshot.state === 'present'
      && persistedStateMatchesVerifiedTombstone(
        snapshot,
        facts,
        rootClaimSetDigest,
        pendingDeletionTable,
      )) {
    const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(snapshot.appliedState);
    const reservedQuads = Object.freeze([
      ...snapshot.previousReservedQuads,
      ...priorRootQuads,
    ]);
    const requiredAbsentReservedSubjects = canonicalSubjects([
      ...snapshot.requiredAbsentReservedSubjects,
      ...requiredAbsentRootSubjects,
    ]);
    const prior = Object.freeze({
      appliedState: snapshot.appliedState,
      headVersion: snapshot.headVersion,
      capacityState: snapshot.capacityState,
      materializationEpoch: snapshot.materializationEpoch,
      ownedSubjectTable: priorTable,
      ...(snapshot.pendingDeletionTable === undefined
        ? {}
        : { pendingDeletionTable: snapshot.pendingDeletionTable }),
      rootClaimSet: snapshot.rootClaimSet,
      receipt: snapshot.receipt,
      rootClaimQuads: priorRootQuads,
      reservedQuads,
      requiredAbsentReservedSubjects,
    });
    const next = Object.freeze({
      appliedState: snapshot.appliedState,
      headVersion: snapshot.headVersion,
      appliedStateDigest,
      capacityState: snapshot.capacityState,
      materializationEpoch: snapshot.materializationEpoch,
      ownedSubjectTable: emptyTable,
      ...(snapshot.pendingDeletionTable === undefined
        ? {}
        : { pendingDeletionTable: snapshot.pendingDeletionTable }),
      rootClaimSet: snapshot.rootClaimSet,
      receipt: snapshot.receipt,
      receiptDigest: computeSystemRecordMaterializationReceiptDigestV1(snapshot.receipt),
      rootClaimQuads: priorRootQuads,
      reservedQuads,
      projectionQuads: Object.freeze([]),
    });
    return markComplete(Object.freeze({
      outcome: 'already-applied',
      plan: Object.freeze({
        stableKeyHash,
        projectionGraph: systemRecordProjectionGraphV1(facts.mode),
        projectionDeletionTable: facts.deletionOwnedSubjectTable,
        prior,
        next,
        rootClaimGuards: rootGuards(nextRootSubjects, recordSubject),
        success: Object.freeze({
          stateRevision: snapshot.appliedState.stateRevision,
          appliedStateDigest,
        }),
      }),
    }));
  }

  if (mergedSubjectCount(
    priorTable,
    facts.deletionOwnedSubjectTable,
  ) > SYSTEM_RECORD_MAX_OWNED_SUBJECTS) {
    return Object.freeze({ outcome: 'capacity-exhausted', reason: 'subject-union-cap' });
  }
  const nextStateRevision = incrementU64(
    snapshot.state === 'present' ? snapshot.appliedState.stateRevision : '0',
  );
  if (nextStateRevision === null) {
    return Object.freeze({ outcome: 'capacity-exhausted', reason: 'state-revision-overflow' });
  }
  const capacityRevision = incrementU64(snapshot.capacityState.revision);
  if (capacityRevision === null) {
    return Object.freeze({ outcome: 'capacity-exhausted', reason: 'capacity-revision-overflow' });
  }
  const deletionTableDigest = computeOwnedSubjectTableDigestV1(
    head.rootSubject,
    facts.deletionOwnedSubjectTable,
  );
  const appliedState = canonicalAppliedState({
    objectType: 'system-record-applied-state',
    state: 'present',
    kind: 'agents',
    networkId: head.networkId,
    stableKeyHash,
    peerId: head.peerId,
    stateRevision: nextStateRevision,
    status: facts.mode === 'shadow' ? 'dirty' : 'tombstone',
    headDigest,
    transitionLineage: summary.transitionLineage,
    projectionDigest: SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
    projectionBytes: '0',
    projectionQuads: '0',
    ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    ownedSubjectCount: '0',
    ownedSubjectTableBytes: '0',
    ...(pendingDeletionTable === undefined ? {} : {
      pendingDeletionTableDigest: deletionTableDigest,
      pendingDeletionSubjectCount: String(pendingDeletionTable.length),
      pendingDeletionTableBytes: String(pendingTableBytes),
    }),
    currentRoot: head.rootSubject,
    historicalRoots: summary.historicalRoots,
    conflictDigestSlots: snapshot.state === 'present'
      ? snapshot.appliedState.conflictDigestSlots
      : Object.freeze([]),
    conflictOverflow: snapshot.state === 'present'
      ? snapshot.appliedState.conflictOverflow
      : false,
    materializationEpoch: facts.materializationEpoch,
    rootClaimSetDigest,
    accountedBytes: computeSystemRecordAccountedBytesV1(0, 0, pendingTableBytes).toString(),
  });
  const nextCapacity = deriveCapacity(
    snapshot,
    appliedState,
    0,
    capacityRevision,
    pendingTableBytes,
  );
  if (nextCapacity.outcome !== 'capacity') return nextCapacity;
  const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(appliedState);
  const receipt = canonicalReceipt({
    objectType: 'system-record-materialization-receipt',
    kind: 'agents',
    networkId: head.networkId,
    stableKeyHash,
    stateRevision: nextStateRevision,
    appliedStateDigest,
    headDigest,
    materializationEpoch: facts.materializationEpoch,
  });
  const nextReserved = buildSystemRecordReservedStateQuadsV1({
    appliedState,
    headVersion: head.version,
    ownedSubjectTable: emptyTable,
    ...(pendingDeletionTable === undefined ? {} : { pendingDeletionTable }),
    rootClaimSet,
    capacityState: nextCapacity.state,
    receipt,
  });
  const priorReservedQuads = Object.freeze([
    ...snapshot.previousReservedQuads,
    ...priorRootQuads,
  ]);
  const requiredAbsentReservedSubjects = canonicalSubjects([
    ...snapshot.requiredAbsentReservedSubjects,
    ...requiredAbsentRootSubjects,
  ]);
  const prior = Object.freeze({
    appliedState: snapshot.appliedState,
    ...(snapshot.state === 'present' ? { headVersion: snapshot.headVersion } : {}),
    capacityState: snapshot.capacityState,
    materializationEpoch: snapshot.materializationEpoch,
    ownedSubjectTable: priorTable,
    ...(snapshot.state === 'present' && snapshot.pendingDeletionTable !== undefined
      ? { pendingDeletionTable: snapshot.pendingDeletionTable }
      : {}),
    ...(snapshot.state === 'present' ? {
      rootClaimSet: snapshot.rootClaimSet,
      receipt: snapshot.receipt,
    } : {}),
    rootClaimQuads: priorRootQuads,
    reservedQuads: priorReservedQuads,
    requiredAbsentReservedSubjects,
  });
  const next = Object.freeze({
    appliedState,
    headVersion: head.version,
    appliedStateDigest,
    capacityState: nextCapacity.state,
    materializationEpoch: facts.materializationEpoch,
    ownedSubjectTable: emptyTable,
    ...(pendingDeletionTable === undefined ? {} : { pendingDeletionTable }),
    rootClaimSet,
    receipt,
    receiptDigest: computeSystemRecordMaterializationReceiptDigestV1(receipt),
    rootClaimQuads: nextReserved.rootClaims,
    reservedQuads: Object.freeze([
      ...nextReserved.record,
      ...nextReserved.capacity,
      ...nextReserved.epoch,
      ...nextReserved.receipt,
      ...nextReserved.rootClaims,
    ]),
    projectionQuads: Object.freeze([]),
  });
  return markComplete(Object.freeze({
    outcome: 'ready',
    plan: Object.freeze({
      stableKeyHash,
      projectionGraph: systemRecordProjectionGraphV1(facts.mode),
      projectionDeletionTable: facts.deletionOwnedSubjectTable,
      prior,
      next,
      rootClaimGuards: rootGuards(nextRootSubjects, recordSubject),
      success: Object.freeze({ stateRevision: nextStateRevision, appliedStateDigest }),
    }),
  }));
}

/** Equal digest is necessary but not sufficient for an already-applied result. */
function persistedStateMatchesVerifiedHead(
  snapshot: Extract<SystemRecordAppliedSnapshotV1, { readonly state: 'present' }>,
  facts: SystemRecordVerifiedReplacementFactsV1,
  table: OwnedSubjectTableObjectV1,
  rootClaimSet: SystemRecordRootClaimSetV1,
  headDigest: Digest32V1,
): boolean {
  const state = snapshot.appliedState;
  const tableBytes = canonicalizeOwnedSubjectTableObjectV1(
    facts.head.rootSubject,
    table,
  ).byteLength;
  const rootClaimSetDigest = computeSystemRecordRootClaimSetDigestV1(rootClaimSet);
  const eligibleStatus = state.status === 'active'
    || (facts.operation === 'quarantine'
      && state.status === 'quarantined'
      && state.conflictEvidenceDigest === facts.conflictEvidenceDigest);
  const terminalEvidenceRetained = facts.operation !== 'quarantine'
    || !facts.terminalTransitionConflict
    || state.conflictOverflow
    || facts.conflictEvidence.entries.every((entry) => entry.type !== 'transition'
      || entry.objectDigests.every((digest) => state.conflictDigestSlots.includes(digest)));
  return eligibleStatus
    && terminalEvidenceRetained
    && state.conflictSidecarIntentOperation === undefined
    && state.headDigest === headDigest
    && String(state.transitionLineage.length) === facts.head.authoritySequence
    && snapshot.headVersion === facts.head.version
    && state.projectionDigest === facts.projectionDigest
    && state.projectionBytes === facts.head.projectionBytes
    && state.projectionQuads === facts.head.projectionQuads
    && state.ownedSubjectTableDigest === facts.head.ownedSubjectTableDigest
    && state.ownedSubjectCount === facts.head.ownedSubjectCount
    && state.ownedSubjectTableBytes === String(tableBytes)
    && state.currentRoot === facts.head.rootSubject
    && state.rootClaimSetDigest === rootClaimSetDigest
    && state.accountedBytes === String(computeSystemRecordAccountedBytesV1(
      tableBytes,
      Number(parseCanonicalDecimalU64(facts.head.projectionBytes)),
    ));
}

export function assertAuthenticSystemRecordActiveReplacementCompleteV1(
  value: unknown,
): asserts value is SystemRecordActiveReplacementCompleteV1 {
  if (value === null || typeof value !== 'object' || !AUTHENTIC_COMPLETE_DERIVATIONS.has(value)) {
    throw new Error('system-record complete derivation was not produced by the verified state derivation');
  }
}

function assertTrustedReplacement(
  facts: SystemRecordVerifiedReplacementFactsV1,
  snapshot: SystemRecordAppliedSnapshotV1,
): void {
  assertAuthenticSystemRecordVerifiedReplacementFactsV1(facts);
  assertAgentProfileHeadObjectV1(facts.head);
  assertAgentProfileVerifiedAuthoritySummaryV1(facts.verifiedAuthoritySummary);
  if (facts.head.state !== 'active'
      || (facts.operation !== 'active' && facts.operation !== 'quarantine')
      || facts.kind !== 'agents'
      || facts.networkId !== facts.head.networkId
      || facts.materializationEpoch !== snapshot.materializationEpoch
      || (facts.mode !== 'shadow' && facts.mode !== 'authoritative')) {
    throw new Error('verified active replacement crosses its materialization binding');
  }
  assertCanonicalDigest(facts.projectionDigest);
  const summary = facts.verifiedAuthoritySummary;
  const headDigest = computeAgentProfileHeadObjectDigestV1(facts.head);
  if (summary.candidateHeadDigest !== headDigest
      || BigInt(summary.transitionLineage.length) !== parseCanonicalDecimalU64(facts.head.authoritySequence)
      || summary.historicalRoots.length !== summary.transitionLineage.length
      || summary.tombstonePredecessor !== undefined
      || summary.deletionTableDigest !== undefined) {
    throw new Error('verified authority summary is incomplete or does not bind the active head');
  }
  const lastTransition = summary.transitionLineage.at(-1);
  if (facts.head.authoritySequence === '0') {
    if (facts.head.acceptedTransitionDigest !== undefined
        || summary.lastAuthorityTransitionPriorHeadDigest !== undefined) {
      throw new Error('sequence-zero active replacement retained authority-transition state');
    }
  } else if (lastTransition === undefined
      || lastTransition.transitionDigest !== facts.head.acceptedTransitionDigest
      || summary.lastAuthorityTransitionPriorHeadDigest === undefined) {
    throw new Error('nonzero active replacement lacks its latest verified transition binding');
  }
  const tableDigest = computeOwnedSubjectTableDigestV1(
    facts.head.rootSubject,
    facts.ownedSubjectTable,
  );
  if (tableDigest !== facts.head.ownedSubjectTableDigest
      || BigInt(facts.ownedSubjectTable.length) !== BigInt(facts.head.ownedSubjectCount)
      || BigInt(facts.projectionQuads.length) !== BigInt(facts.head.projectionQuads)) {
    throw new Error('verified active replacement facts no longer bind their head');
  }
}

function assertTrustedTombstoneReplacement(
  facts: SystemRecordVerifiedTombstoneReplacementFactsV1,
  snapshot: SystemRecordAppliedSnapshotV1,
): void {
  assertAuthenticSystemRecordVerifiedReplacementFactsV1(facts);
  assertAgentProfileHeadObjectV1(facts.head);
  assertAgentProfileVerifiedAuthoritySummaryV1(facts.verifiedAuthoritySummary);
  const summary = facts.verifiedAuthoritySummary;
  const predecessor = summary.tombstonePredecessor;
  if (facts.operation !== 'tombstone'
      || facts.head.state !== 'tombstone'
      || facts.networkId !== facts.head.networkId
      || facts.materializationEpoch !== snapshot.materializationEpoch
      || predecessor === undefined
      || summary.candidateHeadDigest !== computeAgentProfileHeadObjectDigestV1(facts.head)
      || summary.deletionTableDigest !== predecessor.ownedSubjectTableDigest
      || facts.head.previousHeadDigest !== computeAgentProfileHeadObjectDigestV1(predecessor)
      || facts.head.peerId !== predecessor.peerId
      || facts.head.authoritySequence !== predecessor.authoritySequence
      || facts.head.rootSubject !== predecessor.rootSubject
      || computeOwnedSubjectTableDigestV1(
        predecessor.rootSubject,
        facts.deletionOwnedSubjectTable,
      ) !== predecessor.ownedSubjectTableDigest
      || BigInt(facts.deletionOwnedSubjectTable.length)
        !== BigInt(predecessor.ownedSubjectCount)) {
    throw new Error('verified tombstone replacement facts no longer bind their predecessor');
  }
}

type TombstoneAdvance =
  | Readonly<{ readonly outcome: 'advance' }>
  | Exclude<SystemRecordActiveReplacementDerivationV1, SystemRecordActiveReplacementReadyV1>;

function classifyTombstoneAdvance(
  snapshot: SystemRecordAppliedSnapshotV1,
  facts: SystemRecordVerifiedTombstoneReplacementFactsV1,
  headDigest: Digest32V1,
): TombstoneAdvance {
  if (snapshot.state === 'absent') return Object.freeze({ outcome: 'advance' });
  const current = snapshot.appliedState;
  if (current.headDigest === headDigest) return Object.freeze({ outcome: 'advance' });
  const predecessor = facts.verifiedAuthoritySummary.tombstonePredecessor;
  if (predecessor === undefined) {
    return Object.freeze({ outcome: 'deferred', reason: 'verified-state-mismatch' });
  }
  if (current.headDigest === computeAgentProfileHeadObjectDigestV1(predecessor)
      && snapshot.headVersion === predecessor.version
      && current.peerId === predecessor.peerId
      && current.currentRoot === predecessor.rootSubject
      && sameTransitions(
        current.transitionLineage,
        facts.verifiedAuthoritySummary.transitionLineage,
      )
      && sameStrings(
        current.historicalRoots,
        facts.verifiedAuthoritySummary.historicalRoots,
      )) {
    return Object.freeze({ outcome: 'advance' });
  }
  if (BigInt(facts.head.authoritySequence) < BigInt(current.transitionLineage.length)
      || (facts.head.authoritySequence === String(current.transitionLineage.length)
        && BigInt(facts.head.version) < BigInt(snapshot.headVersion))) {
    return Object.freeze({ outcome: 'stale' });
  }
  return Object.freeze({ outcome: 'deferred', reason: 'authority-history-mismatch' });
}

function persistedStateMatchesVerifiedTombstone(
  snapshot: Extract<SystemRecordAppliedSnapshotV1, { readonly state: 'present' }>,
  facts: SystemRecordVerifiedTombstoneReplacementFactsV1,
  rootClaimSetDigest: Digest32V1,
  pendingDeletionTable: OwnedSubjectTableObjectV1 | undefined,
): boolean {
  const state = snapshot.appliedState;
  const expectedStatus = facts.mode === 'shadow' ? 'dirty' : 'tombstone';
  const pendingBytes = pendingDeletionTable === undefined
    ? undefined
    : canonicalizeOwnedSubjectTableObjectV1(
        facts.head.rootSubject,
        pendingDeletionTable,
      ).byteLength;
  return snapshot.appliedTupleEpoch === snapshot.materializationEpoch
    && state.status === expectedStatus
    && state.headDigest === computeAgentProfileHeadObjectDigestV1(facts.head)
    && snapshot.headVersion === facts.head.version
    && state.projectionDigest === SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1
    && state.projectionBytes === '0'
    && state.projectionQuads === '0'
    && state.ownedSubjectTableDigest === EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1
    && state.ownedSubjectCount === '0'
    && state.ownedSubjectTableBytes === '0'
    && snapshot.ownedSubjectTable.length === 0
    && state.rootClaimSetDigest === rootClaimSetDigest
    && state.conflictSidecarIntentOperation === undefined
    && state.conflictEvidenceDigest === undefined
    && (pendingDeletionTable === undefined
      ? state.pendingDeletionTableDigest === undefined
        && snapshot.pendingDeletionTable === undefined
      : state.pendingDeletionTableDigest === computeOwnedSubjectTableDigestV1(
          facts.head.rootSubject,
          pendingDeletionTable,
        )
        && state.pendingDeletionSubjectCount === String(pendingDeletionTable.length)
        && state.pendingDeletionTableBytes === String(pendingBytes)
        && snapshot.pendingDeletionTable !== undefined
        && sameStrings(snapshot.pendingDeletionTable, pendingDeletionTable));
}

type AuthorityAdvance =
  | Readonly<{
      readonly outcome: 'advance';
      readonly materialization: 'reuse' | 'rematerialize';
    }>
  | Exclude<SystemRecordActiveReplacementDerivationV1, SystemRecordActiveReplacementReadyV1>;

function classifyAuthorityAdvance(
  snapshot: SystemRecordAppliedSnapshotV1,
  facts: SystemRecordVerifiedReplacementFactsV1,
  headDigest: Digest32V1,
): AuthorityAdvance {
  if (snapshot.state === 'absent') {
    return Object.freeze({ outcome: 'advance', materialization: 'rematerialize' });
  }
  const current = snapshot.appliedState;
  if (current.status === 'quarantined') {
    if (facts.operation === 'active') {
      if (current.conflictDigestSlots.length > 0 || current.conflictOverflow
          || facts.head.forkResolutionDigest === undefined
          || parseCanonicalDecimalU64(facts.head.version)
            <= parseCanonicalDecimalU64(snapshot.headVersion)) {
        return Object.freeze({ outcome: 'deferred', reason: 'non-active-state' });
      }
    } else if (facts.operation !== 'quarantine') {
      return Object.freeze({ outcome: 'deferred', reason: 'non-active-state' });
    }
  } else if (current.status !== 'active') {
    return Object.freeze({ outcome: 'deferred', reason: 'non-active-state' });
  }
  const candidate = facts.head;
  const candidateSequence = parseCanonicalDecimalU64(candidate.authoritySequence);
  const currentSequence = BigInt(current.transitionLineage.length);
  if (candidateSequence < currentSequence) return Object.freeze({ outcome: 'stale' });
  if (candidateSequence > currentSequence + 1n) {
    return Object.freeze({ outcome: 'deferred', reason: 'authority-history-mismatch' });
  }
  const summary = facts.verifiedAuthoritySummary;
  const currentLineage = current.transitionLineage;
  const currentHistory = current.historicalRoots;
  if (candidateSequence === currentSequence) {
    if (!sameTransitions(summary.transitionLineage, currentLineage)
        || !sameStrings(summary.historicalRoots, currentHistory)
        || candidate.rootSubject !== current.currentRoot) {
      return Object.freeze({ outcome: 'deferred', reason: 'authority-history-mismatch' });
    }
    const candidateVersion = parseCanonicalDecimalU64(candidate.version);
    const currentVersion = parseCanonicalDecimalU64(snapshot.headVersion);
    if (candidateVersion < currentVersion) return Object.freeze({ outcome: 'stale' });
    if (candidateVersion === currentVersion) {
      return headDigest === current.headDigest
        ? Object.freeze({
            outcome: 'advance',
            materialization: requiresSystemRecordSnapshotRematerializationV1(snapshot)
              || (facts.operation === 'quarantine'
                && (current.status !== 'quarantined'
                  || current.conflictEvidenceDigest !== facts.conflictEvidenceDigest))
              ? 'rematerialize'
              : 'reuse',
          })
        : Object.freeze({ outcome: 'deferred', reason: 'authority-fork' });
    }
    return Object.freeze({ outcome: 'advance', materialization: 'rematerialize' });
  }
  const expectedHistory = [...currentHistory, current.currentRoot];
  const tail = summary.transitionLineage.at(-1);
  if (summary.transitionLineage.length !== currentLineage.length + 1
      || !sameTransitions(summary.transitionLineage.slice(0, -1), currentLineage)
      || !sameStrings(summary.historicalRoots, expectedHistory)
      || summary.lastAuthorityTransitionPriorHeadDigest !== current.headDigest
      || tail === undefined
      || tail.priorAuthoritySequence !== currentSequence.toString()
      || tail.nextAuthoritySequence !== candidate.authoritySequence
      || tail.transitionDigest !== candidate.acceptedTransitionDigest
      || candidate.rootSubject === current.currentRoot
      || currentHistory.includes(candidate.rootSubject)) {
    return Object.freeze({ outcome: 'deferred', reason: 'authority-history-mismatch' });
  }
  return Object.freeze({ outcome: 'advance', materialization: 'rematerialize' });
}

type RootSnapshotClassification =
  | Readonly<{ readonly outcome: 'match' }>
  | Extract<SystemRecordActiveReplacementDerivationV1,
      { readonly outcome: 'root-collision' | 'deferred' }>;

function classifyRootSnapshot(
  actual: readonly Readonly<Quad>[],
  expected: readonly Readonly<Quad>[],
  requiredAbsent: readonly string[],
  networkId: string,
  contenderRecordSubject: string,
): RootSnapshotClassification {
  try {
    assertSystemRecordRootClaimSnapshotV1(actual, expected, requiredAbsent);
    return Object.freeze({ outcome: 'match' });
  } catch {
    const collided = exactForeignRootClaims(
      actual,
      new Set(requiredAbsent),
      networkId,
      contenderRecordSubject,
    );
    return collided !== null && collided.length > 0
      ? Object.freeze({ outcome: 'root-collision', claimSubjects: collided })
      : Object.freeze({ outcome: 'deferred', reason: 'root-state-changed' });
  }
}

/** A random/orphan row at a claim subject is corruption, not ownership evidence. */
function exactForeignRootClaims(
  quads: readonly Readonly<Quad>[],
  candidateSubjects: ReadonlySet<string>,
  networkId: string,
  contenderRecordSubject: string,
): readonly string[] | null {
  const bySubject = new Map<string, Readonly<Quad>[]>();
  for (const quad of quads) {
    if (!candidateSubjects.has(quad.subject)) continue;
    const rows = bySubject.get(quad.subject) ?? [];
    rows.push(quad);
    bySubject.set(quad.subject, rows);
  }
  const collisions: string[] = [];
  for (const [subject, rows] of bySubject) {
    if (rows.length !== 3) return null;
    const byPredicate = new Map(rows.map((quad) => [quad.predicate, quad]));
    if (byPredicate.size !== 3) return null;
    const root = byPredicate.get(SYSTEM_RECORD_V1_PREDICATES.root);
    const owner = byPredicate.get(SYSTEM_RECORD_V1_PREDICATES.claimedBy);
    const position = byPredicate.get(SYSTEM_RECORD_V1_PREDICATES.claimPosition);
    if (!root || !owner || !position
        || !isSafeIri(root.object)
        || systemRecordRootClaimSubjectV1(networkId, root.object) !== subject
        || !isSafeIri(owner.object)
        || owner.object === contenderRecordSubject
        || !/^"(?:current|historical:(?:0|[1-9][0-9]*))"$/.test(position.object)) {
      return null;
    }
    collisions.push(subject);
  }
  return Object.freeze(collisions.sort(compareUtf8));
}

type CapacityDerivation =
  | Readonly<{ readonly outcome: 'capacity'; readonly state: SystemRecordCapacityStateV1 }>
  | Extract<SystemRecordActiveReplacementDerivationV1, { readonly outcome: 'capacity-exhausted' }>;

function deriveCapacity(
  snapshot: SystemRecordAppliedSnapshotV1,
  next: SystemRecordAppliedStatePresentV1,
  nextTableBytes: number,
  revision: string,
  nextPendingTableBytes = 0,
): CapacityDerivation {
  const current = snapshot.capacityState;
  const wasPresent = snapshot.state === 'present';
  const oldPendingTableBytes = wasPresent && 'pendingDeletionTableBytes' in snapshot.appliedState
    ? BigInt(snapshot.appliedState.pendingDeletionTableBytes as string)
    : 0n;
  const prior = {
    liveRecordCount: wasPresent ? 1n : 0n,
    stateBytes: wasPresent ? BigInt(SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES) : 0n,
    tableBytes: wasPresent
      ? BigInt(snapshot.appliedState.ownedSubjectTableBytes) + oldPendingTableBytes
      : 0n,
    projectionBytes: wasPresent ? BigInt(snapshot.appliedState.projectionBytes) : 0n,
    projectionQuads: wasPresent ? BigInt(snapshot.appliedState.projectionQuads) : 0n,
  };
  const dimensions = {
    liveRecordCount: replaceContribution(current.liveRecordCount, prior.liveRecordCount, 1n),
    stateBytes: replaceContribution(
      current.stateBytes,
      prior.stateBytes,
      BigInt(SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES),
    ),
    tableBytes: replaceContribution(
      current.tableBytes,
      prior.tableBytes,
      BigInt(nextTableBytes) + BigInt(nextPendingTableBytes),
    ),
    projectionBytes: replaceContribution(
      current.projectionBytes,
      prior.projectionBytes,
      BigInt(next.projectionBytes),
    ),
    projectionQuads: replaceContribution(
      current.projectionQuads,
      prior.projectionQuads,
      BigInt(next.projectionQuads),
    ),
  };
  if (Object.values(dimensions).some((value) => value === null)) {
    throw new Error('persisted system-record capacity underflows its current record contribution');
  }
  const values = dimensions as Record<keyof typeof dimensions, bigint>;
  if (values.liveRecordCount > BigInt(SYSTEM_RECORD_MAX_INVENTORY_RECORDS)) {
    return Object.freeze({ outcome: 'capacity-exhausted', reason: 'record-count-cap' });
  }
  if (values.stateBytes > BigInt(SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES)
      || values.tableBytes > BigInt(SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES)
      || values.projectionBytes > BigInt(SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES)
      || values.stateBytes + values.tableBytes + values.projectionBytes
        > BigInt(SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES)
      || values.projectionQuads > BigInt(SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_QUADS)) {
    return Object.freeze({ outcome: 'capacity-exhausted', reason: 'aggregate-cap' });
  }
  const state = canonicalCapacity({
    objectType: 'system-record-capacity-state',
    kind: 'agents',
    networkId: next.networkId,
    revision,
    liveRecordCount: values.liveRecordCount.toString(),
    stateBytes: values.stateBytes.toString(),
    tableBytes: values.tableBytes.toString(),
    projectionBytes: values.projectionBytes.toString(),
    projectionQuads: values.projectionQuads.toString(),
  });
  return Object.freeze({ outcome: 'capacity', state });
}

function replaceContribution(current: string, prior: bigint, next: bigint): bigint | null {
  const value = BigInt(current);
  return value < prior ? null : value - prior + next;
}

function incrementU64(value: string): string | null {
  const parsed = parseCanonicalDecimalU64(value);
  return parsed === MAX_DECIMAL_U64 ? null : (parsed + 1n).toString();
}

function mergedSubjectCount(left: readonly string[], right: readonly string[]): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let count = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (leftValue === undefined) rightIndex += 1;
    else if (rightValue === undefined) leftIndex += 1;
    else {
      const order = compareUtf8(leftValue, rightValue);
      if (order <= 0) leftIndex += 1;
      if (order >= 0) rightIndex += 1;
    }
    count += 1;
    if (count > SYSTEM_RECORD_MAX_OWNED_SUBJECTS) return count;
  }
  return count;
}

function canonicalAppliedState(value: unknown): SystemRecordAppliedStatePresentV1 {
  const parsed = parseCanonicalSystemRecordAppliedStateV1(
    canonicalizeSystemRecordAppliedStateV1(value as SystemRecordAppliedStatePresentV1),
  );
  if (parsed.state !== 'present') throw new Error('derived active state became absent');
  return parsed;
}

function canonicalRootClaimSet(value: unknown): SystemRecordRootClaimSetV1 {
  return parseCanonicalSystemRecordRootClaimSetV1(
    canonicalizeSystemRecordRootClaimSetV1(value as SystemRecordRootClaimSetV1),
  );
}

function canonicalCapacity(value: unknown): SystemRecordCapacityStateV1 {
  return parseCanonicalSystemRecordCapacityStateV1(
    canonicalizeSystemRecordCapacityStateV1(value as SystemRecordCapacityStateV1),
  );
}

function canonicalReceipt(value: unknown): SystemRecordMaterializationReceiptV1 {
  return parseCanonicalSystemRecordMaterializationReceiptV1(
    canonicalizeSystemRecordMaterializationReceiptV1(value as SystemRecordMaterializationReceiptV1),
  );
}

function rootGuards(
  claimSubjects: readonly string[],
  recordSubject: string,
): readonly SystemRecordRootClaimGuardV1[] {
  return Object.freeze(claimSubjects.map((claimSubject) => Object.freeze({
    claimSubject,
    recordSubject,
  })));
}

function markComplete<Outcome extends 'ready' | 'already-applied'>(
  value: SystemRecordActiveReplacementCompleteV1<Outcome>,
): SystemRecordActiveReplacementCompleteV1<Outcome> {
  AUTHENTIC_COMPLETE_DERIVATIONS.add(value);
  return value;
}

function canonicalSubjects(values: readonly string[]): readonly string[] {
  const unique = [...new Set(values)];
  unique.sort(compareUtf8);
  return Object.freeze(unique);
}

function presentSubjectsFrom(
  value: readonly Readonly<Quad>[],
  candidates: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return Object.freeze([]);
  const present = new Set<string>();
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object' || utilTypes.isProxy(candidate)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(candidate, 'subject');
    if (descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && typeof descriptor.value === 'string' && candidates.has(descriptor.value)) {
      present.add(descriptor.value);
    }
  }
  return canonicalSubjects([...present]);
}

function sameTransitions(
  left: readonly AgentProfileAppliedTransitionV1[],
  right: readonly AgentProfileAppliedTransitionV1[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return entry.priorAuthoritySequence === other.priorAuthoritySequence
      && entry.nextAuthoritySequence === other.nextAuthoritySequence
      && entry.transitionDigest === other.transitionDigest;
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalDigests(values: readonly Digest32V1[]): readonly Digest32V1[] {
  const unique = [...new Set(values)];
  unique.sort(compareUtf8);
  return Object.freeze(unique);
}

function withoutConflictSaga(
  state: SystemRecordAppliedStatePresentV1,
): Omit<SystemRecordAppliedStatePresentV1,
  | 'conflictEvidenceDigest'
  | 'conflictSidecarIntentOperation'
  | 'conflictSidecarIntentEvidenceDigest'
  | 'conflictSidecarIntentStateRevision'> {
  const {
    conflictEvidenceDigest: _evidence,
    conflictSidecarIntentOperation: _operation,
    conflictSidecarIntentEvidenceDigest: _intentEvidence,
    conflictSidecarIntentStateRevision: _intentRevision,
    ...rest
  } = state;
  return rest;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
