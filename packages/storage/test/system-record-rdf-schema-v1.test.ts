import { describe, expect, it } from 'vitest';

import {
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordAccountedBytesV1,
  computeSystemRecordAppliedStateDigestV1,
  computeSystemRecordRootClaimSetDigestV1,
  computeSystemRecordStableKeyHashV1,
  type OwnedSubjectTableObjectV1,
  type SystemRecordAppliedStatePresentV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import {
  SYSTEM_RECORD_V1_AUTHORITATIVE_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_JSON_DATATYPE,
  SYSTEM_RECORD_V1_PREDICATES,
  buildSystemRecordReservedStateQuadsV1,
  systemRecordCapacitySubjectV1,
  systemRecordEpochSubjectV1,
  systemRecordProjectionGraphV1,
  systemRecordReceiptSubjectV1,
  systemRecordRecordSubjectV1,
  systemRecordRootClaimSubjectV1,
} from '../src/system-record-rdf-schema-v1-internal.js';
import {
  SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_STATE_GRAPH,
} from '../src/internal-graph-policy.js';

const NETWORK = 'otp:20430';
const PEER = '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf';
const ROOT = 'did:dkg:agent:0x1111111111111111111111111111111111111111';
const HEAD = `0x${'aa'.repeat(32)}` as const;
const PROJECTION = `0x${'bb'.repeat(32)}` as const;
const STABLE_KEY = computeSystemRecordStableKeyHashV1(NETWORK, PEER);
const TABLE = Object.freeze([ROOT]) as OwnedSubjectTableObjectV1;

describe('system-record V1 reserved RDF schema', () => {
  it('derives fixed safe subjects and projection graphs without caller IRIs', () => {
    expect(systemRecordProjectionGraphV1('shadow')).toBe(SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH);
    expect(systemRecordProjectionGraphV1('authoritative')).toBe(
      SYSTEM_RECORD_V1_AUTHORITATIVE_AGENTS_GRAPH,
    );
    expect(() => systemRecordProjectionGraphV1('other' as never)).toThrow(/mode/);

    const values = [
      systemRecordRecordSubjectV1(NETWORK, STABLE_KEY),
      systemRecordCapacitySubjectV1(NETWORK),
      systemRecordEpochSubjectV1(NETWORK),
      systemRecordReceiptSubjectV1(NETWORK, STABLE_KEY),
      systemRecordRootClaimSubjectV1(NETWORK, ROOT),
    ];
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((value) => value.startsWith('urn:dkg:system-record-v1:'))).toBe(true);
    expect(() => systemRecordRecordSubjectV1(NETWORK, `0x${'A'.repeat(64)}`)).toThrow(/digest/);
  });

  it('encodes one mutually bound canonical state/table/claim/capacity/receipt set', () => {
    const rootClaimSet = {
      objectType: 'system-record-root-claim-set', kind: 'agents', networkId: NETWORK,
      stableKeyHash: STABLE_KEY, currentRoot: ROOT, historicalRoots: [],
    } as const;
    const appliedState = activeState(computeSystemRecordRootClaimSetDigestV1(rootClaimSet));
    const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(appliedState);
    const quads = buildSystemRecordReservedStateQuadsV1({
      appliedState,
      headVersion: '0',
      ownedSubjectTable: TABLE,
      rootClaimSet,
      capacityState: {
        objectType: 'system-record-capacity-state', kind: 'agents', networkId: NETWORK,
        revision: '1', liveRecordCount: '1', stateBytes: '65536',
        tableBytes: appliedState.ownedSubjectTableBytes,
        projectionBytes: appliedState.projectionBytes,
        projectionQuads: appliedState.projectionQuads,
      },
      receipt: {
        objectType: 'system-record-materialization-receipt', kind: 'agents', networkId: NETWORK,
        stableKeyHash: STABLE_KEY, stateRevision: '1', appliedStateDigest,
        headDigest: HEAD, materializationEpoch: '2',
      },
    });

    const all = [...quads.record, ...quads.capacity, ...quads.epoch, ...quads.receipt, ...quads.rootClaims];
    expect(all).toHaveLength(15);
    expect(all.every((quad) => quad.graph === SYSTEM_RECORD_V1_STATE_GRAPH)).toBe(true);
    expect(all.every((quad) => Object.isFrozen(quad))).toBe(true);
    expect(Object.isFrozen(quads.record)).toBe(true);
    expect(quads.record.find((quad) => quad.predicate === SYSTEM_RECORD_V1_PREDICATES.appliedState)?.object)
      .toContain(`^^<${SYSTEM_RECORD_V1_JSON_DATATYPE}>`);
    expect(quads.rootClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: systemRecordRootClaimSubjectV1(NETWORK, ROOT),
        predicate: SYSTEM_RECORD_V1_PREDICATES.claimedBy,
        object: systemRecordRecordSubjectV1(NETWORK, STABLE_KEY),
      }),
    ]));
  });

  it('fails closed when any persisted object belongs to a different materialization', () => {
    const rootClaimSet = {
      objectType: 'system-record-root-claim-set', kind: 'agents', networkId: NETWORK,
      stableKeyHash: STABLE_KEY, currentRoot: ROOT, historicalRoots: [],
    } as const;
    const appliedState = activeState(computeSystemRecordRootClaimSetDigestV1(rootClaimSet));
    expect(() => buildSystemRecordReservedStateQuadsV1({
      appliedState,
      headVersion: '0',
      ownedSubjectTable: TABLE,
      rootClaimSet,
      capacityState: {
        objectType: 'system-record-capacity-state', kind: 'agents', networkId: NETWORK,
        revision: '1', liveRecordCount: '1', stateBytes: '65536', tableBytes: '80',
        projectionBytes: '4096', projectionQuads: '3',
      },
      receipt: {
        objectType: 'system-record-materialization-receipt', kind: 'agents', networkId: NETWORK,
        stableKeyHash: STABLE_KEY, stateRevision: '1',
        appliedStateDigest: `0x${'cc'.repeat(32)}`,
        headDigest: HEAD, materializationEpoch: '2',
      },
    })).toThrow(/receipt does not bind/);

    const accessor = Object.defineProperty({}, 'appliedState', {
      enumerable: true,
      get: () => appliedState,
    });
    for (const [key, value] of Object.entries({
      headVersion: '0',
      ownedSubjectTable: TABLE,
      rootClaimSet,
      capacityState: {
        objectType: 'system-record-capacity-state', kind: 'agents', networkId: NETWORK,
        revision: '1', liveRecordCount: '1', stateBytes: '65536', tableBytes: '80',
        projectionBytes: '4096', projectionQuads: '3',
      },
      receipt: {
        objectType: 'system-record-materialization-receipt', kind: 'agents', networkId: NETWORK,
        stableKeyHash: STABLE_KEY, stateRevision: '1',
        appliedStateDigest: computeSystemRecordAppliedStateDigestV1(appliedState),
        headDigest: HEAD, materializationEpoch: '2',
      },
    })) Object.defineProperty(accessor, key, { enumerable: true, value });
    expect(() => buildSystemRecordReservedStateQuadsV1(accessor as never)).toThrow(/data properties/);
    expect(() => buildSystemRecordReservedStateQuadsV1(new Proxy(accessor, {}) as never))
      .toThrow(/plain data/);
  });
});

function activeState(rootClaimSetDigest: `0x${string}`): SystemRecordAppliedStatePresentV1 {
  const tableBytes = new TextEncoder().encode(JSON.stringify(TABLE)).byteLength;
  return {
    objectType: 'system-record-applied-state', state: 'present', kind: 'agents',
    networkId: NETWORK, stableKeyHash: STABLE_KEY, peerId: PEER,
    stateRevision: '1', status: 'active', headDigest: HEAD,
    transitionLineage: [], projectionDigest: PROJECTION,
    projectionBytes: '4096', projectionQuads: '3',
    ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(ROOT, TABLE),
    ownedSubjectCount: '1', ownedSubjectTableBytes: tableBytes.toString(),
    currentRoot: ROOT, historicalRoots: [], conflictDigestSlots: [], conflictOverflow: false,
    materializationEpoch: '2', rootClaimSetDigest,
    accountedBytes: computeSystemRecordAccountedBytesV1(tableBytes, 4096).toString(),
  };
}
