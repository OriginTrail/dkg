import { describe, expect, it } from 'vitest';

import {
  canonicalizeOwnedSubjectTableObjectV1,
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordAccountedBytesV1,
  computeSystemRecordAppliedStateDigestV1,
  computeSystemRecordRootClaimSetDigestV1,
  computeSystemRecordStableKeyHashV1,
  SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES,
  type OwnedSubjectTableObjectV1,
  type SystemRecordAppliedStatePresentV1,
  type SystemRecordCapacityStateV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import {
  buildSystemRecordReservedStateQuadsV1,
  systemRecordRootClaimSubjectV1,
  SYSTEM_RECORD_V1_PREDICATES,
} from '../src/system-record-rdf-schema-v1-internal.js';
import {
  assertAuthenticSystemRecordAppliedSnapshotV1,
  assertSystemRecordRootClaimSnapshotV1,
  decodeSystemRecordAppliedSnapshotV1,
} from '../src/system-record-state-snapshot-v1-internal.js';

const NETWORK = 'otp:20430' as const;
const OTHER_NETWORK = 'base:84532' as const;
const PEER = '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf';
const ROOT = 'did:dkg:agent:0x1111111111111111111111111111111111111111';
const OTHER_ROOT = 'did:dkg:agent:0x2222222222222222222222222222222222222222';
const HEAD = `0x${'aa'.repeat(32)}` as const;
const PROJECTION = `0x${'bb'.repeat(32)}` as const;
const STABLE_KEY = computeSystemRecordStableKeyHashV1(NETWORK, PEER);
const TABLE = Object.freeze([ROOT]) as OwnedSubjectTableObjectV1;

describe('system-record reserved-state snapshot decoder', () => {
  it('decodes canonical absent state with either absent or persisted global capacity', () => {
    const canonical = tuple();
    const initial = decodeSystemRecordAppliedSnapshotV1({
      networkId: NETWORK,
      stableKeyHash: STABLE_KEY,
      materializationEpoch: '2',
      quads: canonical.epoch,
    });
    expect(initial).toMatchObject({
      state: 'absent',
      capacityState: { revision: '0', liveRecordCount: '0' },
    });
    expect(initial.requiredAbsentReservedSubjects).toHaveLength(3);
    expect(initial.requiredAbsentReservedSubjects).toEqual(
      [...initial.requiredAbsentReservedSubjects].sort(),
    );

    const occupied = decodeSystemRecordAppliedSnapshotV1({
      networkId: NETWORK,
      stableKeyHash: STABLE_KEY,
      materializationEpoch: '2',
      quads: [...canonical.capacity, ...canonical.epoch],
    });
    expect(occupied).toMatchObject({
      state: 'absent',
      capacityState: { revision: '7', liveRecordCount: '3' },
    });
    expect(occupied.requiredAbsentReservedSubjects).toHaveLength(2);
    expect(occupied.previousReservedQuads).toHaveLength(3);
    expect(Object.isFrozen(occupied.previousReservedQuads)).toBe(true);
  });

  it('decodes the one exact present tuple and retains the exact root-claim expectation', () => {
    const canonical = tuple();
    const decoded = decodeSystemRecordAppliedSnapshotV1({
      networkId: NETWORK,
      stableKeyHash: STABLE_KEY,
      materializationEpoch: '2',
      quads: [...canonical.receipt, ...canonical.record, ...canonical.epoch, ...canonical.capacity],
    });
    expect(decoded).toMatchObject({
      state: 'present',
      appliedState: { stableKeyHash: STABLE_KEY, stateRevision: '4' },
      capacityState: { revision: '7' },
      materializationEpoch: '2',
    });
    if (decoded.state !== 'present') throw new Error('expected present state');
    expect(decoded.expectedRootClaimQuads).toEqual(canonical.rootClaims);
    expect(decoded.previousReservedQuads).toHaveLength(12);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(() => assertAuthenticSystemRecordAppliedSnapshotV1(decoded)).not.toThrow();
    expect(() => assertAuthenticSystemRecordAppliedSnapshotV1({ ...decoded })).toThrow(/exact decoder/);
  });

  it('rejects missing, extra, duplicate, malformed, and mismatched-epoch rows', () => {
    const canonical = tuple();
    const all = [...canonical.record, ...canonical.capacity, ...canonical.epoch, ...canonical.receipt];
    const decode = (quads: typeof all, epoch = '2') => decodeSystemRecordAppliedSnapshotV1({
      networkId: NETWORK,
      stableKeyHash: STABLE_KEY,
      materializationEpoch: epoch,
      quads,
    });

    expect(() => decode(all.filter((quad) => quad !== canonical.receipt[0]))).toThrow(/receipt/);
    expect(() => decode([...all, { ...canonical.record[0] }])).toThrow(/duplicate/);
    let accessorCalls = 0;
    const accessorQuad = Object.defineProperty({
      predicate: canonical.record[0].predicate,
      object: canonical.record[0].object,
      graph: canonical.record[0].graph,
    }, 'subject', {
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return canonical.record[0].subject;
      },
    });
    expect(() => decode([...all.slice(1), accessorQuad] as typeof all)).toThrow(/data properties/);
    expect(accessorCalls).toBe(0);
    expect(() => decode([...all.slice(1), new Proxy(canonical.record[0], {})] as typeof all))
      .toThrow(/non-data quad/);
    let arrayAccessorCalls = 0;
    const accessorRows = [...all];
    Object.defineProperty(accessorRows, '0', {
      enumerable: true,
      get: () => {
        arrayAccessorCalls += 1;
        return all[0];
      },
    });
    expect(() => decode(accessorRows)).toThrow(/dense data array/);
    expect(arrayAccessorCalls).toBe(0);
    const sparseRows = [...all];
    delete sparseRows[0];
    expect(() => decode(sparseRows)).toThrow(/dense data array/);
    expect(() => decode([...all, {
      ...canonical.record[0],
      predicate: canonical.capacity[0].predicate,
      object: canonical.capacity[0].object,
    }])).toThrow(/fixed canonical RDF schema/);
    expect(() => decode(all.map((quad) => quad === canonical.record[0]
      ? { ...quad, object: '"not-json"^^<urn:dkg:system-record-v1:canonical-json>' }
      : quad))).toThrow();
    expect(() => decode(all, '3')).toThrow(/epoch changed/);
    expect(() => decode([...canonical.record, ...canonical.epoch, ...canonical.receipt]))
      .toThrow(/requires the global capacity/);
    expect(() => decodeSystemRecordAppliedSnapshotV1({
      networkId: NETWORK,
      stableKeyHash: STABLE_KEY,
      materializationEpoch: '2',
      quads: [canonical.capacity[0], ...canonical.epoch],
    })).toThrow(/capacity digest/);
    expect(() => decodeTuple(tuple({
      capacityState: {
        objectType: 'system-record-capacity-state',
        kind: 'agents',
        networkId: NETWORK,
        revision: '7',
        liveRecordCount: '0',
        stateBytes: '0',
        tableBytes: '0',
        projectionBytes: '0',
        projectionQuads: '0',
      },
    }))).toThrow(/does not account/);
    expect(() => decodeTuple(tuple({
      capacityState: {
        objectType: 'system-record-capacity-state',
        kind: 'agents',
        networkId: NETWORK,
        revision: '7',
        liveRecordCount: '3',
        stateBytes: '1024',
        tableBytes: '80',
        projectionBytes: '8192',
        projectionQuads: '6',
      },
    }))).toThrow(/fixed per-record precharge/);

    let outerAccessorCalls = 0;
    const accessorInput = Object.defineProperty({
      stableKeyHash: STABLE_KEY,
      materializationEpoch: '2',
      quads: all,
    }, 'networkId', {
      enumerable: true,
      get: () => {
        outerAccessorCalls += 1;
        return NETWORK;
      },
    });
    expect(() => decodeSystemRecordAppliedSnapshotV1(accessorInput as never))
      .toThrow(/data properties/);
    expect(outerAccessorCalls).toBe(0);
    expect(() => decodeSystemRecordAppliedSnapshotV1({
      networkId: NETWORK,
      stableKeyHash: STABLE_KEY,
      materializationEpoch: '2',
      quads: all,
      extra: true,
    } as never)).toThrow(/unknown or missing/);
    expect(() => decodeSystemRecordAppliedSnapshotV1(new Proxy({
      networkId: NETWORK,
      stableKeyHash: STABLE_KEY,
      materializationEpoch: '2',
      quads: all,
    }, {}) as never)).toThrow(/plain data object/);
  });

  it('enforces the decoded reserved-read byte cap at exactly one byte over', () => {
    const epoch = tuple().epoch[0];
    const paddingBase = {
      subject: epoch.subject,
      predicate: SYSTEM_RECORD_V1_PREDICATES.appliedState,
      graph: epoch.graph,
    };
    const fixedBytes = quadDecodedBytes(epoch)
      + Buffer.byteLength(paddingBase.subject, 'utf8')
      + Buffer.byteLength(paddingBase.predicate, 'utf8')
      + Buffer.byteLength(paddingBase.graph, 'utf8')
      + 2;
    const atLimit = SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES - fixedBytes;
    const decodeWithPadding = (length: number) => decodeSystemRecordAppliedSnapshotV1({
      networkId: NETWORK,
      stableKeyHash: STABLE_KEY,
      materializationEpoch: '2',
      quads: [epoch, { ...paddingBase, object: `"${'x'.repeat(length)}"` }],
    });

    expect(() => decodeWithPadding(atLimit)).toThrow(/fixed canonical RDF schema/);
    expect(() => decodeWithPadding(atLimit + 1)).toThrow(/decoded byte bound/);
  });

  it('rejects cross-network/key objects and table count or byte disagreement', () => {
    const canonical = tuple();
    expect(() => decodeSystemRecordAppliedSnapshotV1({
      networkId: OTHER_NETWORK,
      stableKeyHash: computeSystemRecordStableKeyHashV1(OTHER_NETWORK, PEER),
      materializationEpoch: '2',
      quads: [...canonical.record, ...canonical.capacity, ...canonical.epoch, ...canonical.receipt],
    })).toThrow(/out-of-scope/);
    expect(() => decodeSystemRecordAppliedSnapshotV1({
      networkId: NETWORK,
      stableKeyHash: `0x${'cc'.repeat(32)}`,
      materializationEpoch: '2',
      quads: [...canonical.record, ...canonical.capacity, ...canonical.epoch, ...canonical.receipt],
    })).toThrow(/out-of-scope/);

    const wrongCount = state({ ownedSubjectCount: '2' });
    expect(() => decodeTuple(tuple({ appliedState: wrongCount }))).toThrow(/count or byte/);

    const actualTableBytes = canonicalizeOwnedSubjectTableObjectV1(ROOT, TABLE).byteLength;
    const wrongByteCount = actualTableBytes + 1;
    const wrongBytes = state({
      ownedSubjectTableBytes: wrongByteCount.toString(),
      accountedBytes: computeSystemRecordAccountedBytesV1(wrongByteCount, 4096).toString(),
    });
    expect(() => decodeTuple(tuple({ appliedState: wrongBytes }))).toThrow(/count or byte/);
  });

  it('validates exact root claims and proves candidate roots absent in the same bounded read', () => {
    const canonical = tuple();
    const absentRoot = systemRecordRootClaimSubjectV1(NETWORK, OTHER_ROOT);
    expect(assertSystemRecordRootClaimSnapshotV1(
      canonical.rootClaims,
      canonical.rootClaims,
      [absentRoot],
    )).toEqual(expect.arrayContaining(canonical.rootClaims));
    expect(() => assertSystemRecordRootClaimSnapshotV1(
      canonical.rootClaims.slice(1),
      canonical.rootClaims,
      [absentRoot],
    )).toThrow(/root-claim state/);
    expect(() => assertSystemRecordRootClaimSnapshotV1(
      [...canonical.rootClaims, { ...canonical.rootClaims[0] }],
      canonical.rootClaims,
      [absentRoot],
    )).toThrow(/duplicate/);
    expect(() => assertSystemRecordRootClaimSnapshotV1(
      [...canonical.rootClaims, { ...canonical.rootClaims[0], subject: absentRoot }],
      canonical.rootClaims,
      [absentRoot],
    )).toThrow(/root-claim state/);
    expect(() => assertSystemRecordRootClaimSnapshotV1(
      canonical.rootClaims,
      canonical.rootClaims,
      [canonical.rootClaims[0].subject],
    )).toThrow(/present and absent/);

    const crossNetwork = systemRecordRootClaimSubjectV1(OTHER_NETWORK, OTHER_ROOT);
    expect(() => assertSystemRecordRootClaimSnapshotV1(
      [...canonical.rootClaims, { ...canonical.rootClaims[0], subject: crossNetwork }],
      canonical.rootClaims,
      [absentRoot],
    )).toThrow(/out-of-scope/);
  });
});

