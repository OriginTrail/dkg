import { describe, expect, it } from 'vitest';
import {
  QUERY_CATALOG_READ_CAPABILITIES,
  QUERY_CATALOG_SCHEMA_VERSION,
} from '@origintrail-official/dkg-core/query-catalog';
import { DkgClient } from '../src/client.js';
import { makeConfig } from './harness.js';

describe('DkgClient query-catalog routes', () => {
  const makeClient = () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: (async (url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        calls.push({
          url: String(url),
          method: String(init?.method),
          headers: init?.headers as Record<string, string>,
          body,
        });
        const response = String(url).endsWith('/read')
          ? {
              schemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
              capabilities: QUERY_CATALOG_READ_CAPABILITIES,
              contextGraphId: body.contextGraphId,
              graph: `did:dkg:context-graph:${body.contextGraphId}/meta/query-catalog`,
              items: [],
              result: { type: 'bindings', bindings: [] },
            }
          : {
              ok: true,
              contextGraphId: body.contextGraphId,
              graph: `did:dkg:context-graph:${body.contextGraphId}/meta`,
              subGraphName: 'meta',
              assertionName: 'query-catalog-test',
              assertionUri: `did:dkg:context-graph:${body.contextGraphId}/assertion/default/query-catalog-test`,
              scopeGraphs: [`did:dkg:context-graph:${body.contextGraphId}`],
              scopeGraph: `did:dkg:context-graph:${body.contextGraphId}`,
              queryCount: 1,
              triplesWritten: Array.isArray(body.quads) ? body.quads.length : 0,
              alreadyExists: false,
            };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });
    return { client, calls };
  };

  it('normalizes the Context Graph DID and reads the versioned DTO', async () => {
    const { client, calls } = makeClient();
    const result = await client.readQueryCatalog('did:dkg:context-graph:test-cg');

    expect(calls[0]).toMatchObject({
      url: 'http://localhost:9200/api/profile/query-catalog/read',
      method: 'POST',
      body: { contextGraphId: 'test-cg' },
    });
    expect(calls[0].headers.Authorization).toBe('Bearer test-token');
    expect(result.schemaVersion).toBe(QUERY_CATALOG_SCHEMA_VERSION);
  });

  it('delegates canonical quads without a mutable write mode', async () => {
    const { client, calls } = makeClient();
    const quads = [{
      subject: 'urn:query:1',
      predicate: 'http://dkg.io/ontology/profile/displayName',
      object: '"Query one"',
      graph: '',
    }];
    const result = await client.writeQueryCatalog({
      contextGraphId: 'did:dkg:context-graph:test-cg',
      quads,
    });

    expect(calls[0]).toMatchObject({
      url: 'http://localhost:9200/api/profile/query-catalog/write',
      method: 'POST',
      body: { contextGraphId: 'test-cg', quads },
    });
    expect(result).toMatchObject({
      ok: true,
      triplesWritten: 1,
      assertionName: 'query-catalog-test',
      alreadyExists: false,
    });
  });
});
