/**
 * GH #306 / #787 — write routes must reject malformed (string-shaped) quads with
 * an actionable 4xx instead of crashing with a TypeError → HTTP 500.
 *
 *   #787 — the retired POST /api/shared-memory/write route must stay removed.
 *   #306 — POST /api/knowledge-assets/{name}/wm/write with string quads → was 500
 *          ("Cannot use 'in' operator to search for 'graph' in <s> <p> <o> .").
 *          https://github.com/OriginTrail/dkg/issues/306
 *
 * The fix validates quad shape at the route boundary (isWritableQuad) BEFORE the
 * agent write path. This test also asserts the POSITIVE path — well-formed
 * {subject,predicate,object} quads (graph optional) still succeed — so the
 * validation can't regress valid writes. One real auth-enabled daemon against
 * the cli suite's shared Hardhat node; no chain mocks. Daemon lifecycle reuses
 * the shared `live-daemon` helper (startup config, wallet seeding, readiness,
 * token loading, port allocation) so it can't drift from the other cli live
 * tests.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, postJson, type LiveDaemon } from './helpers/live-daemon.js';

let daemon: LiveDaemon | undefined;
const CG = 'wq-validation-cg';
const OVERSIZED_LITERAL = `"${'x'.repeat(60_000)}"`;

beforeAll(async () => {
  daemon = await startLiveDaemon({ authEnabled: true });
  const { status, body } = await postJson(daemon, '/api/context-graph/create', {
    id: CG, name: 'WQ Validation CG', accessPolicy: 0,
  });
  if (status >= 300) throw new Error(`CG create failed: ${status} ${JSON.stringify(body)}`);
}, 120_000);

afterAll(async () => {
  await stopLiveDaemon(daemon);
});

describe('GH #787 — retired shared-memory write route', () => {
  it('returns route-not-found (not 500) for N-Quad string-shaped quads', async () => {
    const { status } = await postJson(daemon!, '/api/shared-memory/write', {
      contextGraphId: CG, quads: ['<http://example.org/s787> <http://example.org/p> "v" .'],
    });
    expect(status).toBe(404);
  });

  it('returns route-not-found for oversized RDF literals instead of serving the retired SWM write', async () => {
    const { status } = await postJson(daemon!, '/api/shared-memory/write', {
      contextGraphId: CG,
      quads: [{ subject: 'urn:wq:oversized-swm', predicate: 'http://schema.org/text', object: OVERSIZED_LITERAL }],
    });
    expect(status).toBe(404);
  });
});

describe('GH #306 — POST /api/knowledge-assets/{name}/wm/write quad-shape validation', () => {
  it('returns 4xx (not 500) for N-Quad string-shaped quads', async () => {
    const created = await postJson(daemon!, '/api/knowledge-assets', { contextGraphId: CG, name: 'ka-306' });
    expect(created.status, 'KA create precondition').toBeLessThan(300);
    const { status } = await postJson(daemon!, '/api/knowledge-assets/ka-306/wm/write', {
      contextGraphId: CG, quads: ['<urn:s> <urn:p> <urn:o> .'],
    });
    expect(status).not.toBe(500);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it('accepts well-formed object quads (regression: valid wm/write still succeeds)', async () => {
    const created = await postJson(daemon!, '/api/knowledge-assets', { contextGraphId: CG, name: 'ka-306-ok' });
    expect(created.status).toBeLessThan(300);
    const { status, body } = await postJson(daemon!, '/api/knowledge-assets/ka-306-ok/wm/write', {
      contextGraphId: CG, quads: [{ subject: 'urn:wq:s306', predicate: 'http://schema.org/name', object: '"ok306"' }],
    });
    expect(status, JSON.stringify(body)).toBe(200);
  });

  it('returns 400 for oversized RDF literals before WM write', async () => {
    const created = await postJson(daemon!, '/api/knowledge-assets', { contextGraphId: CG, name: 'ka-306-oversized' });
    expect(created.status).toBeLessThan(300);
    const { status, body } = await postJson(daemon!, '/api/knowledge-assets/ka-306-oversized/wm/write', {
      contextGraphId: CG,
      quads: [{ subject: 'urn:wq:oversized-wm', predicate: 'http://schema.org/text', object: OVERSIZED_LITERAL }],
    });
    expect(status, JSON.stringify(body)).toBe(400);
    expect(body.code).toBe('OVERSIZED_RDF_LITERAL');
    expect(body.actualBytes).toBeGreaterThan(60_000);
  });
});

/**
 * GH #306/#787 FOLLOW-UP — a quad whose `object` is neither a quoted literal nor
 * an absolute IRI (e.g. a bare word `hello`, a number `123`) passes the shape
 * guard (isWritableQuad checks only that the fields are strings) but then crashes
 * the RDF parser with an uncaught "No scheme found in an absolute IRI" → HTTP 500.
 * The fix runs `validateQuadObjectTerms` on the write routes too (it already ran
 * on publish), so these now return an actionable 400.
 */
describe('GH #306/#787 follow-up — malformed object TERM is 4xx, not a 500 parser crash', () => {
  const badObjectQuad = (s: string) => [
    { subject: s, predicate: 'http://schema.org/name', object: 'hello' }, // bare word: not a literal, not an IRI
  ];

  it('/shared-memory/write stays removed for a bare-word object', async () => {
    const { status } = await postJson(daemon!, '/api/shared-memory/write', {
      contextGraphId: CG, quads: badObjectQuad('urn:wq:obj1'),
    });
    expect(status).toBe(404);
  });

  it('/shared-memory/conditional-write stays removed for a bare-word object', async () => {
    const { status } = await postJson(daemon!, '/api/shared-memory/conditional-write', {
      contextGraphId: CG,
      quads: badObjectQuad('urn:wq:obj2'),
      conditions: [{ subject: 'urn:wq:obj2', predicate: 'http://schema.org/name', expectedValue: null }],
    });
    expect(status).toBe(404);
  });

  it('/knowledge-assets/{name}/wm/write rejects a bare-word object with 400', async () => {
    const created = await postJson(daemon!, '/api/knowledge-assets', { contextGraphId: CG, name: 'ka-objterm' });
    expect(created.status, 'KA create precondition').toBeLessThan(300);
    const { status, body } = await postJson(daemon!, '/api/knowledge-assets/ka-objterm/wm/write', {
      contextGraphId: CG, quads: badObjectQuad('urn:wq:obj3'),
    });
    expect(status, JSON.stringify(body)).toBe(400);
  });

  it('still accepts an absolute-IRI object (regression)', async () => {
    const created = await postJson(daemon!, '/api/knowledge-assets', { contextGraphId: CG, name: 'ka-objterm-ok' });
    expect(created.status, 'KA create precondition').toBeLessThan(300);
    const { status, body } = await postJson(daemon!, '/api/knowledge-assets/ka-objterm-ok/wm/write', {
      contextGraphId: CG,
      quads: [{ subject: 'urn:wq:obj4', predicate: 'http://schema.org/url', object: 'https://example.org/ok' }],
    });
    expect(status, JSON.stringify(body)).toBe(200);
  });
});
