/**
 * /api/query route error-mapping contract — REAL daemon, NO mocks.
 *
 * The retired version of this file fed `handleQueryRoutes` a hand-built
 * `RequestContext` whose `agent.query` was a vitest mock that rejected with a
 * hand-typed `Error('error at 1:27: …')`. That pinned the route's error→HTTP-status
 * classification against a HAND-TYPED error string — if the real query engine
 * changed the shape of its parse/scope errors, the route could start
 * misclassifying them (500 instead of 400) and the mock test would stay green.
 *
 * This version drives the contract through a real edge daemon: a genuinely
 * malformed SPARQL makes the REAL oxigraph throw its REAL parse error, and the
 * REAL route maps it. So the #889 fix (parser errors → 400, not 500) is proven
 * end-to-end, and the guard that a VALID query is not misclassified is a real
 * 200. Runs in the standard cli lane against the shared Hardhat node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, postJson, type LiveDaemon } from '../../helpers/live-daemon.js';

describe('/api/query error mapping (real daemon)', () => {
  let daemon: LiveDaemon;

  beforeAll(async () => {
    daemon = await startLiveDaemon();
  }, 120_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  it('maps a real malformed-SPARQL parse error to HTTP 400, not 500 (#889)', async () => {
    // Missing closing brace is rejected either by the fail-closed graph-scope
    // boundary or by the backend parser; both are caller errors, never 500s.
    const { status, body } = await postJson(daemon, '/api/query', {
      sparql: 'SELECT ?s WHERE { ?s ?p ?o',
      contextGraphId: 'all',
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(
      /Scoped query violation: unable to locate|error at \d+:\d+|expected one of|parse/i,
    );
  });

  it('a valid SELECT is not misclassified as 400 (the #889 widening stays narrow)', async () => {
    const { status } = await postJson(daemon, '/api/query', {
      sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 1',
      contextGraphId: 'all',
    });
    expect(status).toBe(200);
  });

  it('rejects a SPARQL mutation (INSERT/DELETE) with a 4xx, not a 500', async () => {
    // Read endpoint must refuse writes — a real, observable contract that
    // does not depend on any injected error string.
    const { status } = await postJson(daemon, '/api/query', {
      sparql: 'INSERT DATA { <urn:s> <urn:p> <urn:o> }',
      contextGraphId: 'all',
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
});
