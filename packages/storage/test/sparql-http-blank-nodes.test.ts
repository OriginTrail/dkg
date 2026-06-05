/**
 * Blank-node deletion regression suite for the `sparql-http` adapter.
 *
 * BACKGROUND (rc.16 ship-blocker): `SparqlHttpStore.delete(quads)` used to
 * serialize every quad into a single `DELETE DATA { … }` block. SPARQL forbids
 * blank nodes in `DELETE DATA`, so the moment any quad carried a blank node
 * (`_:b`) a spec-compliant endpoint — Oxigraph, Fuseki, … — rejected the whole
 * statement with HTTP 400 ("Variables and blank nodes are not allowed in
 * DELETE DATA"). This broke "Promote All → Shared" (WM→SWM) for any entity
 * containing nested/anonymous RDF, which is the common case.
 *
 * WHY IT WASN'T CAUGHT: every promote/share unit test used the embedded
 * `OxigraphStore` (native object delete — blank-node-safe), and the lone
 * `sparql-http.test.ts` used a mock HTTP server that *records* the update
 * string but never parses or executes it. Invalid SPARQL therefore passed.
 *
 * THIS SUITE closes both gaps:
 *   1. Unit-asserts the SPARQL that `buildBlankNodeSafeDelete` emits.
 *   2. Executes that SPARQL through a REAL embedded Oxigraph engine — the same
 *      engine `oxigraph-server` runs — across a broad matrix of blank-node
 *      shapes, proving it parses, executes, and deletes exactly the right
 *      triples. A control test proves the legacy `DELETE DATA`-with-bnode form
 *      still throws on that engine, so a regression can't slip back in.
 *   3. Drives the full `SparqlHttpStore.delete()` path over HTTP against an
 *      in-process endpoint backed by that same engine.
 */
import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import oxigraph from 'oxigraph';
import { SparqlHttpStore, type Quad } from '../src/index.js';
import { buildBlankNodeSafeDelete, isBlankNodeTerm } from '../src/adapters/sparql-http.js';

const G = 'http://example.org/graph/wm';
const G2 = 'http://example.org/graph/wm2';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

// ── helpers ────────────────────────────────────────────────────────────────

function escapeLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** oxigraph Term → the N-Quads string form used by DKGQuad. */
function termToStr(t: oxigraph.Term): string {
  switch (t.termType) {
    case 'NamedNode':
      return t.value;
    case 'BlankNode':
      return `_:${t.value}`;
    case 'Literal': {
      const lit = t as oxigraph.Literal;
      if (lit.language) return `"${escapeLiteral(lit.value)}"@${lit.language}`;
      const dt = lit.datatype?.value;
      if (dt && dt !== 'http://www.w3.org/2001/XMLSchema#string') {
        return `"${escapeLiteral(lit.value)}"^^<${dt}>`;
      }
      return `"${escapeLiteral(lit.value)}"`;
    }
    default:
      return t.value;
  }
}

/** Read every quad of `graph` from an embedded store as DKGQuads (real bnode labels). */
function readGraph(store: InstanceType<typeof oxigraph.Store>, graph: string): Quad[] {
  const out: Quad[] = [];
  for (const q of store.match(null, null, null, oxigraph.namedNode(graph))) {
    out.push({
      subject: termToStr(q.subject),
      predicate: q.predicate.value,
      object: termToStr(q.object),
      graph,
    });
  }
  return out;
}

function countGraph(store: InstanceType<typeof oxigraph.Store>, graph: string): number {
  return [...store.match(null, null, null, oxigraph.namedNode(graph))].length;
}

function loaded(nquads: string): InstanceType<typeof oxigraph.Store> {
  const store = new oxigraph.Store();
  store.load(nquads, { format: 'application/n-quads' });
  return store;
}

// ── blank-node fixtures (a broad matrix of "rich" shapes) ────────────────────

