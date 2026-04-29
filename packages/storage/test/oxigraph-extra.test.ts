/**
 * Extra coverage for the OxigraphStore adapter. No mocks — every test
 * runs against a real in-process Oxigraph engine (+ real N-Quads file
 * for durability).
 *
 * Findings covered (see .test-audit/
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
import { mkdtempSync, rmSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
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

  // the numeric-subtype side-table used
  // to live only in memory, so `oxigraph-persistent` lost every publisher-
  // declared `xsd:long` / `xsd:int` / `xsd:short` / `xsd:byte` on restart
  // and `restoreOriginalDatatype*()` collapsed them back to Oxigraph's
  // canonical `xsd:integer`. The fix persists the side-table to a
  // `<persistPath>.numeric-datatypes.json` sidecar and hydrates it on
  // startup — this test pins that contract.
  it('numeric-subtype declarations survive a restart (xsd:long/xsd:int/xsd:short preserved)', async () => {
    try {
      const LONG = 'http://www.w3.org/2001/XMLSchema#long';
      const INT = 'http://www.w3.org/2001/XMLSchema#int';
      const SHORT = 'http://www.w3.org/2001/XMLSchema#short';
      const g = 'urn:dkg:subtype:graph';
      const s1 = new OxigraphStore(persistPath);
      await s1.insert([
        { subject: 'urn:num:a', predicate: 'http://ex.org/v', object: `"9223372036854775807"^^<${LONG}>`, graph: g },
        { subject: 'urn:num:b', predicate: 'http://ex.org/v', object: `"123456"^^<${INT}>`, graph: g },
        { subject: 'urn:num:c', predicate: 'http://ex.org/v', object: `"777"^^<${SHORT}>`, graph: g },
      ]);
      await s1.close();

      // Fresh instance — must rebuild the side-table from the sidecar.
      const s2 = new OxigraphStore(persistPath);
      const r = await s2.query(
        `SELECT ?s ?o WHERE { GRAPH <${g}> { ?s <http://ex.org/v> ?o } } ORDER BY ?s`,
      );
      expect(r.type).toBe('bindings');
      if (r.type !== 'bindings') return;
      const byS: Record<string, string> = {};
      for (const row of r.bindings) byS[row['s'] as string] = row['o'] as string;
      expect(byS['urn:num:a']).toBe(`"9223372036854775807"^^<${LONG}>`);
      expect(byS['urn:num:b']).toBe(`"123456"^^<${INT}>`);
      expect(byS['urn:num:c']).toBe(`"777"^^<${SHORT}>`);
      await s2.close();
    } finally {
      cleanup();
    }
  });

  // Pre-fix the
  // numeric-datatype sidecar was hydrated unconditionally — even when
  // the primary N-Quads dump was missing, empty, or corrupt. That left
  // stale subtype metadata in `originalNumericDatatype` while the store
  // was empty, so the first new `insert()` whose subject reused a
  // sidecar key would silently "restore" the new literal to the OLD
  // datatype that no longer existed in the store. The fix gates sidecar
  // hydration on a successful dump load. Regression test:
  //   1. Persist a real (subtype + sidecar) pair.
  //   2. Delete the dump, leaving only the sidecar.
  //   3. Insert a NEW literal at the same subject/predicate with the
  //      DEFAULT canonical xsd:integer encoding.
  //   4. Read it back. The literal MUST come back as
  //      `"…"^^<xsd:integer>`, NOT silently re-typed to the stale
  //      `xsd:long` from the surviving sidecar.
  it('sidecar is NOT hydrated when the primary dump is missing (no stale subtype leak)', async () => {
    try {
      const LONG = 'http://www.w3.org/2001/XMLSchema#long';
      const INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
      const g = 'urn:dkg:subtype:graph';

      const s1 = new OxigraphStore(persistPath);
      await s1.insert([
        { subject: 'urn:reuse', predicate: 'http://ex.org/v', object: `"42"^^<${LONG}>`, graph: g },
      ]);
      await s1.close();

      // Sanity: the sidecar exists alongside the dump.
      expect(existsSync(persistPath)).toBe(true);
      expect(existsSync(`${persistPath}.numeric-datatypes.json`)).toBe(true);

      // Simulate a partial restore: delete the primary dump but
      // leave the sidecar behind.
      unlinkSync(persistPath);
      expect(existsSync(persistPath)).toBe(false);
      expect(existsSync(`${persistPath}.numeric-datatypes.json`)).toBe(true);

      // Reopen — store starts empty, sidecar must NOT be hydrated.
      const s2 = new OxigraphStore(persistPath);
      // Insert a fresh literal at the same subject/predicate using
      // the canonical xsd:integer datatype. If the stale sidecar
      // had been hydrated, the store would re-tag this literal as
      // xsd:long when reading it back.
      await s2.insert([
        { subject: 'urn:reuse', predicate: 'http://ex.org/v', object: `"99"^^<${INTEGER}>`, graph: g },
      ]);

      const r = await s2.query(
        `SELECT ?o WHERE { GRAPH <${g}> { <urn:reuse> <http://ex.org/v> ?o } }`,
      );
      expect(r.type).toBe('bindings');
      if (r.type !== 'bindings') return;
      expect(r.bindings).toHaveLength(1);
      // No stale xsd:long ressurection — the new literal keeps its
      // canonical xsd:integer typing.
      expect(r.bindings[0]['o']).toBe(`"99"^^<${INTEGER}>`);
      await s2.close();
    } finally {
      cleanup();
    }
  });

  // Companion regression: an EMPTY primary dump must also skip the
  // sidecar (treats empty-but-present the same as missing).
  it('sidecar is NOT hydrated when the primary dump is present-but-empty', async () => {
    try {
      const LONG = 'http://www.w3.org/2001/XMLSchema#long';
      const INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
      const g = 'urn:dkg:subtype:graph';

      const s1 = new OxigraphStore(persistPath);
      await s1.insert([
        { subject: 'urn:reuse2', predicate: 'http://ex.org/v', object: `"7"^^<${LONG}>`, graph: g },
      ]);
      await s1.close();

      // Truncate the dump to an empty file (the sidecar persists).
      writeFileSync(persistPath, '');

      const s2 = new OxigraphStore(persistPath);
      await s2.insert([
        { subject: 'urn:reuse2', predicate: 'http://ex.org/v', object: `"55"^^<${INTEGER}>`, graph: g },
      ]);
      const r = await s2.query(
        `SELECT ?o WHERE { GRAPH <${g}> { <urn:reuse2> <http://ex.org/v> ?o } }`,
      );
      expect(r.type).toBe('bindings');
      if (r.type !== 'bindings') return;
      expect(r.bindings).toHaveLength(1);
      expect(r.bindings[0]['o']).toBe(`"55"^^<${INTEGER}>`);
      await s2.close();
    } finally {
      cleanup();
    }
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
  // . The test stays RED to keep the bug
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

// =======================================================================
// per-position numeric-
// subtype conflict detection. The previous side-table happily let a
// later insert at the SAME `(s, p, value, g)` overwrite a different
// declared subtype, so a SELECT readback silently returned the
// latest-written subtype for both writes. We now mark the position
// (and the lexeme) as conflicted and refuse to restore — the caller
// gets Oxigraph's canonical form (`xsd:integer`).
// =======================================================================
describe('OxigraphStore — per-position numeric-subtype conflict (r31-8 regression)', () => {
  const XSD = 'http://www.w3.org/2001/XMLSchema';
  const intType = `${XSD}#int`;
  const positiveIntegerType = `${XSD}#positiveInteger`;
  const integerType = `${XSD}#integer`;
  const longType = `${XSD}#long`;
  const subject = 'urn:dkg:r31-8:s';
  const predicate = 'http://ex.org/v';
  const graph = 'urn:dkg:r31-8:g';

  it('two writes at the same (s,p,value,g) with DIFFERENT declared subtypes fall back to canonical (NOT silently latest-write-wins)', async () => {
    const store = new OxigraphStore();
    // Write 1: declares xsd:int.
    await store.insert([
      { subject, predicate, object: `"1"^^<${intType}>`, graph },
    ]);
    // Write 2: same lexeme/position but a different declared subtype.
    // Oxigraph collapses both literals to `"1"^^xsd:integer` in the
    // store, so SELECT can ONLY see one canonicalised quad. Without
    // r31-8, the side-table would silently report the LAST-written
    // subtype — for either logical source.
    await store.insert([
      { subject, predicate, object: `"1"^^<${positiveIntegerType}>`, graph },
    ]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    expect(r.bindings).toHaveLength(1);
    // r31-8 contract: when the per-position subtype is ambiguous, the
    // restorer MUST fall back to Oxigraph's canonical xsd:integer
    // form. Returning either xsd:int OR xsd:positiveInteger here
    // would be a fail-OPEN restoration.
    expect(r.bindings[0]['o']).toBe(`"1"^^<${integerType}>`);
    expect(r.bindings[0]['o']).not.toBe(`"1"^^<${intType}>`);
    expect(r.bindings[0]['o']).not.toBe(`"1"^^<${positiveIntegerType}>`);
    await store.close();
  });

  it('CONSTRUCT round-trip on a per-position-conflicted lexeme returns canonical xsd:integer (NOT either source subtype)', async () => {
    const store = new OxigraphStore();
    await store.insert([
      { subject, predicate, object: `"7"^^<${intType}>`, graph },
    ]);
    await store.insert([
      { subject, predicate, object: `"7"^^<${positiveIntegerType}>`, graph },
    ]);

    const c = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
    );
    expect(c.type).toBe('quads');
    if (c.type !== 'quads') return;
    expect(c.quads).toHaveLength(1);
    expect(c.quads[0].object).toBe(`"7"^^<${integerType}>`);
    await store.close();
  });

  it('two writes at the same position with the SAME declared subtype do NOT mark a conflict (idempotent inserts stay restorable)', async () => {
    const store = new OxigraphStore();
    // Same key, same dtype — must NOT trip the conflict detector.
    await store.insert([
      { subject, predicate, object: `"42"^^<${longType}>`, graph },
    ]);
    await store.insert([
      { subject, predicate, object: `"42"^^<${longType}>`, graph },
    ]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    expect(r.bindings).toHaveLength(1);
    // Idempotent insert preserves the original declared subtype.
    expect(r.bindings[0]['o']).toBe(`"42"^^<${longType}>`);
    await store.close();
  });

  it('a SELECT binding whose lexeme matches a per-position-conflicted lexeme refuses lexical-only restore (no sibling-dtype leak)', async () => {
    const store = new OxigraphStore();
    // Position A in graph A: conflicting xsd:int + xsd:positiveInteger.
    await store.insert([
      { subject: 'urn:dkg:r31-8:a', predicate, object: `"5"^^<${intType}>`, graph },
    ]);
    await store.insert([
      { subject: 'urn:dkg:r31-8:a', predicate, object: `"5"^^<${positiveIntegerType}>`, graph },
    ]);
    // Position B in a DIFFERENT graph but same lexeme `5` with a
    // single declared subtype. The lexical fallback would otherwise
    // pick xsd:long — but because the lexeme appears in
    // `conflictedNumericDatatypeLexemes`, even non-conflicted SELECT
    // rows with this lexeme must refuse to restore.
    await store.insert([
      { subject: 'urn:dkg:r31-8:b', predicate, object: `"5"^^<${longType}>`, graph: 'urn:dkg:r31-8:other-graph' },
    ]);

    // Run a SELECT across BOTH graphs that strips position
    // information (no GRAPH binding in projection) — the binding row
    // for the conflicted position would otherwise inherit b's xsd:long
    // through the lexical-only fallback.
    const r = await store.query(
      `SELECT ?s ?o WHERE { GRAPH ?g { ?s <${predicate}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    // Find the row for subject :a (the conflicted lexeme position).
    const aRow = r.bindings.find((b) => b['s'] === 'urn:dkg:r31-8:a');
    expect(aRow).toBeDefined();
    if (!aRow) return;
    // r31-8 contract: lexeme-level conflict refusal scopes to ANY
    // SELECT row carrying the conflicted lexeme, so we must NOT
    // restore it as xsd:long here.
    expect(aRow['o']).toBe(`"5"^^<${integerType}>`);
    expect(aRow['o']).not.toBe(`"5"^^<${longType}>`);
    await store.close();
  });
});

// =======================================================================
// oxigraph.ts:169, KK3b): when the last
// per-key conflict marker for a lexeme is evicted (because the
// contributing quad was deleted, the graph dropped, or the subject
// prefix wiped) the COMPANION lexeme-level marker MUST also be
// recomputed against ground truth. the lexeme marker was
// kept "pessimistically" forever, so once `"V"` had a transient
// conflict at any position EVERY future write of any
// `"V"^^xsd:<numeric>` literal across the entire store fell back to
// canonical xsd:integer regardless of whether any conflict still
// existed.
// =======================================================================
describe('OxigraphStore — lexeme-marker GC after conflict-key eviction (r31-13 KK3b regression)', () => {
  const XSD = 'http://www.w3.org/2001/XMLSchema';
  const intType = `${XSD}#int`;
  const positiveIntegerType = `${XSD}#positiveInteger`;
  const integerType = `${XSD}#integer`;
  const longType = `${XSD}#long`;
  const predicate = 'http://ex.org/v';

  it('after delete() removes the contributing quad, a FRESH write of the same lexeme on a clean key is restorable to its declared subtype (lexeme marker GC\'d)', async () => {
    const store = new OxigraphStore();
    const subject = 'urn:dkg:r31-13-kk3b:s';
    const graph = 'urn:dkg:r31-13-kk3b:g';

    await store.insert([
      { subject, predicate, object: `"9"^^<${intType}>`, graph },
    ]);
    await store.insert([
      { subject, predicate, object: `"9"^^<${positiveIntegerType}>`, graph },
    ]);

    {
      const r = await store.query(
        `SELECT ?o WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?o } }`,
      );
      expect(r.type).toBe('bindings');
      if (r.type !== 'bindings') return;
      expect(r.bindings).toHaveLength(1);
      expect(r.bindings[0]['o']).toBe(`"9"^^<${integerType}>`);
    }

    // Delete the conflicting canonical literal at this position.
    // r31-8 already drops the per-key conflict marker; r31-13
    // additionally GCs the lexeme-level marker because no remaining
    // key still conflicts on `"9"`.
    await store.delete([
      { subject, predicate, object: `"9"^^<${integerType}>`, graph },
    ]);

    // Fresh write of the same lexeme on a clean key — pre-KK3b the
    // stale lexeme marker would have permanently downgraded this
    // restore to xsd:integer, even though there is no remaining
    // conflict anywhere in the store.
    const otherSubject = 'urn:dkg:r31-13-kk3b:other';
    const otherGraph = 'urn:dkg:r31-13-kk3b:other-graph';
    await store.insert([
      { subject: otherSubject, predicate, object: `"9"^^<${longType}>`, graph: otherGraph },
    ]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${otherGraph}> { <${otherSubject}> <${predicate}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    expect(r.bindings).toHaveLength(1);
    expect(r.bindings[0]['o']).toBe(`"9"^^<${longType}>`);
    expect(r.bindings[0]['o']).not.toBe(`"9"^^<${integerType}>`);
    await store.close();
  });

  it('after dropGraph() wipes the contributing graph, a fresh write of the same lexeme in a different graph is restorable (evict path GCs lexeme marker)', async () => {
    const store = new OxigraphStore();
    const conflictGraph = 'urn:dkg:r31-13-kk3b:dropme';
    const subject = 'urn:dkg:r31-13-kk3b:dropsubject';

    await store.insert([
      { subject, predicate, object: `"3"^^<${intType}>`, graph: conflictGraph },
    ]);
    await store.insert([
      { subject, predicate, object: `"3"^^<${positiveIntegerType}>`, graph: conflictGraph },
    ]);

    await store.dropGraph(conflictGraph);

    // Fresh write of the same lexeme in a fully unrelated graph.
    // Pre-KK3b the lexeme-level marker survived dropGraph and
    // permanently downgraded this restore.
    const cleanSubject = 'urn:dkg:r31-13-kk3b:cleansubject';
    const cleanGraph = 'urn:dkg:r31-13-kk3b:cleangraph';
    await store.insert([
      { subject: cleanSubject, predicate, object: `"3"^^<${longType}>`, graph: cleanGraph },
    ]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${cleanGraph}> { <${cleanSubject}> <${predicate}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    expect(r.bindings).toHaveLength(1);
    expect(r.bindings[0]['o']).toBe(`"3"^^<${longType}>`);
    expect(r.bindings[0]['o']).not.toBe(`"3"^^<${integerType}>`);
    await store.close();
  });

  it('lexeme marker is RETAINED while ANOTHER per-key conflict still references that lexeme (partial eviction must not over-release)', async () => {
    const store = new OxigraphStore();
    const lexeme = '11';
    const conflictPredicate = 'http://ex.org/conflict';
    const aSubject = 'urn:dkg:r31-13-kk3b:guard:a';
    const bSubject = 'urn:dkg:r31-13-kk3b:guard:b';
    const aGraph = 'urn:dkg:r31-13-kk3b:guard:agraph';
    const bGraph = 'urn:dkg:r31-13-kk3b:guard:bgraph';

    // Conflict #1: subject A in graph A.
    await store.insert([
      { subject: aSubject, predicate: conflictPredicate, object: `"${lexeme}"^^<${intType}>`, graph: aGraph },
    ]);
    await store.insert([
      { subject: aSubject, predicate: conflictPredicate, object: `"${lexeme}"^^<${positiveIntegerType}>`, graph: aGraph },
    ]);
    // Conflict #2: subject B in graph B (independent key, same lexeme).
    await store.insert([
      { subject: bSubject, predicate: conflictPredicate, object: `"${lexeme}"^^<${intType}>`, graph: bGraph },
    ]);
    await store.insert([
      { subject: bSubject, predicate: conflictPredicate, object: `"${lexeme}"^^<${positiveIntegerType}>`, graph: bGraph },
    ]);

    // Drop graph A — releases conflict-key #1 only. Conflict-key #2
    // still references lexeme `11`, so the lexeme marker MUST stay.
    await store.dropGraph(aGraph);

    // Fresh write of the same lexeme on a clean key — the lexeme
    // marker must still suppress lexical-only restore here, because
    // ambiguity for `11` is still real (subject B in graph B).
    const guardSubject = 'urn:dkg:r31-13-kk3b:guard:fresh';
    const guardGraph = 'urn:dkg:r31-13-kk3b:guard:freshgraph';
    await store.insert([
      { subject: guardSubject, predicate: conflictPredicate, object: `"${lexeme}"^^<${longType}>`, graph: guardGraph },
    ]);

    // Project across all graphs without binding ?g so the lexical
    // fallback would fire if the lexeme marker had been mistakenly
    // released.
    const r = await store.query(
      `SELECT ?s ?o WHERE { GRAPH ?g { ?s <${conflictPredicate}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    const guardRow = r.bindings.find((b) => b['s'] === guardSubject);
    expect(guardRow).toBeDefined();
    if (!guardRow) return;
    // Must remain canonical because lexeme `11` is still ambiguous
    // somewhere in the live store.
    expect(guardRow['o']).toBe(`"${lexeme}"^^<${integerType}>`);
    expect(guardRow['o']).not.toBe(`"${lexeme}"^^<${longType}>`);

    // Now drop graph B too — lexeme `11` finally has no remaining
    // contributing key. The lexeme marker MUST now be released, and
    // a fresh write on yet another clean key must restore correctly.
    await store.dropGraph(bGraph);

    const finalSubject = 'urn:dkg:r31-13-kk3b:guard:final';
    const finalGraph = 'urn:dkg:r31-13-kk3b:guard:finalgraph';
    await store.insert([
      { subject: finalSubject, predicate: conflictPredicate, object: `"${lexeme}"^^<${longType}>`, graph: finalGraph },
    ]);
    const r2 = await store.query(
      `SELECT ?o WHERE { GRAPH <${finalGraph}> { <${finalSubject}> <${conflictPredicate}> ?o } }`,
    );
    expect(r2.type).toBe('bindings');
    if (r2.type !== 'bindings') return;
    expect(r2.bindings).toHaveLength(1);
    expect(r2.bindings[0]['o']).toBe(`"${lexeme}"^^<${longType}>`);
    await store.close();
  });

  it('after deleteBySubjectPrefix() wipes the contributing subject, a fresh write of the same lexeme in another subject is restorable', async () => {
    const store = new OxigraphStore();
    // Conflict on subject prefix `urn:dkg:r31-13-kk3b:wipe:`.
    const conflictSubject = 'urn:dkg:r31-13-kk3b:wipe:conflict';
    const conflictGraph = 'urn:dkg:r31-13-kk3b:wipe:graph';

    await store.insert([
      { subject: conflictSubject, predicate, object: `"77"^^<${intType}>`, graph: conflictGraph },
    ]);
    await store.insert([
      { subject: conflictSubject, predicate, object: `"77"^^<${positiveIntegerType}>`, graph: conflictGraph },
    ]);

    await store.deleteBySubjectPrefix(conflictGraph, 'urn:dkg:r31-13-kk3b:wipe:');

    // Fresh write — must NOT be downgraded by a stale lexeme marker.
    const cleanSubject = 'urn:dkg:r31-13-kk3b:wipe:clean';
    await store.insert([
      { subject: cleanSubject, predicate, object: `"77"^^<${longType}>`, graph: conflictGraph },
    ]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${conflictGraph}> { <${cleanSubject}> <${predicate}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    expect(r.bindings).toHaveLength(1);
    expect(r.bindings[0]['o']).toBe(`"77"^^<${longType}>`);
    expect(r.bindings[0]['o']).not.toBe(`"77"^^<${integerType}>`);
    await store.close();
  });

  it('forgetNumericDatatype on a non-numeric quad does NOT release unrelated lexeme markers', async () => {
    const store = new OxigraphStore();
    const subject = 'urn:dkg:r31-13-kk3b:noop:s';
    const graph = 'urn:dkg:r31-13-kk3b:noop:g';

    // Establish a real conflict on lexeme `13` so a lexeme marker exists.
    await store.insert([
      { subject, predicate, object: `"13"^^<${intType}>`, graph },
    ]);
    await store.insert([
      { subject, predicate, object: `"13"^^<${positiveIntegerType}>`, graph },
    ]);

    // Delete an UNRELATED non-numeric quad — must not GC anything.
    await store.insert([
      { subject, predicate: 'http://ex.org/label', object: '"hello"', graph },
    ]);
    await store.delete([
      { subject, predicate: 'http://ex.org/label', object: '"hello"', graph },
    ]);

    // Lexeme marker for `13` must still suppress restore on a fresh key.
    const cleanSubject = 'urn:dkg:r31-13-kk3b:noop:clean';
    const cleanGraph = 'urn:dkg:r31-13-kk3b:noop:cleangraph';
    await store.insert([
      { subject: cleanSubject, predicate, object: `"13"^^<${longType}>`, graph: cleanGraph },
    ]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${cleanGraph}> { <${cleanSubject}> <${predicate}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    expect(r.bindings).toHaveLength(1);
    expect(r.bindings[0]['o']).toBe(`"13"^^<${integerType}>`);
    await store.close();
  });
});
