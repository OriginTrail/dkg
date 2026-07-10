/**
 * OT-RFC-59 write-side (ChangelogStore) tests.
 *
 * The load-bearing properties, and why each matters:
 *  - Upsert markers ride the SAME inner.insert() call as the data → one backend
 *    transaction → the fatal "committed data invisible to the log" case is
 *    impossible. Proven structurally (SpyStore counts insert calls) so it holds
 *    for EVERY adapter: a single insert() is one txn on Oxigraph (in-memory
 *    apply + whole-snapshot flush), Blazegraph (one N-Quads POST) and sparql-http
 *    (one INSERT DATA) alike.
 *  - seq is monotonic AND contiguous even under concurrent writes → commit order
 *    equals seq order, so a cursor can never skip a change (the multi-writer
 *    reordering hole). Enforced by the in-process write mutex.
 *  - seq reseeds from the durable high-water mark on restart → no reuse/rollback.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { ChangelogStore, CHANGELOG_GRAPH } from '../src/changelog-store.js';
import { createTripleStore } from '../src/triple-store.js';
import type { Quad, QueryOptions, QueryResult, TripleStore, UpdateOptions } from '../src/triple-store.js';

const G1 = 'http://ex.org/g1';
const G2 = 'http://ex.org/g2';
const G3 = 'http://ex.org/g3';

function q(subject: string, graph: string, object = '"x"'): Quad {
  return { subject, predicate: 'http://ex.org/p', object, graph };
}

/** Delegating TripleStore that records insert() call shapes and can inject failures. */
class SpyStore implements TripleStore {
  readonly insertCalls: Quad[][] = [];
  failNextInsert = false;
  constructor(private readonly inner: TripleStore) {}
  async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    this.insertCalls.push(quads.map((x) => ({ ...x })));
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error('injected insert failure');
    }
    return this.inner.insert(quads, options);
  }
  delete(quads: Quad[], options?: QueryOptions) { return this.inner.delete(quads, options); }
  deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions) { return this.inner.deleteByPattern(pattern, options); }
  deleteBySubjectPrefix(g: string, p: string, options?: QueryOptions) { return this.inner.deleteBySubjectPrefix(g, p, options); }
  query(sparql: string, options?: QueryOptions): Promise<QueryResult> { return this.inner.query(sparql, options); }
  hasGraph(g: string, options?: QueryOptions) { return this.inner.hasGraph(g, options); }
  createGraph(g: string) { return this.inner.createGraph(g); }
  dropGraph(g: string, options?: QueryOptions) { return this.inner.dropGraph(g, options); }
  listGraphs(options?: QueryOptions) { return this.inner.listGraphs(options); }
  update(sparql: string, options?: UpdateOptions) { return this.inner.update!(sparql, options); }
  countQuads(g?: string, options?: QueryOptions) { return this.inner.countQuads(g, options); }
  close() { return this.inner.close(); }
}

describe('ChangelogStore — upsert marker atomicity', () => {
  it('appends the marker in the SAME inner.insert() call as the data (one transaction)', async () => {
    const base = new OxigraphStore();
    const spy = new SpyStore(base);
    const log = new ChangelogStore(spy);

    await log.insert([q('http://ex.org/s1', G1)]);

    // Exactly one inner insert() — data + marker together, never two calls.
    expect(spy.insertCalls).toHaveLength(1);
    const call = spy.insertCalls[0];
    const dataQuads = call.filter((x) => x.graph === G1);
    const markerQuads = call.filter((x) => x.graph === CHANGELOG_GRAPH);
    expect(dataQuads).toHaveLength(1);
    expect(markerQuads.length).toBeGreaterThanOrEqual(1);
    await base.close();
  });

  it('a failed insert does NOT advance seq (gapless): the next write reuses it', async () => {
    const base = new OxigraphStore();
    const spy = new SpyStore(base);
    const log = new ChangelogStore(spy);

    spy.failNextInsert = true;
    await expect(log.insert([q('http://ex.org/s1', G1)])).rejects.toThrow(/injected/);

    // Recover: the next successful write must be seq 1, not seq 2.
    await log.insert([q('http://ex.org/s2', G1)]);
    const changes = await log.readChanges(0, 100);
    expect(changes.map((c) => c.seq)).toEqual([1]);
    await base.close();
  });
});