const FIXTURES: Array<{ name: string; nquads: string; minQuads: number }> = [
  {
    name: 'blank node as object',
    nquads: `<http://ex/s> <http://ex/p> _:b0 <${G}> .`,
    minQuads: 1,
  },
  {
    name: 'blank node as subject',
    nquads: `_:b0 <http://ex/p> <http://ex/o> <${G}> .`,
    minQuads: 1,
  },
  {
    name: 'nested entity → address bnode → values (incl. typed literal)',
    nquads: [
      `<http://ex/alice> <http://ex/address> _:addr <${G}> .`,
      `_:addr <http://ex/street> "Main St" <${G}> .`,
      `_:addr <http://ex/city> "Springfield"@en <${G}> .`,
      `_:addr <http://ex/geo> _:geo <${G}> .`,
      `_:geo <http://ex/lat> "1.5"^^<${XSD_DECIMAL}> <${G}> .`,
      `_:geo <http://ex/long> "2.5"^^<${XSD_DECIMAL}> <${G}> .`,
    ].join('\n'),
    minQuads: 6,
  },
  {
    name: 'RDF collection (rdf:first/rdf:rest list with bnode cells)',
    nquads: [
      `<http://ex/s> <http://ex/items> _:l0 <${G}> .`,
      `_:l0 <${RDF}first> <http://ex/a> <${G}> .`,
      `_:l0 <${RDF}rest> _:l1 <${G}> .`,
      `_:l1 <${RDF}first> <http://ex/b> <${G}> .`,
      `_:l1 <${RDF}rest> <${RDF}nil> <${G}> .`,
    ].join('\n'),
    minQuads: 5,
  },
  {
    name: 'bnode shared by two distinct subjects (one component)',
    nquads: [
      `<http://ex/a> <http://ex/knows> _:shared <${G}> .`,
      `<http://ex/c> <http://ex/knows> _:shared <${G}> .`,
      `_:shared <http://ex/name> "Bob" <${G}> .`,
    ].join('\n'),
    minQuads: 3,
  },
  {
    name: 'two disjoint blank-node structures in one graph',
    nquads: [
      `<http://ex/x> <http://ex/p> _:b0 <${G}> .`,
      `_:b0 <http://ex/v> "first" <${G}> .`,
      `<http://ex/y> <http://ex/p> _:b1 <${G}> .`,
      `_:b1 <http://ex/v> "second" <${G}> .`,
    ].join('\n'),
    minQuads: 4,
  },
  {
    name: 'deep bnode chain (b0→b1→b2→b3)',
    nquads: [
      `<http://ex/root> <http://ex/n> _:b0 <${G}> .`,
      `_:b0 <http://ex/n> _:b1 <${G}> .`,
      `_:b1 <http://ex/n> _:b2 <${G}> .`,
      `_:b2 <http://ex/n> _:b3 <${G}> .`,
      `_:b3 <http://ex/leaf> "end" <${G}> .`,
    ].join('\n'),
    minQuads: 5,
  },
  {
    name: 'mixed ground + blank-node quads',
    nquads: [
      `<http://ex/s1> <http://ex/p> <http://ex/o1> <${G}> .`,
      `<http://ex/s2> <http://ex/label> "ground literal" <${G}> .`,
      `<http://ex/s3> <http://ex/nested> _:b0 <${G}> .`,
      `_:b0 <http://ex/v> "blank" <${G}> .`,
    ].join('\n'),
    minQuads: 4,
  },
];

// ── 1. builder: structural assertions on the generated SPARQL ────────────────

