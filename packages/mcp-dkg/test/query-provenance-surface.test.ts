/**
 * Public-surface coverage for `includeProvenance` (PR review 🟡): the engine
 * tests prove the behaviour, but the flag must also survive the MCP plumbing —
 * the real `DkgClient.query` body, the `dkg_query` tool→client forward, and the
 * tool's rendering of `result.provenance`. Without these, the engine could work
 * while the public surface silently drops the flag or the rendered handle.
 */
import { describe, it, expect } from 'vitest';
import { DkgClient } from '../src/client.js';
import { registerReadTools } from '../src/tools.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

const PROV = {
  sourceGraph: 'did:dkg:context-graph:cg/_verifiable_memory/0xaa/7',
  contextGraphId: 'cg',
  memoryLayer: 'verifiable-memory' as const,
  author: '0xaa',
  kaNumber: '7',
};

describe('includeProvenance — MCP public surface', () => {
  it('DkgClient.query serializes includeProvenance into the /api/query body and returns provenance', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ result: { bindings: [{ s: 'urn:x' }], provenance: [PROV] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });
    const res = await client.query({
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      contextGraphId: 'cg',
      includeProvenance: true,
    });
    expect(calls[0].url).toContain('/api/query');
    expect(calls[0].body.includeProvenance).toBe(true);
    // ...and the provenance the daemon returned survives back to the caller.
    expect(res.provenance?.[0]?.kaNumber).toBe('7');
  });

  it('DkgClient.query omits includeProvenance from the body when not requested (back-compat)', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: (async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ result: { bindings: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });
    await client.query({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }', contextGraphId: 'cg' });
    expect('includeProvenance' in calls[0].body).toBe(false);
  });

  it('dkg_query forwards includeProvenance to the client', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_query', {
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      includeProvenance: true,
    });
    expect(result.isError).toBeFalsy();
    expect(client.queryCalls.at(-1)!.includeProvenance).toBe(true);
  });

  it('dkg_query renders the verifiable Sources section when the daemon returns provenance', async () => {
    const server = new FakeServer();
    const client = new FakeClient({
      query: async () => ({ bindings: [{ s: 'urn:x', o: '"V"' }], provenance: [PROV] }),
    });
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_query', {
      sparql: 'SELECT ?s ?o WHERE { ?s ?p ?o }',
      includeProvenance: true,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain('Sources');
    expect(text).toContain('0xaa/7');
  });
});
