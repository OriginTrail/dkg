import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StoreSchedulerBusyError,
  type QueryResult as StoreQueryResult,
  type StoreSchedulerBusyErrorLike,
  type StoreSchedulerBusyReason,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryHandler } from '../src/query-handler.js';
import type { QueryBusyResponse } from '../src/query-types.js';

const CONTEXT_GRAPH_ID = 'busy-query-cg';

function queryOnlyStore(query: TripleStore['query']): TripleStore {
  return {
    insert: async () => undefined,
    delete: async () => undefined,
    deleteByPattern: async () => 0,
    query,
    hasGraph: async () => false,
    createGraph: async () => undefined,
    dropGraph: async () => undefined,
    listGraphs: async () => [],
    deleteBySubjectPrefix: async () => 0,
    countQuads: async () => 0,
    close: async () => undefined,
  };
}

function busyError(reason: StoreSchedulerBusyReason, operation: string) {
  return new StoreSchedulerBusyError(reason, 'normal', operation);
}

function structuralBusyError(
  reason: StoreSchedulerBusyReason,
  operation: string,
): StoreSchedulerBusyErrorLike {
  return {
    code: 'STORE_SCHEDULER_BUSY',
    retryable: true,
    outcome: 'not_started',
    storeOperationOutcomeTag: 'dkg.store-operation-outcome.v1',
    reason,
    priority: 'normal',
    operation,
    storeOperation: 'query',
  };
}

function expectedBusyResponse(
  operationId: string,
  reason: StoreSchedulerBusyReason,
): QueryBusyResponse {
  return {
    operationId,
    status: 'BUSY',
    truncated: false,
    resultCount: 0,
    error: 'Node storage is temporarily busy. Retry later.',
    code: 'STORE_BUSY',
    retryable: true,
    retryAfterMs: 1_000,
    reason,
  };
}

class BusyUalQueryEngine extends DKGQueryEngine {
  constructor(private readonly failure: StoreSchedulerBusyError) {
    super(queryOnlyStore(async (): Promise<StoreQueryResult> => ({
      type: 'bindings',
      bindings: [],
    })));
  }

  override async resolveKnowledgeAsset(): Promise<never> {
    throw this.failure;
  }
}

describe('QueryHandler store-busy responses', () => {
  it('preserves queue-wait admission failure through direct and encoded SPARQL responses', async () => {
    // Deliberately use a plain structural value to exercise the package
    // boundary rather than relying on shared Error-class identity.
    const failure = structuralBusyError('queue_wait_timeout', 'remote-query.read');
    const store = queryOnlyStore(async (): Promise<StoreQueryResult> => { throw failure; });
    const handler = new QueryHandler(new DKGQueryEngine(store), {
      defaultPolicy: 'public',
      contextGraphs: {
        [CONTEXT_GRAPH_ID]: { policy: 'public', sparqlEnabled: true },
      },
    });
    const request = {
      operationId: 'busy-op',
      lookupType: 'SPARQL_QUERY' as const,
      contextGraphId: CONTEXT_GRAPH_ID,
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
    };
    const expected = expectedBusyResponse('busy-op', 'queue_wait_timeout');

    await expect(handler.handle(request, 'peer-busy')).resolves.toEqual(expected);

    const wireResponse = await handler.handler(
      new TextEncoder().encode(JSON.stringify(request)),
      {
        toString: () => 'peer-busy',
        toBytes: () => new Uint8Array(),
      } as Parameters<QueryHandler['handler']>[1],
    );
    expect(JSON.parse(new TextDecoder().decode(wireResponse))).toEqual(expected);
  });

  it('preserves queue-full admission failure through UAL resolution', async () => {
    const handler = new QueryHandler(
      new BusyUalQueryEngine(
        busyError('queue_full', 'remote-query.resolveKnowledgeAsset'),
      ),
      { defaultPolicy: 'public' },
    );

    await expect(handler.handle({
      operationId: 'busy-ual',
      lookupType: 'ENTITY_BY_UAL',
      ual: 'did:dkg:testnet:31337/0xabc/1',
    }, 'peer-busy')).resolves.toEqual(expectedBusyResponse('busy-ual', 'queue_full'));
  });
});

describe('QueryHandler node-side store limit', () => {
  afterEach(() => vi.restoreAllMocks());

  // Structural, as it crosses package and worker boundaries; the sizes stay on this node.
  const internalLimit = () => Object.assign(new Error('Graph catalog exceeds the node-side limit'), {
    code: 'STORE_INTERNAL_LIMIT', limitName: 'STORE_GRAPH_CATALOG_MAX_BYTES', limitBytes: 1024, actualBytes: 2048,
  });
  const expectedInternalLimit = (operationId: string): QueryBusyResponse => ({
    operationId,
    status: 'BUSY',
    truncated: false,
    resultCount: 0,
    error: 'Node storage reached an internal limit. Retry later.',
    code: 'STORE_INTERNAL_LIMIT',
    retryable: true,
    retryAfterMs: 1_000,
  });

  it('answers the retryable BUSY status with the code, directly and on the wire, and warns once per window', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = queryOnlyStore(async (): Promise<StoreQueryResult> => { throw internalLimit(); });
    const handler = new QueryHandler(new DKGQueryEngine(store), {
      defaultPolicy: 'public',
      contextGraphs: { [CONTEXT_GRAPH_ID]: { policy: 'public', sparqlEnabled: true } },
    });
    const request = {
      operationId: 'limit-op',
      lookupType: 'SPARQL_QUERY' as const,
      contextGraphId: CONTEXT_GRAPH_ID,
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
    };

    await expect(handler.handle(request, 'peer-limit')).resolves.toEqual(expectedInternalLimit('limit-op'));
    const wireResponse = await handler.handler(
      new TextEncoder().encode(JSON.stringify(request)),
      { toString: () => 'peer-limit', toBytes: () => new Uint8Array() } as Parameters<QueryHandler['handler']>[1],
    );
    const wire = JSON.parse(new TextDecoder().decode(wireResponse));
    expect(wire).toEqual(expectedInternalLimit('limit-op'));
    expect(JSON.stringify(wire)).not.toContain('2048');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[query-handler] Node-side store limit reached, answered BUSY STORE_INTERNAL_LIMIT: limit=STORE_GRAPH_CATALOG_MAX_BYTES',
    );
  });

  it('answers the same through UAL resolution', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class LimitedUalQueryEngine extends DKGQueryEngine {
      override async resolveKnowledgeAsset(): Promise<never> {
        throw internalLimit();
      }
    }
    const handler = new QueryHandler(
      new LimitedUalQueryEngine(queryOnlyStore(async () => ({ type: 'bindings', bindings: [] }))),
      { defaultPolicy: 'public' },
    );
    await expect(handler.handle({
      operationId: 'limit-ual',
      lookupType: 'ENTITY_BY_UAL',
      ual: 'did:dkg:testnet:31337/0xabc/1',
    }, 'peer-limit')).resolves.toEqual(expectedInternalLimit('limit-ual'));
  });
});