describe('buildBlankNodeSafeDelete — generated SPARQL shape', () => {
  it('ground-only quads → a single DELETE DATA, no variables, no blank nodes', () => {
    const update = buildBlankNodeSafeDelete([
      { subject: 'http://ex/s', predicate: 'http://ex/p', object: 'http://ex/o', graph: G },
    ])!;
    expect(update).toContain('DELETE DATA');
    expect(update).not.toContain('WHERE');
    expect(update).not.toContain('_:');
    expect(update).not.toMatch(/\?b\d/);
  });

  it('blank-node quad → DELETE … WHERE with the bnode rewritten to a variable; never DELETE DATA, never a raw _:', () => {
    const update = buildBlankNodeSafeDelete([
      { subject: 'http://ex/s', predicate: 'http://ex/p', object: '_:b0', graph: G },
    ])!;
    expect(update).toContain('DELETE {');
    expect(update).toContain('WHERE {');
    expect(update).toMatch(/\?b0/);
    // A blank node must NEVER appear in the generated update text.
    expect(update).not.toContain('_:');
  });

  it('disjoint components emit SEPARATE DELETE/WHERE statements (no cross-product)', () => {
    const update = buildBlankNodeSafeDelete([
      { subject: 'http://ex/x', predicate: 'http://ex/p', object: '_:b0', graph: G },
      { subject: '_:b0', predicate: 'http://ex/v', object: '"first"', graph: G },
      { subject: 'http://ex/y', predicate: 'http://ex/p', object: '_:b1', graph: G },
      { subject: '_:b1', predicate: 'http://ex/v', object: '"second"', graph: G },
    ])!;
    const stmts = update.split(';').filter((s) => s.includes('DELETE'));
    expect(stmts.length).toBe(2);
    expect(update).not.toContain('_:');
  });

  it('mixed input → both a DELETE DATA block and a DELETE/WHERE block', () => {
    const update = buildBlankNodeSafeDelete([
      { subject: 'http://ex/s1', predicate: 'http://ex/p', object: 'http://ex/o1', graph: G },
      { subject: 'http://ex/s3', predicate: 'http://ex/nested', object: '_:b0', graph: G },
      { subject: '_:b0', predicate: 'http://ex/v', object: '"blank"', graph: G },
    ])!;
    expect(update).toContain('DELETE DATA');
    expect(update).toContain('DELETE {');
    expect(update).not.toContain('_:');
  });

  it('empty input → null', () => {
    expect(buildBlankNodeSafeDelete([])).toBeNull();
  });

  it('isBlankNodeTerm distinguishes blank nodes from IRIs and literals', () => {
    expect(isBlankNodeTerm('_:b0')).toBe(true);
    expect(isBlankNodeTerm('http://ex/s')).toBe(false);
    expect(isBlankNodeTerm('"a literal"')).toBe(false);
  });
});

// ── 2. control: the legacy form must still be rejected by the real engine ────

describe('control — legacy DELETE DATA with a blank node is rejected by the SPARQL engine', () => {
  it('store.update(DELETE DATA { … _:b … }) throws (the exact rc.16 bug)', () => {
    const store = loaded(`<http://ex/s> <http://ex/p> _:b0 <${G}> .`);
    const legacy = `DELETE DATA {\nGRAPH <${G}> { <http://ex/s> <http://ex/p> _:b0 . }\n}`;
    expect(() => store.update(legacy)).toThrow();
  });
});

// ── 3. engine execution: generated SPARQL parses, runs, and deletes exactly ──

