import { describe, expect, it } from 'vitest';

import {
  canonicalizeSystemRecordAppliedStateV1,
  canonicalizeSystemRecordCapacityStateV1,
  canonicalizeSystemRecordMaterializationReceiptV1,
  computeSystemRecordAccountedBytesV1,
  computeSystemRecordAppliedStateDigestV1,
  computeSystemRecordRootClaimSetDigestV1,
  parseCanonicalSystemRecordAppliedStateV1,
  parseCanonicalSystemRecordCapacityStateV1,
  parseCanonicalSystemRecordMaterializationReceiptV1,
  systemRecordAppliedStateAbsentV1,
  type SystemRecordAppliedStatePresentV1,
} from '../src/system-record-applied-state-v1.js';
import { computeSystemRecordStableKeyHashV1 } from '../src/system-record-inventory-v1.js';
import { SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES } from '../src/system-record-limits-v1.js';
import { EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1 } from '../src/system-record-objects-v1.js';

const HASH_A = `0x${'aa'.repeat(32)}` as const;
const HASH_B = `0x${'bb'.repeat(32)}` as const;
const ROOT_A = 'did:dkg:agent:0x1111111111111111111111111111111111111111';
const ROOT_B = 'did:dkg:agent:0x2222222222222222222222222222222222222222';
const PEER = '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf';
const STABLE_KEY = computeSystemRecordStableKeyHashV1('otp:20430', PEER);

