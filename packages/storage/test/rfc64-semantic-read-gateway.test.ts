import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
  compileRfc64SemanticReadOperationV1,
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
  type Rfc64SemanticStoreRowV1,
  type SubGraphNameV1,
} from '@origintrail-official/dkg-core';

import {
  BlazegraphStore,
  MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1,
  OxigraphStore,
  SyncSemanticStoreV1,
  type QueryOptions,
  type QueryResult,
} from '../src/index.js';

const NETWORK = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH = (
  '0x0123456789abcdef0123456789abcdef01234567/14'
) as ContextGraphIdV1;
const AUTHOR = '0x89abcdef0123456789abcdef0123456789abcdef' as EvmAddressV1;
const GOVERNANCE = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const CHAIN = '20430' as ChainIdV1;
const SUBGRAPH = 'research' as SubGraphNameV1;
const APPLIED_AT = '2026-08-29T10:00:00.123Z' as const;
const D = (byte: string): Digest32V1 => `0x${byte.repeat(64)}` as Digest32V1;
const U = (value: string): DecimalU64V1 => value as DecimalU64V1;

const FIXTURES: readonly {
  readonly queryId: Rfc64SemanticReadQueryIdV1;
  readonly coordinate: Rfc64SemanticRecordCoordinateV1;
  readonly record: Rfc64SemanticRecordV1;
}[] = [
  fixture('SYNC_HEAD_REF_GET_V1', {
    recordType: 'CurrentAuthorCatalogRefV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      governanceChainId: CHAIN,
      governanceContractAddress: GOVERNANCE,
      ownershipTransitionDigest: D('1'),
      subGraphName: SUBGRAPH,
      authorAddress: AUTHOR,
      catalogEra: U('2'),
      catalogVersion: U('7'),
      catalogHeadDigest: D('a'),
    },
  }),
  fixture('SYNC_APPLIED_SEAL_GET_V1', {
    recordType: 'AppliedSubgraphSealV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
      checkpointEra: U('3'),
      checkpointVersion: U('9'),
      checkpointDigest: D('b'),
      mutationGeneration: U('11'),
      appliedAt: APPLIED_AT,
    },
  }),
  fixture('SYNC_MUTATION_GUARD_GET_V1', {
    recordType: 'SubgraphMutationGuardV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      subGraphName: SUBGRAPH,
      generation: U('12'),
    },
  }),
  fixture('SYNC_MUTATION_GUARD_GET_V1', {
    recordType: 'ContextGraphMutationGuardV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      generation: U('13'),
    },
  }),
  fixture('SYNC_RECONCILE_TARGET_GET_V1', {
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
  }),
  fixture('SYNC_APPLIED_SET_GET_V1', {
    recordType: 'AppliedSubgraphSetRefV1',
    value: {
      networkId: NETWORK,
      contextGraphId: CONTEXT_GRAPH,
      generation: U('15'),
      subgraphIndexEra: U('4'),
      subgraphIndexVersion: U('10'),
      subgraphCount: U('6'),
      appliedDirectoryRootDigest: D('e'),
    },
  }),
  fixture('SYNC_APPLIED_CG_SEAL_GET_V1', {
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
      appliedAt: APPLIED_AT,
    },
  }),
];

