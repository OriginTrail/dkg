import { expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryHandler } from '../src/query-handler.js';

it.each(['ENTITIES_BY_TYPE', 'ENTITY_TRIPLES'] as const)(
  'remote %s reads recovered public partitions without entering a registered child', async lookupType => {
    const store = new OxigraphStore();
    const parent = 'did:dkg:context-graph:parent', child = `${parent}/code`;
    const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const handler = new QueryHandler(new DKGQueryEngine(store), {
      defaultPolicy: 'deny', contextGraphs: { parent: { policy: 'public' }, 'parent/code': { policy: 'deny' } },
    });
    try {
      await store.insert([
        ...['code', 'public'].map(name => ({ graph: `${parent}/_meta`, subject: `urn:receipt:${name}`,
          predicate: 'http://dkg.io/ontology/authenticatedSubGraphName', object: JSON.stringify(name) })),
        { graph: `${child}/_meta`, subject: child, predicate: type, object: 'https://dkg.network/ontology#ContextGraph' },
        { graph: `${child}/_verifiable_memory/a/1`, subject: 'urn:secret', predicate: type, object: 'urn:Topic' },
        { graph: `${parent}/public/_verifiable_memory/a/2`, subject: 'urn:public', predicate: type, object: 'urn:Topic' },
      ]);
      const request = { operationId: 'scoped-remote', lookupType, contextGraphId: 'parent',
        rdfType: 'urn:Topic', entityUri: 'urn:public' };
      const result = await handler.handle(request, 'parent-only-reader');
      expect(result.status).toBe('OK');
      if (lookupType === 'ENTITIES_BY_TYPE') expect(result.entityUris).toEqual(['urn:public']);
      else {
        expect(result.resultCount).toBe(1);
        expect(result.ntriples).toContain('<urn:public>');
        const hidden = await handler.handle({ ...request, entityUri: 'urn:secret' }, 'parent-only-reader');
        expect(hidden).toMatchObject({ status: 'OK', resultCount: 0, ntriples: '' });
      }
      const denied = await handler.handle({ ...request, contextGraphId: 'parent/code' }, 'parent-only-reader');
      expect(denied.status).toBe('ACCESS_DENIED');
    } finally { await store.close(); }
  },
);