describe('system-record applied-state codecs', () => {
  it('pins the absent sentinel and round-trips present state', () => {
    const absent = systemRecordAppliedStateAbsentV1();
    expect(parseCanonicalSystemRecordAppliedStateV1(
      canonicalizeSystemRecordAppliedStateV1(absent),
    )).toBe(absent);
    expect(computeSystemRecordAppliedStateDigestV1(absent)).toMatch(/^0x[0-9a-f]{64}$/);

    const present = activeState();
    const parsed = parseCanonicalSystemRecordAppliedStateV1(
      canonicalizeSystemRecordAppliedStateV1(present),
    );
    expect(parsed).toEqual(present);
  });

  it('rejects partial intent/deletion groups, nulls, duplicate roots, and over-cap slots', () => {
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(), conflictSidecarIntentOperation: 'publish',
    } as SystemRecordAppliedStatePresentV1)).toThrow(/all present/);
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(), pendingDeletionTableDigest: HASH_A,
      pendingDeletionSubjectCount: '1', pendingDeletionTableBytes: '10',
    } as SystemRecordAppliedStatePresentV1)).toThrow(/dirty/);
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(), conflictEvidenceDigest: null,
    } as unknown as SystemRecordAppliedStatePresentV1)).toThrow(/omit optional/);
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(), historicalRoots: [ROOT_A],
    })).toThrow(/duplicate/);
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(), conflictDigestSlots: Array.from({ length: 17 }, (_, index) =>
        `0x${index.toString(16).padStart(64, '0')}`),
    } as SystemRecordAppliedStatePresentV1)).toThrow(/slots/);
  });

  it('enforces tombstone zero accounting and capacity aggregate arithmetic', () => {
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(), status: 'tombstone', projectionBytes: '1', projectionQuads: '0',
      ownedSubjectCount: '0',
      accountedBytes: computeSystemRecordAccountedBytesV1(80, 1).toString(),
    })).toThrow(/canonical empty/);

    const capacity = {
      objectType: 'system-record-capacity-state', kind: 'agents', networkId: 'otp:20430',
      revision: '1', liveRecordCount: '1', stateBytes: '1024', tableBytes: '2048',
      projectionBytes: '4096', projectionQuads: '3',
    } as const;
    expect(parseCanonicalSystemRecordCapacityStateV1(
      canonicalizeSystemRecordCapacityStateV1(capacity),
    )).toEqual(capacity);
    expect(computeSystemRecordAccountedBytesV1(2048, 4096)).toBe(
      SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES + 2048 + 4096,
    );
    const exact = Number(activeState().accountedBytes);
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(),
      accountedBytes: (exact - 1).toString(),
    })).toThrow(/must equal/);
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(),
      accountedBytes: (exact + 1).toString(),
    })).toThrow(/must equal/);
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(),
      conflictDigestSlots: Array.from({ length: 16 }, (_, index) =>
        `0x${index.toString(16).padStart(64, '0')}`),
    })).not.toThrow();
  });

  it('binds a root-claim-set digest into present state', () => {
    const claims = {
      objectType: 'system-record-root-claim-set', kind: 'agents', networkId: 'otp:20430',
      stableKeyHash: STABLE_KEY, currentRoot: ROOT_A, historicalRoots: [ROOT_B],
    } as const;
    const digest = computeSystemRecordRootClaimSetDigestV1(claims);
    expect(computeSystemRecordAppliedStateDigestV1({
      ...activeState(),
      transitionLineage: [{ priorAuthoritySequence: '0', nextAuthoritySequence: '1', transitionDigest: HASH_A }],
      historicalRoots: [ROOT_B],
      rootClaimSetDigest: digest,
    })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('binds canonical peer identity, roots, lineage, and sidecar saga relations', () => {
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(), stableKeyHash: HASH_A,
    })).toThrow(/stableKeyHash/);
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(), rootClaimSetDigest: HASH_A,
    })).toThrow(/rootClaimSetDigest/);
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...activeState(), historicalRoots: [ROOT_B],
    })).toThrow(/lineage/);

    const publish = {
      ...activeState(), status: 'quarantined' as const,
      conflictSidecarIntentOperation: 'publish' as const,
      conflictSidecarIntentEvidenceDigest: HASH_A,
      conflictSidecarIntentStateRevision: '1' as const,
    };
    expect(() => canonicalizeSystemRecordAppliedStateV1(publish)).not.toThrow();
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...publish, status: 'active',
    })).toThrow(/publish\/deferred/);
    const remove = {
      ...activeState(), conflictEvidenceDigest: HASH_A,
      conflictSidecarIntentOperation: 'remove' as const,
      conflictSidecarIntentEvidenceDigest: HASH_A,
      conflictSidecarIntentStateRevision: '1' as const,
    };
    expect(() => canonicalizeSystemRecordAppliedStateV1(remove)).not.toThrow();
    expect(() => canonicalizeSystemRecordAppliedStateV1({
      ...remove, conflictSidecarIntentEvidenceDigest: HASH_B,
    })).toThrow(/retaining/);
  });

  it('round-trips terminal tombstone state and materialization receipts', () => {
    const tombstone = {
      ...activeState(), status: 'tombstone' as const,
      projectionBytes: '0' as const, projectionQuads: '0' as const,
      ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
      ownedSubjectCount: '0' as const, ownedSubjectTableBytes: '0' as const,
      accountedBytes: SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES.toString(),
    };
    expect(parseCanonicalSystemRecordAppliedStateV1(
      canonicalizeSystemRecordAppliedStateV1(tombstone),
    )).toEqual(tombstone);
    const receipt = {
      objectType: 'system-record-materialization-receipt', kind: 'agents', networkId: 'otp:20430',
      stableKeyHash: STABLE_KEY, stateRevision: '1', appliedStateDigest: HASH_A,
      headDigest: HASH_B, materializationEpoch: '2',
    } as const;
    expect(parseCanonicalSystemRecordMaterializationReceiptV1(
      canonicalizeSystemRecordMaterializationReceiptV1(receipt),
    )).toEqual(receipt);
  });
});

function activeState(): SystemRecordAppliedStatePresentV1 {
  const rootClaimSetDigest = computeSystemRecordRootClaimSetDigestV1({
    objectType: 'system-record-root-claim-set', kind: 'agents', networkId: 'otp:20430',
    stableKeyHash: STABLE_KEY, currentRoot: ROOT_A, historicalRoots: [],
  });
  return {
    objectType: 'system-record-applied-state', state: 'present', kind: 'agents',
    networkId: 'otp:20430', stableKeyHash: STABLE_KEY, peerId: PEER,
    stateRevision: '1', status: 'active', headDigest: HASH_A,
    transitionLineage: [],
    projectionDigest: HASH_B, projectionBytes: '4096', projectionQuads: '3',
    ownedSubjectTableDigest: HASH_A, ownedSubjectCount: '1', ownedSubjectTableBytes: '80',
    currentRoot: ROOT_A, historicalRoots: [], conflictDigestSlots: [],
    conflictOverflow: false, materializationEpoch: '2', rootClaimSetDigest,
    accountedBytes: computeSystemRecordAccountedBytesV1(80, 4096).toString(),
  };
}
