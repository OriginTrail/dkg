/**
 * Live Blazegraph oracle for the dormant RFC-64 semantic read gateway.
 * CI's tornado-blazegraph lane supplies BLAZEGRAPH_TEST_URL; ordinary local
 * runs skip this without weakening the embedded-Oxigraph and HTTP-adapter unit
 * conformance in rfc64-semantic-read-gateway.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  projectRfc64SemanticRecordStoreRowsV1,
  renderRfc64SemanticStoreRowV1,
  type ChainIdV1,
  type ContextGraphIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type Rfc64SemanticReadQueryIdV1,
  type Rfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticRecordV1,
  type SubGraphNameV1,
} from '@origintrail-official/dkg-core';

import { BlazegraphStore, SyncSemanticStoreV1 } from '../src/index.js';

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_TEST_URL;
const NETWORK = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH = (
  `0x0123456789abcdef0123456789abcdef01234567/${Date.now()}`
) as ContextGraphIdV1;
const SUBGRAPH = 'live-blazegraph' as SubGraphNameV1;
const AUTHOR = '0x89abcdef0123456789abcdef0123456789abcdef' as EvmAddressV1;
const GOVERNANCE = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const CHAIN = '20430' as ChainIdV1;
const D = (byte: string): Digest32V1 => `0x${byte.repeat(64)}` as Digest32V1;
const U = (value: string): DecimalU64V1 => value as DecimalU64V1;

const CASES: readonly {
  readonly queryId: Rfc64SemanticReadQueryIdV1;
  readonly coordinate: Rfc64SemanticRecordCoordinateV1;
  readonly record: Rfc64SemanticRecordV1;
}[] = [
  {
    queryId: 'SYNC_HEAD_REF_GET_V1',
    coordinate: {
      recordType: 'CurrentAuthorCatalogRefV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
      authorAddress: AUTHOR,
    },
    record: {
      recordType: 'CurrentAuthorCatalogRefV1',
      value: {
        networkId: NETWORK,
        contextGraphId: CONTEXT_GRAPH,
        governanceChainId: CHAIN,
        governanceContractAddress: GOVERNANCE,
        ownershipTransitionDigest: null,
        subGraphName: SUBGRAPH,
        authorAddress: AUTHOR,
        catalogEra: U('2'),
        catalogVersion: U('7'),
        catalogHeadDigest: D('a'),
      },
    },
  },
  {
    queryId: 'SYNC_RECONCILE_TARGET_GET_V1',
    coordinate: {
      recordType: 'SubgraphReconcileTargetGuardV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
    },
    record: {
      recordType: 'SubgraphReconcileTargetGuardV1',
      value: {
        networkId: NETWORK,
        contextGraphId: CONTEXT_GRAPH,
        subGraphName: SUBGRAPH,
        generation: U('14'),
        baselineSubgraphCheckpointDigest: null,
        activeTargetSubgraphCheckpointDigest: D('d'),
        pendingTargetCheckpointDigests: [D('c'), D('d')],
      },
    },
  },
  {
    queryId: 'SYNC_APPLIED_CG_SEAL_GET_V1',
    coordinate: {
      recordType: 'AppliedContextGraphSealV1',
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
    },
    record: {
      recordType: 'AppliedContextGraphSealV1',
      value: {
        networkId: NETWORK,
        contextGraphId: CONTEXT_GRAPH,
        checkpointEra: U('5'),
        checkpointVersion: U('12'),
        checkpointDigest: D('f'),
        policyDigest: D('2'),
        chainCoverageDigest: D('3'),
        mutationGeneration: U('16'),
        appliedAt: '2026-08-29T10:00:00.123Z',
      },
    },
  },
];

describe.skipIf(!BLAZEGRAPH_URL)('RFC-64 semantic read gateway (live Blazegraph)', () => {
  let store: BlazegraphStore;
  const graphs = new Set<string>();

  beforeAll(async () => {
    store = new BlazegraphStore(BLAZEGRAPH_URL as string, { timeout: 5_000 });
    for (const current of CASES) {
      const quads = projectRfc64SemanticRecordStoreRowsV1(current.record)
        .map(renderRfc64SemanticStoreRowV1);
      for (const quad of quads) graphs.add(quad.graph);
      await store.insert(quads);
    }
  }, 30_000);

  afterAll(async () => {
    if (!store) return;
    await Promise.all([...graphs].map((graph) => store.dropGraph(graph).catch(() => {})));
    await store.close();
  });

  it('round-trips null, JCS-list, datetime, digest, integer, and string terms', async () => {
    const gateway = new SyncSemanticStoreV1(store);
    for (const current of CASES) {
      const result = await gateway.read({
        coordinate: current.coordinate,
      }, { timeoutMs: 5_000 });
      expect(result.kind, current.record.recordType).toBe('record');
      if (result.kind === 'record') expect(result.decoded.record).toEqual(current.record);
    }
  }, 30_000);
});
