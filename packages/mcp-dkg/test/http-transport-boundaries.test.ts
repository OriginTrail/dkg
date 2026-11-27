import { afterEach, describe, expect, it, vi } from 'vitest';
import { DkgClient, DkgHttpError, DkgOutcomeUnknownError } from '../src/client.js';
import { makeConfig } from './harness.js';

afterEach(() => vi.restoreAllMocks());

describe('daemon HTTP response boundaries', () => {
  it.each([
    ['{"error":"denied"}', { error: 'denied' }, 'denied'],
    ['{"reason":"unavailable"}', { reason: 'unavailable' }, '{"reason":"unavailable"}'],
    ['proxy is down', { raw: 'proxy is down' }, '{"raw":"proxy is down"}'],
    ['', undefined, 'undefined'],
  ])('retains status and diagnostic body for %j', async (body, parsed, detail) => {
    const client = new DkgClient({ config: makeConfig(), fetcher: async () => new Response(body as string, { status: 503 }) });
    await expect(client.getStatus()).rejects.toMatchObject({ name: 'DkgHttpError', status: 503, body: parsed,
      message: `GET /api/status → 503: ${detail}` });
  });

  it.each([['', undefined], ['non-JSON diagnostic', { raw: 'non-JSON diagnostic' }]])
    ('preserves successful non-JSON response semantics (%j)', async (body, expected) => {
      const client = new DkgClient({ config: makeConfig({ token: '' }), fetcher: async () => new Response(body as string) });
      await expect(client.getStatus()).resolves.toEqual(expected);
    });

  it('sets bearer and JSON headers only where needed, and normalizes a trailing API slash', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    const client = new DkgClient({ config: makeConfig({ api: 'http://localhost:9200/' }), fetcher });
    await client.getStatus();
    await client.query({ sparql: 'SELECT * WHERE {}', contextGraphId: 'team' });
    expect(fetcher.mock.calls[0]).toEqual(['http://localhost:9200/api/status', {
      method: 'GET', headers: { Authorization: 'Bearer test-token' }, body: undefined, signal: expect.any(AbortSignal),
    }]);
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' });
    const unauthenticated = new DkgClient({ config: makeConfig({ token: '' }), fetcher });
    await unauthenticated.getStatus();
    expect(fetcher.mock.calls[2][1]?.headers).toEqual({});
  });

  it('does not replace a definite HTTP rejection with outcome-unknown after the deadline', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const client = new DkgClient({ config: makeConfig(), fetcher: async () => {
      controller.abort();
      return new Response('{"error":"invalid asset"}', { status: 422 });
    } });
    await expect(client.knowledgeAssetShare({ contextGraphId: 'team', name: 'asset' }))
      .rejects.toMatchObject({ name: 'DkgHttpError', status: 422, body: { error: 'invalid asset' } });
  });

  it('preserves an opaque transport failure even if inspecting its cause throws', async () => {
    const error = new Error('transport failure');
    Object.defineProperty(error, 'cause', { get() { throw new Error('unreadable cause'); } });
    const client = new DkgClient({ config: makeConfig(), fetcher: async () => { throw error; } });
    await expect(client.knowledgeAssetShare({ contextGraphId: 'team', name: 'asset' })).rejects.toBe(error);
  });
});

describe('multipart import boundaries', () => {
  it.each([true, false])('sends exact bytes and form fields with authentication=%s', async authenticated => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"imported":true}'));
    const client = new DkgClient({ config: makeConfig({ token: authenticated ? 'secret-token' : '' }), fetcher });
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    await expect(client.importAssertionFile({ contextGraphId: 'did:dkg:context-graph:team', assertionName: 'report/a b',
      fileBuffer: bytes, fileName: 'report.bin', contentType: 'application/x-test', ontologyRef: 'urn:ontology', subGraphName: 'docs' }))
      .resolves.toEqual({ imported: true });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/knowledge-assets/report%2Fa%20b/wm/import-file');
    expect(init?.headers).toEqual({ Accept: 'application/json', ...(authenticated ? { Authorization: 'Bearer secret-token' } : {}) });
    const form = init?.body as FormData;
    expect([...form.keys()].sort()).toEqual(['contentType', 'contextGraphId', 'file', 'ontologyRef', 'subGraphName']);
    expect(form.get('contextGraphId')).toBe('team');
    expect(form.get('ontologyRef')).toBe('urn:ontology');
    expect(form.get('subGraphName')).toBe('docs');
    const file = form.get('file') as File;
    expect(file.name).toBe('report.bin');
    expect(file.type).toBe('application/x-test');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(bytes).toEqual(new Uint8Array([0, 1, 127, 128, 255]));
  });

  it.each(['raw proxy error', '{"error":"too large"}'])('retains a rejected upload body (%j)', async body => {
    const client = new DkgClient({ config: makeConfig(), fetcher: async () => new Response(body, { status: 413 }) });
    await expect(client.importAssertionFile({ contextGraphId: 'team', assertionName: 'asset', fileBuffer: new Uint8Array(), fileName: 'empty.bin' }))
      .rejects.toMatchObject({ name: 'DkgHttpError', status: 413, body: body.startsWith('{') ? { error: 'too large' } : body });
  });

  it('keeps the HTTP status when the rejected upload response body cannot be read', async () => {
    const response = new Response(null, { status: 502 });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('broken response body'));
    const client = new DkgClient({ config: makeConfig(), fetcher: async () => response });
    await expect(client.importAssertionFile({ contextGraphId: 'team', assertionName: 'asset', fileBuffer: new Uint8Array(), fileName: 'empty.bin' }))
      .rejects.toMatchObject({ name: 'DkgHttpError', status: 502, body: '' });
  });

  it('reports a body-stream timeout on a long upload as outcome unknown', async () => {
    const response = new Response('{}');
    vi.spyOn(response, 'json').mockRejectedValue(Object.assign(new Error('stream timed out'), { cause: { code: 'UND_ERR_BODY_TIMEOUT' } }));
    const client = new DkgClient({ config: makeConfig(), fetcher: async () => response });
    const rejection = client.importAssertionFile({ contextGraphId: 'team', assertionName: 'asset', fileBuffer: new Uint8Array(), fileName: 'empty.bin' });
    await expect(rejection).rejects.toBeInstanceOf(DkgOutcomeUnknownError);
    await expect(rejection).rejects.not.toBeInstanceOf(DkgHttpError);
  });
});
