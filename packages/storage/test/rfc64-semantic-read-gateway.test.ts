import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
  Rfc64SemanticReadManifestErrorV1,
  compileRfc64SemanticReadOperationV2,
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
  executeRfc64ExactBindingsReadCapabilityV1,
  MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1,
  OxigraphStore,
  OxigraphWorkerStore,
  Rfc64SemanticReadCapabilityResultErrorV1,
  SparqlHttpStore,
  Rfc64SemanticReadGatewayErrorV1,
  SyncSemanticStoreV1,
  type QueryOptions,
  type QueryResult,
  type TripleStore,
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
    expect(requests[0].body).toBe(
      compileRfc64SemanticReadOperationV2(current.coordinate).sparql,
    );
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('distinguishes valid Blazegraph absence from malformed successful responses', async () => {
    const current = FIXTURES[0];
    const payloads: unknown[] = [
      { head: { vars: ['p', 'o'] }, results: { bindings: [] } },
      { head: { vars: [] }, results: { bindings: [] } },
      { head: {}, results: { bindings: [] } },
      {},
      { head: { vars: ['p', 'o'] } },
      { head: { vars: ['p', 'o'] }, results: {} },
    ];
    for (const [index, payload] of payloads.entries()) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      }));
      const read = new SyncSemanticStoreV1(
        new BlazegraphStore(`http://rfc64-shape-${index}.test/sparql`),
      ).read(requestOf(current), { timeoutMs: 1_000 });
      if (index === 0) {
        await expect(read).resolves.toEqual({ kind: 'absent' });
      } else {
        const error = await rejected(read);
        expectGatewayResultError(error);
        expect((error as Error & { cause: unknown }).cause)
          .toBeInstanceOf(Rfc64SemanticReadCapabilityResultErrorV1);
      }
    }
  });

  it.each([
    ['invalid JSON', '{'],
    ['a null top-level value', 'null'],
  ])('classifies HTTP 200 with %s as a malformed semantic result', async (_label, body) => {
    const current = FIXTURES[0];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    }));
    const error = await rejected(new SyncSemanticStoreV1(
      new BlazegraphStore('http://rfc64-malformed-json.test/sparql'),
    ).read(requestOf(current), { timeoutMs: 1_000 }));
    expectGatewayResultError(error);
    expect((error as Error & { cause: unknown }).cause)
      .toBeInstanceOf(Rfc64SemanticReadCapabilityResultErrorV1);
  });

  it('returns an explicit absent result without invoking the strict record decoder', async () => {
    const query = vi.fn(async (): Promise<QueryResult> => ({
      type: 'bindings',
      bindings: [],
    }));
    const gateway = new SyncSemanticStoreV1(certifiedStore(query));
    await expect(gateway.read(requestOf(FIXTURES[3]), { timeoutMs: 1_000 }))
      .resolves.toMatchObject({
      kind: 'absent',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT 4'),
      expect.objectContaining({
        source: 'rfc64.exact-bindings.SYNC_MUTATION_GUARD_GET_V1',
        priority: 'background',
        maxResponseBytes: MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
      }),
    );
  });

  it('finds certification through decorators and rejects uncertified generic stores', async () => {
    const inner = certifiedStore(async () => ({
      type: 'bindings',
      bindings: [],
    }));
    const decorated = {
      innerStore: inner,
      query: inner.query,
    } as unknown as TripleStore;
    await expect(new SyncSemanticStoreV1(decorated).read(
      requestOf(FIXTURES[0]),
      { timeoutMs: 1_000 },
    )).resolves.toEqual({ kind: 'absent' });
    expect(() => new SyncSemanticStoreV1({
      query: inner.query,
    } as unknown as TripleStore)).toThrow(/no certified RFC-64 semantic read capability/u);

    let getterInvoked = false;
    const getterBacked = { query: inner.query } as Record<string, unknown>;
    getterBacked.rfc64SemanticReadCertifiedV1 = true;
    Object.defineProperty(getterBacked, 'rfc64SemanticReadV1', {
      get: () => {
        getterInvoked = true;
        return (inner as unknown as Record<string, unknown>).rfc64SemanticReadV1;
      },
    });
    expect(() => new SyncSemanticStoreV1(getterBacked as unknown as TripleStore))
      .toThrow(/no certified RFC-64 semantic read capability/u);
    expect(getterInvoked).toBe(false);
  });

  it('accepts a legacy semantic-only custom adapter during the compatibility window', async () => {
    const legacyRead = vi.fn(async () => ({
      variables: ['p', 'o'],
      rows: [],
    }));
    const legacyStore = {
      rfc64SemanticReadCertifiedV1: true,
      rfc64SemanticReadV1: legacyRead,
    } as unknown as TripleStore;
    await expect(new SyncSemanticStoreV1(legacyStore).read(
      requestOf(FIXTURES[0]),
      { timeoutMs: 1_000 },
    )).resolves.toEqual({ kind: 'absent' });
    expect(legacyRead).toHaveBeenCalledOnce();
  });

  it('validates a legacy adapter projection before treating empty rows as absent', async () => {
    const legacyStore = {
      rfc64SemanticReadCertifiedV1: true,
      rfc64SemanticReadV1: vi.fn(async () => ({
        variables: ['o', 'p'],
        rows: [],
      })),
    } as unknown as TripleStore;
    await expect(new SyncSemanticStoreV1(legacyStore).read(
      requestOf(FIXTURES[0]),
      { timeoutMs: 1_000 },
    )).rejects.toMatchObject({ code: 'rfc64-semantic-read-result' });
  });

  it('preserves legacy semantic adapter result-error classification', async () => {
    const legacyError = new Rfc64SemanticReadCapabilityResultErrorV1('malformed result');
    const legacyStore = {
      rfc64SemanticReadCertifiedV1: true,
      rfc64SemanticReadV1: vi.fn(async () => {
        throw legacyError;
      }),
    } as unknown as TripleStore;
    const error = await rejected(new SyncSemanticStoreV1(legacyStore).read(
      requestOf(FIXTURES[0]),
      { timeoutMs: 1_000 },
    ));
    expectGatewayResultError(error);
    expect((error as Error & { cause: unknown }).cause).toBe(legacyError);
  });

  it('certifies only DKG-managed Oxigraph HTTP stores', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      head: { vars: ['p', 'o'] },
      results: { bindings: [] },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    }));
    const managed = new SparqlHttpStore({
      queryEndpoint: 'http://managed-oxigraph.test/query',
      managedOxigraph: true,
    });
    const decorated = { innerStore: managed } as unknown as TripleStore;
    await expect(new SyncSemanticStoreV1(decorated).read(
      requestOf(FIXTURES[0]),
      { timeoutMs: 1_000 },
    )).resolves.toEqual({ kind: 'absent' });

    const generic = new SparqlHttpStore({
      queryEndpoint: 'http://generic-sparql.test/query',
    });
    expect(() => new SyncSemanticStoreV1(generic)).toThrow(
      /no certified RFC-64 semantic read capability/u,
    );
  });

  it('uses the manifest compiler as the only request-validation boundary', async () => {
    const query = vi.fn(async (): Promise<QueryResult> => ({ type: 'bindings', bindings: [] }));
    const gateway = new SyncSemanticStoreV1(certifiedStore(query));
    let getterInvoked = false;
    const accessorRequest = {};
    Object.defineProperty(accessorRequest, 'coordinate', {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return FIXTURES[0].coordinate;
      },
    });
    for (const input of [
      accessorRequest,
      { coordinate: FIXTURES[0].coordinate, extra: true },
      { coordinate: { recordType: 'not-a-record' } },
    ]) {
      const error = await rejected(gateway.read(input, { timeoutMs: 1_000 }));
      expect(error).toBeInstanceOf(Rfc64SemanticReadGatewayErrorV1);
      expect(error).toMatchObject({ code: 'rfc64-semantic-read-request' });
      expect((error as Error & { cause: unknown }).cause)
        .toBeInstanceOf(Rfc64SemanticReadManifestErrorV1);
    }
    expect(getterInvoked).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('round-trips a semantic record through the real worker adapter capability', async () => {
    const store = new OxigraphWorkerStore();
    const current = FIXTURES[0];
    try {
      await store.insert(projectRfc64SemanticRecordStoreRowsV1(current.record)
        .map(renderRfc64SemanticStoreRowV1));
      const result = await new SyncSemanticStoreV1(store).read(requestOf(current), {
        timeoutMs: 5_000,
      });
      expect(result.kind).toBe('record');
      if (result.kind === 'record') expect(result.decoded.record).toEqual(current.record);
    } finally {
      await store.close();
    }
  });

  it('requires a bounded deadline and never dispatches after caller cancellation', async () => {
    const query = vi.fn(async (): Promise<QueryResult> => ({
      type: 'bindings',
      bindings: [],
    }));
    const gateway = new SyncSemanticStoreV1(certifiedStore(query));
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
    const gateway = new SyncSemanticStoreV1(certifiedStore(query));
    await expect(gateway.read(requestOf(FIXTURES[0]), { timeoutMs: 10 })).rejects
      .toMatchObject({ name: 'TimeoutError' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('includes an Oxigraph worker respawn wait in the read deadline and never dispatches later', async () => {
    const store = new OxigraphWorkerStore();
    let releaseRespawn!: () => void;
    const heldRespawn = new Promise<void>((resolve) => {
      releaseRespawn = resolve;
    });
    const internals = store as unknown as {
      respawnPromise: Promise<void> | null;
      postToWorker: (...args: unknown[]) => Promise<unknown>;
    };
    internals.respawnPromise = heldRespawn;
    const postToWorker = vi.spyOn(internals, 'postToWorker');
    try {
      await expect(new SyncSemanticStoreV1(store).read(requestOf(FIXTURES[0]), {
        timeoutMs: 10,
      })).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(postToWorker).not.toHaveBeenCalled();
      internals.respawnPromise = null;
      releaseRespawn();
      await heldRespawn;
      await Promise.resolve();
      expect(postToWorker).not.toHaveBeenCalled();
    } finally {
      internals.respawnPromise = null;
      releaseRespawn();
      await store.close();
    }
  });

  it('times out a pending worker respawn with typed metadata and never dispatches', async () => {
    const store = new OxigraphWorkerStore();
    let releaseRespawn!: () => void;
    const heldRespawn = new Promise<void>((resolve) => {
      releaseRespawn = resolve;
    });
    const internals = store as unknown as {
      respawnPromise: Promise<void> | null;
      callWithTimeout: <T>(
        timeoutMs: number,
        signal: AbortSignal | undefined,
        method: string,
        ...args: unknown[]
      ) => Promise<T>;
      postToWorker: (...args: unknown[]) => Promise<unknown>;
    };
    internals.respawnPromise = heldRespawn;
    const postToWorker = vi.spyOn(internals, 'postToWorker');
    try {
      await expect(internals.callWithTimeout(10, undefined, 'query', 'SELECT {}'))
        .rejects.toMatchObject({
          code: 'OXIGRAPH_WORKER_OP_TIMEOUT',
          method: 'query',
          timeoutMs: 10,
        });
      expect(postToWorker).not.toHaveBeenCalled();
    } finally {
      internals.respawnPromise = null;
      releaseRespawn();
      await store.close();
    }
  });

  it('reports the configured worker timeout after a respawn consumes part of the deadline', async () => {
    const store = new OxigraphWorkerStore();
    let releaseRespawn!: () => void;
    const heldRespawn = new Promise<void>((resolve) => {
      releaseRespawn = resolve;
    });
    const internals = store as unknown as {
      respawnPromise: Promise<void> | null;
      callWithTimeout: <T>(
        timeoutMs: number,
        signal: AbortSignal | undefined,
        method: string,
        ...args: unknown[]
      ) => Promise<T>;
      postToWorker: (...args: unknown[]) => Promise<unknown>;
    };
    internals.respawnPromise = heldRespawn;
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(300);
    const postToWorker = vi.spyOn(internals, 'postToWorker').mockResolvedValue(undefined);
    try {
      const pending = internals.callWithTimeout<void>(1_000, undefined, 'query', 'SELECT {}');
      internals.respawnPromise = null;
      releaseRespawn();
      await pending;
      expect(postToWorker).toHaveBeenCalledWith(
        700,
        undefined,
        'query',
        ['SELECT {}'],
        1_000,
      );
    } finally {
      internals.respawnPromise = null;
      releaseRespawn();
      await store.close();
    }
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
    const gateway = new SyncSemanticStoreV1(certifiedStore(query));
    await expect(gateway.read(requestOf(FIXTURES[0]), { timeoutMs: 5 })).rejects
      .toMatchObject({ name: 'TimeoutError' });
  });

  it('keeps the deadline authoritative across normalization and record decoding', async () => {
    const rows = projectRfc64SemanticRecordStoreRowsV1(FIXTURES[0].record);
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(6);
    const store = certifiedStore(async () => ({
      type: 'bindings',
      bindings: rows.map((row) => {
        const rendered = renderRfc64SemanticStoreRowV1(row);
        return { p: rendered.predicate, o: rendered.object };
      }),
    }));
    await expect(new SyncSemanticStoreV1(store).read(requestOf(FIXTURES[0]), {
      timeoutMs: 5,
    })).rejects.toMatchObject({ name: 'TimeoutError' });
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
        bindings: [{ p: 'urn:test:p', o: '"value"^^<not an iri>' }],
      },
      {
        type: 'bindings',
        bindings: Array.from({ length: 6 }, () => ({ p: 'urn:test:p', o: '"v"' })),
      },
    ] as QueryResult[]) {
      const gateway = new SyncSemanticStoreV1(certifiedStore(async () => result));
      const error = await rejected(gateway.read(requestOf(current), { timeoutMs: 1_000 }));
      expectGatewayResultError(error);
      expect((error as Error & { cause: unknown }).cause)
        .toBeInstanceOf(Rfc64SemanticReadCapabilityResultErrorV1);
    }
  });

  it('rejects accessor-backed, sparse, adorned, and nonordinary capability results', async () => {
    const cases: Array<{ result: QueryResult; getterInvoked?: () => boolean }> = [];
    let resultGetterInvoked = false;
    const accessorResult = {};
    Object.defineProperty(accessorResult, 'type', {
      enumerable: true,
      get: () => {
        resultGetterInvoked = true;
        return 'bindings';
      },
    });
    Object.defineProperty(accessorResult, 'bindings', {
      enumerable: true,
      value: [],
    });
    cases.push({
      result: accessorResult as QueryResult,
      getterInvoked: () => resultGetterInvoked,
    });

    let bindingGetterInvoked = false;
    const accessorBinding = { o: '"value"' } as Record<string, string>;
    Object.defineProperty(accessorBinding, 'p', {
      enumerable: true,
      get: () => {
        bindingGetterInvoked = true;
        return 'urn:test:p';
      },
    });
    cases.push({
      result: { type: 'bindings', bindings: [accessorBinding] },
      getterInvoked: () => bindingGetterInvoked,
    });

    const sparse: Array<Record<string, string>> = [];
    sparse.length = 1;
    cases.push({ result: { type: 'bindings', bindings: sparse } });
    const adorned: Array<Record<string, string>> = [];
    Object.defineProperty(adorned, 'extra', { enumerable: true, value: true });
    cases.push({ result: { type: 'bindings', bindings: adorned } });
    const nonordinary = Object.setPrototypeOf([], null) as Array<Record<string, string>>;
    cases.push({ result: { type: 'bindings', bindings: nonordinary } });

    for (const current of cases) {
      const gateway = new SyncSemanticStoreV1(certifiedStore(async () => current.result));
      const error = await rejected(gateway.read(requestOf(FIXTURES[0]), { timeoutMs: 1_000 }));
      expectGatewayResultError(error);
      expect(current.getterInvoked?.() ?? false).toBe(false);
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
  query: (sparql: string, options?: QueryOptions) => Promise<QueryResult>,
): TripleStore {
  const store = {
    query,
    rfc64ExactBindingsReadCertifiedV1: true as const,
    rfc64ExactBindingsReadV1(operation, options) {
      return executeRfc64ExactBindingsReadCapabilityV1(store, operation, options);
    },
  } satisfies Pick<TripleStore, 'query' | 'rfc64ExactBindingsReadCertifiedV1'
    | 'rfc64ExactBindingsReadV1'>;
  return store as unknown as TripleStore;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}

function expectGatewayResultError(error: unknown): void {
  expect(error).toBeInstanceOf(Rfc64SemanticReadGatewayErrorV1);
  expect(error).toMatchObject({ code: 'rfc64-semantic-read-result' });
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