describe('buildBlankNodeSafeDelete — executes correctly on a real Oxigraph engine', () => {
  for (const fx of FIXTURES) {
    it(`deletes the full graph for: ${fx.name}`, () => {
      const store = loaded(fx.nquads);
      expect(countGraph(store, G)).toBeGreaterThanOrEqual(fx.minQuads);

      const quads = readGraph(store, G);
      const update = buildBlankNodeSafeDelete(quads)!;

      // Must not throw — this is what the legacy DELETE DATA did.
      expect(() => store.update(update)).not.toThrow();
      // And every quad must be gone.
      expect(countGraph(store, G)).toBe(0);
    });
  }

  it('partial delete: removes one entity component and leaves the rest intact', () => {
    const store = loaded([
      `<http://ex/alice> <http://ex/address> _:a <${G}> .`,
      `_:a <http://ex/city> "Springfield" <${G}> .`,
      `<http://ex/bob> <http://ex/address> _:b <${G}> .`,
      `_:b <http://ex/city> "Portland" <${G}> .`,
    ].join('\n'));
    expect(countGraph(store, G)).toBe(4);

    // Delete only Alice's component (entity IRI + its bnode subtree).
    const aliceQuads = readGraph(store, G).filter(
      (q) => q.subject === 'http://ex/alice' ||
        // the bnode whose city is Springfield
        [...store.match(null, oxigraph.namedNode('http://ex/city'), oxigraph.literal('Springfield'), oxigraph.namedNode(G))]
          .some((m) => `_:${(m.subject as oxigraph.BlankNode).value}` === q.subject),
    );
    const update = buildBlankNodeSafeDelete(aliceQuads)!;
    expect(() => store.update(update)).not.toThrow();

    // Bob survives intact.
    expect(countGraph(store, G)).toBe(2);
    const remaining = readGraph(store, G);
    expect(remaining.some((q) => q.subject === 'http://ex/bob')).toBe(true);
    expect(remaining.some((q) => q.object === '"Portland"')).toBe(true);
    expect(remaining.some((q) => q.object === '"Springfield"')).toBe(false);
  });

  it('cross-graph delete: blank-node structures in two graphs in one call', () => {
    const store = loaded([
      `<http://ex/s> <http://ex/p> _:b0 <${G}> .`,
      `_:b0 <http://ex/v> "g1" <${G}> .`,
      `<http://ex/s> <http://ex/p> _:b1 <${G2}> .`,
      `_:b1 <http://ex/v> "g2" <${G2}> .`,
    ].join('\n'));
    const quads = [...readGraph(store, G), ...readGraph(store, G2)];
    const update = buildBlankNodeSafeDelete(quads)!;
    expect(() => store.update(update)).not.toThrow();
    expect(countGraph(store, G)).toBe(0);
    expect(countGraph(store, G2)).toBe(0);
  });

  it('reproduces the promote bug end-to-end: CONSTRUCT a WM graph then delete the result', () => {
    // Mirrors assertionPromote(): CONSTRUCT all quads from the source graph,
    // then delete them. Pre-fix this CONSTRUCT→delete round-trip 400'd.
    const store = loaded(FIXTURES[2].nquads); // nested entity w/ bnodes
    const construct = store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${G}> { ?s ?p ?o } }`,
    ) as oxigraph.Quad[];
    const quads: Quad[] = construct.map((q) => ({
      subject: termToStr(q.subject),
      predicate: q.predicate.value,
      object: termToStr(q.object),
      graph: G,
    }));
    const update = buildBlankNodeSafeDelete(quads)!;
    expect(() => store.update(update)).not.toThrow();
    expect(countGraph(store, G)).toBe(0);
  });
});

// ── 4. full adapter path: SparqlHttpStore.delete() over HTTP, real engine ────

describe('SparqlHttpStore.delete() — full HTTP path against a real Oxigraph engine', () => {
  let server: Server;
  let store: InstanceType<typeof oxigraph.Store>;
  let updateUrl: string;
  let adapter: SparqlHttpStore;

  beforeAll(async () => {
    store = new oxigraph.Store();
    // Minimal SPARQL endpoint: /update runs the real engine and returns 400 on
    // any parse/exec error — exactly how oxigraph-server behaves.
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url?.endsWith('/update')) {
          try {
            store.update(body);
            res.writeHead(204);
            res.end();
          } catch (e) {
            // Mirror oxigraph-server's "400 on bad update" behaviour. The
            // adapter only inspects the status code, never the body, so return a
            // constant text/plain message instead of reflecting the caught
            // exception text into the HTTP response (CodeQL: exception text
            // reinterpreted as HTML + stack-trace info exposure). Surface the
            // real reason to the test runner via stderr for debuggability.
            console.error('[mock-sparql] update rejected:', (e as Error)?.message ?? e);
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('SPARQL update rejected');
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    updateUrl = `http://127.0.0.1:${port}/update`;
    adapter = new SparqlHttpStore({
      queryEndpoint: `http://127.0.0.1:${port}/query`,
      updateEndpoint: updateUrl,
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    // The long-lived endpoint serves whatever `store` currently points at, so
    // give each case a FRESH embedded graph. Without this, data left behind (or
    // an early failure before cleanup) in one case would leak into the next and
    // produce a misleading failure.
    store = new oxigraph.Store();
  });

  it('deletes blank-node entities through the adapter without a 400', async () => {
    store.load(FIXTURES[2].nquads, { format: 'application/n-quads' });
    expect(countGraph(store, G)).toBeGreaterThan(0);

    const quads = readGraph(store, G);
    // Pre-fix this rejected with "SPARQL HTTP delete failed (400)".
    await expect(adapter.delete(quads)).resolves.toBeUndefined();
    expect(countGraph(store, G)).toBe(0);
  });

  it('still deletes ground-only quads exactly (no regression to the fast path)', async () => {
    store.load(
      [
        `<http://ex/g1> <http://ex/p> <http://ex/o> <${G}> .`,
        `<http://ex/g2> <http://ex/p> "lit" <${G}> .`,
      ].join('\n'),
      { format: 'application/n-quads' },
    );
    const before = countGraph(store, G);
    expect(before).toBe(2);
    await expect(
      adapter.delete([
        { subject: 'http://ex/g1', predicate: 'http://ex/p', object: 'http://ex/o', graph: G },
      ]),
    ).resolves.toBeUndefined();
    expect(countGraph(store, G)).toBe(1); // only the targeted ground quad removed
  });
});
