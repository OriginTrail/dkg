import { describe, expect, it } from 'vitest';
import { DkgClient } from '../src/client.js';
import { makeConfig } from './harness.js';

function clientReturning(result: unknown): DkgClient {
  return new DkgClient({
    config: makeConfig(),
    fetcher: (async () => new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
  });
}

describe('DkgClient rolling query-result compatibility', () => {
  it('normalizes legacy ASK bindings from an older daemon', async () => {
    const result = await clientReturning({ bindings: [{ result: 'false' }] }).query({
      sparql: 'PREFIX ex: <urn:ex:> ASK { ?s ex:p ?o }',
      contextGraphId: 'test-cg',
    });
    expect(result).toEqual({ type: 'boolean', value: false });
  });

  it('normalizes legacy graph results from an older daemon', async () => {
    const quads = [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' }];
    const result = await clientReturning({ bindings: [], quads }).query({
      sparql: 'PREFIX ex: <urn:ex:> CONSTRUCT { ?s ex:p ?o } WHERE { ?s ex:p ?o }',
      contextGraphId: 'test-cg',
    });
    expect(result).toEqual({ type: 'quads', quads });
  });

  it('accepts the additive head-daemon result contract', async () => {
    const result = await clientReturning({
      type: 'boolean',
      value: true,
      bindings: [{ result: 'true' }],
    }).query({ sparql: 'ASK { ?s ?p ?o }', contextGraphId: 'test-cg' });
    expect(result).toEqual({ type: 'boolean', value: true });
  });
});