describe('ChangelogStore — sequence semantics', () => {
  let base: OxigraphStore;
  let log: ChangelogStore;
  beforeEach(() => { base = new OxigraphStore(); log = new ChangelogStore(base); });
  afterEach(async () => { await base.close(); });

  it('assigns monotonic contiguous seqs across successive writes', async () => {
    await log.insert([q('http://ex.org/a', G1)]);
    await log.insert([q('http://ex.org/b', G2)]);
    const changes = await log.readChanges(0, 100);
    expect(changes).toEqual([
      { seq: 1, graph: G1, op: 'upsert' },
      { seq: 2, graph: G2, op: 'upsert' },
    ]);
  });

  it('allocates one contiguous seq per distinct graph within a single insert', async () => {
    await log.insert([q('http://ex.org/a', G1), q('http://ex.org/b', G2), q('http://ex.org/c', G1)]);
    const changes = await log.readChanges(0, 100);
    expect(changes.map((c) => c.seq)).toEqual([1, 2]);
    expect(new Set(changes.map((c) => c.graph))).toEqual(new Set([G1, G2]));
  });

  it('readChanges honours sinceSeq and limit and returns ascending order', async () => {
    for (const g of [G1, G2, G3]) await log.insert([q(`http://ex.org/${g}`, g)]);
    const tail = await log.readChanges(1, 100);
    expect(tail.map((c) => c.seq)).toEqual([2, 3]);
    const capped = await log.readChanges(0, 2);
    expect(capped.map((c) => c.seq)).toEqual([1, 2]);
    expect(await log.headSeq()).toBe(3);
  });

  it('serializes concurrent writes into contiguous non-overlapping seqs (single-writer)', async () => {
    const graphs = Array.from({ length: 12 }, (_, i) => `http://ex.org/c${i}`);
    // Fire all writes concurrently — the mutex must still yield 1..12 with no
    // gaps, no duplicates, one marker per graph (commit order === seq order).
    await Promise.all(graphs.map((g) => log.insert([q(`${g}/s`, g)])));
    const changes = await log.readChanges(0, 100);
    expect(changes.map((c) => c.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(new Set(changes.map((c) => c.graph)).size).toBe(12);
  });
});

describe('ChangelogStore — drop / delete op attribution', () => {
  let base: OxigraphStore;
  let log: ChangelogStore;
  beforeEach(() => { base = new OxigraphStore(); log = new ChangelogStore(base); });
  afterEach(async () => { await base.close(); });

  it('dropGraph emits a drop marker', async () => {
    await log.insert([q('http://ex.org/a', G1)]);
    await log.dropGraph(G1);
    const changes = await log.readChanges(0, 100);
    expect(changes).toEqual([
      { seq: 1, graph: G1, op: 'upsert' },
      { seq: 2, graph: G1, op: 'drop' },
    ]);
  });

  it('a delete that empties a graph emits drop; one that leaves data emits upsert', async () => {
    await log.insert([q('http://ex.org/a', G1), q('http://ex.org/b', G1)]);
    // Remove one of two → graph still exists → upsert.
    await log.delete([q('http://ex.org/a', G1)]);
    // Remove the last → graph gone → drop.
    await log.delete([q('http://ex.org/b', G1)]);
    const ops = (await log.readChanges(0, 100)).map((c) => c.op);
    expect(ops).toEqual(['upsert', 'upsert', 'drop']);
  });
});

describe('ChangelogStore — restart reseed & reserved-graph hiding', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'changelog-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('markers are durable and seq reseeds from the high-water mark after reopen', async () => {
    const path = join(dir, 'store.nq');
    const first = new OxigraphStore(path);
    const log1 = new ChangelogStore(first);
    await log1.insert([q('http://ex.org/a', G1)]);
    await log1.insert([q('http://ex.org/b', G2)]);
    await first.flush();
    await first.close();

    // Reopen: a brand-new ChangelogStore over the hydrated store must continue
    // at seq 3, not restart at 1 (which would collide with durable markers).
    const second = new OxigraphStore(path);
    const log2 = new ChangelogStore(second);
    expect(await log2.headSeq()).toBe(2);
    await log2.insert([q('http://ex.org/c', G3)]);
    const changes = await log2.readChanges(0, 100);
    expect(changes.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(changes[2]).toEqual({ seq: 3, graph: G3, op: 'upsert' });
    await second.close();
  });

  it('hides the reserved changelog graph from listGraphs', async () => {
    const base = new OxigraphStore();
    const log = new ChangelogStore(base);
    await log.insert([q('http://ex.org/a', G1)]);
    const graphs = await log.listGraphs();
    expect(graphs).toContain(G1);
    expect(graphs).not.toContain(CHANGELOG_GRAPH);
    // hasGraph on the reserved plane reads as invisible upward.
    expect(await log.hasGraph(CHANGELOG_GRAPH)).toBe(false);
    await base.close();
  });
});

