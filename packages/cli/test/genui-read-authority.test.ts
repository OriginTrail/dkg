// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmClient } from '@origintrail-official/dkg-node-ui';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const caller = `0x${'22'.repeat(20)}`;
const entity = 'urn:entity';
const type = 'urn:EntityType';
const triples = [
  { p: { value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' }, o: { value: type } },
  { p: { value: 'http://schema.org/name' }, o: { value: 'private authorized title' } },
];
afterEach(() => vi.restoreAllMocks());

function fixture(body: object = { contextGraphId: 'private-cg', entityUri: entity, libraryPrompt: 'Component library' }) {
  const req = Object.assign(new EventEmitter(), { method: 'POST', headers: {}, aborted: false,
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)) });
  const res = Object.assign(new EventEmitter(), { body: '', statusCode: 0, writableEnded: false,
    destroyed: false, headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; Object.assign(this.headers, headers); },
    setHeader(key: string, value: string) { this.headers[key] = value; },
    write(chunk: string) { this.body += chunk; },
    end(chunk = '') { this.body += chunk; this.writableEnded = true; },
  });
  const query = vi.fn(async (_sparql: string, options: { subGraphName?: string }) => ({
    bindings: options.subGraphName === 'meta'
      ? [{ hint: '"Use an entity card"', label: '"Entity label"' }] : triples,
  }));
  const authority = vi.fn(async () => ({ outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant' }));
  const ctx = { req, res, path: '/api/genui/render', config: { llm: { apiKey: 'test' } },
    authentication: requestAuthentication({ kind: 'agent', agentAddress: caller }), requestAgentAddress: 'wrong-node-address',
    agent: { query, resolveContextGraphReadAuthority: authority },
  } as unknown as RequestContext;
  const stream = vi.spyOn(LlmClient.prototype, 'stream').mockImplementation(async function* () {
    yield { type: 'text_delta', delta: 'EntityCard()' };
    yield { type: 'final', mode: 'streaming', message: { content: 'EntityCard()' } };
  });
  return { ctx, res, query, authority, stream };
}

describe('GenUI scoped read and extracted render behavior', () => {
  it('binds entity and profile reads to the same bearer actor before constructing the LLM prompt', async () => {
    const h = fixture();
    await handleQueryRoutes(h.ctx);
    expect(h.authority).toHaveBeenCalledWith('private-cg', expect.objectContaining({ callerAgentAddress: caller }));
    expect(h.query).toHaveBeenCalledTimes(2);
    for (const [, options] of h.query.mock.calls) expect(options).toMatchObject({ contextGraphId: 'private-cg', callerAgentAddress: caller });
    expect(h.stream.mock.calls[0][0].request.messages[1].content).toContain('private authorized title');
    expect(h.stream.mock.calls[0][0].request.messages[1].content).toContain('Use an entity card');
    expect(h.res.statusCode).toBe(200);
    expect(h.res.headers['Content-Type']).toBe('text/event-stream');
    expect(h.res.body).toContain('event: delta');
    expect(h.res.body).toContain('event: final');
    expect(h.res.body).toContain('event: done');
  });
  it.each([
    {}, { contextGraphId: 'private-cg', libraryPrompt: 'library' },
    { contextGraphId: 'private-cg', entityUri: entity },
  ])('validates required fields before retrieval: %j', async body => {
    const h = fixture(body);
    await handleQueryRoutes(h.ctx);
    expect(h.res.statusCode).toBe(400);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.stream).not.toHaveBeenCalled();
  });
  it('retains the configured-LLM refusal after read authority is established', async () => {
    const h = fixture(); h.ctx.config.llm = undefined;
    await handleQueryRoutes(h.ctx);
    expect(h.res.statusCode).toBe(503);
    expect(h.query).not.toHaveBeenCalled();
  });
  it('rejects an unsafe entity URI without sending a SPARQL query', async () => {
    const h = fixture({ contextGraphId: 'private-cg', entityUri: 'urn:x> ?s ?p ?o', libraryPrompt: 'library' });
    await handleQueryRoutes(h.ctx);
    expect(h.res.statusCode).toBe(400);
    expect(h.query).not.toHaveBeenCalled();
  });
  it('reports missing data without handing a prompt to the LLM', async () => {
    const h = fixture(); h.query.mockResolvedValue({ bindings: [] });
    await handleQueryRoutes(h.ctx);
    expect(h.res.statusCode).toBe(404);
    expect(h.stream).not.toHaveBeenCalled();
  });
  it('retains safe retryable authority errors from the physical scoped read', async () => {
    const h = fixture(); h.query.mockRejectedValue(Object.assign(new Error('private internal detail'), {
      code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true,
    }));
    await handleQueryRoutes(h.ctx);
    expect(h.res.statusCode).toBe(503);
    expect(h.res.headers['Retry-After']).toBe('3');
    expect(h.res.body).not.toContain('private internal detail');
    expect(h.stream).not.toHaveBeenCalled();
  });
  it('surfaces genuine data-query failure and does not render', async () => {
    const h = fixture(); h.query.mockRejectedValue(new Error('data read failed'));
    await handleQueryRoutes(h.ctx);
    expect(h.res.statusCode).toBe(500);
    expect(h.stream).not.toHaveBeenCalled();
  });
  it('still renders authorized triples when optional profile metadata is absent', async () => {
    const h = fixture(); h.query.mockResolvedValueOnce({ bindings: triples }).mockRejectedValueOnce(new Error('no meta subgraph'));
    await handleQueryRoutes(h.ctx);
    expect(h.res.statusCode).toBe(200);
    expect(h.res.body).toContain('event: done');
  });
  it('never builds a metadata query from an unsafe stored rdf:type', async () => {
    const h = fixture(); h.query.mockResolvedValue({ bindings: [{ p: { value: triples[0].p.value }, o: { value: 'urn:x> ?s ?p ?o' } }] });
    await handleQueryRoutes(h.ctx);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.res.statusCode).toBe(200);
  });
  it('settles the SSE response after a provider stream fails', async () => {
    const h = fixture(); h.stream.mockImplementation(async function* () { yield { type: 'text_delta', delta: 'partial' }; throw new Error('provider unavailable'); });
    await handleQueryRoutes(h.ctx);
    expect(h.res.body).toContain('event: error');
    expect(h.res.writableEnded).toBe(true);
  });
});
