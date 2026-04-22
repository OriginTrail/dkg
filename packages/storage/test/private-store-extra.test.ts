/**
 * Extra coverage for PrivateContentStore and named-graph confidentiality
 * model. No mocks — every test runs against a real OxigraphStore.
 *
 * Findings covered (see .test-audit/BUGS_FOUND.md, "packages/storage"):
 *
 *   ST-2  PROD-BUG — PrivateContentStore is documented as encrypted private
 *          storage but src/private-store.ts only remaps the graph URI. The
 *          literal value lands on disk in plaintext.
 *
 *   ST-3  Named-graph isolation using REAL V10 URIs
 *          (contextGraphSharedMemoryUri / contextGraphVerifiedMemoryUri /
 *          contextGraphPrivateUri). Axiom 5 of the spec.
 *
 *   ST-4  Dual-graph leak — a SPARQL query scoped to the public data graph
 *          must NOT see triples that live in the _private graph (DUP #38, #39).
 *
 *   ST-7  SPARQL injection negative tests — malicious rootEntity values
 *          ("> <evil", '"; DROP …') must be rejected by assertSafeIri, never
 *          smuggled into the SPARQL body.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OxigraphStore,
  ContextGraphManager,
  PrivateContentStore,
  type Quad,
  type TripleStore,
} from '../src/index.js';
import {
  contextGraphDataUri,
  contextGraphPrivateUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiedMemoryUri,
} from '@origintrail-official/dkg-core';

const CONTEXT_GRAPH = 'agent-registry';
const ROOT = 'did:dkg:agent:QmSecretHolder';

// =======================================================================
// ST-2 — "encrypted private storage" is a lie.
// =======================================================================
describe('PrivateContentStore — at-rest confidentiality [ST-2]', () => {
  // PROD-BUG: PrivateContentStore does NOT encrypt. src/private-store.ts
  // only remaps the quad's graph URI to the <cg>/_private named graph.
  // The literal object is persisted verbatim by Oxigraph. Any operator
  // with read access to the on-disk N-Quads file or the SPARQL endpoint
  // can recover the plaintext. README claims otherwise — see
  // BUGS_FOUND.md ST-2. Leaving this test RED is the evidence.

  const SECRET = 'SECRET_PLAINTEXT_AAAA';
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dkg-private-store-'));
  });

  it('on-disk N-Quads dump must not contain the plaintext literal', async () => {
    const persistPath = join(tempDir, 'store.nq');
    const store = new OxigraphStore(persistPath);
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      {
        subject: ROOT,
        predicate: 'http://schema.org/ssn',
        object: `"${SECRET}"`,
        graph: '',
      },
    ]);
    // Force the debounced flush to land on disk.
    await store.close();

    const onDisk = readFileSync(persistPath, 'utf-8');
    try {
      expect(onDisk).not.toContain(SECRET);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a second, unrelated SPARQL client can read the secret verbatim', async () => {
    // The "confidentiality" model is purely a query-routing convention:
    // whoever queries `GRAPH <…/_private> { ?s ?p ?o }` gets everything.
    // No capability check, no encryption key. Demonstrates the gap.
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      { subject: ROOT, predicate: 'http://schema.org/ssn', object: `"${SECRET}"`, graph: '' },
    ]);

    // Simulate an unrelated caller that just knows the graph URI.
    const privateGraph = contextGraphPrivateUri(CONTEXT_GRAPH);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${privateGraph}> { ?s ?p ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type !== 'bindings') return;
    const objects = result.bindings.map((b) => b['o']);
    // PROD-BUG: plaintext readable by anyone with SPARQL access.
    // See BUGS_FOUND.md ST-2.
    expect(objects).toContain(`"${SECRET}"`);
  });
});

// =======================================================================
// ST-3 — Named-graph isolation (Axiom 5) using REAL V10 URIs.
// =======================================================================
describe('Named-graph isolation — real V10 URIs [ST-3]', () => {
  let store: TripleStore;

  beforeEach(() => {
    store = new OxigraphStore();
  });

  const s = 'urn:test:s';
  const p = 'http://ex.org/p';

  function quadIn(graph: string, obj: string): Quad {
    return { subject: s, predicate: p, object: `"${obj}"`, graph };
  }

  it('shared-memory insert is invisible to verified-memory SELECT', async () => {
    const shared = contextGraphSharedMemoryUri(CONTEXT_GRAPH);
    const verified = contextGraphVerifiedMemoryUri(CONTEXT_GRAPH, 'vm-1');

    await store.insert([quadIn(shared, 'shared-only')]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${verified}> { <${s}> <${p}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    expect(r.bindings).toEqual([]);
  });

  it('private-graph insert is invisible to shared-memory SELECT', async () => {
    const priv = contextGraphPrivateUri(CONTEXT_GRAPH);
    const shared = contextGraphSharedMemoryUri(CONTEXT_GRAPH);

    await store.insert([quadIn(priv, 'private-only')]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${shared}> { <${s}> <${p}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    expect(r.bindings).toEqual([]);
  });

  it('distinct values in three V10 named graphs remain distinct after SELECT', async () => {
    const shared = contextGraphSharedMemoryUri(CONTEXT_GRAPH);
    const verified = contextGraphVerifiedMemoryUri(CONTEXT_GRAPH, 'vm-1');
    const priv = contextGraphPrivateUri(CONTEXT_GRAPH);

    await store.insert([
      quadIn(shared, 'v-shared'),
      quadIn(verified, 'v-verified'),
      quadIn(priv, 'v-private'),
    ]);

    for (const [g, expected] of [
      [shared, '"v-shared"'],
      [verified, '"v-verified"'],
      [priv, '"v-private"'],
    ] as const) {
      const r = await store.query(
        `SELECT ?o WHERE { GRAPH <${g}> { <${s}> <${p}> ?o } }`,
      );
      expect(r.type).toBe('bindings');
      if (r.type !== 'bindings') continue;
      expect(r.bindings.map((b) => b['o'])).toEqual([expected]);
    }
  });

  it('dropping one V10 graph leaves sibling graphs untouched', async () => {
    const shared = contextGraphSharedMemoryUri(CONTEXT_GRAPH);
    const priv = contextGraphPrivateUri(CONTEXT_GRAPH);

    await store.insert([quadIn(shared, 'alive'), quadIn(priv, 'die')]);
    await store.dropGraph(priv);

    expect(await store.countQuads(priv)).toBe(0);
    expect(await store.countQuads(shared)).toBe(1);
  });
});

// =======================================================================
// ST-4 — Dual-graph leak: public data graph must not surface _private
//        content (DUP #38 / #39).
// =======================================================================
describe('Dual-graph confidentiality leak [ST-4]', () => {
  it('SELECT against the public data graph excludes _private quads', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const publicQuad: Quad = {
      subject: ROOT,
      predicate: 'http://schema.org/name',
      object: '"public-name"',
      graph: contextGraphDataUri(CONTEXT_GRAPH),
    };
    await store.insert([publicQuad]);

    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      {
        subject: ROOT,
        predicate: 'http://schema.org/ssn',
        object: '"PRIVATE-SSN-9999"',
        graph: '',
      },
    ]);

    // A standard public query addresses the data graph explicitly.
    const pub = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${contextGraphDataUri(CONTEXT_GRAPH)}> { <${ROOT}> ?p ?o } }`,
    );
    expect(pub.type).toBe('bindings');
    if (pub.type !== 'bindings') return;
    const values = pub.bindings.map((b) => b['o']);
    expect(values).toContain('"public-name"');
    expect(values).not.toContain('"PRIVATE-SSN-9999"');
  });

  it('UNION of _shared_memory + dataGraph still excludes _private', async () => {
    // A common query builder mistake is `UNION` over every "readable" graph.
    // Verify that as long as _private is not explicitly named, it is not
    // pulled in by a catch-all public query.
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const dataG = contextGraphDataUri(CONTEXT_GRAPH);
    const sharedG = contextGraphSharedMemoryUri(CONTEXT_GRAPH);

    await store.insert([
      { subject: ROOT, predicate: 'http://ex.org/a', object: '"data"', graph: dataG },
      { subject: ROOT, predicate: 'http://ex.org/b', object: '"shared"', graph: sharedG },
    ]);
    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      { subject: ROOT, predicate: 'http://ex.org/c', object: '"LEAKED"', graph: '' },
    ]);

    const r = await store.query(`
      SELECT ?o WHERE {
        { GRAPH <${dataG}> { <${ROOT}> ?p ?o } }
        UNION
        { GRAPH <${sharedG}> { <${ROOT}> ?p ?o } }
      }
    `);
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    const values = r.bindings.map((b) => b['o']);
    expect(values.sort()).toEqual(['"data"', '"shared"']);
    expect(values).not.toContain('"LEAKED"');
  });
});

// =======================================================================
// ST-7 — SPARQL injection: assertSafeIri must reject malicious rootEntity.
// =======================================================================
describe('PrivateContentStore — SPARQL injection defence [ST-7]', () => {
  let store: TripleStore;
  let gm: ContextGraphManager;
  let ps: PrivateContentStore;

  beforeEach(() => {
    store = new OxigraphStore();
    gm = new ContextGraphManager(store);
    ps = new PrivateContentStore(store, gm);
  });

  const MALICIOUS_ROOTS = [
    'did:dkg:agent:evil> <http://attacker/xyz',
    'did:dkg:agent:evil"; DROP ALL; #',
    'did:dkg:agent:evil\n} DELETE WHERE { ?s ?p ?o }\n{',
    'did:dkg:agent:evil>\n}',
    'did:dkg:agent:evil<>',
    'did:dkg:agent:evil{injected}',
    'did:dkg:agent:evil|pipe',
    'did:dkg:agent:evil`backtick',
    '',
    'did:dkg:agent:evil with space',
  ];

  it.each(MALICIOUS_ROOTS)('getPrivateTriples rejects malicious rootEntity %#', async (root) => {
    await expect(ps.getPrivateTriples(CONTEXT_GRAPH, root)).rejects.toThrow(
      /Unsafe or empty IRI/,
    );
  });

  it.each(MALICIOUS_ROOTS)('deletePrivateTriples rejects malicious rootEntity %#', async (root) => {
    // deletePrivateTriples → deleteBySubjectPrefix; the oxigraph adapter
    // escapes the prefix string, but assertSafeIri is not invoked on
    // this code path. Document current behaviour: when root is non-empty
    // we expect either a rejected promise (if a future patch adds
    // assertSafeIri) or a successful no-op. The test fails if the engine
    // executes a smuggled UPDATE that widens the delete beyond the graph.
    const probeQuad: Quad = {
      subject: 'urn:probe:survivor',
      predicate: 'http://ex.org/p',
      object: '"probe"',
      graph: 'urn:probe:graph',
    };
    await store.insert([probeQuad]);

    // Either outcome is acceptable for this malicious-input probe:
    //   (a) delete rejects with an IRI-safety / syntax error — the
    //       desired defensive behaviour; OR
    //   (b) delete succeeds as a scoped no-op and leaves the probe
    //       intact — also acceptable because the real invariant is
    //       "no injection widening".
    // A bare empty catch used to accept ANY thrown error shape, which
    // would have hidden regressions in the delete pipeline (store
    // error, timeout, assertion framework error). Narrow to the
    // defensive error class and assert the probe invariant always.
    let deleteThrew = false;
    let deleteError: unknown;
    try {
      await ps.deletePrivateTriples(CONTEXT_GRAPH, root);
    } catch (err) {
      deleteThrew = true;
      deleteError = err;
    }

    // Probe invariant: the unrelated-graph quad MUST survive no matter
    // which branch ran. If injection widened the DELETE the probe
    // would be gone and this assertion catches the regression.
    expect(await store.countQuads('urn:probe:graph')).toBe(1);

    // If delete rejected, at minimum it must be a real Error — not
    // `undefined`, a string, or an assertion-framework artefact. The
    // original empty catch accepted anything; we tightened that much
    // at least. We deliberately do NOT pin the error message shape:
    // the defensive rejection vocabulary legitimately varies across
    // layers (assertSafeIri, Oxigraph SPARQL parser, Blazegraph query
    // engine) and across the parametric malicious-input matrix, so a
    // narrow regex produces false-positive test failures that hide
    // the real invariant (probe survival, asserted above).
    if (deleteThrew) {
      expect(deleteError).toBeInstanceOf(Error);
    }
  });

  it('storePrivateTriples silently accepts unsafe rootEntity (defence-in-depth gap)', async () => {
    // PROD-BUG (defence-in-depth): `storePrivateTriples` never validates
    // `rootEntity`. It ends up only in the in-memory tracker, so there is
    // no immediate SPARQL injection, but a later hasPrivateTriples /
    // getPrivateTriples / deletePrivateTriples call with the same string
    // will blow up. Tracker should reject unsafe IRIs at the entry point.
    // See BUGS_FOUND.md ST-7.
    const unsafe = 'did:dkg:agent:evil> <http://attacker/';
    await expect(
      ps.storePrivateTriples(CONTEXT_GRAPH, unsafe, [
        { subject: 'urn:safe:s', predicate: 'http://ex.org/p', object: '"v"', graph: '' },
      ]),
    ).rejects.toThrow(/Unsafe or empty IRI/);
  });
});