describe('ChangelogStore — opaque update handling', () => {
  it('an update() with touchedGraphs emits markers; without, it flags reconcile', async () => {
    const base = new OxigraphStore();
    const log = new ChangelogStore(base);
    await log.insert([q('http://ex.org/a', G1)]);

    // Hinted update → attributable → marker emitted for G2.
    await base.insert([q('http://ex.org/seed', G2)]); // pre-create so hasGraph is true
    await log.update(
      `INSERT DATA { GRAPH <${G2}> { <http://ex.org/x> <http://ex.org/p> "y" } }`,
      { touchedGraphs: [G2] },
    );
    expect(log.needsReconcile).toBe(false);
    const g2 = (await log.readChanges(0, 100)).filter((c) => c.graph === G2);
    expect(g2.length).toBeGreaterThanOrEqual(1);

    // Opaque update (no hint) → reconcile owed.
    await log.update(`INSERT DATA { GRAPH <${G3}> { <http://ex.org/z> <http://ex.org/p> "w" } }`);
    expect(log.needsReconcile).toBe(true);
    await base.close();
  });
});

describe('ChangelogStore over Blazegraph — single-request atomicity', () => {
  let server: Server;
  let url: string;
  const insertBodies: string[] = [];

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const ct = String(req.headers['content-type'] ?? '');
          if (ct.includes('application/sparql-query')) {
            // headSeq/seed MAX(?seq) → empty result (log starts at 0).
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ head: { vars: ['m'] }, results: { bindings: [] } }));
            return;
          }
          // n-quads insert (text/x-nquads) — capture the body.
          insertBodies.push(body);
          res.writeHead(200);
          res.end();
        });
      });
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(server.address() as { port: number }).port}/sparql`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('the data quad and its marker land in ONE n-quads POST', async () => {
    insertBodies.length = 0;
    const log = new ChangelogStore(new BlazegraphStore(url));
    await log.insert([q('http://ex.org/s1', G1)]);

    // Exactly one write request, carrying both the data triple and the marker.
    expect(insertBodies).toHaveLength(1);
    const body = insertBodies[0];
    expect(body).toContain(G1);                 // data graph
    expect(body).toContain(CHANGELOG_GRAPH);    // marker graph, same POST
    expect(body).toContain('urn:dkg:changelog#seq');
  });
});

describe('ChangelogStore — createTripleStore wiring', () => {
  it('is OFF by default (no marker graph appears)', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    await store.insert([q('http://ex.org/a', G1)]);
    const graphs = await store.listGraphs();
    expect(graphs).not.toContain(CHANGELOG_GRAPH);
    await store.close();
  });

  it('wraps when changelog:true, independent of backend gating', async () => {
    const store = await createTripleStore({ backend: 'oxigraph', changelog: true });
    await store.insert([q('http://ex.org/a', G1)]);
    // The reserved graph is written but hidden; markers are queryable via a raw query.
    const res = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${CHANGELOG_GRAPH}> { ?s ?p ?o } }`,
    );
    const count = res.type === 'bindings' ? Number(res.bindings[0].c.match(/\d+/)?.[0] ?? '0') : 0;
    expect(count).toBeGreaterThan(0);
    expect(await store.listGraphs()).not.toContain(CHANGELOG_GRAPH);
    await store.close();
  });
});

