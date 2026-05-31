import { describe, it, expect, vi, afterEach } from 'vitest';
import { RemoteSparqlSource } from '../src/data-sources/remote-sparql-source.js';

// ───────────────────────────────────────────────────────────────────────────
// Regression (#789 follow-up — Bug 4): RemoteSparqlSource form-encoded queries.
//
// Same defect class as the Blazegraph / SPARQL-HTTP storage adapters: the viz
// source POSTed `application/x-www-form-urlencoded` with `query=<encoded>`,
// which trips Jetty's default 200 KB form-content limit on Blazegraph
// (HTTP 400 "Unable to parse form content") for large queries. The fix uses the
// W3C SPARQL 1.1 Protocol "query via POST directly" form: raw query body with
// `Content-Type: application/sparql-query`, which has no form-size cap.
// ───────────────────────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function stubFetch(responder: () => Response): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responder();
  }));
  return { calls };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RemoteSparqlSource — W3C direct POST transport (Bug 4)', () => {
  const source = new RemoteSparqlSource({ endpoint: 'http://blazegraph.test/sparql' });

  it('select() POSTs the raw query with Content-Type application/sparql-query', async () => {
    const { calls } = stubFetch(() => jsonResponse({ head: { vars: ['s'] }, results: { bindings: [] } }));
    const sparql = 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1';

    await source.select(sparql);

    expect(calls).toHaveLength(1);
    const { init } = calls[0];
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe('POST');
    expect(headers['Content-Type']).toBe('application/sparql-query');
    expect(headers['Accept']).toBe('application/sparql-results+json');
    // Body is the raw query — NOT form-encoded.
    expect(init.body).toBe(sparql);
    expect(String(init.body)).not.toMatch(/^query=/);
    expect(String(init.body)).not.toContain('%20');
  });

  it('construct() POSTs the raw query with the n-triples Accept header', async () => {
    const { calls } = stubFetch(() => textResponse('<urn:s> <urn:p> <urn:o> .'));
    const sparql = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';

    const result = await source.construct(sparql);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].init.method).toBe('POST');
    expect(headers['Content-Type']).toBe('application/sparql-query');
    expect(headers['Accept']).toBe('application/n-triples');
    expect(calls[0].init.body).toBe(sparql);
    expect(result.triples).toHaveLength(1);
  });

  it('sends large queries verbatim (no form-encoding size blow-up)', async () => {
    const { calls } = stubFetch(() => jsonResponse({ head: { vars: ['s'] }, results: { bindings: [] } }));
    // A query big enough that form-encoding would have pushed it over the
    // ~200 KB Jetty form limit (URL-encoding inflates further). Direct POST
    // sends it byte-for-byte.
    const values = Array.from({ length: 12_000 }, (_, i) => `<urn:item:${i}>`).join(' ');
    const sparql = `SELECT ?s WHERE { VALUES ?s { ${values} } ?s ?p ?o }`;
    // Raw query already ~190 KB; the old `query=<percent-encoded>` form would
    // inflate `<`/`>`/spaces ~3× and sail well past Jetty's ~200 KB form cap.
    expect(sparql.length).toBeGreaterThan(150_000);

    await source.select(sparql);

    expect(calls[0].init.body).toBe(sparql);
    // The exact bytes are sent; nothing prepends `query=` or percent-encodes.
    expect(String(calls[0].init.body)).not.toMatch(/^query=/);
    expect(String(calls[0].init.body)).not.toContain('%3C');
  });

  it('propagates caller headers without overriding the SPARQL content type', async () => {
    const authed = new RemoteSparqlSource({
      endpoint: 'http://blazegraph.test/sparql',
      headers: { Authorization: 'Bearer xyz' },
    });
    const { calls } = stubFetch(() => jsonResponse({ head: { vars: [] }, results: { bindings: [] } }));

    await authed.select('SELECT ?s WHERE { ?s ?p ?o }');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer xyz');
    expect(headers['Content-Type']).toBe('application/sparql-query');
  });

  it('does NOT let caller headers override the protocol Content-Type/Accept', async () => {
    // The raw-body transport requires `application/sparql-query`; a caller that
    // (accidentally) supplies a form-encoded Content-Type must not be able to
    // recreate the large-query regression.
    const overriding = new RemoteSparqlSource({
      endpoint: 'http://blazegraph.test/sparql',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/csv',
      },
    });
    const { calls } = stubFetch(() => jsonResponse({ head: { vars: [] }, results: { bindings: [] } }));

    await overriding.select('SELECT ?s WHERE { ?s ?p ?o }');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/sparql-query');
    expect(headers['Accept']).toBe('application/sparql-results+json');
  });
});
