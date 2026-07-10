/**
 * ChangelogStore INTEGRATION tests — run against a REAL Blazegraph server.
 *
 * The unit suite (`changelog-store.test.ts`) proves the decorator's logic on
 * embedded Oxigraph and proves the blazegraph WRITE shape (marker rides one
 * POST) with a mock. It does NOT exercise the blazegraph READ path, which is
 * the one thing OT-RFC-59's "must work on blazegraph too" actually turns on:
 *   - headSeq()  → SELECT (MAX(?seq) …) over "n"^^xsd:integer markers
 *   - readChanges → FILTER(?seq > N) ORDER BY ?seq  (typed-integer compare/sort)
 *   - seed        → reseeding the in-memory counter from a POPULATED log
 * Typed-integer aggregation/ordering is exactly where SPARQL engines differ, so
 * this suite pins it on a live Blazegraph.
 *
 * Gated on BLAZEGRAPH_TEST_URL so a plain `pnpm test` skips it (no Java/Docker
 * required); CI's blazegraph job sets it. Example:
 *   BLAZEGRAPH_TEST_URL=http://127.0.0.1:19999/bigdata/namespace/kb/sparql
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { ChangelogStore, CHANGELOG_GRAPH } from '../src/changelog-store.js';
import type { Quad } from '../src/triple-store.js';

const URL = process.env.BLAZEGRAPH_TEST_URL;
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const G = (n: number) => `urn:cl-int:${RUN}:g${n}`;

function q(subject: string, graph: string): Quad {
  return { subject, predicate: 'urn:cl-int:p', object: '"x"', graph };
}

describe.skipIf(!URL)('ChangelogStore integration (live Blazegraph read-path)', () => {
  let base: BlazegraphStore;

  beforeAll(async () => {
    base = new BlazegraphStore(URL as string);
    // Clean slate: the changelog graph is a fixed URI shared across runs.
    await base.dropGraph(CHANGELOG_GRAPH);
  });

  afterAll(async () => {
    if (!base) return;
    await base.dropGraph(CHANGELOG_GRAPH).catch(() => {});
    for (let i = 0; i < 4; i++) await base.dropGraph(G(i)).catch(() => {});
  });

  it('upserts → headSeq (MAX) and readChanges (FILTER/ORDER BY) work on typed-integer markers', async () => {
    const log = new ChangelogStore(base);
    await log.insert([q('urn:cl-int:s1', G(0))]);
    await log.insert([q('urn:cl-int:s2', G(1))]);

    // MAX(?seq) over "1"^^xsd:integer / "2"^^xsd:integer must return 2, not "2" lexical noise.
    expect(await log.headSeq()).toBe(2);

    const all = await log.readChanges(0, 100);
    expect(all).toEqual([
      { seq: 1, graph: G(0), op: 'upsert' },
      { seq: 2, graph: G(1), op: 'upsert' },
    ]);

    // sinceSeq narrowing via FILTER(?seq > 1) on a real engine.
    expect((await log.readChanges(1, 100)).map((c) => c.seq)).toEqual([2]);
  });

  it('dropGraph records a drop marker; seq stays monotonic', async () => {
    const log = new ChangelogStore(base);
    await log.dropGraph(G(0));
    const changes = await log.readChanges(0, 100);
    expect(changes.at(-1)).toEqual({ seq: 3, graph: G(0), op: 'drop' });
  });

  it('a fresh ChangelogStore reseeds seq from the POPULATED live log (restart)', async () => {
    // Simulates a daemon restart against the same Blazegraph namespace: the new
    // in-memory counter must recover from the durable high-water mark, not 0.
    const log2 = new ChangelogStore(base);
    expect(await log2.headSeq()).toBe(3);
    await log2.insert([q('urn:cl-int:s4', G(2))]);
    const tail = await log2.readChanges(3, 100);
    expect(tail).toEqual([{ seq: 4, graph: G(2), op: 'upsert' }]);
  });

  it('era is minted once and reseeds from the live log on a fresh store', async () => {
    // First reader mints+persists an era; a second store (restart) must recover
    // the SAME era from the live Blazegraph, not mint a new one.
    const era1 = (await new ChangelogStore(base).changelogHead()).era;
    expect(era1).toMatch(/^[0-9a-f-]{36}$/i);
    const head2 = await new ChangelogStore(base).changelogHead();
    expect(head2.era).toBe(era1);
    expect(head2.seq).toBeGreaterThanOrEqual(3); // seq survives across the "restart" too
  });

  it('upsert marker and data are both durably present after one insert', async () => {
    const log = new ChangelogStore(base);
    await log.insert([q('urn:cl-int:s5', G(3))]);
    // Data landed.
    expect(await base.hasGraph(G(3))).toBe(true);
    // Marker landed in the reserved graph (one transaction, real backend).
    const res = await base.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${CHANGELOG_GRAPH}> { ?s <urn:dkg:changelog#graph> <${G(3)}> } }`,
    );
    const c = res.type === 'bindings' ? Number(res.bindings[0].c.match(/\d+/)?.[0] ?? '0') : 0;
    expect(c).toBeGreaterThanOrEqual(1);
  });
});
