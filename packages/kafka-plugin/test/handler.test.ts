import { describe, it, expect, vi } from 'vitest';
import { attachRequest } from './_helpers/daemon-ctx.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createHandler } from '../src/handler.js';
import { buildListQuery, buildSingleByUalQuery } from '../src/discovery.js';
interface MockResShape {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  writableEnded: boolean;
  headersSent: boolean;
}
function mockReqRes(method: string, urlPath: string, body?: unknown): {
  req: IncomingMessage;
  res: ServerResponse;
  captured: MockResShape;
} {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const reqStream = Readable.from([payload]) as unknown as IncomingMessage;
  (reqStream as unknown as Record<string, unknown>).method = method;
  (reqStream as unknown as Record<string, unknown>).url = urlPath;
  (reqStream as unknown as Record<string, unknown>).headers = { host: 'localhost' };
  const captured: MockResShape = {
    statusCode: 0,
    body: undefined,
    headers: {},
    writableEnded: false,
    headersSent: false,
  };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
      captured.headersSent = true;
      return this;
    },
    end(payload?: string) {
      captured.writableEnded = true;
      if (payload) {
        try {
          captured.body = JSON.parse(payload);
        } catch {
          captured.body = payload;
        }
      }
      return this;
    },
    setHeader(k: string, v: string) {
      captured.headers[k] = v;
    },
    get writableEnded() {
      return captured.writableEnded;
    },
    get headersSent() {
      return captured.headersSent;
    },
  } as unknown as ServerResponse;
  return { req: reqStream, res, captured };
}
function mockCtx(overrides: Partial<Record<string, unknown>> = {}) {
  const publishAsync = vi.fn().mockResolvedValue({ captureID: 'cap-123' });
  const getStatus = vi.fn();
  const query = vi.fn();
  return {
    publishAsync,
    getStatus,
    query,
    ctx: {
      agent: { publishAsync, query },
      publisherControl: { getStatus },
      publisherState: { runtime: { walletIds: ['0xwallet'] }, availability: { available: true } },
      config: {},
      requestAgentAddress: '0x0000000000000000000000000000000000000000',
      ...overrides,
    } as unknown as import('../src/handler.js').KafkaPluginCtx,
  };
}
const validBody = {
  name: 'demo',
  kafkaBootstrapUrl: 'kafka://broker:9092',
  kafkaTopicName: 'demo-topic',
};
describe('handler — POST /register happy path', () => {
  it('returns 202 with captureID/contextGraphId/receivedAt and invokes publishAsync', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx, publishAsync } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(202);
    expect(publishAsync).toHaveBeenCalledTimes(1);
    const [cgId, content] = publishAsync.mock.calls[0];
    expect(cgId).toBe('urn:cg:demo');
    expect(content).toHaveProperty('private');
    expect(content).toHaveProperty('public');
    expect(content.private['@type']).toBe('dkg-streams:KafkaStream');
    expect(content.private['@id']).toMatch(/^urn:dkg:kafka-stream:/);
    expect(content.public).toMatchObject({
      '@id': content.private['@id'],
      'dkg:privateDataAnchor': 'true',
    });
    expect(captured.body).toMatchObject({
      captureID: 'cap-123',
      contextGraphId: 'urn:cg:demo',
    });
    expect(typeof (captured.body as Record<string, unknown>).receivedAt).toBe('string');
  });
  it('falls back to ctx.config.kafka.contextGraphId when factory option absent', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx, publishAsync } = mockCtx({ config: { kafka: { contextGraphId: 'urn:cg:from-config' } } });
    const handler = createHandler({ basePath: '/api/kafka/streams' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(202);
    expect(publishAsync.mock.calls[0][0]).toBe('urn:cg:from-config');
  });
  it('stamps the AUTHENTICATED submitter and a client cannot name its own owner', async () => {
    // Ownership decides who may run the destructive by-id clear. `publishOptions` here is an
    // unfiltered client record, unlike the EPCIS lane's allow-list, so the stamp must beat a
    // caller-supplied value — the spread ORDER is the guard, and this row is what fails if
    // it is ever reversed.
    const SUBMITTER = '0x00000000000000000000000000000000000000b7';
    const ATTACKER = '0x00000000000000000000000000000000000000ff';
    const { req, res } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx, publishAsync } = mockCtx({ requestAgentAddress: SUBMITTER });
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      publishOptions: { accessPolicy: 'public', admittedByAgentAddress: ATTACKER },
    });
    await handler(attachRequest(ctx, req, res));
    const opts = publishAsync.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.admittedByAgentAddress).toBe(SUBMITTER);
    expect(opts.admittedByAgentAddress).not.toBe(ATTACKER);
    // Ordinary options still forward untouched.
    expect(opts.accessPolicy).toBe('public');
  });

  it('forwards factoryOptions.publishOptions to agent.publishAsync', async () => {
    const { req, res } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx, publishAsync } = mockCtx();
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      publishOptions: { accessPolicy: 'public', subGraphName: 'streams' },
    });
    await handler(attachRequest(ctx, req, res));
    // The authenticated submitter is stamped alongside the forwarded options: a Kafka stream
    // request is externally authenticated, so its job must be owned by the agent that sent it
    // rather than by the node default.
    expect(publishAsync.mock.calls[0][2]).toEqual({
      accessPolicy: 'public',
      subGraphName: 'streams',
      admittedByAgentAddress: '0x0000000000000000000000000000000000000000',
    });
  });
});
describe('handler — POST /register error paths', () => {
  it('returns 503 PluginMisconfigured when no contextGraphId resolves', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: 'PluginMisconfigured' });
  });
  it('returns 503 PublisherUnavailable when the publisher runtime is absent', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx } = mockCtx({ publisherState: { runtime: null, availability: { available: false } } });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: 'PublisherUnavailable' });
  });
  it('returns 503 PublisherUnavailable when walletIds is empty', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx } = mockCtx({ publisherState: { runtime: { walletIds: [] }, availability: { available: true } } });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: 'PublisherUnavailable' });
  });
  it('returns 400 InvalidContent on Zod validation failure with details array', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', { name: 'only-name' });
    const { ctx } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({ error: 'InvalidContent' });
    expect(Array.isArray((captured.body as Record<string, unknown>).details)).toBe(true);
  });
  it('returns 400 InvalidContent when body has unknown keys (e.g. caller-supplied contextGraphId)', async () => {
    const body = { ...validBody, contextGraphId: 'urn:cg:bypass' };
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', body);
    const { ctx } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({ error: 'InvalidContent' });
  });
  it('returns 400 InvalidContent when body is not valid JSON', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register');
    const reqStream = Readable.from([Buffer.from('not-json')]) as unknown as IncomingMessage;
    (reqStream as unknown as Record<string, unknown>).method = 'POST';
    (reqStream as unknown as Record<string, unknown>).url = '/api/kafka/streams/register';
    (reqStream as unknown as Record<string, unknown>).headers = { host: 'localhost' };
    const { ctx } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, reqStream as never, res));
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({ error: 'InvalidContent' });
  });
  it('returns 404 ContextGraphNotFound when publishAsync throws a ContextGraphNotFound typed error', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx, publishAsync } = mockCtx();
    const err = Object.assign(new Error('cg missing'), { code: 'ContextGraphNotFound' });
    publishAsync.mockRejectedValueOnce(err);
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toMatchObject({ error: 'ContextGraphNotFound' });
  });
  it('returns 503 EnqueueFailed when publishAsync throws an unexpected error', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx, publishAsync } = mockCtx();
    publishAsync.mockRejectedValueOnce(new Error('boom'));
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: 'EnqueueFailed', message: 'boom' });
  });
  it('returns 400 InvalidContent when publishAsync throws an error tagged with code "InvalidContent"', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx, publishAsync } = mockCtx();
    const err = Object.assign(new Error('bad content'), { code: 'InvalidContent' });
    publishAsync.mockRejectedValueOnce(err);
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({ error: 'InvalidContent', message: 'bad content' });
  });
  it('returns 400 InvalidContent when publishAsync throws an error whose name is "InvalidContentError"', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx, publishAsync } = mockCtx();
    const err = Object.assign(new Error('bad content'), { name: 'InvalidContentError' });
    publishAsync.mockRejectedValueOnce(err);
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({ error: 'InvalidContent', message: 'bad content' });
  });
});
describe('handler — GET /register/:captureID', () => {
  it('returns 200 with shape matching the PRD when the job is found', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register/cap-1');
    const { ctx, getStatus } = mockCtx();
    getStatus.mockResolvedValueOnce({
      status: 'finalized',
      request: {
        jobType: 'lift',
        lift: { contextGraphId: 'urn:cg:demo' },
      },
      timestamps: { acceptedAt: 1700000000000, finalizedAt: 1700000005000 },
      finalization: { ual: 'did:dkg:1/0xabc' },
    });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      captureID: 'cap-1',
      state: 'finalized',
      contextGraphId: 'urn:cg:demo',
      ual: 'did:dkg:1/0xabc',
      receivedAt: new Date(1700000000000).toISOString(),
      finalizedAt: new Date(1700000005000).toISOString(),
      error: null,
    });
  });
  it('returns nulls for ual and finalizedAt when the job is still pending', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register/cap-2');
    const { ctx, getStatus } = mockCtx();
    getStatus.mockResolvedValueOnce({
      status: 'accepted',
      request: { contextGraphId: 'urn:cg:demo' },
      timestamps: { acceptedAt: 1700000000000 },
    });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      state: 'accepted',
      ual: null,
      finalizedAt: null,
      error: null,
    });
  });
  it('accepts named KA VM publish job request envelopes when checking capture ownership', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register/cap-ka');
    const { ctx, getStatus } = mockCtx();
    getStatus.mockResolvedValueOnce({
      status: 'accepted',
      request: {
        jobType: 'knowledge-asset-vm-publish',
        knowledgeAssetVmPublish: {
          contextGraphId: 'urn:cg:demo',
          subGraphName: 'streams',
        },
      },
      timestamps: { acceptedAt: 1700000000000 },
    });
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      publishOptions: { subGraphName: 'streams' },
    });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      captureID: 'cap-ka',
      state: 'accepted',
      contextGraphId: 'urn:cg:demo',
    });
  });
  it('returns error message when state is failed', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register/cap-3');
    const { ctx, getStatus } = mockCtx();
    getStatus.mockResolvedValueOnce({
      status: 'failed',
      request: { contextGraphId: 'urn:cg:demo' },
      timestamps: { acceptedAt: 1700000000000 },
      failure: { message: 'tx reverted' },
    });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(200);
    expect((captured.body as Record<string, unknown>).error).toBe('tx reverted');
  });
  it('returns 404 CaptureNotFound when publisherControl.getStatus returns null', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register/missing');
    const { ctx, getStatus } = mockCtx();
    getStatus.mockResolvedValueOnce(null);
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toMatchObject({ error: 'CaptureNotFound' });
  });
  it('maps publisherControl.getStatus failures to structured JSON', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register/cap-err');
    const { ctx, getStatus } = mockCtx();
    getStatus.mockRejectedValueOnce(new Error('status store down'));
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: 'StatusLookupFailed', message: 'status store down' });
  });
  it.each([
    ['another context graph', { contextGraphId: 'urn:cg:other' }, {}],
    ['another sub-graph', { contextGraphId: 'urn:cg:demo', subGraphName: 'private' }, { subGraphName: 'streams' }],
  ])('returns 404 CaptureNotFound when capture belongs to %s', async (_label, request, publishOptions) => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register/cap-other');
    const { ctx, getStatus } = mockCtx();
    getStatus.mockResolvedValueOnce({
      status: 'finalized',
      request,
      timestamps: { acceptedAt: 1700000000000 },
      finalization: { ual: 'did:dkg:1/0xabc' },
    });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo', publishOptions });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toMatchObject({ error: 'CaptureNotFound' });
  });
  it('returns 404 CaptureNotFound when captureID segment is empty', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register/');
    const { ctx } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toMatchObject({ error: 'CaptureNotFound' });
  });
  it('decodes percent-encoded captureID before lookup', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register/cap%2Fone');
    const { ctx, getStatus } = mockCtx();
    getStatus.mockResolvedValueOnce({
      status: 'accepted',
      request: { contextGraphId: 'urn:cg:demo' },
      timestamps: { acceptedAt: 1700000000000 },
    });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(getStatus).toHaveBeenCalledWith('cap/one');
    expect(captured.statusCode).toBe(200);
  });
});
describe('handler — unmatched routes', () => {
  it('does not claim the response when the path is outside basePath', async () => {
    const { req, res, captured } = mockReqRes('POST', '/api/something/else', {});
    const { ctx } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.writableEnded).toBe(false);
    expect(captured.headersSent).toBe(false);
  });
});
describe('handler — GET / (list)', () => {
  const samplePageBindings = [
    {
      ual: 'did:dkg:1/0xaaa',
      root: 'urn:entity:aaa',
      contentGraph: 'did:dkg:context-graph:urn:cg:demo/_private/0xaaa/1/assertions/1',
    },
    {
      ual: 'did:dkg:1/0xbbb',
      root: 'urn:entity:bbb',
      contentGraph: 'did:dkg:context-graph:urn:cg:demo/_private/0xbbb/2/assertions/1',
    },
  ];
  const sampleListBindings = [
    { ual: 'did:dkg:1/0xaaa', root: 'urn:entity:aaa', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
    { ual: 'did:dkg:1/0xaaa', root: 'urn:entity:aaa', p: 'https://schema.org/name', o: '"stream-a"' },
    { ual: 'did:dkg:1/0xaaa', root: 'urn:entity:aaa', p: 'https://ontology.dkg.io/streams#kafkaBootstrapUrl', o: '"kafka://a:9092"' },
    { ual: 'did:dkg:1/0xaaa', root: 'urn:entity:aaa', p: 'https://ontology.dkg.io/streams#kafkaTopicName', o: '"topic-a"' },
    { ual: 'did:dkg:1/0xbbb', root: 'urn:entity:bbb', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
    { ual: 'did:dkg:1/0xbbb', root: 'urn:entity:bbb', p: 'https://schema.org/name', o: '"stream-b"' },
    { ual: 'did:dkg:1/0xbbb', root: 'urn:entity:bbb', p: 'https://ontology.dkg.io/streams#kafkaBootstrapUrl', o: '"kafka://b:9092"' },
    { ual: 'did:dkg:1/0xbbb', root: 'urn:entity:bbb', p: 'https://ontology.dkg.io/streams#kafkaTopicName', o: '"topic-b"' },
  ];
  it('returns 200 with paginated items + total from count query', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams');
    const { ctx, query } = mockCtx();
    query.mockResolvedValueOnce({ bindings: [{ count: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }] });
    query.mockResolvedValueOnce({ bindings: samplePageBindings });
    query.mockResolvedValueOnce({ bindings: sampleListBindings });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(200);
    const body = captured.body as { items: Array<Record<string, unknown>>; limit: number; offset: number; total: number };
    expect(body.limit).toBe(30);
    expect(body.offset).toBe(0);
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    const ids = body.items.map((it) => it['@id']);
    expect(ids).toEqual(expect.arrayContaining(['did:dkg:1/0xaaa', 'did:dkg:1/0xbbb']));
    const a = body.items.find((it) => it['@id'] === 'did:dkg:1/0xaaa');
    expect(a).toMatchObject({
      '@type': 'dkg-streams:KafkaStream',
      'schema:name': 'stream-a',
      'dkg-streams:kafkaBootstrapUrl': 'kafka://a:9092',
      'dkg-streams:kafkaTopicName': 'topic-a',
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toContain('VALUES (?ual ?root ?contentGraph)');
  });
  it('scopes both queries to the configured contextGraphId', async () => {
    const { req, res } = mockReqRes('GET', '/api/kafka/streams');
    const { ctx, query } = mockCtx();
    query.mockResolvedValueOnce({ bindings: [{ count: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }] });
    query.mockResolvedValueOnce({ bindings: [] });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler({ ...attachRequest(ctx, req, res), requestAgentAddress: '0x0000000000000000000000000000000000000001' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toMatchObject({
      contextGraphId: 'urn:cg:demo',
      callerAgentAddress: '0x0000000000000000000000000000000000000001',
      includePrivate: true,
    });
    expect(query.mock.calls[1][1]).toMatchObject({
      contextGraphId: 'urn:cg:demo',
      callerAgentAddress: '0x0000000000000000000000000000000000000001',
      includePrivate: true,
    });
    for (const call of query.mock.calls) {
      expect(call[0]).toContain('GRAPH <did:dkg:context-graph:urn:cg:demo/_meta>');
      expect(call[0]).toContain(
        '(<did:dkg:context-graph:urn:cg:demo> <did:dkg:context-graph:urn:cg:demo>',
      );
    }
  });
  it('uses root meta and publishOptions.subGraphName data graph URIs for discovery queries', async () => {
    const { req, res } = mockReqRes('GET', '/api/kafka/streams');
    const { ctx, query } = mockCtx();
    query.mockResolvedValueOnce({ bindings: [{ count: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }] });
    query.mockResolvedValueOnce({ bindings: [] });
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      publishOptions: { subGraphName: 'streams' },
    });
    await handler(attachRequest(ctx, req, res));
    expect(query).toHaveBeenCalledTimes(2);
    for (const call of query.mock.calls) {
      expect(call[0]).toContain('GRAPH <did:dkg:context-graph:urn:cg:demo/_meta>');
      expect(call[0]).toContain(
        '(<did:dkg:context-graph:urn:cg:demo/streams> <did:dkg:context-graph:urn:cg:demo/streams>',
      );
      expect(call[0]).not.toContain('GRAPH <did:dkg:context-graph:urn:cg:demo/streams/_meta>');
    }
  });
  it('returns 500 PluginMisconfigured when publishOptions.subGraphName is invalid', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams');
    const { ctx, query } = mockCtx();
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      publishOptions: { subGraphName: 'bad/streams' },
    });
    await expect(handler(attachRequest(ctx, req, res))).resolves.toBeUndefined();
    expect(captured.statusCode).toBe(500);
    expect(captured.body).toMatchObject({
      error: 'PluginMisconfigured',
      message: expect.stringContaining('Invalid subGraphName'),
    });
    expect(query).not.toHaveBeenCalled();
  });
  it('forwards explicit ?limit=1000 unchanged (no cap reduction needed)', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams?limit=1000');
    const { ctx, query } = mockCtx();
    query.mockResolvedValueOnce({ bindings: [{ count: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }] });
    query.mockResolvedValueOnce({ bindings: [] });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(200);
    expect((captured.body as { limit: number }).limit).toBe(1000);
    expect(query.mock.calls[1][0]).toContain('LIMIT 1000 OFFSET 0');
  });
  it('clamps ?limit=2000 to 1000 in both response and SPARQL', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams?limit=2000');
    const { ctx, query } = mockCtx();
    query.mockResolvedValueOnce({ bindings: [{ count: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }] });
    query.mockResolvedValueOnce({ bindings: [] });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(200);
    expect((captured.body as { limit: number }).limit).toBe(1000);
    expect(query.mock.calls[1][0]).toContain('LIMIT 1000 OFFSET 0');
  });
  it('returns empty items + total 0 when the CG has no kafka streams', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams');
    const { ctx, query } = mockCtx();
    query.mockResolvedValueOnce({ bindings: [{ count: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }] });
    query.mockResolvedValueOnce({ bindings: [] });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ items: [], limit: 30, offset: 0, total: 0 });
  });
  it('returns 400 when ?limit is invalid', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams?limit=-3');
    const { ctx } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({ error: 'InvalidContent' });
  });
  it('returns 503 PluginMisconfigured when no contextGraphId resolves', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams');
    const { ctx } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: 'PluginMisconfigured' });
  });
});
describe('handler — GET /:ual (single)', () => {
  it('returns 200 with raw JSON-LD KA for a known UAL — UAL distinct from RDF root subject', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/did:dkg:1/0xabc');
    const { ctx, query } = mockCtx();
    query.mockResolvedValueOnce({
      bindings: [
        { root: 'urn:entity:demo-root', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
        { root: 'urn:entity:demo-root', p: 'https://schema.org/name', o: '"demo"' },
        { root: 'urn:entity:demo-root', p: 'https://ontology.dkg.io/streams#kafkaBootstrapUrl', o: '"kafka://broker:9092"' },
        { root: 'urn:entity:demo-root', p: 'https://ontology.dkg.io/streams#kafkaTopicName', o: '"demo-topic"' },
      ],
    });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler({ ...attachRequest(ctx, req, res), requestAgentAddress: '0x0000000000000000000000000000000000000001' });
    expect(captured.statusCode).toBe(200);
    const body = captured.body as Record<string, unknown>;
    expect(body['@type']).toBe('dkg-streams:KafkaStream');
    expect(body['@id']).toBe('did:dkg:1/0xabc');
    expect(body['schema:name']).toBe('demo');
    expect(body['dkg-streams:kafkaBootstrapUrl']).toBe('kafka://broker:9092');
    expect(body['dkg-streams:kafkaTopicName']).toBe('demo-topic');
    expect(query.mock.calls[0][1]).toMatchObject({
      contextGraphId: 'urn:cg:demo',
      callerAgentAddress: '0x0000000000000000000000000000000000000001',
      includePrivate: true,
    });
    expect(query.mock.calls[0][0]).toContain('<did:dkg:1/0xabc>');
    expect(query.mock.calls[0][0]).toContain('GRAPH <did:dkg:context-graph:urn:cg:demo/_meta>');
    expect(query.mock.calls[0][0]).toContain(
      '(<did:dkg:context-graph:urn:cg:demo> <did:dkg:context-graph:urn:cg:demo>',
    );
  });
  it('uses root meta and publishOptions.subGraphName data graph URIs for single-UAL discovery', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/did:dkg:1/0xabc');
    const { ctx, query } = mockCtx();
    query.mockResolvedValueOnce({
      bindings: [
        { root: 'urn:entity:demo-root', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      ],
    });
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      publishOptions: { subGraphName: 'streams' },
    });
    await handler({ ...attachRequest(ctx, req, res), requestAgentAddress: '0x0000000000000000000000000000000000000001' });
    expect(captured.statusCode).toBe(200);
    expect(query.mock.calls[0][0]).toContain('GRAPH <did:dkg:context-graph:urn:cg:demo/_meta>');
    expect(query.mock.calls[0][0]).toContain(
      '(<did:dkg:context-graph:urn:cg:demo/streams> <did:dkg:context-graph:urn:cg:demo/streams>',
    );
    expect(query.mock.calls[0][0]).not.toContain('GRAPH <did:dkg:context-graph:urn:cg:demo/streams/_meta>');
  });
  it('returns 404 StreamNotFound when no bindings are returned for the UAL', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/did:dkg:1/0xmissing');
    const { ctx, query } = mockCtx();
    query.mockResolvedValueOnce({ bindings: [] });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toMatchObject({ error: 'StreamNotFound' });
  });
  it('does NOT route /register or /register/:captureID to the single-fetch handler', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register/cap-1');
    const { ctx, getStatus, query } = mockCtx();
    getStatus.mockResolvedValueOnce({
      status: 'accepted',
      request: { contextGraphId: 'urn:cg:demo' },
      timestamps: { acceptedAt: 1700000000000 },
    });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(200);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
  it('does NOT treat GET /register as UAL "register" (no agent.query, no 200)', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/register');
    const { ctx, query, getStatus } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(query).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
    expect(captured.statusCode).not.toBe(200);
  });
  it('returns 503 PluginMisconfigured when no contextGraphId resolves', async () => {
    const { req, res, captured } = mockReqRes('GET', '/api/kafka/streams/did:dkg:1/0xabc');
    const { ctx } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: 'PluginMisconfigured' });
  });
  it('decodes percent-encoded UAL before issuing the query', async () => {
    const encoded = encodeURIComponent('did:dkg:1/0xabc');
    const { req, res, captured } = mockReqRes('GET', `/api/kafka/streams/${encoded}`);
    const { ctx, query } = mockCtx();
    query.mockResolvedValueOnce({
      bindings: [
        { root: 'urn:entity:1', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'https://ontology.dkg.io/streams#KafkaStream' },
      ],
    });
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(200);
    expect(query.mock.calls[0][0]).toContain('<did:dkg:1/0xabc>');
  });
});
describe('handler — discovery query failures', () => {
  it.each([
    ['list', '/api/kafka/streams'],
    ['single', '/api/kafka/streams/did:dkg:1/0xabc'],
  ])('returns 503 QueryFailed when %s query rejects', async (_label, path) => {
    const { req, res, captured } = mockReqRes('GET', path);
    const { ctx, query } = mockCtx();
    query.mockRejectedValue(new Error('query backend down'));
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo' });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: 'QueryFailed', message: 'query backend down' });
  });
});
describe('handler — register-to-discovery regression', () => {
  it('publishes KafkaStream KAs private by default and discovery queries follow the public anchor', async () => {
    const cgId = 'urn:cg:demo';
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', validBody);
    const { ctx, publishAsync } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: cgId });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(202);
    const [, content] = publishAsync.mock.calls[0];
    expect(content).toHaveProperty('private');
    expect(content).toHaveProperty('public');
    expect((content.private as Record<string, unknown>)['@type']).toBe('dkg-streams:KafkaStream');
    expect((content.public as Record<string, unknown>)['@id']).toBe(
      (content.private as Record<string, unknown>)['@id'],
    );
    const expectedPublicGraph = `(<did:dkg:context-graph:${cgId}> <did:dkg:context-graph:${cgId}>`;
    const expectedPrivateGraph = `(<did:dkg:context-graph:${cgId}> <did:dkg:context-graph:${cgId}/_private>`;
    expect(buildListQuery({ contextGraphId: cgId, limit: 30, offset: 0 })).toContain(expectedPublicGraph);
    expect(buildListQuery({ contextGraphId: cgId, limit: 30, offset: 0 })).toContain(expectedPrivateGraph);
    expect(buildSingleByUalQuery({ contextGraphId: cgId, ual: 'did:dkg:1/0xabc' })).toContain(expectedPublicGraph);
    expect(buildSingleByUalQuery({ contextGraphId: cgId, ual: 'did:dkg:1/0xabc' })).toContain(expectedPrivateGraph);
  });
});
import { z } from 'zod';
describe('handler — POST /register with extension', () => {
  const extension = {
    schema: z.object({ externalRef: z.string(), sourceRef: z.string() }),
    augment: (parsed: { externalRef: string; sourceRef: string }) => ({
      'vendor:externalRef': parsed.externalRef,
      'vendor:sourceRef': parsed.sourceRef,
    }),
  };
  it('accepts a body merging core + extension fields and publishes augmented KA', async () => {
    const body = {
      ...validBody,
      externalRef: 'ref-alpha',
      sourceRef: 'source-1',
    };
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', body);
    const { ctx, publishAsync } = mockCtx();
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      extension,
    });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(202);
    expect(publishAsync).toHaveBeenCalledTimes(1);
    const [, content] = publishAsync.mock.calls[0];
    expect(content).toHaveProperty('private');
    expect(content).toHaveProperty('public');
    const ka = content.private as Record<string, unknown>;
    expect(ka['@type']).toBe('dkg-streams:KafkaStream');
    expect(ka['schema:name']).toBe('demo');
    expect(ka['dkg-streams:kafkaBootstrapUrl']).toBe('kafka://broker:9092');
    expect(ka['dkg-streams:kafkaTopicName']).toBe('demo-topic');
    expect(ka['vendor:externalRef']).toBe('ref-alpha');
    expect(ka['vendor:sourceRef']).toBe('source-1');
  });
  it('rejects body missing an extension-required field as 400 InvalidContent', async () => {
    const body = { ...validBody, externalRef: 'ref-alpha' }; // missing sourceRef
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', body);
    const { ctx, publishAsync } = mockCtx();
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      extension,
    });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({ error: 'InvalidContent' });
    expect(publishAsync).not.toHaveBeenCalled();
  });
  it('rejects unknown keys outside the merged schema (strict mode)', async () => {
    const body = { ...validBody, externalRef: 'a', sourceRef: 'd', stray: 'x' };
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', body);
    const { ctx } = mockCtx();
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      extension,
    });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({ error: 'InvalidContent' });
  });
  it('passes only the extension fields to extension.augment (not the whole body)', async () => {
    const augmentSpy = vi.fn().mockReturnValue({});
    const ext = {
      schema: z.object({ externalRef: z.string(), sourceRef: z.string() }),
      augment: augmentSpy,
    };
    const body = { ...validBody, externalRef: 'ref-alpha', sourceRef: 'source-1' };
    const { req, res } = mockReqRes('POST', '/api/kafka/streams/register', body);
    const { ctx } = mockCtx();
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      extension: ext,
    });
    await handler(attachRequest(ctx, req, res));
    expect(augmentSpy).toHaveBeenCalledTimes(1);
    const arg = augmentSpy.mock.calls[0][0];
    expect(arg).toEqual({ externalRef: 'ref-alpha', sourceRef: 'source-1' });
    expect(arg).not.toHaveProperty('name');
    expect(arg).not.toHaveProperty('kafkaBootstrapUrl');
  });
  it('maps extension augment failures to 400 InvalidContent', async () => {
    const ext = {
      schema: z.object({ externalRef: z.string(), sourceRef: z.string() }),
      augment: () => { throw new Error('extension says no'); },
    };
    const body = { ...validBody, externalRef: 'ref-alpha', sourceRef: 'source-1' };
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', body);
    const { ctx, publishAsync } = mockCtx();
    const handler = createHandler({ basePath: '/api/kafka/streams', contextGraphId: 'urn:cg:demo', extension: ext });
    await handler(attachRequest(ctx, req, res));
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({ error: 'InvalidContent', message: 'extension says no' });
    expect(publishAsync).not.toHaveBeenCalled();
  });
});
describe('handler — extension runtime collision (one warn per unique key across requests)', () => {
  it('drops collision keys and warns exactly once per unique key across N requests', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ext = {
      schema: z.object({ externalRef: z.string() }),
      augment: (_p: { externalRef: string }) => ({
        'schema:name': 'OVERRIDE_NAME',
        'dkg-streams:kafkaTopicName': 'OVERRIDE_TOPIC',
        'vendor:ok': 'ok',
      }),
    };
    const handler = createHandler({
      basePath: '/api/kafka/streams',
      contextGraphId: 'urn:cg:demo',
      extension: ext,
    });
    const ctxs: Array<{ publishAsync: ReturnType<typeof vi.fn> }> = [];
    for (let i = 0; i < 4; i++) {
      const body = { ...validBody, externalRef: `t${i}` };
      const { req, res } = mockReqRes('POST', '/api/kafka/streams/register', body);
      const { ctx, publishAsync } = mockCtx();
      ctxs.push({ publishAsync });
      await handler(attachRequest(ctx, req, res));
    }
    for (const { publishAsync } of ctxs) {
      const ka = publishAsync.mock.calls[0][1].private as Record<string, unknown>;
      expect(ka['schema:name']).toBe('demo');
      expect(ka['dkg-streams:kafkaTopicName']).toBe('demo-topic');
      expect(ka['vendor:ok']).toBe('ok');
    }
    const allWarns = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(allWarns.filter((m) => m.includes('schema:name'))).toHaveLength(1);
    expect(allWarns.filter((m) => m.includes('dkg-streams:kafkaTopicName'))).toHaveLength(1);
    warnSpy.mockRestore();
  });
});