function decodeTuple(value: ReturnType<typeof tuple>) {
  return decodeSystemRecordAppliedSnapshotV1({
    networkId: NETWORK,
    stableKeyHash: STABLE_KEY,
    materializationEpoch: '2',
    quads: [...value.record, ...value.capacity, ...value.epoch, ...value.receipt],
  });
}

function tuple(overrides: {
  readonly appliedState?: SystemRecordAppliedStatePresentV1;
  readonly rootClaimSet?: Parameters<typeof buildSystemRecordReservedStateQuadsV1>[0]['rootClaimSet'];
  readonly capacityState?: SystemRecordCapacityStateV1;
} = {}) {
  const rootClaimSet = overrides.rootClaimSet ?? {
    objectType: 'system-record-root-claim-set',
    kind: 'agents',
    networkId: NETWORK,
    stableKeyHash: STABLE_KEY,
    currentRoot: ROOT,
    historicalRoots: [],
  } as const;
  const appliedState = overrides.appliedState ?? state({
    rootClaimSetDigest: computeSystemRecordRootClaimSetDigestV1(rootClaimSet),
  });
  const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(appliedState);
  return buildSystemRecordReservedStateQuadsV1({
    appliedState,
    headVersion: '0',
    ownedSubjectTable: TABLE,
    rootClaimSet,
    capacityState: overrides.capacityState ?? {
      objectType: 'system-record-capacity-state',
      kind: 'agents',
      networkId: NETWORK,
      revision: '7',
      liveRecordCount: '3',
      stateBytes: (3 * 65_536).toString(),
      tableBytes: '80',
      projectionBytes: '8192',
      projectionQuads: '6',
    },
    receipt: {
      objectType: 'system-record-materialization-receipt',
      kind: 'agents',
      networkId: NETWORK,
      stableKeyHash: STABLE_KEY,
      stateRevision: appliedState.stateRevision,
      appliedStateDigest,
      headDigest: appliedState.headDigest,
      materializationEpoch: appliedState.materializationEpoch,
    },
  });
}