describe('ChangelogStore — reserved-graph mutation guard', () => {
  it('does not emit a marker for mutations that TARGET the reserved changelog graph', async () => {
    const base = new OxigraphStore();
    const spy = new SpyStore(base);
    const log = new ChangelogStore(spy);
    await log.insert([q('http://ex.org/s1', G1)]); // 1 fused insert (data+marker)
    const callsBefore = spy.insertCalls.length;
    // A drop/delete aimed at the reserved graph must NOT append a self-referential
    // marker (which would pollute the log and, in PR2, make the responder try to
    // reconcile the log graph itself).
    await log.dropGraph(CHANGELOG_GRAPH);
    await log.deleteByPattern({ graph: CHANGELOG_GRAPH });
    expect(spy.insertCalls.length).toBe(callsBefore); // no new marker write
    // No record ever names the changelog graph as its changed graph.
    await log.insert([q('http://ex.org/s2', G2)]);
    const changes = await log.readChanges(0, 100);
    expect(changes.every((c) => c.graph !== CHANGELOG_GRAPH)).toBe(true);
    await base.close();
  });
});

describe('ChangelogStore — delete-path op attribution & reconcile', () => {
  let base: OxigraphStore;
  let log: ChangelogStore;
  beforeEach(() => { base = new OxigraphStore(); log = new ChangelogStore(base); });
  afterEach(async () => { await base.close(); });

  it('deleteBySubjectPrefix emits upsert when data remains, drop when it empties the graph', async () => {
    await log.insert([
      q('http://ex.org/a/1', G1), q('http://ex.org/a/2', G1), q('http://ex.org/b/1', G1),
    ]);
    // Remove the a/* subjects → b/1 remains → graph still there → upsert.
    expect(await log.deleteBySubjectPrefix(G1, 'http://ex.org/a/')).toBeGreaterThan(0);
    // Remove the last subject → graph empty → drop.
    expect(await log.deleteBySubjectPrefix(G1, 'http://ex.org/b/')).toBeGreaterThan(0);
    expect((await log.readChanges(0, 100)).map((c) => c.op)).toEqual(['upsert', 'upsert', 'drop']);
  });

  it('deleteByPattern with NO graph hint flags reconcile when it removes quads', async () => {
    await log.insert([q('http://ex.org/s1', G1)]);
    expect(log.needsReconcile).toBe(false);
    const removed = await log.deleteByPattern({ predicate: 'http://ex.org/p' }); // no graph
    expect(removed).toBeGreaterThan(0);
    // Cannot attribute which graphs shrank/emptied → reconcile owed.
    expect(log.needsReconcile).toBe(true);
  });
});

describe('ChangelogStore — reserved-graph hiding (prefix) & post-mutation failure', () => {
  it('hides the reserved changelog graph from listGraphsByPrefix (even a matching prefix)', async () => {
    const base = new OxigraphStore();
    const log = new ChangelogStore(base);
    await log.insert([q('http://ex.org/s1', G1)]);
    // 'urn:' and the exact IRI both match CHANGELOG_GRAPH in the inner store, but
    // the decorator must filter it out of prefix enumeration too.
    expect(await log.listGraphsByPrefix('urn:')).not.toContain(CHANGELOG_GRAPH);
    expect(await log.listGraphsByPrefix('urn:dkg:changelog')).not.toContain(CHANGELOG_GRAPH);
    await base.close();
  });

  it('flags reconcile when a post-mutation (drop) marker write fails after the mutation committed', async () => {
    const base = new OxigraphStore();
    const spy = new SpyStore(base);
    const log = new ChangelogStore(spy);
    await log.insert([q('http://ex.org/s1', G1)]); // seq 1 (fused, succeeds)
    spy.failNextInsert = true;                     // the drop's marker insert will throw
    await expect(log.dropGraph(G1)).rejects.toThrow(/injected/);
    // The graph is durably dropped but its marker was lost → gap recorded.
    expect(log.needsReconcile).toBe(true);
    await base.close();
  });
});