describe('SyncSemanticStoreV1', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips all seven semantic records through real embedded Oxigraph', async () => {
    const store = new OxigraphStore();
    try {
      for (const current of FIXTURES) {
        const quads = projectRfc64SemanticRecordStoreRowsV1(current.record)
          .map(renderRfc64SemanticStoreRowV1);
        await store.insert(quads);
      }
      const gateway = new SyncSemanticStoreV1(store);
      expect(gateway.backend).toBe('oxigraph');
      for (const current of FIXTURES) {
        const result = await gateway.read(requestOf(current), { timeoutMs: 1_000 });
        expect(result.kind, current.record.recordType).toBe('record');
        if (result.kind === 'record') {
          expect(result.decoded.record).toEqual(current.record);
        }
      }
    } finally {
      await store.close();
    }
  });

  it('normalizes Blazegraph SPARQL JSON terms into the same exact decoded record', async () => {
    const current = FIXTURES[0];
    const rows = projectRfc64SemanticRecordStoreRowsV1(current.record);
    const requests: Array<{ body: string; signal: AbortSignal | null }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requests.push({
        body: String(init?.body ?? ''),
        signal: init?.signal instanceof AbortSignal ? init.signal : null,
      });
      return new Response(JSON.stringify({
        head: { vars: ['p', 'o'] },
        results: { bindings: rows.map(toSparqlJsonBinding) },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      });
    });
    const store = new BlazegraphStore('http://rfc64-read.test/sparql');
    const result = await new SyncSemanticStoreV1(store).read(requestOf(current), {
      timeoutMs: 1_000,
    });
    expect(result.kind).toBe('record');
    if (result.kind === 'record') expect(result.decoded.record).toEqual(current.record);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toBe(compileRfc64SemanticReadOperationV1({
      backend: 'blazegraph',
      coordinate: current.coordinate,
    }).sparql);
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('returns an explicit absent result without invoking the strict record decoder', async () => {
    const query = vi.fn(async (): Promise<QueryResult> => ({
      type: 'bindings',
      bindings: [],
    }));
    const gateway = new SyncSemanticStoreV1(certifiedStore('oxigraph', query));
    await expect(gateway.read(requestOf(FIXTURES[3]), { timeoutMs: 1_000 }))
      .resolves.toMatchObject({
      kind: 'absent',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT 4'),
      expect.objectContaining({
        source: 'rfc64.semantic.SYNC_MUTATION_GUARD_GET_V1',
        priority: 'background',
        maxResponseBytes: MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
      }),
    );
  });

  it('finds certification through decorators and rejects uncertified generic stores', async () => {
    const inner = certifiedStore('blazegraph', async () => ({
      type: 'bindings',
      bindings: [],
    }));
    const decorated = {
      innerStore: inner,
      query: inner.query,
    };
    expect(new SyncSemanticStoreV1(decorated).backend).toBe('blazegraph');
    expect(() => new SyncSemanticStoreV1({
      query: inner.query,
    })).toThrow(/no certified RFC-64 semantic read backend/u);
  });

  it('requires a bounded deadline and never dispatches after caller cancellation', async () => {
    const query = vi.fn(async (): Promise<QueryResult> => ({
      type: 'bindings',
      bindings: [],
    }));
    const gateway = new SyncSemanticStoreV1(certifiedStore('oxigraph', query));
    for (const timeoutMs of [0, -1, 1.5, MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1 + 1]) {
      await expect(gateway.read(requestOf(FIXTURES[0]), { timeoutMs })).rejects
        .toThrow(/timeoutMs must be an integer/u);
    }
    const controller = new AbortController();
    controller.abort(new Error('cancel before dispatch'));
    await expect(gateway.read(requestOf(FIXTURES[0]), {
      timeoutMs: 1_000,
      signal: controller.signal,
    })).rejects.toThrow(/cancel before dispatch/u);
    expect(query).not.toHaveBeenCalled();
  });

  it('aborts an in-flight certified read at the caller-supplied deadline', async () => {
    let observedSignal: AbortSignal | undefined;
    const query = vi.fn((_sparql: string, options?: QueryOptions) => {
      observedSignal = options?.signal;
      return new Promise<QueryResult>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const gateway = new SyncSemanticStoreV1(certifiedStore('blazegraph', query));
    await expect(gateway.read(requestOf(FIXTURES[0]), { timeoutMs: 10 })).rejects
      .toMatchObject({ name: 'TimeoutError' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('detects an elapsed deadline after a blocking pre-dispatch backend returns', async () => {
    const query = vi.fn(async (): Promise<QueryResult> => {
      const end = performance.now() + 15;
      while (performance.now() < end) {
        // Model the embedded Oxigraph call: the event loop cannot deliver the
        // timeout event until the synchronous native operation returns.
      }
      return { type: 'bindings', bindings: [] };
    });
    const gateway = new SyncSemanticStoreV1(certifiedStore('oxigraph', query));
    await expect(gateway.read(requestOf(FIXTURES[0]), { timeoutMs: 5 })).rejects
      .toMatchObject({ name: 'TimeoutError' });
  });

  it('rejects wrong result kinds, malformed terms, and row overflow', async () => {
    const current = FIXTURES[2];
    for (const result of [
      { type: 'boolean', value: false },
      {
        type: 'bindings',
        bindings: [{ p: 'urn:test:p', o: '"value"@en' }],
      },
      {
        type: 'bindings',
        bindings: Array.from({ length: 6 }, () => ({ p: 'urn:test:p', o: '"v"' })),
      },
    ] as QueryResult[]) {
      const gateway = new SyncSemanticStoreV1(certifiedStore(
        'oxigraph',
        async () => result,
      ));
      await expect(gateway.read(requestOf(current), { timeoutMs: 1_000 }))
        .rejects.toThrow();
    }
  });
});

function fixture(
  queryId: Rfc64SemanticReadQueryIdV1,
  record: Rfc64SemanticRecordV1,
): {
  readonly queryId: Rfc64SemanticReadQueryIdV1;
  readonly coordinate: Rfc64SemanticRecordCoordinateV1;
  readonly record: Rfc64SemanticRecordV1;
} {
  const common = {
    recordType: record.recordType,
    networkId: record.value.networkId,
    contextGraphId: record.value.contextGraphId,
  };
  let coordinate: Rfc64SemanticRecordCoordinateV1;
  if (record.recordType === 'CurrentAuthorCatalogRefV1') {
    coordinate = {
      ...common,
      recordType: record.recordType,
      subGraphName: record.value.subGraphName,
      authorAddress: record.value.authorAddress,
    };
  } else if (
    record.recordType === 'AppliedSubgraphSealV1'
    || record.recordType === 'SubgraphMutationGuardV1'
    || record.recordType === 'SubgraphReconcileTargetGuardV1'
  ) {
    coordinate = {
      ...common,
      recordType: record.recordType,
      subGraphName: record.value.subGraphName,
    };
  } else {
    coordinate = { ...common, recordType: record.recordType };
  }
  return Object.freeze({ queryId, coordinate: Object.freeze(coordinate), record });
}

function requestOf(current: (typeof FIXTURES)[number]) {
  return {
    coordinate: current.coordinate,
  };
}

function certifiedStore(
  backend: 'oxigraph' | 'blazegraph',
  query: (sparql: string, options?: QueryOptions) => Promise<QueryResult>,
) {
  return {
    rfc64SemanticReadBackendV1: backend,
    query,
  } as const;
}

function toSparqlJsonBinding(row: Rfc64SemanticStoreRowV1) {
  const object = row.object.kind === 'named-node'
    ? { type: 'uri', value: row.object.value }
    : {
        type: 'literal',
        value: row.object.value,
        datatype: row.object.datatypeIri,
      };
  return {
    p: { type: 'uri', value: row.predicateIri },
    o: object,
  };
}
