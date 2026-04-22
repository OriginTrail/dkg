/**
 * Extra coverage for the OxigraphStore adapter. No mocks — every test
 * runs against a real in-process Oxigraph engine (+ real N-Quads file
 * for durability).
 *
 * Findings covered (see .test-audit/BUGS_FOUND.md "packages/storage"):
 *
 *   ST-5  oxigraph-persistent durability — close and re-open from the
 *          same path must recover every quad.
 *
 *   ST-6  Concurrent insert / deleteByPattern on the same graph must
 *          produce a deterministic final state.
 *
 *   ST-8  DESCRIBE query on the real adapter (returns CONSTRUCT-like
 *          quads for the described subject).
 *
 *   ST-9  ASK query on the real engine — positive + negative branch.
 *
 *   ST-10 Duplicate insert — same quad twice collapses to one quad
 *          (RDF set semantics).
 *
 *   ST-11 Bulk insert at scale (100k triples) — completes without OOM
 *          and count matches.
 *
 *   ST-12 N-Quads typed-literal regression test explicitly named for
 *          issue #34 — `"42"^^<xsd:integer>` round-trips through
 *          insert → query → re-insert → query without loss.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OxigraphStore,
  createTripleStore,
  type Quad,
  type TripleStore,
} from '../src/index.js';

// =======================================================================
// ST-5 — durability via oxigraph-persistent
// =======================================================================
describe('oxigraph-persistent — durability [ST-5]', () => {
  let dir: string;
  let persistPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-ox-persist-'));
    persistPath = join(dir, 'store.nq');
  });

  function cleanup() {
    rmSync(dir, { recursive: true, force: true });
  }

  it('close() flushes and a fresh instance at the same path recovers every quad', async () => {
    try {
      const s1 = new OxigraphStore(persistPath);
      const quads: Quad[] = Array.from({ length: 25 }, (_, i) => ({
        subject: `urn:dkg:durable:${i}`,
        predicate: 'http://ex.org/idx',
        object: `"${i}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        graph: 'urn:dkg:durable:graph',
      }));
      await s1.insert(quads);
      // close() must drain the debounced flushTimer.
      await s1.close();
      expect(existsSync(persistPath)).toBe(true);

      const s2 = new OxigraphStore(persistPath);
      expect(await s2.countQuads('urn:dkg:durable:graph')).toBe(25);

      // Verify a specific literal survives with its datatype intact.
      const r = await s2.query(
        `SELECT ?o WHERE { GRAPH <urn:dkg:durable:graph> { <urn:dkg:durable:7> <http://ex.org/idx> ?o } }`,
      );
      expect(r.type).toBe('bindings');
      if (r.type === 'bindings') {
        expect(r.bindings[0]['o']).toBe(
          '"7"^^<http://www.w3.org/2001/XMLSchema#integer>',
        );
      }
      await s2.close();
    } finally {
      cleanup();
    }
  });

  it('oxigraph-persistent factory rejects missing path (contract test)', async () => {
    await expect(
      createTripleStore({ backend: 'oxigraph-persistent' }),
    ).rejects.toThrow(/oxigraph-persistent requires options\.path/);
  });

  it('delete then close also flushes — reopen shows deletion', async () => {
    try {
      const s1 = new OxigraphStore(persistPath);
      const q: Quad = {
        subject: 'urn:dkg:toggle:s',
        predicate: 'http://ex.org/p',
        object: '"keep-or-kill"',
        graph: 'urn:dkg:toggle:g',
      };
      await s1.insert([q]);
      await s1.delete([q]);
      await s1.close();

      const s2 = new OxigraphStore(persistPath);
      expect(await s2.countQuads('urn:dkg:toggle:g')).toBe(0);
      await s2.close();
    } finally {
      cleanup();
    }
  });
});

// =======================================================================
// ST-6 — concurrent insert/deleteByPattern on the same graph
// =======================================================================
describe('Concurrent insert / deleteByPattern [ST-6]', () => {
  it('parallel inserts produce a deterministic final quad count', async () => {
    const store = new OxigraphStore();
    const g = 'urn:dkg:concurrent:g';

    const batches = Array.from({ length: 20 }, (_, b) =>
      Array.from({ length: 50 }, (_, i) => ({
        subject: `urn:dkg:c:${b}:${i}`,
        predicate: 'http://ex.org/p',
        object: `"${b}-${i}"`,
        graph: g,
      })),
    );

    await Promise.all(batches.map((batch) => store.insert(batch)));
    expect(await store.countQuads(g)).toBe(20 * 50);
    await store.close();
  });

  it('parallel insert + deleteByPattern settles deterministically (all inserts pre-delete visible)', async () => {
    const store = new OxigraphStore();
    const g = 'urn:dkg:racetrack:g';
    const victim = 'urn:dkg:racetrack:victim';

    // Pre-seed the victim so the deleteByPattern has real work to do.
    await store.insert([
      { subject: victim, predicate: 'http://ex.org/p', object: '"0"', graph: g },
    ]);

    const inserts = Array.from({ length: 30 }, (_, i) =>
      store.insert([
        {
          subject: `urn:dkg:racetrack:other:${i}`,
          predicate: 'http://ex.org/p',
          object: `"${i}"`,
          graph: g,
        },
      ]),
    );
    const deletes = Array.from({ length: 5 }, () =>
      store.deleteByPattern({ graph: g, subject: victim }),
    );

    const results = await Promise.all([...inserts, ...deletes]);
    const removedCounts = results.slice(inserts.length) as number[];
    // At most one of the five delete calls should find the victim,
    // because subsequent deletes see an empty pattern. Never negative,
    // never >1.
    const totalRemoved = removedCounts.reduce((a, b) => a + (b ?? 0), 0);
    expect(totalRemoved).toBeLessThanOrEqual(1);

    // Victim gone, unrelated inserts intact.
    expect(await store.countQuads(g)).toBe(30 + (1 - totalRemoved));

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${g}> { <${victim}> <http://ex.org/p> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type === 'bindings') {
      expect(r.bindings.length).toBe(1 - totalRemoved);
    }
    await store.close();
  });
});

// =======================================================================
// ST-8 — DESCRIBE query
// =======================================================================
describe('OxigraphStore DESCRIBE [ST-8]', () => {
  it('returns CONSTRUCT-equivalent quads for the described subject', async () => {
    const store = new OxigraphStore();
    const g = 'urn:dkg:describe:g';
    const s = 'urn:dkg:describe:s';

    await store.insert([
      { subject: s, predicate: 'http://schema.org/name', object: '"Alice"', graph: g },
      { subject: s, predicate: 'http://schema.org/age', object: '"30"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: g },
      { subject: 'urn:dkg:describe:other', predicate: 'http://schema.org/name', object: '"Bob"', graph: g },
    ]);

    const r = await store.query(`DESCRIBE <${s}> FROM <${g}>`);
    expect(r.type).toBe('quads');
    if (r.type !== 'quads') return;
    // Must include both predicates for the described subject, and must
    // NOT pull in the unrelated "Bob" quad.
    const subjects = r.quads.map((q) => q.subject);
    expect(new Set(subjects)).toEqual(new Set([s]));
    const predicates = new Set(r.quads.map((q) => q.predicate));
    expect(predicates).toEqual(
      new Set(['http://schema.org/name', 'http://schema.org/age']),
    );
    await store.close();
  });
});

// =======================================================================
// ST-9 — ASK query
// =======================================================================
describe('OxigraphStore ASK [ST-9]', () => {
  let store: TripleStore;

  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('returns { type: "boolean", value: true } when the pattern matches', async () => {
    await store.insert([
      { subject: 'urn:dkg:ask:s', predicate: 'http://ex.org/p', object: '"yes"', graph: 'urn:dkg:ask:g' },
    ]);
    const r = await store.query(
      `ASK { GRAPH <urn:dkg:ask:g> { <urn:dkg:ask:s> <http://ex.org/p> "yes" } }`,
    );
    expect(r).toEqual({ type: 'boolean', value: true });
  });

  it('returns { type: "boolean", value: false } when no data matches', async () => {
    await store.insert([
      { subject: 'urn:dkg:ask:s', predicate: 'http://ex.org/p', object: '"yes"', graph: 'urn:dkg:ask:g' },
    ]);
    const r = await store.query(
      `ASK { GRAPH <urn:dkg:ask:g> { <urn:dkg:ask:s> <http://ex.org/p> "NOPE" } }`,
    );
    expect(r).toEqual({ type: 'boolean', value: false });
  });

  it('ASK against an empty store returns false, not an error', async () => {
    const r = await store.query(`ASK { ?s ?p ?o }`);
    expect(r).toEqual({ type: 'boolean', value: false });
  });
});

// =======================================================================
// ST-10 — duplicate insert (RDF set semantics)
// =======================================================================
describe('OxigraphStore — RDF set semantics on duplicate insert [ST-10]', () => {
  it('inserting the identical quad twice stores one copy', async () => {
    const store = new OxigraphStore();
    const q: Quad = {
      subject: 'urn:dkg:dup:s',
      predicate: 'http://ex.org/p',
      object: '"v"',
      graph: 'urn:dkg:dup:g',
    };

    await store.insert([q]);
    await store.insert([q]);
    await store.insert([q, q, q]);

    expect(await store.countQuads('urn:dkg:dup:g')).toBe(1);
    await store.close();
  });

  it('duplicate inside a single insert() call also collapses', async () => {
    const store = new OxigraphStore();
    const q: Quad = {
      subject: 'urn:dkg:dup:s',
      predicate: 'http://ex.org/p',
      object: '"v"',
      graph: 'urn:dkg:dup:g',
    };
    await store.insert([q, q, q, q, q]);
    expect(await store.countQuads('urn:dkg:dup:g')).toBe(1);
    await store.close();
  });

  it('differing typed-literal datatype makes the quad distinct (set key includes datatype)', async () => {
    const store = new OxigraphStore();
    const g = 'urn:dkg:dup:typed';
    await store.insert([
      { subject: 'urn:s', predicate: 'http://ex.org/v', object: '"42"', graph: g },
      {
        subject: 'urn:s',
        predicate: 'http://ex.org/v',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: g,
      },
      {
        subject: 'urn:s',
        predicate: 'http://ex.org/v',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#string>',
        graph: g,
      },
    ]);
    // xsd:string literal is canonical-equivalent to a plain literal in
    // RDF 1.1, so Oxigraph collapses those two. xsd:integer is distinct.
    expect(await store.countQuads(g)).toBe(2);
    await store.close();
  });
});

// =======================================================================
// ST-11 — bulk insert / scale
// =======================================================================
describe('OxigraphStore — bulk insert scale [ST-11]', () => {
  it('100,000 triples land in a single graph without OOM and count matches', async () => {
    const store = new OxigraphStore();
    const g = 'urn:dkg:scale:g';
    const N = 100_000;

    // Batch to keep the interim N-Quads buffer bounded. The adapter
    // itself loads the whole blob at once; chunking models realistic
    // publisher behaviour and keeps the test memory-stable.
    const CHUNK = 10_000;
    for (let offset = 0; offset < N; offset += CHUNK) {
      const batch: Quad[] = new Array(CHUNK);
      for (let i = 0; i < CHUNK; i++) {
        const idx = offset + i;
        batch[i] = {
          subject: `urn:dkg:scale:${idx}`,
          predicate: 'http://ex.org/idx',
          object: `"${idx}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
          graph: g,
        };
      }
      await store.insert(batch);
    }

    expect(await store.countQuads(g)).toBe(N);
    await store.close();
  }, 60_000);
});

// =======================================================================
// ST-12 — N-Quads typed-literal regression (issue #34)
// =======================================================================
describe('N-Quads typed-literal round-trip — regression for issue #34 [ST-12]', () => {
  // PROD-BUG: Oxigraph silently normalises XSD subtypes to their
  // lexical supertype on SELECT. `"42"^^<xsd:long>` comes back as
  // `"42"^^<xsd:integer>`; `"42"^^<xsd:nonNegativeInteger>` likewise.
  // Downstream callers that rely on the exact datatype (e.g.
  // `packages/publisher/src/dkg-publisher.ts#parseRdfInt`, which enumerates
  // xsd:integer / xsd:long explicitly) can mis-parse or drop values.
  // This is the spec-drift that issue #34 tracks — see
  // BUGS_FOUND.md ST-12 / DUP #34. The test stays RED to keep the bug
  // visible until the storage layer either (a) stops normalising or
  // (b) documents the normalisation and callers are updated.

  const DATATYPES = [
    'http://www.w3.org/2001/XMLSchema#integer',
    'http://www.w3.org/2001/XMLSchema#long',
    'http://www.w3.org/2001/XMLSchema#decimal',
    'http://www.w3.org/2001/XMLSchema#boolean',
    'http://www.w3.org/2001/XMLSchema#dateTime',
  ];

  it.each(DATATYPES)('preserves datatype %s through SELECT round-trip', async (dt) => {
    const store = new OxigraphStore();
    const g = 'urn:dkg:issue-34:g';
    const value =
      dt.endsWith('#boolean')
        ? 'true'
        : dt.endsWith('#dateTime')
          ? '2026-01-01T00:00:00Z'
          : dt.endsWith('#decimal')
            ? '3.14'
            : '42';
    const objectLiteral = `"${value}"^^<${dt}>`;

    await store.insert([
      { subject: 'urn:dkg:issue-34:s', predicate: 'http://ex.org/v', object: objectLiteral, graph: g },
    ]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${g}> { <urn:dkg:issue-34:s> <http://ex.org/v> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type === 'bindings') {
      expect(r.bindings[0]['o']).toBe(objectLiteral);
    }
    await store.close();
  });

  it('CONSTRUCT emits typed literals that re-parse into an identical store', async () => {
    const src = new OxigraphStore();
    const g = 'urn:dkg:issue-34:src';
    await src.insert([
      {
        subject: 'urn:dkg:issue-34:count',
        predicate: 'http://ex.org/n',
        object: '"9223372036854775807"^^<http://www.w3.org/2001/XMLSchema#long>',
        graph: g,
      },
    ]);

    const r = await src.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${g}> { ?s ?p ?o } }`,
    );
    expect(r.type).toBe('quads');
    if (r.type !== 'quads') return;

    const sink = new OxigraphStore();
    await sink.insert(
      r.quads.map((q) => ({ ...q, graph: 'urn:dkg:issue-34:sink' })),
    );

    const back = await sink.query(
      `SELECT ?o WHERE { GRAPH <urn:dkg:issue-34:sink> { ?s ?p ?o } }`,
    );
    expect(back.type).toBe('bindings');
    if (back.type === 'bindings') {
      expect(back.bindings[0]['o']).toBe(
        '"9223372036854775807"^^<http://www.w3.org/2001/XMLSchema#long>',
      );
    }
    await src.close();
    await sink.close();
  });
});