function state(
  overrides: Partial<SystemRecordAppliedStatePresentV1> = {},
): SystemRecordAppliedStatePresentV1 {
  const tableBytes = canonicalizeOwnedSubjectTableObjectV1(ROOT, TABLE).byteLength;
  const claims = {
    objectType: 'system-record-root-claim-set',
    kind: 'agents',
    networkId: NETWORK,
    stableKeyHash: STABLE_KEY,
    currentRoot: ROOT,
    historicalRoots: [],
  } as const;
  return {
    objectType: 'system-record-applied-state',
    state: 'present',
    kind: 'agents',
    networkId: NETWORK,
    stableKeyHash: STABLE_KEY,
    peerId: PEER,
    stateRevision: '4',
    status: 'active',
    headDigest: HEAD,
    transitionLineage: [],
    projectionDigest: PROJECTION,
    projectionBytes: '4096',
    projectionQuads: '3',
    ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(ROOT, TABLE),
    ownedSubjectCount: '1',
    ownedSubjectTableBytes: tableBytes.toString(),
    currentRoot: ROOT,
    historicalRoots: [],
    conflictDigestSlots: [],
    conflictOverflow: false,
    materializationEpoch: '2',
    rootClaimSetDigest: computeSystemRecordRootClaimSetDigestV1(claims),
    accountedBytes: computeSystemRecordAccountedBytesV1(tableBytes, 4096).toString(),
    ...overrides,
  } as SystemRecordAppliedStatePresentV1;
}

function quadDecodedBytes(
  quad: Readonly<{ subject: string; predicate: string; object: string; graph: string }>,
): number {
  return Buffer.byteLength(quad.subject, 'utf8')
    + Buffer.byteLength(quad.predicate, 'utf8')
    + Buffer.byteLength(quad.object, 'utf8')
    + Buffer.byteLength(quad.graph, 'utf8');
}
