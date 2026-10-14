import { expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { createRemoteQueryHandler } from '../src/remote-query-handler.js';
import { assertPublicSnapshotQueryTrust, markCoreTrustedGraph, withPublicSnapshotQueryTrust } from '../src/public-snapshot-evidence.js';

it('refuses remote descendant aliases of imported partitions and preserves unrelated scopes', async () => {
  const store = new OxigraphStore();
  try {
    const engine = new DKGQueryEngine(store);
    const handler = createRemoteQueryHandler({ store, queryEngine: engine,
      isContextGraphPublicOnChain: async () => true, contextGraphServingWithheld: () => false } as never,
    { defaultPolicy: 'public' });
    for (const id of ['example/code', 'example/code/deeper', 'example-other/code', 'unrelated']) {
      await store.insert([{ graph: `did:dkg:context-graph:${id}/_verifiable_memory/author/1`,
        subject: 'urn:entity', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Type' }]);
      const before = await handler.handle({ operationId: id, contextGraphId: id,
        lookupType: 'ENTITIES_BY_TYPE', rdfType: 'urn:Type' }, 'peer');
      expect(before.status).toBe('OK');
      expect(before.resultCount).toBe(1);
    }
    await markCoreTrustedGraph(store, 'example');
    for (const id of ['example', 'example/code', 'example/code/deeper']) {
      const response = await handler.handle({ operationId: id, contextGraphId: id,
        lookupType: 'ENTITIES_BY_TYPE', rdfType: 'urn:Type' }, 'peer');
      expect(response.status).toBe('ERROR');
      expect(response.bindings).toBeUndefined();
      expect(response.ntriples).toBeUndefined();
      for (const mode of [undefined, 'rpc-only'] as const)
        await expect(assertPublicSnapshotQueryTrust(store, id, mode)).rejects.toMatchObject({ code: 'CORE_CACHE_QUERY_TRUST_REQUIRED' });
      await assertPublicSnapshotQueryTrust(store, id, 'core-cache');
    }
    for (const id of ['example-other/code', 'unrelated']) {
      const response = await handler.handle({ operationId: id, contextGraphId: id,
        lookupType: 'ENTITIES_BY_TYPE', rdfType: 'urn:Type' }, 'peer');
      expect(response.status).toBe('OK');
      expect(response.resultCount).toBe(1);
    }
  } finally { await store.close(); }
});

it('withholds a descendant result when an ancestor import starts during the read', async () => {
  const store = new OxigraphStore();
  try {
    await expect(withPublicSnapshotQueryTrust(store, 'example/code', undefined, async () => {
      await markCoreTrustedGraph(store, 'example');
      return 'must not escape';
    })).rejects.toMatchObject({ code: 'CORE_CACHE_QUERY_TRUST_REQUIRED' });
  } finally { await store.close(); }
});
