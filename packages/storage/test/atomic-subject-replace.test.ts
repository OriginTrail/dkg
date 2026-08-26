import { describe, expect, it, vi } from 'vitest';
import {
  OxigraphStore,
  buildAtomicSubjectReplaceUpdate,
  type Quad,
} from '../src/index.js';

const GRAPH = 'urn:test:control-plane';
const SUBJECT_A = 'urn:test:job:a';
const SUBJECT_B = 'urn:test:request:b';

function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: GRAPH };
}

describe('buildAtomicSubjectReplaceUpdate', () => {
  it('emits a single DELETE WHERE + INSERT DATA request scoped to the subject and graph', () => {
    const sparql = buildAtomicSubjectReplaceUpdate(GRAPH, SUBJECT_A, [
      quad(SUBJECT_A, 'urn:test:status', '"validated"'),
    ]);
    expect(sparql).toContain(`DELETE WHERE { GRAPH <${GRAPH}> { <${SUBJECT_A}> ?p ?o } }`);
    expect(sparql).toContain('INSERT DATA {');
    expect(sparql).toContain(`GRAPH <${GRAPH}>`);
    // One request: the DELETE and INSERT are joined by a single `;` separator.
    expect(sparql.match(/;/g)).toHaveLength(1);
  });

  it('atomically replaces the subject rows, leaving a co-located subject untouched', async () => {
    const store = new OxigraphStore();
    await store.insert([
      quad(SUBJECT_A, 'urn:test:status', '"accepted"'),
      quad(SUBJECT_A, 'urn:test:retry', '"0"'),
      quad(SUBJECT_B, 'urn:test:kind', '"request"'),
    ]);

    await store.update(
      buildAtomicSubjectReplaceUpdate(GRAPH, SUBJECT_A, [
        quad(SUBJECT_A, 'urn:test:status', '"validated"'),
      ]),
    );

    // SUBJECT_A fully replaced: the stale `retry` row is gone, the status is new.
    const a = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${GRAPH}> { <${SUBJECT_A}> ?p ?o } } ORDER BY ?p`,
    );
    expect(a.type === 'bindings' ? a.bindings : []).toEqual([
      { p: 'urn:test:status', o: '"validated"' },
    ]);
    // SUBJECT_B untouched — it was never in the DELETE scope.
    expect(await store.countQuads(GRAPH)).toBe(2);
  });

  it('rejects a co-located subject in the insert set — it is a STRICT single-subject primitive', () => {
    // The delete scope and the insert scope must be the same single subject, so
    // the helper name never diverges from behaviour. A caller needing to write
    // another subject must do it as a separate write.
    expect(() =>
      buildAtomicSubjectReplaceUpdate(GRAPH, SUBJECT_A, [
        quad(SUBJECT_A, 'urn:test:status', '"claimed"'),
        quad(SUBJECT_B, 'urn:test:kind', '"request"'),
      ]),
    ).toThrow(/must target subject/);
  });

  it('round-trips a JSON-payload literal bearing quotes, backslashes and newlines', async () => {
    const store = new OxigraphStore();
    const payload = JSON.stringify({ name: 'a"b\\c', note: 'line1\nline2', ctx: 'µ/∆' });
    // `literal()` in the control plane is JSON.stringify — a valid SPARQL string literal.
    const literalTerm = JSON.stringify(payload);

    await store.update(
      buildAtomicSubjectReplaceUpdate(GRAPH, SUBJECT_A, [
        quad(SUBJECT_A, 'urn:test:payload', literalTerm),
      ]),
    );

    const row = await store.query(
      `SELECT ?o WHERE { GRAPH <${GRAPH}> { <${SUBJECT_A}> <urn:test:payload> ?o } }`,
    );
    const stored = row.type === 'bindings' ? row.bindings[0]?.['o'] : undefined;
    expect(stored).toBe(literalTerm);
    // The exact JSON payload survives the SPARQL round-trip byte-for-byte.
    expect(JSON.parse(JSON.parse(stored as string) as string)).toEqual({
      name: 'a"b\\c',
      note: 'line1\nline2',
      ctx: 'µ/∆',
    });
  });

  it('rejects an injection-bearing subject or graph before building any SPARQL', () => {
    expect(() =>
      buildAtomicSubjectReplaceUpdate(GRAPH, 'urn:test:job> } DROP ALL #', [
        quad('urn:test:job', 'urn:test:status', '"x"'),
      ]),
    ).toThrow(/Unsafe/);
    expect(() =>
      buildAtomicSubjectReplaceUpdate('urn:test:graph }', SUBJECT_A, []),
    ).toThrow(/Unsafe/);
  });

  it('rejects a quad that targets a different graph', () => {
    expect(() =>
      buildAtomicSubjectReplaceUpdate(GRAPH, SUBJECT_A, [
        { subject: SUBJECT_A, predicate: 'urn:test:status', object: '"x"', graph: 'urn:test:other' },
      ]),
    ).toThrow(/must target subject .* in graph/);
  });

  it('rejects a blank-node subject — a replace needs a canonical skolem IRI, not an IRI-wrapped `_:`', () => {
    // `_:b1` passes assertSafeIri but would be interpolated as `<_:b1>` and treated
    // as an IRI, operating on the wrong RDF term while the real blank-node rows stay.
    expect(() =>
      buildAtomicSubjectReplaceUpdate(GRAPH, '_:b1', [
        { subject: '_:b1', predicate: 'urn:test:p', object: '"v"', graph: GRAPH },
      ]),
    ).toThrow(/blank node/);
    // Guarded on the empty-quads DELETE path too.
    expect(() => buildAtomicSubjectReplaceUpdate(GRAPH, '_:b1', [])).toThrow(/blank node/);
  });

  it('OxigraphStore.replaceSubject applies the mutation as ONE transactional embedded update (not delete-then-insert)', async () => {
    // The reader-atomicity guarantee is a STORE property: the embedded oxigraph
    // runs the whole DELETE WHERE + INSERT DATA as ONE update() (a single
    // transaction), so a reader can never observe the subject transiently empty.
    // White-box guard against a future regression to an internal delete-then-insert
    // (the window a publisher-level proxy test cannot observe).
    const store = new OxigraphStore();
    const embedded = (store as unknown as { store: { update: (sparql: string) => void } }).store;
    const spy = vi.spyOn(embedded, 'update');

    await store.replaceSubject(GRAPH, SUBJECT_A, [
      quad(SUBJECT_A, 'urn:test:status', '"validated"'),
    ]);

    // Exactly one mutating update, carrying BOTH the DELETE and the INSERT in a
    // single request (not two separate calls).
    const mutations = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((sparql) => sparql.includes('DELETE WHERE') || sparql.includes('INSERT DATA'));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toContain('DELETE WHERE');
    expect(mutations[0]).toContain('INSERT DATA');
  });

  it('OxigraphStore.replaceSubjects commits a multi-subject catalog replacement together', async () => {
    const store = new OxigraphStore();
    const subjectB = 'urn:dkg:profile:test:query:b';
    await store.insert([
      quad(SUBJECT_A, 'urn:dkg:profile:sparql', '"old-a"'),
      quad(subjectB, 'urn:dkg:profile:sparql', '"old-b"'),
    ]);

    await store.replaceSubjects!(GRAPH, [
      {
        subject: SUBJECT_A,
        quads: [quad(SUBJECT_A, 'urn:dkg:profile:sparql', '"new-a"')],
      },
      {
        subject: subjectB,
        quads: [quad(subjectB, 'urn:dkg:profile:sparql', '"new-b"')],
      },
    ]);

    const rows = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${GRAPH}> { ?s <urn:dkg:profile:sparql> ?o } } ORDER BY ?s`,
    );
    expect(rows.type === 'bindings' ? rows.bindings : []).toEqual([
      { s: subjectB, o: '"new-b"' },
      { s: SUBJECT_A, o: '"new-a"' },
    ]);
  });

  it('rejects an invalid multi-subject payload before changing any subject', async () => {
    const store = new OxigraphStore();
    const subjectB = 'urn:dkg:profile:test:query:b';
    await store.insert([
      quad(SUBJECT_A, 'urn:dkg:profile:sparql', '"old-a"'),
      quad(subjectB, 'urn:dkg:profile:sparql', '"old-b"'),
    ]);

    await expect(store.replaceSubjects!(GRAPH, [
      {
        subject: SUBJECT_A,
        quads: [quad(SUBJECT_A, 'urn:dkg:profile:sparql', '"new-a"')],
      },
      {
        subject: subjectB,
        quads: [quad(subjectB, 'urn:dkg:profile:sparql', '_:unsafe')],
      },
    ])).rejects.toThrow('blank node');

    const rows = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${GRAPH}> { ?s <urn:dkg:profile:sparql> ?o } } ORDER BY ?s`,
    );
    expect(rows.type === 'bindings' ? rows.bindings : []).toEqual([
      { s: subjectB, o: '"old-b"' },
      { s: SUBJECT_A, o: '"old-a"' },
    ]);
  });

  it('returns a bare DELETE when the insert set is empty', () => {
    const sparql = buildAtomicSubjectReplaceUpdate(GRAPH, SUBJECT_A, []);
    expect(sparql).toBe(`DELETE WHERE { GRAPH <${GRAPH}> { <${SUBJECT_A}> ?p ?o } }`);
    expect(sparql).not.toContain('INSERT DATA');
  });
});
