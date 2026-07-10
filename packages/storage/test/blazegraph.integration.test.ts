/**
 * BlazegraphStore INTEGRATION tests — run against a REAL Blazegraph server.
 *
 * These are the no-mock regression tests for the large-publish bug: publishing
 * a bigger batch (~1,800 triples / ~200 KB) to a Blazegraph node used to fail
 * with HTTP 400 "Unable to parse form content". Root cause: the adapter sent
 * SPARQL updates/queries as URL-encoded form data (`update=…` / `query=…`),
 * which Jetty's form parser caps at `maxFormContentSize` (~200 KB on a stock
 * Blazegraph image). A publish issues a single large DELETE DATA over the full
 * quad set, so any operator on the default node-setup image hit the wall. The
 * fix switches the transport to a W3C SPARQL 1.1 direct POST
 * (`application/sparql-update` / `application/sparql-query`), which is not form
 * parsed and so has no size cap.
 *
 * The unit suite (`blazegraph.unit.test.ts`) asserts the wire format with a
 * mocked fetch; this suite proves the behaviour end-to-end against a live
 * server. It is gated on BLAZEGRAPH_TEST_URL so local `pnpm test` runs skip it
 * (no Docker required); CI provisions a Blazegraph service container and sets
 * the env var (see `.github/workflows/ci.yml`, job `tornado-blazegraph`).
 *
 * BLAZEGRAPH_TEST_URL example:
 *   http://127.0.0.1:9999/bigdata/namespace/kb/sparql
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import type { Quad } from '../src/triple-store.js';

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_TEST_URL;

// A unique graph prefix per run so repeated runs against a persistent
// namespace never collide or see stale data.
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const GRAPH = `urn:bg-int:${RUN}:graph`;
const PRED = 'urn:bg-int:prop';

// ~120-char ASCII literal so each DELETE DATA line is ~300 bytes; well under
// the per-literal MUTF-8 cap (65 535 bytes) but big enough that the whole
// batch blows past Jetty's ~200 KB form-content limit.
const PADDING = 'x'.repeat(120);

function makeQuads(n: number): Quad[] {
  const quads: Quad[] = [];
  for (let i = 0; i < n; i++) {
    quads.push({
      subject: `urn:bg-int:${RUN}:subject-${i}`,
      predicate: PRED,
      object: `"value-${i}-${PADDING}"`,
      graph: GRAPH,
    });
  }
  return quads;
}

describe.skipIf(!BLAZEGRAPH_URL)('BlazegraphStore integration (live server)', () => {
  let store: BlazegraphStore;

  beforeAll(async () => {
    store = new BlazegraphStore(BLAZEGRAPH_URL as string);
    // Start from a clean graph in case the namespace persists across runs.
    await store.dropGraph(GRAPH);
  });

  afterAll(async () => {
    if (store) await store.dropGraph(GRAPH).catch(() => {});
  });

  it(
    'large DELETE DATA (publish path) succeeds — the form-content-limit regression',
    async () => {
      // 2 000 quads → a single DELETE DATA body of ~600 KB raw. Form-encoded
      // (`update=` + URL-escaping) this is >1 MB, far past Jetty's ~200 KB
      // cap — the exact shape a large publish produces.
      const quads = makeQuads(2000);

      await store.insert(quads);
      expect(await store.countQuads(GRAPH)).toBe(quads.length);

      // Sanity-check the assumption: the DELETE DATA body really is large
      // enough that the old form-encoded transport would have been rejected.
      const deleteBodyBytes = quads
        .map((q) => `GRAPH <${q.graph}> { <${q.subject}> <${q.predicate}> ${q.object} . }`)
        .join('\n').length;
      expect(deleteBodyBytes).toBeGreaterThan(200_000);

      // This is the operation that used to throw HTTP 400 on Blazegraph.
      await expect(store.delete(quads)).resolves.toBeUndefined();
      expect(await store.countQuads(GRAPH)).toBe(0);
    },
    60_000,
  );

  it(
    'large SELECT query body succeeds — the query-path form-limit regression',
    async () => {
      const quads = makeQuads(3);
      await store.insert(quads);

      // Build a SELECT whose VALUES block alone exceeds ~200 KB so the old
      // form-encoded `query=` transport would have been rejected. Includes
      // the 3 real subjects plus thousands of decoys. A non-aggregate
      // projection (`SELECT ?s`) is used deliberately — Blazegraph evaluates
      // `VALUES + COUNT(*)` without GROUP BY as a per-binding aggregate, so we
      // count the returned rows instead.
      const realIris = quads.map((q) => `<${q.subject}>`);
      const decoyIris: string[] = [];
      for (let i = 0; i < 4000; i++) {
        decoyIris.push(`<urn:bg-int:${RUN}:decoy-${i}-${PADDING}>`);
      }
      const values = [...realIris, ...decoyIris].join('\n');
      const sparql = `SELECT ?s WHERE {
        VALUES ?s { ${values} }
        GRAPH <${GRAPH}> { ?s <${PRED}> ?o }
      }`;
      expect(sparql.length).toBeGreaterThan(200_000);

      const result = await store.query(sparql);
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        const matched = new Set(result.bindings.map((b) => b.s));
        expect(matched.size).toBe(quads.length);
        for (const q of quads) expect(matched.has(q.subject)).toBe(true);
      }

      await store.delete(quads);
    },
    60_000,
  );

  it(
    'round-trips data through the live server (insert → query → delete)',
    async () => {
      const quads = makeQuads(50);
      await store.insert(quads);

      const r = await store.query(
        `SELECT ?o WHERE { GRAPH <${GRAPH}> { <urn:bg-int:${RUN}:subject-7> <${PRED}> ?o } }`,
      );
      expect(r.type).toBe('bindings');
      if (r.type === 'bindings') {
        expect(r.bindings).toHaveLength(1);
        expect(r.bindings[0].o).toContain('value-7-');
      }

      await store.delete(quads);
      expect(await store.countQuads(GRAPH)).toBe(0);
    },
    60_000,
  );
});
