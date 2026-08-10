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
import { ChangelogStore, CHANGELOG_GRAPH, asChangelogReader, type ChangelogEraGuard } from '../src/changelog-store.js';
import { createTripleStore } from '../src/triple-store.js';
import type { Quad, QueryOptions, QueryResult, StructuredMutation, TripleStore, UpdateOptions } from '../src/triple-store.js';
import { UnsupportedTripleStoreCapabilityError } from '../src/unsupported-capability-error.js';
import { captureStructuredMutationSnapshot } from '../src/bounded-structured-mutation.js';
import { materializeStructuredMutation } from '../src/structured-mutation-materialization-internal.js';

const G1 = 'http://ex.org/g1';
const G2 = 'http://ex.org/g2';
const G3 = 'http://ex.org/g3';

function q(subject: string, graph: string, object = '"x"'): Quad {
  return { subject, predicate: 'http://ex.org/p', object, graph };
}

/** Delegating TripleStore that records insert() call shapes and can inject failures. */
class SpyStore implements TripleStore {
  readonly insertCalls: Quad[][] = [];
  readonly queryCalls: string[] = [];
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
  query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    this.queryCalls.push(sparql);
    return this.inner.query(sparql, options);
  }
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

    // Seed first so the one-time era-mint insert isn't counted; we are asserting
    // that a DATA write fuses its marker into a single call, not the seed path.
    await log.changelogHead();
    spy.insertCalls.length = 0;
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
  it('attributes a structured projection copy only to its target graph', async () => {
    const source = 'http://ex.org/projection-source';
    const target = 'http://ex.org/projection-target';
    const root = 'http://ex.org/projection-root';
    const base = new OxigraphStore();
    await base.insert([q(root, source)]);
    const log = new ChangelogStore(base);

    await log.structuredMutation({ kind: 'copy-subject-projection', input: {
      sourceGraphUris: [source],
      targetGraphUri: target,
      roots: [root],
      descendantSuffix: '/',
      excludedPredicates: [],
    } });

    expect(await log.readChanges(0, 100)).toEqual([
      { seq: 1, graph: target, op: 'upsert' },
    ]);
    expect(log.needsReconcile).toBe(false);
    await base.close();
  });

  it('treats a typed structured-capability refusal as mutation-free preflight', async () => {
    const base = new OxigraphStore();
    const log = new ChangelogStore(new SpyStore(base));

    await expect(log.structuredMutation({ kind: 'copy-subject-projection', input: {
      sourceGraphUris: [G1],
      targetGraphUri: G2,
      roots: ['http://ex.org/root'],
      descendantSuffix: '/',
      excludedPredicates: [],
    } })).rejects.toMatchObject<Partial<UnsupportedTripleStoreCapabilityError>>({
      name: 'UnsupportedTripleStoreCapabilityError',
      capability: 'structuredMutation',
    });
    expect(log.needsReconcile).toBe(false);
    await base.close();
  });

  it('flags reconcile after an indeterminate structured mutation failure', async () => {
    const source = 'http://ex.org/indeterminate-source';
    const targetGraph = 'http://ex.org/indeterminate-target';
    const root = 'http://ex.org/indeterminate-root';
    const base = new OxigraphStore();
    await base.insert([q(root, source)]);
    const uncertain = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'structuredMutation') {
          return async (mutation: StructuredMutation, options?: QueryOptions) => {
            await target.structuredMutation(mutation, options);
            throw new Error('lost structured mutation response');
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const log = new ChangelogStore(uncertain);

    await expect(log.structuredMutation({ kind: 'copy-subject-projection', input: {
      sourceGraphUris: [source],
      targetGraphUri: targetGraph,
      roots: [root],
      descendantSuffix: '/',
      excludedPredicates: [],
    } })).rejects.toThrow('lost structured mutation response');
    expect(log.needsReconcile).toBe(true);
    expect(await base.hasGraph(targetGraph)).toBe(true);
    await base.close();
  });

  it('flags reconcile when a no-op fails because the inner store lost data', async () => {
    const base = new OxigraphStore();
    const failing = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'structuredMutation') {
          return async () => { throw new Error('in-memory worker data was lost'); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const log = new ChangelogStore(failing);

    await expect(log.structuredMutation({
      kind: 'delete-subjects',
      input: { graphUri: G1, subjects: [] },
    })).rejects.toThrow('in-memory worker data was lost');

    expect(log.needsReconcile).toBe(true);
    await base.close();
  });

  it('does not flag reconcile after a deferred-budget refusal before backend I/O', async () => {
    const base = new OxigraphStore();
    let backendUpdates = 0;
    const validatingLeaf = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'structuredMutation') {
          return async (mutation: StructuredMutation, options?: QueryOptions) => {
            const materialized = materializeStructuredMutation(
              captureStructuredMutationSnapshot(mutation),
            );
            if (materialized.outcome === 'noop') return;
            backendUpdates += 1;
            await target.structuredMutation(mutation, options);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const log = new ChangelogStore(validatingLeaf);

    await expect(log.structuredMutation(overBudgetDeleteMutation(G1)))
      .rejects.toThrow(/operand bytes/);

    expect(backendUpdates).toBe(0);
    expect(log.needsReconcile).toBe(false);
    expect(await log.readChanges(0, 100)).toEqual([]);
    await base.close();
  });

  it('keeps an enabled no-op inside the write tail while close drains it', async () => {
    const base = new OxigraphStore();
    await base.insert([q('http://ex.org/delete-me', G1)]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const calls: Array<{ mutation: StructuredMutation; options?: QueryOptions }> = [];
    const gated = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'structuredMutation') {
          return async (mutation: StructuredMutation, options?: QueryOptions) => {
            calls.push({ mutation, options });
            if (calls.length === 1) {
              started();
              await gate;
            }
            await target.structuredMutation(mutation, options);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const appended: unknown[] = [];
    const log = new ChangelogStore(gated, { onAppend: (record) => appended.push(record) });
    const options = { source: 'changelog.noop' };

    const mutation = log.structuredMutation({
      kind: 'delete-subjects',
      input: { graphUri: G1, subjects: ['http://ex.org/delete-me'] },
    });
    await firstStarted;
    const noop = log.structuredMutation({
      kind: 'delete-subjects',
      input: { graphUri: G1, subjects: [] },
    }, options);
    const close = log.close();

    await expect(Promise.race([
      noop.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ])).resolves.toBe('pending');
    await expect(log.structuredMutation({
      kind: 'delete-subjects',
      input: { graphUri: G1, subjects: [] },
    })).rejects.toThrow(/store is closing/);

    release();
    await mutation;
    await noop;
    await close;

    expect(calls).toHaveLength(2);
    expect(calls[1].options).toBe(options);
    expect(Object.isFrozen(calls[1].mutation)).toBe(true);
    expect(appended).toHaveLength(1);
    expect(log.needsReconcile).toBe(false);
  });

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

  it('a SPARQL UPDATE smuggled through query() (even behind a comment) flags reconcile', async () => {
    // Some HTTP backends execute UPDATEs sent to the query endpoint; the changelog
    // cannot observe those, so it must flag reconcile. (Oxigraph's query() rejects
    // updates outright, so this uses an inner whose query() runs them.)
    const base = new OxigraphStore();
    const executed: string[] = [];
    const inner = new (class extends SpyStore {
      async query(sparql: string): Promise<QueryResult> {
        executed.push(sparql);
        return { type: 'bindings', bindings: [] };
      }
    })(base);
    const log = new ChangelogStore(inner);
    expect(log.needsReconcile).toBe(false);
    // Leading comment exercises the canonical prologue-aware classifier.
    await log.query(`# housekeeping\nINSERT DATA { GRAPH <${G1}> { <http://ex.org/s> <http://ex.org/p> "v" } }`);
    expect(log.needsReconcile).toBe(true); // update detected behind the comment
    expect(executed).toHaveLength(1);      // and the inner query ran
    await base.close();
  });
});

function overBudgetDeleteMutation(graphUri: string): StructuredMutation {
  return {
    kind: 'delete-subjects',
    input: {
      graphUri,
      subjects: Array.from(
        { length: 65_000 },
        (_, index) => `urn:test:operand:${index}:${'x'.repeat(55)}`,
      ),
    },
  };
}

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
    const log = new ChangelogStore(new BlazegraphStore(url));
    await log.changelogHead();   // one-time era-mint POST, not under test here
    insertBodies.length = 0;
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

describe('ChangelogStore — reserved-graph write protection', () => {
  it('rejects graph-targeted mutations against the reserved changelog plane', async () => {
    const base = new OxigraphStore();
    const spy = new SpyStore(base);
    const log = new ChangelogStore(spy);
    await log.insert([q('http://ex.org/s1', G1)]); // 1 fused insert (data+marker)
    const callsBefore = spy.insertCalls.length;
    // The reserved plane is not writable through the public API — a drop/delete
    // aimed at it would erase or corrupt the log, so it is rejected outright.
    await expect(log.dropGraph(CHANGELOG_GRAPH)).rejects.toThrow(/reserved/i);
    await expect(log.deleteByPattern({ graph: CHANGELOG_GRAPH })).rejects.toThrow(/reserved/i);
    await expect(log.deleteBySubjectPrefix(CHANGELOG_GRAPH, 'x')).rejects.toThrow(/reserved/i);
    expect(spy.insertCalls.length).toBe(callsBefore); // nothing reached the store
    await base.close();
  });

  it('strips forged marker quads from insert() — the high-water mark cannot be jumped', async () => {
    const base = new OxigraphStore();
    const log = new ChangelogStore(base);
    await log.insert([q('http://ex.org/a', G1)]); // seq 1
    // Forge a marker with a huge seq alongside real data in ONE insert.
    await log.insert([
      q('http://ex.org/b', G2),
      {
        subject: 'urn:dkg:changelog:e:999999',
        predicate: 'urn:dkg:changelog#seq',
        object: '"999999"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: CHANGELOG_GRAPH,
      },
    ]);
    // The real data landed (G2 → seq 2); the forged marker never reached the store.
    expect(await log.headSeq()).toBe(2);
    const changes = await log.readChanges(0, 100);
    expect(changes.map((c) => c.seq)).toEqual([1, 2]);
    expect(changes.every((c) => c.graph !== CHANGELOG_GRAPH)).toBe(true);
    await base.close();
  });

  it('rejects a no-graph deleteByPattern that targets marker terms (cross-graph log erasure)', async () => {
    const base = new OxigraphStore();
    const log = new ChangelogStore(base);
    await log.insert([q('http://ex.org/a', G1)]); // seq 1
    await expect(log.deleteByPattern({ predicate: 'urn:dkg:changelog#seq' })).rejects.toThrow(/reserved/i);
    await expect(log.deleteByPattern({ subject: 'urn:dkg:changelog:e:1' })).rejects.toThrow(/reserved/i);
    expect(await log.headSeq()).toBe(1); // log intact
    await base.close();
  });

  it('rejects a SPARQL update()/query()-UPDATE that references the reserved plane, but allows reads', async () => {
    const base = new OxigraphStore();
    const log = new ChangelogStore(base);
    await expect(
      log.update(`INSERT DATA { GRAPH <${CHANGELOG_GRAPH}> { <urn:x> <urn:p> "9" } }`),
    ).rejects.toThrow(/reserved/i);
    await expect(
      log.query(`INSERT DATA { GRAPH <${CHANGELOG_GRAPH}> { <urn:x> <urn:p> "9" } }`),
    ).rejects.toThrow(/reserved/i);
    // A READ referencing the reserved graph is NOT a mutation → allowed.
    const res = await log.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${CHANGELOG_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(res.type).toBe('bindings');
    await base.close();
  });
});

describe('ChangelogStore — capability boundary (asChangelogReader)', () => {
  it('recovers the changelog reader from a createTripleStore result without a cast', async () => {
    const store = await createTripleStore({ backend: 'oxigraph', changelog: true });
    const reader = asChangelogReader(store);
    expect(reader).not.toBeNull();
    await store.insert([q('http://ex.org/a', G1)]);
    expect(await reader!.headSeq()).toBe(1);
    expect((await reader!.readChanges(0, 100)).map((c) => c.graph)).toContain(G1);
    await store.close();
  });

  it('returns null when the changelog is not enabled', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    expect(asChangelogReader(store)).toBeNull();
    await store.close();
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

  it('deleteByPattern WITH a graph hint emits a marker: upsert when data remains, drop when it empties', async () => {
    await log.insert([q('http://ex.org/a', G1), q('http://ex.org/b', G1)]); // seq 1
    // Remove one subject → G1 still has data → upsert.
    expect(await log.deleteByPattern({ subject: 'http://ex.org/a', graph: G1 })).toBeGreaterThan(0);
    // Remove the last subject → G1 empty → drop.
    expect(await log.deleteByPattern({ subject: 'http://ex.org/b', graph: G1 })).toBeGreaterThan(0);
    expect((await log.readChanges(0, 100)).map((c) => c.op)).toEqual(['upsert', 'upsert', 'drop']);
    expect(log.needsReconcile).toBe(false); // graph-hinted path is fully attributed
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

/** Inner store whose insert() can be held mid-flight to prove close()/flush() drain. */
class GatedStore implements TripleStore {
  readonly insertCalls: Quad[][] = [];
  flushed = false;
  closed = false;
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  constructor(private readonly inner: TripleStore) {}
  block() { this.gate = new Promise<void>((r) => { this.release = r; }); }
  unblock() { this.release?.(); this.gate = null; this.release = null; }
  async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    if (this.gate) await this.gate;
    this.insertCalls.push(quads.map((x) => ({ ...x })));
    return this.inner.insert(quads, options);
  }
  delete(quads: Quad[], options?: QueryOptions) { return this.inner.delete(quads, options); }
  deleteByPattern(p: Partial<Quad>, options?: QueryOptions) { return this.inner.deleteByPattern(p, options); }
  deleteBySubjectPrefix(g: string, p: string, options?: QueryOptions) { return this.inner.deleteBySubjectPrefix(g, p, options); }
  query(sparql: string, options?: QueryOptions): Promise<QueryResult> { return this.inner.query(sparql, options); }
  hasGraph(g: string, options?: QueryOptions) { return this.inner.hasGraph(g, options); }
  createGraph(g: string) { return this.inner.createGraph(g); }
  dropGraph(g: string, options?: QueryOptions) { return this.inner.dropGraph(g, options); }
  listGraphs(options?: QueryOptions) { return this.inner.listGraphs(options); }
  update(sparql: string, options?: UpdateOptions) { return this.inner.update!(sparql, options); }
  countQuads(g?: string, options?: QueryOptions) { return this.inner.countQuads(g, options); }
  async flush(options?: QueryOptions) { this.flushed = true; return this.inner.flush?.(options); }
  async close() { this.closed = true; return this.inner.close(); }
}

const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

describe('ChangelogStore — lifecycle drains the write queue', () => {
  it('close() does not resolve until a queued insert has appended data + marker', async () => {
    const base = new OxigraphStore();
    const gated = new GatedStore(base);
    const log = new ChangelogStore(gated);

    gated.block();
    const insertP = log.insert([q('http://ex.org/s1', G1)]); // enqueued, hangs in inner.insert
    let closed = false;
    const closeP = log.close().then(() => { closed = true; });

    await tick();
    expect(closed, 'close() must not resolve while a write is queued').toBe(false);
    expect(gated.closed, 'inner store must not be closed before the queue drains').toBe(false);

    gated.unblock();
    await Promise.all([insertP, closeP]);

    expect(closed).toBe(true);
    expect(gated.closed).toBe(true);
    // The drained insert carried BOTH the data and its marker (one txn).
    const fused = gated.insertCalls.at(-1)!;
    expect(fused.some((x) => x.graph === G1)).toBe(true);
    expect(fused.some((x) => x.graph === CHANGELOG_GRAPH)).toBe(true);
  });

  it('rejects new writes once close() has started, but still drains the in-flight one', async () => {
    const base = new OxigraphStore();
    const gated = new GatedStore(base);
    const log = new ChangelogStore(gated);

    gated.block();
    const inFlight = log.insert([q('http://ex.org/a', G1)]);
    const closeP = log.close();
    await tick();
    // A write attempted after the gate is shut is refused, not silently queued.
    await expect(log.insert([q('http://ex.org/b', G2)])).rejects.toThrow(/closing/i);

    gated.unblock();
    await Promise.all([inFlight, closeP]);
    // Only the in-flight insert drained; the rejected one never reached the store.
    expect(gated.insertCalls.some((c) => c.some((x) => x.graph === G1))).toBe(true);
    expect(gated.insertCalls.some((c) => c.some((x) => x.graph === G2))).toBe(false);
  });

  it('flush() persists queued mutations before returning (and does NOT shut the gate)', async () => {
    const base = new OxigraphStore();
    const gated = new GatedStore(base);
    const log = new ChangelogStore(gated);

    gated.block();
    const insertP = log.insert([q('http://ex.org/s1', G1)]);
    let flushed = false;
    const flushP = log.flush().then(() => { flushed = true; });

    await tick();
    expect(flushed, 'flush() must wait for the queued write').toBe(false);

    gated.unblock();
    await Promise.all([insertP, flushP]);
    expect(flushed).toBe(true);
    expect(gated.flushed).toBe(true);
    // flush() did not latch closing: further writes still succeed.
    await log.insert([q('http://ex.org/s2', G2)]);
    expect((await log.readChanges(0, 100)).map((c) => c.graph)).toEqual([G1, G2]);
    await base.close();
  });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('ChangelogStore — era foundation & reader capability', () => {
  it('mints a stable era on first changelogHead() and returns the live seq', async () => {
    const base = new OxigraphStore();
    const log = new ChangelogStore(base);
    const h1 = await log.changelogHead();
    expect(h1.era).toMatch(UUID_RE);
    expect(h1.seq).toBe(0);
    await log.insert([q('http://ex.org/a', G1)]);
    await log.insert([q('http://ex.org/b', G2)]);
    const h2 = await log.changelogHead();
    expect(h2.era).toBe(h1.era); // era is immutable while the log lives
    expect(h2.seq).toBe(2);
    await base.close();
  });

  it('serves the seeded live head from memory while headSeq remains a durable diagnostic', async () => {
    const base = new OxigraphStore();
    const spy = new SpyStore(base);
    const log = new ChangelogStore(spy);

    expect((await log.changelogHead()).seq).toBe(0);
    const durableHeadQueries = () => spy.queryCalls.filter((query) => query.includes('MAX(?seq)')).length;
    expect(durableHeadQueries()).toBe(1); // one-time restart seed

    await log.insert([q('http://ex.org/a', G1)]);
    await log.insert([q('http://ex.org/b', G2)]);
    expect((await log.changelogHead()).seq).toBe(2);
    expect((await log.changelogHead({ source: 'sync.head', priority: 'ack' })).seq).toBe(2);
    expect(durableHeadQueries()).toBe(1); // no per-request SPARQL aggregation

    expect(await log.headSeq()).toBe(2);
    expect(durableHeadQueries()).toBe(2); // explicit diagnostic still reads storage
    await base.close();
  });

  it('preserves cancellation on the query-free seeded head path', async () => {
    const base = new OxigraphStore();
    const spy = new SpyStore(base);
    const log = new ChangelogStore(spy);

    await log.changelogHead();
    const durableHeadQueries = () => spy.queryCalls.filter((query) => query.includes('MAX(?seq)')).length;
    expect(durableHeadQueries()).toBe(1);

    const controller = new AbortController();
    const reason = new Error('changelog head cancelled');
    controller.abort(reason);

    await expect(log.changelogHead({ signal: controller.signal })).rejects.toBe(reason);
    expect(durableHeadQueries()).toBe(1); // cancellation must not restore the per-request aggregate
    await base.close();
  });

  it('reads the existing era rather than re-minting (a fresh store over the same log)', async () => {
    const base = new OxigraphStore();
    const minted = (await new ChangelogStore(base).changelogHead()).era;
    // A second ChangelogStore (e.g. a daemon restart) over the SAME underlying
    // store must recover the SAME era — re-minting would falsely signal a wipe
    // to peers and force needless full resyncs.
    const reread = (await new ChangelogStore(base).changelogHead()).era;
    expect(reread).toBe(minted);
    await base.close();
  });

  it('era + seq are durable across a persistent-store reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'changelog-era-'));
    try {
      const path = join(dir, 'store.nq');
      const first = new OxigraphStore(path);
      const log1 = new ChangelogStore(first);
      const era = (await log1.changelogHead()).era;
      await log1.insert([q('http://ex.org/a', G1)]);
      await first.flush();
      await first.close();

      const second = new OxigraphStore(path);
      const head = await new ChangelogStore(second).changelogHead();
      expect(head.era).toBe(era);
      expect(head.seq).toBe(1);
      await second.close();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('asChangelogReader narrows a ChangelogStore and rejects a plain store', async () => {
    const base = new OxigraphStore();
    const log = new ChangelogStore(base);
    const reader = asChangelogReader(log);
    expect(reader).not.toBeNull();
    expect(await reader!.readChanges(0, 10)).toEqual([]);
    // A plain (non-changelog) store is not a reader → capability probe is false.
    expect(asChangelogReader(base)).toBeNull();
    expect(asChangelogReader(null)).toBeNull();
    await base.close();
  });

  it('era-restore guard: a seq rollback under the same era rotates the era (P0)', async () => {
    class MemGuard implements ChangelogEraGuard {
      state: { era: string; highSeq: number } | null;
      constructor(initial: { era: string; highSeq: number } | null = null) { this.state = initial; }
      async load() { return this.state; }
      async save(era: string, highSeq: number) { this.state = { era, highSeq }; }
    }

    // A store that reached seq 5 under era E1.
    const base = new OxigraphStore();
    const era1 = (await new ChangelogStore(base).changelogHead()).era;
    for (let i = 0; i < 5; i++) await new ChangelogStore(base).insert([q(`http://ex.org/s${i}`, `${G1}${i}`)]);

    // Simulate a restore: the durable guard says this era once reached seq 10,
    // but the (restored) store is only at seq 5 → rollback under the same era.
    const guard = new MemGuard({ era: era1, highSeq: 10 });
    const head = await new ChangelogStore(base, { eraGuard: guard }).changelogHead();
    expect(head.seq).toBe(5);
    expect(head.era).not.toBe(era1);              // era rotated → peers full-resync
    expect(guard.state).toEqual({ era: head.era, highSeq: 5 });
    await base.close();
  });

  it('era-restore guard: normal restart (no rollback) keeps the era and advances the high-water', async () => {
    class MemGuard implements ChangelogEraGuard {
      state: { era: string; highSeq: number } | null = null;
      async load() { return this.state; }
      async save(era: string, highSeq: number) { this.state = { era, highSeq }; }
    }
    const base = new OxigraphStore();
    const guard = new MemGuard();
    const log1 = new ChangelogStore(base, { eraGuard: guard });
    const era1 = (await log1.changelogHead()).era;
    await log1.insert([q('http://ex.org/a', G1)]);
    await log1.insert([q('http://ex.org/b', G2)]);
    expect(guard.state).toEqual({ era: era1, highSeq: 2 }); // high-water tracked per write

    // Fresh store (restart) over the same base + same guard: seq(2) == highSeq(2) ⇒ no rotation.
    const head = await new ChangelogStore(base, { eraGuard: guard }).changelogHead();
    expect(head.era).toBe(era1);
    expect(head.seq).toBe(2);
    await base.close();
  });

  it('era-restore guard: a wipe (era absent) mints a fresh era and resets the guard, not a rollback', async () => {
    class MemGuard implements ChangelogEraGuard {
      state: { era: string; highSeq: number } | null;
      constructor(initial: { era: string; highSeq: number } | null) { this.state = initial; }
      async load() { return this.state; }
      async save(era: string, highSeq: number) { this.state = { era, highSeq }; }
    }
    // Guard remembers a prior era at high seq, but the store was wiped (no era/markers).
    const base = new OxigraphStore();
    const guard = new MemGuard({ era: 'old-era-uuid', highSeq: 99 });
    const head = await new ChangelogStore(base, { eraGuard: guard }).changelogHead();
    expect(head.seq).toBe(0);
    expect(head.era).not.toBe('old-era-uuid');    // fresh era, not a rotation of the old one
    expect(guard.state).toEqual({ era: head.era, highSeq: 0 });
    await base.close();
  });

  it('asChangelogReader unwraps a forwarder that exposes .innerStore (the daemon store wrapper)', async () => {
    const base = new OxigraphStore();
    const log = new ChangelogStore(base);
    // Mimic createListContextGraphsCacheInvalidatingStore: a wrapper that exposes
    // .innerStore but does NOT forward the changelog API.
    const wrapper = { innerStore: log, insert: () => {}, listGraphs: () => Promise.resolve([]) };
    const reader = asChangelogReader(wrapper);
    expect(reader).not.toBeNull();
    expect(await reader!.changelogHead()).toMatchObject({ seq: 0 });
    // A wrapper whose inner chain has no ChangelogStore stays null.
    expect(asChangelogReader({ innerStore: { innerStore: base } })).toBeNull();
    await base.close();
  });
});
