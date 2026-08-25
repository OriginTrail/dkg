import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SparqlHttpResponseError,
  SparqlHttpStore,
  isSparqlHttpResponseError,
} from '../src/adapters/sparql-http.js';

// GH#1758 / PR #2330 review — the daemon route classifies malformed SPARQL by
// reading `status` off the thrown error. That only holds if the adapter really
// throws the typed error for a non-OK upstream response, so this pins the seam
// against a real HTTP endpoint. Without it, a change to the adapter's error
// shape would silently push invalid SPARQL back to HTTP 500 while every
// classifier unit test stayed green.
describe('SparqlHttpStore — typed non-OK responses (GH#1758)', () => {
  let server: Server;
  let endpoint: string;
  let respond: { status: number; body: string };

  beforeEach(async () => {
    respond = { status: 400, body: 'error at 1:15: expected one of REDUCED, [_]' };
    server = createServer((_req, res) => {
      res.writeHead(respond.status, { 'Content-Type': 'text/plain' });
      res.end(respond.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    endpoint = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function queryError(): Promise<unknown> {
    const store = new SparqlHttpStore({ queryEndpoint: endpoint, updateEndpoint: endpoint });
    try {
      await store.query('SELECT WHERE {');
      return undefined;
    } catch (err) {
      return err;
    }
  }

  it('throws a typed error carrying the upstream 400 for a parse failure', async () => {
    const err = await queryError();
    expect(isSparqlHttpResponseError(err)).toBe(true);
    expect((err as SparqlHttpResponseError).status).toBe(400);
    expect((err as SparqlHttpResponseError).operation).toBe('query');
    expect((err as SparqlHttpResponseError).responseExcerpt).toContain('error at 1:15');
  });

  it('carries the upstream status for a store-rejects-us response', async () => {
    respond = { status: 401, body: 'Unauthorized' };
    const err = await queryError();
    expect(isSparqlHttpResponseError(err)).toBe(true);
    expect((err as SparqlHttpResponseError).status).toBe(401);
  });

  it('carries the upstream status for a throttling response', async () => {
    respond = { status: 429, body: 'slow down' };
    expect((await queryError() as SparqlHttpResponseError).status).toBe(429);
  });

  it('carries the upstream status for a server fault', async () => {
    respond = { status: 503, body: 'unavailable' };
    expect((await queryError() as SparqlHttpResponseError).status).toBe(503);
  });

  it('keeps the rendered message stable for existing log greps', async () => {
    const err = await queryError() as Error;
    expect(err.message).toMatch(/^SPARQL HTTP query failed \(400\): error at 1:15/);
  });
});
