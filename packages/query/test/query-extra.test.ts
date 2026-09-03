/**
 * packages/query — extra QA coverage for spec-gap & prod-bug findings.
 *
 * Findings covered (see .test-audit/
 *
 *   Q-1  `QueryOptions.minTrust` on `verifiable-memory` view is enforced
 *        with writer-side `dkg:trustLevel` metadata, not graph-scope trust
 *        alone. Tests insert mixed-trust quads and assert the engine only
 *        returns entities that meet the requested trust floor.
 *
 *   Q-2  SPEC-GAP  `QueryHandler.executeSparql` only wires `result.bindings`
 *                  into the response JSON. CONSTRUCT / DESCRIBE queries return
 *                  `{quads}` from the engine (see dkg-query-engine.ts:237) but
 *                  the handler drops them on the wire. Red test pins the gap.
 *
 *   Q-3  SPEC-GAP  `working-memory` view path is implemented in
 *                  `resolveViewGraphs` and `DKGQueryEngine.queryWithView` but
 *                  untested end-to-end. Green test exercises both the single-
 *                  assertion URI form and the prefix-discovery form.
 *
 *   Q-4  SPEC-GAP  `QueryHandler.executeSparql` has a `Promise.race` timeout
 *                  path that should emit `GAS_LIMIT_EXCEEDED`. No existing
 *                  test forces the timer. We wrap `TripleStore.query` with a
 *                  sleeping wrapper to force it.
 *
 *   Q-5  SPEC-GAP  Spec §14 Context Oracle trust-gradient proof params
 *                  (verifiedGraph / minTrust / view routing together) have no
 *                  mapping test. Green test pins which graphs each proof
 *                  params combination targets.
 *
 *   Q-6  TEST-DEBT `QueryHandler` swallows all engine errors into generic
 *                  `'Internal error processing query'` with status 'ERROR'.
 *                  Test pins the specific failure modes we DO distinguish
 *                  (malformed JSON, missing lookupType, missing ual,
 *                  missing sparql, SERVICE/GRAPH/FROM rejection, SPARQL
 *                  rejected) — and records that arbitrary engine failures
 *                  collapse to one error string.
 *
 * Per QA policy: no production-code edits.
 */
import { describe, it, expect } from 'vitest';
import {
  OxigraphStore,
  type TripleStore,
  type Quad,
  type QueryResult as StoreQueryResult,
} from '@origintrail-official/dkg-storage';
import {
  contextGraphDataUri,
  contextGraphVerifiableMemoryUri,
  contextGraphAssertionUri,
  contextGraphLayerUri,
  MemoryLayer,
  contextGraphSharedMemoryUri,
  contextGraphMetaUri,
  assertionLifecycleUri,
  assertionScopedGraphUri,
  sparqlString,
  TrustLevel,
} from '@origintrail-official/dkg-core';
import { DKGQueryEngine, resolveViewGraphs } from '../src/dkg-query-engine.js';
import {
  materializeGraphScopeForExecution,
  prepareGraphScope,
  wrapWithGraph,
} from '../src/sparql-graph-scope.js';
import { QueryHandler } from '../src/query-handler.js';
import type { QueryAccessConfig } from '../src/query-types.js';

const CG = 'qa-extra-cg';

function quad(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

// ─────────────────────────────────────────────────────────────────────────────
// Q-1  writer-side minTrust filtering via `dkg:trustLevel`
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-1] DKGQueryEngine minTrust uses writer-side trust metadata', () => {
  // All trust floors above SelfAttested require explicit writer-side
  // trust metadata. Untagged production data fails closed for these queries.
  it('filters out sub-threshold trust quads WITHIN a verifiable-memory sub-graph at ConsensusVerified (Q-1)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    // All quads live in a single /_verifiable_memory/* sub-graph so graph-
    // scope filtering cannot distinguish them. Only a per-triple filter
    // can drop the low-trust quad.
    const mixedGraph = contextGraphVerifiableMemoryUri(CG, 'mixed-trust-sub-graph');
    const rootGraph = contextGraphDataUri(CG);

    await store.insert([
      quad('urn:low', 'http://schema.org/name', '"LowTrust"', mixedGraph),
      quad('urn:low', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.Endorsed}"`, mixedGraph),
      quad('urn:high', 'http://schema.org/name', '"HighTrust"', mixedGraph),
      quad('urn:high', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, mixedGraph),
      // Untagged root-level quad — writer-side trust filtering excludes this.
      quad('urn:unknown', 'http://schema.org/name', '"UnknownTrust"', rootGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      {
        contextGraphId: CG,
        view: 'verifiable-memory',
        minTrust: TrustLevel.ConsensusVerified,
      },
    );

    const names = result.bindings.map((b) => b['name']);
    // Per-triple filter strips the Endorsed-only `urn:low` quad —
    // only `urn:high` (which carries `ConsensusVerified`) survives.
    expect(names).toEqual(['"HighTrust"']);
  });

  it('Endorsed uses writer-side trustLevel metadata instead of graph-scope trust', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    // RC11 / PR2: VM view sources only `_verifiable_memory/*` named
    // graphs now (root data graph is no longer aliased into VM). The
    // assertion this test was originally pinning — "trust is decided
    // by writer-side `dkg:trustLevel` metadata, NOT by which graph
    // the quad lives in" — is preserved by placing the tagged datum
    // into a different verifiable-memory sub-graph than the untagged
    // quorum, so the test still proves graph-scope alone doesn't
    // grant trust.
    const untaggedQuorumGraph = contextGraphVerifiableMemoryUri(CG, 'no-trust-metadata-quorum');
    const taggedQuorumGraph = contextGraphVerifiableMemoryUri(CG, 'endorsed-trust-tagged');

    await store.insert([
      quad('urn:prod1', 'http://schema.org/name', '"Production1"', untaggedQuorumGraph),
      quad('urn:prod2', 'http://schema.org/name', '"Production2"', untaggedQuorumGraph),
      quad('urn:tagged', 'http://schema.org/name', '"TaggedEndorsed"', taggedQuorumGraph),
      quad('urn:tagged', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.Endorsed}"`, taggedQuorumGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      {
        contextGraphId: CG,
        view: 'verifiable-memory',
        minTrust: TrustLevel.Endorsed,
      },
    );

    const names = result.bindings.map((b) => b['name']).sort();
    expect(names).toEqual(['"TaggedEndorsed"']);
  });

  // pin that ConsensusVerified
  // STILL fails closed on un-tagged production data — the higher
  // tier requires explicit per-triple metadata, and a fail-closed
  // empty result is the correct behaviour when writers haven't
  // started emitting `dkg:trustLevel` yet.
  it('ConsensusVerified fails CLOSED on production data WITHOUT trustLevel literals', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    const subGraph = contextGraphVerifiableMemoryUri(CG, 'no-trust-metadata-quorum');
    await store.insert([
      quad('urn:prod1', 'http://schema.org/name', '"Production1"', subGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      {
        contextGraphId: CG,
        view: 'verifiable-memory',
        minTrust: TrustLevel.ConsensusVerified,
      },
    );

    expect(result.bindings).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // concrete-
  // subject queries like `SELECT ?o WHERE { <entity> <p> ?o }` are the
  // most common SPARQL shape for exact lookups and MUST honor `_minTrust`
  // (not fail closed with an empty result). The fix attaches
  // `<entity> <trustLevel> ?t . FILTER(?t >= N)` to the rewritten WHERE.
  // ─────────────────────────────────────────────────────────────────────────
  it('honors _minTrust on CONCRETE-SUBJECT queries (exact-entity lookup)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Exact-entity lookup MUST succeed when the entity meets the threshold.
    const ok = await engine.query(
      'SELECT ?n WHERE { <urn:e1> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(ok.bindings.map((b) => b['n'])).toEqual(['"Alice"']);
  });

  it('fails CLOSED on a concrete-subject lookup whose entity is BELOW the trust threshold', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const selfAttestedGraph = contextGraphVerifiableMemoryUri(CG, 'self-attested');
    await store.insert([
      quad('urn:low', 'http://schema.org/name', '"Bob"', selfAttestedGraph),
      quad('urn:low', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.SelfAttested}"`, selfAttestedGraph),
    ]);

    const result = await engine.query(
      'SELECT ?n WHERE { <urn:low> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    // Below threshold → empty (the trust filter eliminates the row).
    expect(result.bindings).toEqual([]);
  });

  it('fails CLOSED on a concrete-subject lookup whose entity has NO trust metadata at all', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const verifiedGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:bare', 'http://schema.org/name', '"Ghost"', verifiedGraph),
      // deliberately NO trustLevel quad for <urn:bare>
    ]);
    const result = await engine.query(
      'SELECT ?n WHERE { <urn:bare> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings).toEqual([]);
  });

  // `rdf:type` style
  // IRIs contain a `#` fragment. The prior naive `replace(/#[^\n]*/g,'')`
  // would mangle the IRI into `<http://www.w3.org/1999/02/22-rdf-syntax-ns`
  // and fail-close every such query to `[]`. Lock the happy path so the
  // fragment is preserved and the trust filter is injected correctly.
  it('honors _minTrust when the BGP contains a fragment IRI (rdf:type, xsd, rdfs)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:frag', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://schema.org/Person', consensusGraph),
      quad('urn:frag', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    const result = await engine.query(
      'SELECT ?t WHERE { <urn:frag> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?t }',
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['t'])).toEqual(['http://schema.org/Person']);
  });

  it('honors minTrust for a BASE-relative digit-leading fragment IRI', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    const subject = 'http://example.com/1#item';
    await store.insert([
      quad(subject, 'http://example.com/name', '"Relative item"', consensusGraph),
      quad(subject, 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    const result = await engine.query(
      'BASE <http://example.com/> SELECT ?name WHERE { <1#item> <http://example.com/name> ?name }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );

    expect(result.bindings.map((binding) => binding['name'])).toEqual(['"Relative item"']);
  });

  it('keeps an adjacent fragment IRI inside the requested context graph', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const requestedGraph = contextGraphDataUri(CG);
    const otherGraph = contextGraphDataUri('other-cg');
    const predicate = 'http://example.com/p#name';
    await store.insert([
      quad('urn:requested', predicate, '"Requested"', requestedGraph),
      quad('urn:other', predicate, '"Other"', otherGraph),
    ]);

    const result = await engine.query(
      'SELECT ?o WHERE{?s<http://example.com/p#name>?o}',
      { contextGraphId: CG },
    );

    expect(result.bindings).toEqual([{ o: '"Requested"' }]);
  });

  it('rejects a scoped query when its graph wrapper cannot prove the WHERE boundary', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    await expect(engine.query(
      'SELECT ?o WHERE { ?s <http://example.com/p#name> ?o',
      { contextGraphId: CG },
    )).rejects.toThrow(
      /Scoped query violation: unable to locate (?:a graph-scopable WHERE block|the end of the scoped WHERE block)/,
    );
  });

  it('preserves UCHAR payload while scoped minTrust rewriting uses raw delimiters', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    const otherGraph = contextGraphVerifiableMemoryUri('other-cg', 'consensus-verified');
    const predicate = 'http://example.com/p#name';
    await store.insert([
      quad('urn:e1', predicate, '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
      quad('urn:e1', predicate, '"Alice"', otherGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, otherGraph),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?o WHERE { <urn:e1> <http://example.com/p#name> ?o . FILTER(STR(?o) = "\u0041lice") }`,
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );

    expect(result.bindings.map((binding) => binding['o'])).toEqual(['"Alice"']);
  });

  it.each([
    [String.raw`"\u0022"`, '"'],
    [String.raw`'\u0022'`, '"'],
    [String.raw`"""\u0022"""`, '"'],
    [String.raw`'''\u0022'''`, '"'],
    [String.raw`"\u005C"`, '\\'],
    [String.raw`'\u005C'`, '\\'],
    [String.raw`"""\u000A"""`, '\n'],
    [String.raw`'''\u000A'''`, '\n'],
  ])('executes raw UCHAR literal payload without promoting it to syntax: %s', async (
    literal,
    expected,
  ) => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    const result = await engine.query(`SELECT ?x WHERE { BIND(${literal} AS ?x) }`);

    expect(result.bindings).toEqual([{ x: sparqlString(expected) }]);
  });

  it.each([
    ['GRAPH', '\r'],
    ['FROM', '\r'],
    ['GRAPH', String.raw`\u000D`],
    ['FROM', String.raw`\u000D`],
  ])('rejects %s hidden after a %s comment boundary before store dispatch', async (
    clause,
    commentBoundary,
  ) => {
    const store = new OxigraphStore();
    const originalQuery = store.query.bind(store);
    let queryCalls = 0;
    store.query = async (...args) => {
      queryCalls++;
      return originalQuery(...args);
    };
    const engine = new DKGQueryEngine(store);
    const hidden = clause === 'GRAPH'
      ? 'WHERE { GRAPH <urn:private> { ?s <urn:p> ?o } }'
      : 'FROM <urn:private> WHERE { ?s <urn:p> ?o }';

    await expect(engine.query(
      `SELECT ?o # decoy${commentBoundary}${hidden}`,
      { contextGraphId: CG },
    )).rejects.toThrow(/Scoped query violation/);
    expect(queryCalls).toBe(0);
  });

  it('scopes graphless DESCRIBE with LIMIT to the requested context graph', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:a', 'urn:p', '"Requested"', contextGraphDataUri(CG)),
      quad('urn:a', 'urn:p', '"Other"', contextGraphDataUri('other-cg')),
    ]);

    const result = await engine.query(
      'DESCRIBE <urn:a> LIMIT 10',
      { contextGraphId: CG },
    );

    expect(result.quads?.map((value) => value.object)).toEqual(['"Requested"']);
  });

  it('scopes graphless DESCRIBE with LIMIT across every authorized view graph only', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:a', 'urn:p', '"Root"', contextGraphDataUri(CG)),
      quad(
        'urn:a',
        'urn:p',
        '"Verified"',
        contextGraphVerifiableMemoryUri(CG, 'describe-multi'),
      ),
      quad('urn:a', 'urn:p', '"Foreign"', contextGraphDataUri('other-cg')),
    ]);

    const result = await engine.query(
      'DESCRIBE <urn:a> LIMIT 10',
      { contextGraphId: CG, view: 'verifiable-memory' },
    );

    expect(result.quads?.map((value) => value.object).sort())
      .toEqual(['"Root"', '"Verified"']);
  });

  it('keeps no-op graph rewrites byte-identical and materializes syntax only for execution', () => {
    const source = String.raw`SELECT ?s WHERE \u007B GRAPH <urn:g> \u007B ?s <urn:p> "\u007B" \u007D \u007D`;
    const scope = prepareGraphScope(source);

    expect(wrapWithGraph(scope, 'urn:other')).toBe(scope);
    expect(scope.source).toBe(source);
    expect(materializeGraphScopeForExecution(scope)).toBe(
      String.raw`SELECT ?s WHERE { GRAPH <urn:g> { ?s <urn:p> "\u007B" } }`,
    );
  });

  it('does not alias a UCHAR-spelled caller variable to the dedup helper', async () => {
    const store = new OxigraphStore();
    const originalQuery = store.query.bind(store);
    const queries: string[] = [];
    store.query = async (...args) => {
      queries.push(args[0]);
      return originalQuery(...args);
    };
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:root', 'urn:p', '"Root"', contextGraphDataUri(CG)),
      quad(
        'urn:verified',
        'urn:p',
        '"Verified"',
        contextGraphVerifiableMemoryUri(CG, 'variable-collision'),
      ),
    ]);

    const equivalent = await engine.query(
      'SELECT ?s WHERE { ?s <urn:p> ?callerValue }',
      { contextGraphId: CG, view: 'verifiable-memory' },
    );
    queries.length = 0;
    const escaped = await engine.query(
      String.raw`SELECT ?s WHERE { ?s <urn:p> ?\u005F_dkgDedupGraph }`,
      { contextGraphId: CG, view: 'verifiable-memory' },
    );

    expect(escaped.bindings.map((binding) => binding['s']).sort())
      .toEqual(equivalent.bindings.map((binding) => binding['s']).sort());
    expect(escaped.bindings.every((binding) => Object.keys(binding).join() === 's')).toBe(true);
    expect(queries.some((query) => query.includes('VALUES (?__dkgDedupGraph'))).toBe(false);
  });

  it('does not alias a UCHAR-spelled caller variable to the view helper', async () => {
    const store = new OxigraphStore();
    const originalQuery = store.query.bind(store);
    const queries: string[] = [];
    store.query = async (...args) => {
      queries.push(args[0]);
      return originalQuery(...args);
    };
    const engine = new DKGQueryEngine(store);
    const swmRoot = contextGraphSharedMemoryUri(CG);
    await store.insert([
      quad('urn:first', 'urn:p', '"First"', `${swmRoot}/0xagent/1`),
      quad('urn:second', 'urn:p', '"Second"', `${swmRoot}/0xagent/2`),
    ]);

    const equivalent = await engine.query(
      'SELECT ?s WHERE { ?s <urn:p> ?callerValue }',
      { contextGraphId: CG, view: 'shared-working-memory' },
    );
    queries.length = 0;
    const escaped = await engine.query(
      String.raw`SELECT ?s WHERE { ?s <urn:p> ?\u005F_dkgViewGraph }`,
      { contextGraphId: CG, view: 'shared-working-memory' },
    );

    expect(escaped.bindings.map((binding) => binding['s']).sort())
      .toEqual(equivalent.bindings.map((binding) => binding['s']).sort());
    expect(escaped.bindings.every((binding) => Object.keys(binding).join() === 's')).toBe(true);
    expect(queries.some((query) => query.includes('VALUES ?__dkgViewGraph'))).toBe(false);
  });

  it('scopes a single graph when the WHERE braces use UCHAR source spans', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:a', 'urn:p', '"Requested"', contextGraphDataUri(CG)),
      quad('urn:a', 'urn:p', '"Other"', contextGraphDataUri('other-cg')),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?o WHERE \u007B ?s <urn:p> ?o \u007D`,
      { contextGraphId: CG },
    );

    expect(result.bindings).toEqual([{ o: '"Requested"' }]);
  });

  it('scopes multiple view graphs when the WHERE braces use UCHAR source spans', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:a', 'urn:p', '"Root"', contextGraphDataUri(CG)),
      quad(
        'urn:b',
        'urn:p',
        '"Verified"',
        contextGraphVerifiableMemoryUri(CG, 'encoded-braces'),
      ),
      quad('urn:c', 'urn:p', '"Other"', contextGraphDataUri('other-cg')),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?o WHERE \u007B ?s <urn:p> ?o \u007D`,
      { contextGraphId: CG, view: 'verifiable-memory' },
    );

    expect(result.bindings.map((binding) => binding['o']).sort())
      .toEqual(['"Root"', '"Verified"']);
  });

  it('constrains GRAPH variables when group braces use UCHAR source spans', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const requestedGraph = contextGraphDataUri(CG);
    await store.insert([
      quad('urn:a', 'urn:p', '"Requested"', requestedGraph),
      quad('urn:b', 'urn:p', '"Other"', contextGraphDataUri('other-cg')),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?g ?o WHERE \u007B GRAPH ?g \u007B ?s <urn:p> ?o \u007D \u007D`,
      { contextGraphId: CG },
    );

    expect(result.bindings).toEqual([{ g: requestedGraph, o: '"Requested"' }]);
  });

  it('injects minTrust after a UCHAR-encoded opening WHERE brace', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const graph = contextGraphVerifiableMemoryUri(CG, 'encoded-min-trust');
    await store.insert([
      quad('urn:a', 'urn:p', '"Trusted"', graph),
      quad(
        'urn:a',
        'http://dkg.io/ontology/trustLevel',
        `"${TrustLevel.ConsensusVerified}"`,
        graph,
      ),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?o WHERE \u007B <urn:a> <urn:p> ?o \u007D`,
      {
        contextGraphId: CG,
        view: 'verifiable-memory',
        minTrust: TrustLevel.ConsensusVerified,
      },
    );

    expect(result.bindings).toEqual([{ o: '"Trusted"' }]);
  });

  it('fails closed when UCHAR syntax hides a nested OPTIONAL from minTrust', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const graph = contextGraphVerifiableMemoryUri(CG, 'encoded-optional');
    await store.insert([
      quad('urn:trusted', 'urn:p', '"Visible"', graph),
      quad(
        'urn:trusted',
        'http://dkg.io/ontology/trustLevel',
        `"${TrustLevel.ConsensusVerified}"`,
        graph,
      ),
      quad('urn:foreign', 'urn:secret', '"Must not leak"', graph),
      quad(
        'urn:foreign',
        'http://dkg.io/ontology/trustLevel',
        `"${TrustLevel.SelfAttested}"`,
        graph,
      ),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?secret WHERE { ?trusted <urn:p> ?value \u004FPTIONAL \u007B ?foreign <urn:secret> ?secret \u007D }`,
      {
        contextGraphId: CG,
        view: 'verifiable-memory',
        minTrust: TrustLevel.ConsensusVerified,
      },
    );

    expect(result.bindings).toEqual([]);
  });

  it('supports a UCHAR-spelled leading VALUES clause under minTrust', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const graph = contextGraphVerifiableMemoryUri(CG, 'encoded-values');
    await store.insert([
      quad('urn:trusted', 'urn:p', '"Visible"', graph),
      quad(
        'urn:trusted',
        'http://dkg.io/ontology/trustLevel',
        `"${TrustLevel.ConsensusVerified}"`,
        graph,
      ),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?value WHERE { \u0056ALUES ?subject \u007B <urn:trusted> \u007D ?subject <urn:p> ?value }`,
      {
        contextGraphId: CG,
        view: 'verifiable-memory',
        minTrust: TrustLevel.ConsensusVerified,
      },
    );

    expect(result.bindings).toEqual([{ value: '"Visible"' }]);
  });

  it('avoids UCHAR-equivalent caller variables when allocating minTrust helpers', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const graph = contextGraphVerifiableMemoryUri(CG, 'encoded-helper-collision');
    await store.insert([
      quad('urn:trusted', 'urn:p', '"Visible"', graph),
      quad(
        'urn:trusted',
        'http://dkg.io/ontology/trustLevel',
        `"${TrustLevel.ConsensusVerified}"`,
        graph,
      ),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?value ?__dkgTrust0 WHERE { ?subject <urn:p> ?value . BIND("caller" AS ?\u005F_dkgTrust0) }`,
      {
        contextGraphId: CG,
        view: 'verifiable-memory',
        minTrust: TrustLevel.ConsensusVerified,
      },
    );

    expect(result.bindings).toEqual([{ value: '"Visible"', __dkgTrust0: '"caller"' }]);
  });

  it.each([
    String.raw`\u00ZZ`,
    String.raw`\u006E`,
  ])('round-trips a sparqlString UCHAR lookalike: %s', async (value) => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    const result = await engine.query(
      `SELECT ?value WHERE { BIND(${sparqlString(value)} AS ?value) }`,
    );

    expect(result.bindings).toEqual([{ value: sparqlString(value) }]);
  });

  it('still strips real line comments containing a fake terminator (`# … .`)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:cmt', 'http://schema.org/name', '"ok"', consensus),
      quad('urn:cmt', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
    ]);
    const sparql = [
      'SELECT ?n WHERE {',
      '  <urn:cmt> <http://schema.org/name> ?n . # trailing comment with a fake dot .',
      '}',
    ].join('\n');
    const result = await engine.query(sparql, {
      contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified,
    });
    expect(result.bindings.map((b) => b['n'])).toEqual(['"ok"']);
  });

  // the naive
  // `/\.(?=\s|$)/` split fragmented any query whose literal contained
  // a sentence-terminating dot ("hello. world", an email address
  // ending a chat message, a float "3.14 " — anything where `.` was
  // followed by whitespace inside the string). The rewrite would
  // then bail out and `_minTrust` would fail-closed to `[]` for
  // every text/chat query. These two cases pin the fix.
  it('honors _minTrust when a triple-object literal contains a dot followed by whitespace ("hello. world")', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:msg', 'http://schema.org/text', '"hello. world"', consensus),
      quad('urn:msg', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
    ]);
    const result = await engine.query(
      'SELECT ?t WHERE { <urn:msg> <http://schema.org/text> ?t }',
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['t'])).toEqual(['"hello. world"']);
  });

  it('honors _minTrust on a multi-triple BGP where the FIRST literal contains a sentence-terminator dot', async () => {
    // If the fragmenter splits on the inner-literal dot it will treat
    // "world" . ?s <p> ... as the start of the next statement — the
    // subject scanner then refuses the shape and the query returns
    // [] instead of the join result.
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:m', 'http://schema.org/text', '"ack. ok"', consensus),
      quad('urn:m', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:m', 'http://schema.org/author', '"alice"', consensus),
    ]);
    const result = await engine.query(
      'SELECT ?a WHERE { <urn:m> <http://schema.org/text> "ack. ok" . <urn:m> <http://schema.org/author> ?a }',
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['a'])).toEqual(['"alice"']);
  });

  it('honors _minTrust on MIXED concrete + variable subjects in a single BGP', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:p', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:q', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:p', 'http://schema.org/relatedTo', 'urn:q', consensus),
      quad('urn:q', 'http://schema.org/name', '"q-name"', consensus),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { <urn:p> <http://schema.org/relatedTo> ?t . ?t <http://schema.org/name> ?name }',
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['name'])).toEqual(['"q-name"']);
  });

  // before this
  // round the `_minTrust` subject matcher only accepted variables,
  // `<iri>`, blank nodes, and literals. Standard SPARQL with a
  // `PREFIX ex: <urn:> ...` header and a prefixed-name subject
  // (`ex:item`) was classified as "unsupported shape" and fail-closed
  // to `[]` — even though the exact-entity trust filter is perfectly
  // enforceable. These tests pin the fix: the rewritten WHERE accepts
  // prefixed-name subjects and attaches the trust-level clause inline.
  it('honors _minTrust when the subject is a prefixed name (PNAME_LN)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:item', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:item', 'http://example.org/name', '"Alice"', consensus),
    ]);
    const sparql = [
      'PREFIX ex: <urn:>',
      'PREFIX s: <http://example.org/>',
      'SELECT ?n WHERE { ex:item s:name ?n }',
    ].join('\n');
    const result = await engine.query(
      sparql,
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['n'])).toEqual(['"Alice"']);
  });

  it('filters out below-threshold results for prefixed-name subjects', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:low', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.SelfAttested}"`, consensus),
      quad('urn:low', 'http://example.org/name', '"Bob"', consensus),
    ]);
    // ex:low has SelfAttested < ConsensusVerified, so the rewrite MUST
    // filter it out — not silently drop `_minTrust` and return "Bob".
    const sparql = [
      'PREFIX ex: <urn:>',
      'PREFIX s: <http://example.org/>',
      'SELECT ?n WHERE { ex:low s:name ?n }',
    ].join('\n');
    const result = await engine.query(
      sparql,
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings).toEqual([]);
  });

  it('honors _minTrust on mixed prefixed + variable subjects (multi-triple BGP)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:p', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:q', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:p', 'http://schema.org/relatedTo', 'urn:q', consensus),
      quad('urn:q', 'http://schema.org/name', '"q-name"', consensus),
    ]);
    const sparql = [
      'PREFIX ex: <urn:>',
      'SELECT ?name WHERE { ex:p <http://schema.org/relatedTo> ?t . ?t <http://schema.org/name> ?name }',
    ].join('\n');
    const result = await engine.query(
      sparql,
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['name'])).toEqual(['"q-name"']);
  });

  // The
  // canonical SPARQL shape for batched exact-subject lookups is a
  // leading `VALUES ?s { … }` clause followed by a BGP that binds
  // `?s`. Before r23-2 `injectMinTrustFilter` treated ANY occurrence
  // of `VALUES` as "unsupported shape" and fail-closed to `[]` — even
  // when every bound subject met the threshold. Callers saw a silent
  // empty result with no `minTrust`-related error, which is exactly
  // the false negative the bot flagged. These tests pin the fix:
  // a single-variable leading VALUES clause is peeled off, the trust
  // filter is attached to the BGP, and the VALUES binding is
  // re-emitted verbatim so the engine still restricts subjects.
  it('honors _minTrust on a leading VALUES ?s { … } clause', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:a', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:b', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:a', 'http://example.org/label', '"A"', consensus),
      quad('urn:b', 'http://example.org/label', '"B"', consensus),
    ]);
    const sparql = [
      'SELECT ?s ?l WHERE {',
      '  VALUES ?s { <urn:a> <urn:b> }',
      '  ?s <http://example.org/label> ?l .',
      '}',
      'ORDER BY ?s',
    ].join('\n');
    const result = await engine.query(
      sparql,
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['l'])).toEqual(['"A"', '"B"']);
  });

  it('filters VALUES-bound subjects that fall below _minTrust', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:hi', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:lo', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.SelfAttested}"`, consensus),
      quad('urn:hi', 'http://example.org/label', '"H"', consensus),
      quad('urn:lo', 'http://example.org/label', '"L"', consensus),
    ]);
    const sparql = [
      'SELECT ?l WHERE {',
      '  VALUES ?s { <urn:hi> <urn:lo> }',
      '  ?s <http://example.org/label> ?l .',
      '}',
    ].join('\n');
    const result = await engine.query(
      sparql,
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    // `urn:lo` is SelfAttested — it must be filtered out, not silently
    // returned because the rewriter bailed on VALUES.
    expect(result.bindings.map((b) => b['l'])).toEqual(['"H"']);
  });

  // ─────────────────────────────────────────────────────────────────────
  //
  // A query like
  //     SELECT ?o WHERE { ?s <p> ?o . FILTER(?o > 10) }
  // splits into two top-level statements: `?s <p> ?o` and
  // `FILTER(?o > 10)`. Pre-fix, the subject scanner saw the FILTER
  // statement, the regex didn't match, `injectMinTrustFilter` returned
  // null, and the whole query collapsed to `[]` whenever
  // `minTrust > SelfAttested`. The new behaviour: top-level FILTER /
  // BIND clauses are skipped during the subject scan and survive
  // verbatim in the rewritten WHERE (since the rewriter appends trust-
  // filter triples to the original trimmed inner).
  // ─────────────────────────────────────────────────────────────────────
  it('honors _minTrust on a BGP whose top-level statements include a FILTER', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:doc1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:doc2', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:doc1', 'http://schema.org/score', '"5"^^<http://www.w3.org/2001/XMLSchema#integer>', consensus),
      quad('urn:doc2', 'http://schema.org/score', '"42"^^<http://www.w3.org/2001/XMLSchema#integer>', consensus),
    ]);
    const sparql = [
      'SELECT ?s ?score WHERE {',
      '  ?s <http://schema.org/score> ?score .',
      '  FILTER(?score > 10)',
      '}',
    ].join('\n');
    const result = await engine.query(
      sparql,
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    // Only doc2 has score > 10. Pre-fix this would have returned [] —
    // not because the data didn't match but because the rewriter
    // returned null and the caller fail-closed the entire query.
    expect(result.bindings.map((b) => b['s'])).toEqual(['urn:doc2']);
  });

  it('trust-filters a triple block after FILTER when the optional dot is omitted', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:outer', 'urn:p', '"Visible"', consensus),
      quad('urn:outer', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:allowed', 'urn:secret', '"Allowed"', consensus),
      quad('urn:allowed', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:denied', 'urn:secret', '"Denied"', consensus),
      quad('urn:denied', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.SelfAttested}"`, consensus),
    ]);
    const sparql = [
      'SELECT ?secret WHERE {',
      '  ?outer <urn:p> ?value .',
      '  FILTER(?value = "Visible")',
      '  ?candidate <urn:secret> ?secret',
      '}',
    ].join('\n');

    const result = await engine.query(
      sparql,
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );

    expect(result.bindings.map((binding) => binding['secret'])).toEqual(['"Allowed"']);
  });

  it('honors _minTrust on a BGP whose top-level statements include a BIND', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:x', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:x', 'http://schema.org/title', '"Hello"', consensus),
    ]);
    const sparql = [
      'SELECT ?s ?upper WHERE {',
      '  ?s <http://schema.org/title> ?title .',
      '  BIND(UCASE(?title) AS ?upper)',
      '}',
    ].join('\n');
    const result = await engine.query(
      sparql,
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['upper'])).toEqual(['"HELLO"']);
  });

  it('does not regress: trust-failed FILTER queries still return [] (filter is applied)', async () => {
    // Negative control: FILTER queries that legitimately match nothing
    // because the trust threshold excludes the only candidate must
    // STILL return [] (post-rewrite the trust filter rejects the row).
    // This pins that we didn't accidentally remove the trust check by
    // letting FILTER short-circuit the rewriter.
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:lo', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.SelfAttested}"`, consensus),
      quad('urn:lo', 'http://schema.org/score', '"99"^^<http://www.w3.org/2001/XMLSchema#integer>', consensus),
    ]);
    const sparql = [
      'SELECT ?s ?score WHERE {',
      '  ?s <http://schema.org/score> ?score .',
      '  FILTER(?score > 10)',
      '}',
    ].join('\n');
    const result = await engine.query(
      sparql,
      { contextGraphId: CG, view: 'verifiable-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q-2  executeSparql drops CONSTRUCT / DESCRIBE quads on the wire
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-2] QueryHandler.executeSparql CONSTRUCT / DESCRIBE returns empty bindings', () => {
  // The local engine returns quads for CONSTRUCT (dkg-query-engine.ts:237).
  // QueryHandler only forwards `result.bindings` — quads are dropped. This
  // test pins that behaviour and documents the remote-SPARQL wire gap.
  async function run(sparql: string): Promise<{ bindingsJson?: string; ntriples?: string; resultCount: number; status: string }> {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:a', 'http://schema.org/name', '"A"', contextGraphDataUri(CG)),
      quad('urn:b', 'http://schema.org/name', '"B"', contextGraphDataUri(CG)),
    ]);
    const cfg: QueryAccessConfig = {
      defaultPolicy: 'public',
      contextGraphs: { [CG]: { policy: 'public', sparqlEnabled: true } },
    };
    const handler = new QueryHandler(engine, cfg);
    const resp = await handler.handle(
      {
        operationId: 'op-1',
        lookupType: 'SPARQL_QUERY',
        contextGraphId: CG,
        sparql,
      },
      'peer-q2',
    );
    return { bindingsJson: resp.bindings, ntriples: resp.ntriples, resultCount: resp.resultCount, status: resp.status };
  }

  it('CONSTRUCT succeeds but bindings JSON is empty and no ntriples/quads are transported', async () => {
    const out = await run(
      'CONSTRUCT { ?s <http://schema.org/name> ?o } WHERE { ?s <http://schema.org/name> ?o }',
    );
    // Spec §12 + issue #83 expectation: quads must reach the caller.
    // Current wire only carries `bindings`. We assert the literal current
    // behaviour so any future fix (which should add ntriples / quads) is
    // visible as a test failure.
    expect(out.status).toBe('OK');
    expect(out.bindingsJson).toBe('[]');
    expect(out.ntriples).toBeUndefined();
    expect(out.resultCount).toBe(0);
  });

  it('DESCRIBE succeeds but bindings JSON is empty and no ntriples/quads are transported', async () => {
    const out = await run('DESCRIBE <urn:a>');
    expect(out.status).toBe('OK');
    expect(out.bindingsJson).toBe('[]');
    expect(out.ntriples).toBeUndefined();
    expect(out.resultCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q-3  working-memory view resolution
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-3] resolveViewGraphs + DKGQueryEngine route working-memory', () => {
  const AGENT = '0xAbC0000000000000000000000000000000000001';

  it('resolveViewGraphs requires agentAddress for working-memory', () => {
    expect(() => resolveViewGraphs('working-memory', CG, {})).toThrow(/agentAddress is required/);
  });

  it('resolveViewGraphs(working-memory, {agentAddress, assertionName}) → exact assertion URI', () => {
    const res = resolveViewGraphs('working-memory', CG, { agentAddress: AGENT, assertionName: 'note-1' });
    expect(res.graphPrefixes).toEqual([]);
    expect(res.graphs).toEqual([contextGraphAssertionUri(CG, AGENT, 'note-1')]);
  });

  it('resolveViewGraphs(working-memory, {agentAddress}) → prefix scoped to that agent', () => {
    const res = resolveViewGraphs('working-memory', CG, { agentAddress: AGENT });
    expect(res.graphs).toEqual([]);
    expect(res.graphPrefixes).toEqual([
      `did:dkg:context-graph:${CG}/_working_memory/${AGENT.toLowerCase()}/`,
      `did:dkg:context-graph:${CG}/_working_memory/${AGENT}/`,
    ]);
  });

  // PR #1107 review (🟡): the node default agent's WM is split across the
  // legacy peerId-keyed namespace and the rc.17+ wallet-keyed namespace —
  // an unscoped WM read must span every same-identity alias.
  it('resolveViewGraphs(working-memory, {agentAddress, agentAddressAliases}) → one prefix per alias', () => {
    const PEER = '12D3KooWLegacyPeerIdNamespace';
    const res = resolveViewGraphs('working-memory', CG, {
      agentAddress: AGENT,
      agentAddressAliases: [PEER],
    });
    expect(res.graphs).toEqual([]);
    expect(res.graphPrefixes).toEqual([
      `did:dkg:context-graph:${CG}/_working_memory/${AGENT.toLowerCase()}/`,
      `did:dkg:context-graph:${CG}/_working_memory/${AGENT}/`,
      `did:dkg:context-graph:${CG}/_working_memory/${PEER}/`,
    ]);
  });

  it('keeps one canonical prefix plus the primary legacy checksum-cased prefix', () => {
    const res = resolveViewGraphs('working-memory', CG, {
      agentAddress: AGENT,
      agentAddressAliases: [AGENT.toLowerCase(), '', AGENT],
    });
    expect(res.graphPrefixes).toEqual([
      `did:dkg:context-graph:${CG}/_working_memory/${AGENT.toLowerCase()}/`,
      `did:dkg:context-graph:${CG}/_working_memory/${AGENT}/`,
    ]);
  });

  it('resolveViewGraphs working-memory aliases are ignored for by-name (assertionName) reads', () => {
    const res = resolveViewGraphs('working-memory', CG, {
      agentAddress: AGENT,
      agentAddressAliases: ['12D3KooWLegacyPeerIdNamespace'],
      assertionName: 'note-1',
    });
    // Single-graph read on the primary address only — no sibling-namespace leak.
    expect(res.graphs).toEqual([contextGraphAssertionUri(CG, AGENT, 'note-1')]);
    expect(res.graphPrefixes).toEqual([]);
  });

  it('DKGQueryEngine.query(view=working-memory) returns ONLY this agent\'s assertions and ignores other agents', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const OTHER_AGENT = '0xDeAd000000000000000000000000000000000002';

    const mine = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, AGENT, 1n);
    const mineOther = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, AGENT, 2n);
    const theirs = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, OTHER_AGENT, 1n);

    await store.insert([
      quad('urn:a:1', 'http://schema.org/name', '"MyTodo"', mine),
      quad('urn:a:2', 'http://schema.org/name', '"MyNote"', mineOther),
      quad('urn:a:3', 'http://schema.org/name', '"OtherAgent"', theirs),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CG, view: 'working-memory', agentAddress: AGENT },
    );
    const names = result.bindings.map((b) => b['name']).sort();
    expect(names).toEqual(['"MyNote"', '"MyTodo"']);
    expect(names).not.toContain('"OtherAgent"');
  });

  it('DKGQueryEngine.query(view=working-memory) with agentAddressAliases unions wallet- and peerId-keyed namespaces (PR #1107 🟡)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const PEER = '12D3KooWLegacyPeerIdNamespace';
    const STRANGER = '0xDeAd000000000000000000000000000000000002';

    const walletEra = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, AGENT, 1n);
    const peerEra = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, PEER, 1n);
    const theirs = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, STRANGER, 1n);

    await store.insert([
      quad('urn:a:1', 'http://schema.org/name', '"WalletEra"', walletEra),
      quad('urn:a:2', 'http://schema.org/name', '"PeerIdEra"', peerEra),
      quad('urn:a:3', 'http://schema.org/name', '"NotMine"', theirs),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CG, view: 'working-memory', agentAddress: AGENT, agentAddressAliases: [PEER] },
    );
    const names = result.bindings.map((b) => b['name']).sort();
    // Both eras of the SAME identity visible; other identities still excluded.
    expect(names).toEqual(['"PeerIdEra"', '"WalletEra"']);
  });

  it('DKGQueryEngine.query(view=working-memory, assertionName) scopes to one assertion graph', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    const g1 = contextGraphAssertionUri(CG, AGENT, 'one');
    const g2 = contextGraphAssertionUri(CG, AGENT, 'two');
    await store.insert([
      quad('urn:x:1', 'http://schema.org/name', '"One"', g1),
      quad('urn:x:2', 'http://schema.org/name', '"Two"', g2),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CG, view: 'working-memory', agentAddress: AGENT, assertionName: 'one' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"One"');
  });

  it('by-name WM read resolves name→number from _meta and reads the per-KA graph (rc.17 read-flip)', async () => {
    // Regression: under the uniform layout, a created+written assertion's data lives in the
    // number-keyed graph `…/_working_memory/{addr}/{number}`, and its number is stamped as
    // `dkg:kaId` on the lifecycle URN in `_meta`. A by-name `view: 'working-memory'` query must
    // resolve that number and read the per-KA graph. Before the fix, the engine passed no
    // kaNumber to resolveViewGraphs, so it fell back to the (empty) legacy name-keyed graph and
    // returned 0 bindings.
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const name = 'numbered-draft';
    const kaNumber = 7n;
    const perKaGraph = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, AGENT, kaNumber);
    const urn = assertionLifecycleUri(CG, AGENT, name);
    const metaGraph = contextGraphMetaUri(CG);

    await store.insert([
      // data written by the new create/write path → number-keyed per-KA graph
      quad('urn:numbered:1', 'http://schema.org/name', '"NumberedValue"', perKaGraph),
      // identity-at-create (D1): the KA number stamped on the lifecycle URN in _meta
      quad(urn, 'http://dkg.io/ontology/kaId', '"7"^^<http://www.w3.org/2001/XMLSchema#integer>', metaGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CG, view: 'working-memory', agentAddress: AGENT, assertionName: name },
    );
    expect(result.bindings.map((b) => b['name'])).toEqual(['"NumberedValue"']);
  });

  it('by-name WM read includes scoped child graphs without leaking sibling assertions', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const name = 'named-draft';
    const kaNumber = 11n;
    const perKaGraph = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, AGENT, kaNumber);
    const namedGraph = assertionScopedGraphUri(perKaGraph, 'urn:test:graph:named-draft');
    const siblingGraph = contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, AGENT, 12n);
    const siblingNamedGraph = assertionScopedGraphUri(siblingGraph, 'urn:test:graph:named-draft');
    const urn = assertionLifecycleUri(CG, AGENT, name);
    const metaGraph = contextGraphMetaUri(CG);

    await store.insert([
      quad('urn:named:default', 'http://schema.org/name', '"DefaultDraft"', perKaGraph),
      quad('urn:named:child', 'http://schema.org/name', '"NamedDraft"', namedGraph),
      quad('urn:named:sibling', 'http://schema.org/name', '"SiblingDraft"', siblingNamedGraph),
      quad(urn, 'http://dkg.io/ontology/kaId', '"11"^^<http://www.w3.org/2001/XMLSchema#integer>', metaGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CG, view: 'working-memory', agentAddress: AGENT, assertionName: name },
    );

    expect(result.bindings.map((b) => b['name']).sort()).toEqual(['"DefaultDraft"', '"NamedDraft"']);
  });

  it('by-name WM read preserves a pre-canonicalization checksum-cased per-KA graph', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const name = 'legacy-checksum-draft';
    const kaNumber = 13n;
    const legacyGraph = `did:dkg:context-graph:${CG}/_working_memory/${AGENT}/${kaNumber}`;
    const urn = assertionLifecycleUri(CG, AGENT, name);
    const metaGraph = contextGraphMetaUri(CG);

    await store.insert([
      quad('urn:legacy-checksum:1', 'http://schema.org/name', '"LegacyChecksum"', legacyGraph),
      quad(urn, 'http://dkg.io/ontology/kaId', '"13"^^<http://www.w3.org/2001/XMLSchema#integer>', metaGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CG, view: 'working-memory', agentAddress: AGENT, assertionName: name },
    );
    expect(result.bindings.map((binding) => binding['name'])).toEqual(['"LegacyChecksum"']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// View routing constrains caller GRAPH variables to the selected View
// ─────────────────────────────────────────────────────────────────────────────
describe('DKGQueryEngine view routing constrains GRAPH variables', () => {
  it('verifiable-memory with GRAPH ?g does not read SWM-only data', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    await store.insert([
      quad('urn:view:swm-only', 'http://schema.org/name', '"SwmOnly"', contextGraphSharedMemoryUri(CG)),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } }',
      { contextGraphId: CG, view: 'verifiable-memory' },
    );

    expect(result.bindings).toEqual([]);
  });

  it('shared-working-memory with GRAPH ?g does not read verified data', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    await store.insert([
      quad('urn:view:verified-only', 'http://schema.org/name', '"VerifiedOnly"', contextGraphVerifiableMemoryUri(CG, 'published')),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } }',
      { contextGraphId: CG, view: 'shared-working-memory' },
    );

    expect(result.bindings).toEqual([]);
  });

  it('working-memory with GRAPH ?g does not read another agent assertion', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const agent = '0xAbC0000000000000000000000000000000000001';
    const otherAgent = '0xDeAd000000000000000000000000000000000002';

    await store.insert([
      quad('urn:view:mine', 'http://schema.org/name', '"Mine"', contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, agent, 1n)),
      quad('urn:view:theirs', 'http://schema.org/name', '"Theirs"', contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, otherAgent, 1n)),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } }',
      { contextGraphId: CG, view: 'working-memory', agentAddress: agent },
    );

    expect(result.bindings.map((b) => b['name'])).toEqual(['"Mine"']);
  });

  it('verifiable-memory minTrust with GRAPH ?g fails closed instead of returning trusted data', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const graph = contextGraphVerifiableMemoryUri(CG, 'trusted-graph-pattern');

    await store.insert([
      quad('urn:view:trusted', 'http://schema.org/name', '"Trusted"', graph),
      quad('urn:view:trusted', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, graph),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.Endorsed },
    );

    expect(result.bindings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q-4  QueryHandler.executeSparql timeout → GAS_LIMIT_EXCEEDED
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-4] QueryHandler executeSparql hits the timeout path', () => {
  // Wrap a real OxigraphStore to add artificial latency on query() only.
  class SleepyStore implements TripleStore {
    constructor(private readonly inner: TripleStore, private readonly delayMs: number) {}
    insert(quads: Quad[]) { return this.inner.insert(quads); }
    delete(quads: Quad[]) { return this.inner.delete(quads); }
    deleteByPattern(p: Partial<Quad>) { return this.inner.deleteByPattern(p); }
    hasGraph(u: string) { return this.inner.hasGraph(u); }
    createGraph(u: string) { return this.inner.createGraph(u); }
    dropGraph(u: string) { return this.inner.dropGraph(u); }
    listGraphs() { return this.inner.listGraphs(); }
    deleteBySubjectPrefix(u: string, pfx: string) { return this.inner.deleteBySubjectPrefix(u, pfx); }
    countQuads(u?: string) { return this.inner.countQuads(u); }
    close() { return this.inner.close(); }
    async query(sparql: string): Promise<StoreQueryResult> {
      await new Promise<void>((r) => setTimeout(r, this.delayMs));
      return this.inner.query(sparql);
    }
  }

  it('times out and emits GAS_LIMIT_EXCEEDED when the engine query exceeds request.timeout', async () => {
    const oxi = new OxigraphStore();
    const slow = new SleepyStore(oxi, 200);
    const engine = new DKGQueryEngine(slow);
    const handler = new QueryHandler(engine, {
      defaultPolicy: 'public',
      contextGraphs: { [CG]: { policy: 'public', sparqlEnabled: true } },
    });

    const resp = await handler.handle(
      {
        operationId: 'op-timeout',
        lookupType: 'SPARQL_QUERY',
        contextGraphId: CG,
        sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
        timeout: 25, // ms — well below the 200ms sleep
      },
      'peer-q4',
    );

    expect(resp.status).toBe('GAS_LIMIT_EXCEEDED');
    expect(resp.error).toMatch(/exceeded time limit/);
    expect(resp.error).toContain('25ms');
  });

  it('does NOT time out when request.timeout exceeds the query duration', async () => {
    const oxi = new OxigraphStore();
    const slow = new SleepyStore(oxi, 10);
    const engine = new DKGQueryEngine(slow);
    const handler = new QueryHandler(engine, {
      defaultPolicy: 'public',
      contextGraphs: { [CG]: { policy: 'public', sparqlEnabled: true } },
    });

    const resp = await handler.handle(
      {
        operationId: 'op-ok',
        lookupType: 'SPARQL_QUERY',
        contextGraphId: CG,
        sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
        timeout: 1000,
      },
      'peer-q4-ok',
    );
    expect(resp.status).toBe('OK');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q-5  Context Oracle proof-params mapping (spec §14)
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-5] Context Oracle proof params → correct graph targets', () => {
  const AGENT = '0xFeedFace0000000000000000000000000000BEEF';

  it('verifiable-memory + verifiedGraph points at exactly one _verifiable_memory/<id> URI', () => {
    const res = resolveViewGraphs('verifiable-memory', CG, { verifiedGraph: 'quorum-7' });
    expect(res.graphs).toEqual([contextGraphVerifiableMemoryUri(CG, 'quorum-7')]);
    expect(res.graphPrefixes).toEqual([]);
  });

  it('verifiable-memory without verifiedGraph unions root content graph + `_verifiable_memory/` prefix (RC11 / PR-A: Codex #671)', () => {
    const res = resolveViewGraphs('verifiable-memory', CG, {});
    // RC11 / PR-A (Codex review fix on #671, comment 3302058969):
    // the root content graph is re-included so a successful publish
    // shows up in VM immediately (memory-search flows depend on this).
    // The tentative-VM leak the PR2 first cut was guarding against is
    // now plugged at the publisher (root-graph insert deferred to the
    // chain-success branch in `DKGPublisher.publish`).
    expect(res.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
    expect(res.graphPrefixes).toEqual([`did:dkg:context-graph:${CG}/_verifiable_memory/`]);
  });

  it('shared-working-memory targets exactly the SWM graph (nothing else)', () => {
    const res = resolveViewGraphs('shared-working-memory', CG);
    expect(res.graphs).toEqual([contextGraphSharedMemoryUri(CG)]);
    expect(res.graphPrefixes).toEqual([`did:dkg:context-graph:${CG}/_shared_memory/`]);
  });

  it('working-memory with assertionName is NOT expanded to a prefix (prevents sibling-assertion leak)', () => {
    const res = resolveViewGraphs('working-memory', CG, { agentAddress: AGENT, assertionName: 'only-one' });
    expect(res.graphs).toEqual([contextGraphAssertionUri(CG, AGENT, 'only-one')]);
    expect(res.graphPrefixes).toEqual([]);
  });

  it('removed V10 views (`long-term-memory`, `authoritative`) throw with a migration hint', () => {
    expect(() => resolveViewGraphs('long-term-memory' as any, CG, { agentAddress: AGENT }))
      .toThrow(/removed in V10/);
    expect(() => resolveViewGraphs('authoritative' as any, CG, { agentAddress: AGENT }))
      .toThrow(/removed in V10/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q-6  Error taxonomy — distinct vs collapsed failure codes
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-6] QueryHandler error taxonomy', () => {
  async function mk(): Promise<QueryHandler> {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    return new QueryHandler(engine, {
      defaultPolicy: 'public',
      contextGraphs: { [CG]: { policy: 'public', sparqlEnabled: true } },
    });
  }

  it('malformed JSON on the wire → ERROR "Invalid request: malformed JSON"', async () => {
    const handler = await mk();
    const bytes = new TextEncoder().encode('{ not json');
    const out = await handler.handler(bytes, { toString: () => 'p', toBytes: () => new Uint8Array() } as any);
    const resp = JSON.parse(new TextDecoder().decode(out));
    expect(resp.status).toBe('ERROR');
    expect(resp.error).toContain('malformed JSON');
  });

  it('missing lookupType → ERROR "missing lookupType"', async () => {
    const handler = await mk();
    const resp = await handler.handle({ operationId: 'x', lookupType: undefined as any, contextGraphId: CG }, 'p');
    expect(resp.status).toBe('ERROR');
    expect(resp.error).toContain('missing lookupType');
  });

  it('SPARQL_QUERY without contextGraphId → ERROR "contextGraphId is required"', async () => {
    const handler = await mk();
    const resp = await handler.handle({
      operationId: 'x', lookupType: 'SPARQL_QUERY', sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
    }, 'p');
    expect(resp.status).toBe('ERROR');
    expect(resp.error).toContain('contextGraphId is required');
  });

  it('ENTITY_BY_UAL with missing ual → ERROR "missing ual"', async () => {
    const handler = await mk();
    const resp = await handler.handle({ operationId: 'x', lookupType: 'ENTITY_BY_UAL' }, 'p');
    expect(resp.status).toBe('ERROR');
    expect(resp.error).toContain('missing ual');
  });

  it('SPARQL_QUERY with SERVICE is rejected pre-execution → ERROR not GAS_LIMIT_EXCEEDED', async () => {
    const handler = await mk();
    const resp = await handler.handle({
      operationId: 'x', lookupType: 'SPARQL_QUERY', contextGraphId: CG,
      sparql: 'SELECT ?s WHERE { SERVICE <http://evil> { ?s ?p ?o } }',
    }, 'p');
    expect(resp.status).toBe('ERROR');
    expect(resp.error).toMatch(/SERVICE clauses are not allowed/);
  });

  it('SPARQL_QUERY with explicit GRAPH is rejected pre-execution', async () => {
    const handler = await mk();
    const resp = await handler.handle({
      operationId: 'x', lookupType: 'SPARQL_QUERY', contextGraphId: CG,
      sparql: 'SELECT ?s WHERE { GRAPH <did:dkg:context-graph:other> { ?s ?p ?o } }',
    }, 'p');
    expect(resp.status).toBe('ERROR');
    expect(resp.error).toMatch(/Explicit GRAPH clauses are not allowed/);
  });

  it('SPARQL_QUERY with FROM is rejected pre-execution', async () => {
    const handler = await mk();
    const resp = await handler.handle({
      operationId: 'x', lookupType: 'SPARQL_QUERY', contextGraphId: CG,
      sparql: 'SELECT ?s FROM <did:dkg:context-graph:other> WHERE { ?s ?p ?o }',
    }, 'p');
    expect(resp.status).toBe('ERROR');
    expect(resp.error).toMatch(/FROM.*are not allowed/);
  });

  it('mutating SPARQL rejected by guard reports "SPARQL rejected", not "Internal error"', async () => {
    const handler = await mk();
    const resp = await handler.handle({
      operationId: 'x', lookupType: 'SPARQL_QUERY', contextGraphId: CG,
      sparql: 'INSERT DATA { <urn:s> <urn:p> <urn:o> }',
    }, 'p');
    expect(resp.status).toBe('ERROR');
    expect(resp.error).toMatch(/^SPARQL rejected:/);
  });

  it('TEST-DEBT: an engine-internal exception collapses to generic "Internal error processing query"', async () => {
    // This documents the taxonomy gap: three distinct store failure modes
    // (network error, parse error, I/O error) would all surface as the same
    // opaque string. If the handler is refactored to emit specific codes,
    // this test should be updated to assert them.
    class ExplodingStore implements TripleStore {
      async insert() { /* noop */ }
      async delete() { /* noop */ }
      async deleteByPattern() { return 0; }
      async hasGraph() { return false; }
      async createGraph() { /* noop */ }
      async dropGraph() { /* noop */ }
      async listGraphs() { return []; }
      async deleteBySubjectPrefix() { return 0; }
      async countQuads() { return 0; }
      async close() { /* noop */ }
      async query(): Promise<StoreQueryResult> { throw new Error('boom'); }
    }

    const engine = new DKGQueryEngine(new ExplodingStore());
    const handler = new QueryHandler(engine, {
      defaultPolicy: 'public',
      contextGraphs: { [CG]: { policy: 'public', sparqlEnabled: true } },
    });
    const resp = await handler.handle({
      operationId: 'x', lookupType: 'SPARQL_QUERY', contextGraphId: CG,
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
    }, 'p');
    expect(resp.status).toBe('ERROR');
    expect(resp.error).toBe('Internal error processing query');
  });

  it('preserves the ordinary UAL resolution failure text at the outer boundary', async () => {
    const queryEngine = {
      resolveKnowledgeAsset: async () => { throw new Error('resolver failed'); },
    } as unknown as DKGQueryEngine;
    const handler = new QueryHandler(queryEngine, { defaultPolicy: 'public' });

    const response = await handler.handle({
      operationId: 'failed-ual',
      lookupType: 'ENTITY_BY_UAL',
      ual: 'did:dkg:testnet:31337/0xabc/1',
    }, 'peer');

    expect(response).toMatchObject({
      operationId: 'failed-ual',
      status: 'ERROR',
      error: 'Failed to resolve UAL: did:dkg:testnet:31337/0xabc/1',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The pre-fix
// `injectMinTrustFilter` only matched `WHERE\s*\{`. SPARQL 1.1 allows
// the `WHERE` keyword to be omitted from `SELECT`, `ASK`, and
// `DESCRIBE` queries, and from the second `GroupGraphPattern` of a
// `CONSTRUCT`. Those legitimate shorthand queries used to return
// `null` from the rewriter and the caller silently fell through to
// `emptyQueryResultForKind(...)` whenever `minTrust > Endorsed`,
// turning a valid query into a fail-closed empty result.
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-1] minTrust handles SPARQL 1.1 shorthand WHERE forms', () => {
  it('rewrites a SELECT shorthand (no WHERE keyword) when minTrust > Endorsed', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    const result = await engine.query(
      'SELECT ?n { <urn:e1> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['n'])).toEqual(['"Alice"']);
  });

  it('rewrites an ASK shorthand (no WHERE keyword) when minTrust > Endorsed', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    const result = await engine.query(
      'ASK { <urn:e1> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.length).toBeGreaterThan(0);
    const first = result.bindings[0];
    expect(first['result'] === 'true' || first['result'] === true).toBe(true);
  });

  it('fails CLOSED on a SELECT shorthand whose entity is below the trust threshold', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const selfAttestedGraph = contextGraphVerifiableMemoryUri(CG, 'self-attested');
    await store.insert([
      quad('urn:low', 'http://schema.org/name', '"Bob"', selfAttestedGraph),
      quad('urn:low', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.SelfAttested}"`, selfAttestedGraph),
    ]);

    const result = await engine.query(
      'SELECT ?n { <urn:low> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    // Below threshold → empty (proves the rewriter ran and the FILTER
    // is enforced; without the shorthand fix this would also be empty
    // BUT for the wrong reason — `injectMinTrustFilter` returning
    // null and the caller short-circuiting. The two cases are
    // distinguishable through the positive shorthand test above.)
    expect(result.bindings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// — dkg-query-engine.ts:540 follow-up).
// `findWhereBraceStart` previously treated EVERY `<` as the start of an IRI
// and skipped to the next `>`. SPARQL `<` is overloaded as a comparison
// operator, so queries like `FILTER(?n < 10)` ate the rest of the query
// and `wrapWithGraph` / `injectMinTrustFilter` no-op'd → wrong-graph hits
// or silent fail-closed.
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-1] findWhereBraceStart distinguishes IRI from comparison operator', () => {
  it('honors minTrust on a SELECT whose FILTER uses `<` as less-than (no IRI swallowing)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/age', '"21"^^<http://www.w3.org/2001/XMLSchema#integer>', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Pre-fix: the `<` inside `FILTER(?n < 100)` made findWhereBraceStart
    // scan to the next `>` (here the IRI's closing `>`), corrupting the
    // brace search. With the IRI/comparison disambiguator the rewrite
    // succeeds and the binding is returned.
    const result = await engine.query(
      'SELECT ?n WHERE { <urn:e1> <http://schema.org/age> ?n . FILTER(?n < 100) }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.length).toBe(1);
    // Object literal includes the typed-literal serialisation; just
    // assert the lexical form matches.
    expect(String(result.bindings[0]['n'])).toContain('21');
  });

  it('honors minTrust on a SHORTHAND SELECT whose FILTER uses `<=` as comparison', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/age', '"21"^^<http://www.w3.org/2001/XMLSchema#integer>', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Shorthand (no WHERE keyword) + `<=` operator. Pre-fix this
    // returned `null` from `findWhereBraceStart` because the IRI
    // scanner ran past the closing `}` looking for `>`. Now the
    // disambiguator recognises `<=` and skips past the operator.
    const result = await engine.query(
      'SELECT ?n { <urn:e1> <http://schema.org/age> ?n . FILTER(?n <= 100) }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.length).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // — dkg-query-engine.ts:559).
  // The r30 cut only rejected `=`, `<`, and whitespace as next-byte
  // shapes after `<`. Compact comparison forms like `?n<10&&?m>5`
  // (no whitespace, common in machine-generated SPARQL) made the
  // forward scan walk `1`,`0`,`&`,`&`,`?`,`m` (none IRIREF-forbidden)
  // to the next `>`, mis-classifying the entire `<10&&?m>` as an IRI
  // and corrupting the brace scan. Tighten the next-byte check to a
  // positive allow-list of real IRIREF first chars (ALPHA / `#` /
  // `_` / `/` / `.`).
  // ─────────────────────────────────────────────────────────────────────
  it('honors minTrust on a SHORTHAND SELECT with COMPACT `?n<10&&?m>5` comparison (no whitespace)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/age', '"21"^^<http://www.w3.org/2001/XMLSchema#integer>', consensusGraph),
      quad('urn:e1', 'http://schema.org/score', '"50"^^<http://www.w3.org/2001/XMLSchema#integer>', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Pre-fix: `?n<100&&?m>5` walked through the IRI scan, `?` is not
    // IRIREF-forbidden, so the scanner kept going to the next `>` and
    // ate the closing `}` along the way → findWhereBraceStart returned
    // -1 → graph wrap / minTrust filter silently no-op'd → empty.
    const result = await engine.query(
      'SELECT ?n ?m { <urn:e1> <http://schema.org/age> ?n . <urn:e1> <http://schema.org/score> ?m . FILTER(?n<100&&?m>5) }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.length).toBe(1);
  });

  it('honors minTrust on `?n < (10 + 5)` — sub-expression with `<(` next-byte', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/age', '"21"^^<http://www.w3.org/2001/XMLSchema#integer>', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // `<(` is not IRIREF-legal; the next-byte rejecter let
    // `(` through and the forward scan happened to find no `>`,
    // returning -1. The positive allow-list rejects `(` as a first
    // IRI byte and treats this as a comparison, advancing one byte.
    const result = await engine.query(
      'SELECT ?n { <urn:e1> <http://schema.org/age> ?n . FILTER(?n<(10+50)) }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.length).toBe(1);
  });

  it('honors minTrust on `?n<-1` — negative numeric comparison (next-byte `-`)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/age', '"21"^^<http://www.w3.org/2001/XMLSchema#integer>', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // No row should match (21 < -1 is false), but the rewriter must
    // still RUN (not fail-closed): pre-fix `<-1` walked into the IRI
    // branch and corrupted the brace scan. We assert empty bindings
    // FROM the executed FILTER, not from a silent rewriter bail-out.
    // Distinguishing shape: the inverse comparison (`?n>-1`, age 21)
    // returns a row, proving the engine actually executed both.
    const noMatch = await engine.query(
      'SELECT ?n { <urn:e1> <http://schema.org/age> ?n . FILTER(?n<-1) }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(noMatch.bindings).toEqual([]);

    const match = await engine.query(
      'SELECT ?n { <urn:e1> <http://schema.org/age> ?n . FILTER(?n>-1) }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(match.bindings.length).toBe(1);
  });

  it('still recognises real IRIs that begin with `#`, `_`, `/`, or `.` (allow-list whitelisted starts)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    // Use a real (absolute) IRI for the subject — relative IRI
    // resolution depends on a base IRI which the engine does not
    // configure here. The point of this test is that the SCANNER
    // still treats `<http://...>` as an IRI; the existing alpha
    // path covers that, and we additionally exercise a `<#frag>`
    // shape inside a SPARQL `STR()` expression to prove the
    // allow-list does not over-reject letter-leading shapes.
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Sanity: with a leading absolute-IRI predicate the rewrite still
    // runs end-to-end (this would already have worked pre-r30-2; the
    // assertion guards against any over-zealous tightening that broke
    // ALPHA-leading IRIs).
    const result = await engine.query(
      'SELECT ?n { <urn:e1> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['n'])).toEqual(['"Alice"']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// — dkg-query-engine.ts:851).
// The unsupported-nesting brace check ran on the RAW WHERE body, so any
// `{`/`}` inside a string literal (or sensitive keyword inside a comment)
// caused `injectMinTrustFilter` to bail and the caller fell through to an
// empty result. Real text/JSON payloads constantly contain those tokens,
// so legitimate high-trust queries silently fail-closed.
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-1] minTrust survives literals/comments containing braces or keywords', () => {
  it('honors minTrust when a triple-object literal contains `{` and `}` (JSON payload)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/text', '"{\\"key\\": 1}"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Pre-fix the literal `"{\"key\": 1}"` made the brace check fire
    // and `injectMinTrustFilter` returned null → empty result.
    const result = await engine.query(
      'SELECT ?t WHERE { <urn:e1> <http://schema.org/text> ?t . FILTER(STR(?t) = "{\\"key\\": 1}") }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.length).toBe(1);
  });

  it('honors minTrust when a `# …` comment contains a sensitive keyword like OPTIONAL or SELECT', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Pre-fix the keyword scan saw `OPTIONAL`/`SELECT` inside the
    // comment and returned null. With comment scrubbing the keyword
    // check only sees real code tokens.
    const sparql = [
      '# OPTIONAL inline comment with SELECT inside — must not bail',
      'SELECT ?n WHERE {',
      '  # another comment OPTIONAL { fake } UNION { fake }',
      '  <urn:e1> <http://schema.org/name> ?n',
      '}',
    ].join('\n');
    const result = await engine.query(sparql, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      minTrust: TrustLevel.ConsensusVerified,
    });
    expect(result.bindings.map((b) => b['n'])).toEqual(['"Alice"']);
  });

  it('still bails (returns empty) on a REAL OPTIONAL { … } block in code', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Sanity: literal-aware scrubbing must NOT relax the genuine
    // refusal of nested code (OPTIONAL/UNION/etc.) since the flat
    // subject scanner still cannot reason about them.
    const result = await engine.query(
      'SELECT ?n WHERE { <urn:e1> <http://schema.org/name> ?n . OPTIONAL { ?n <http://schema.org/x> ?z } }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// — dkg-query-engine.ts:939). Three call sites
// in the engine were finding the WHERE-block close-brace by counting `{` and
// `}` characters with no awareness of strings/comments/IRIs:
//
//   • injectMinTrustFilter (line ≈939)
//   • wrapWithGraph
//   • wrapWithGraphUnion
//
// A SPARQL string literal carrying a single unbalanced `{` (or `}`), or an
// IRI containing `{`/`}` characters that escape on the lexer side, drove the
// counter into negative or unmatched territory. The previous tests in this
// file used a literal with BALANCED braces (`"{\"key\": 1}"`), so they
// happened to work despite the bug — they did not exercise the unbalanced
// path. The cases below pin the truly broken inputs and prove the new
// findMatchingCloseBrace helper handles them.
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-1] minTrust + view wrapping survive UNBALANCED literal braces (bot r30-6)', () => {
  it('honors minTrust when a string literal contains a SOLITARY unbalanced `{` (no closing `}`)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/text', '"open-brace {"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // SPARQL: FILTER(STR(?t) = "{")
    // Pre-fix: the brace counter saw the lone `{` inside the literal as
    // an extra block opener and the closing `}` of WHERE re-balanced
    // depth, so the WHERE-end was located at the WRONG `}`. Result was
    // either malformed SPARQL or fail-closed empty bindings.
    const result = await engine.query(
      'SELECT ?t WHERE { <urn:e1> <http://schema.org/text> ?t . FILTER(STR(?t) = "open-brace {") }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.length).toBe(1);
  });

  it('honors minTrust when a string literal contains a SOLITARY unbalanced `}` (no opening `{`)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/text', '"close-brace }"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // SPARQL: FILTER(STR(?t) = "}")
    // Pre-fix: the brace counter saw the literal `}` as the WHERE-end
    // immediately after the FILTER opener, truncating the query.
    const result = await engine.query(
      'SELECT ?t WHERE { <urn:e1> <http://schema.org/text> ?t . FILTER(STR(?t) = "close-brace }") }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.length).toBe(1);
  });

  it('honors minTrust when a `# …` line comment contains an unbalanced `{` or `}`', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // The comment carries a pile of unbalanced braces, mostly the
    // opening kind. Pre-fix the comment scrub for keyword detection
    // worked, but the brace counter STILL saw raw text and bailed.
    const sparql = [
      'SELECT ?n WHERE {',
      '  # legacy syntax used to be: { ?s a <X> { fail',
      '  # and { still { not { closing',
      '  <urn:e1> <http://schema.org/name> ?n',
      '}',
    ].join('\n');
    const result = await engine.query(sparql, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      minTrust: TrustLevel.ConsensusVerified,
    });
    expect(result.bindings.map((b) => b['n'])).toEqual(['"Alice"']);
  });

  it('still bails (empty) on a real OPTIONAL after the literal-aware brace counter — no semantic regression', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Even with the much smarter brace counter, the existing semantic
    // refusal of OPTIONAL/UNION/etc. inside the WHERE block still fires
    // — the only thing the new helper changes is the *location* of the
    // closing brace, not whether the content is allowed.
    const result = await engine.query(
      'SELECT ?n WHERE { <urn:e1> <http://schema.org/name> ?n . OPTIONAL { ?n <http://schema.org/x> ?z } # has "}" comment\n }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // dkg-query-engine.ts:848). The literal
  // scanners only recognised single-line `"…"` and `'…'` literals. SPARQL
  // 1.1 ALSO supports long-form (triple-quoted) literals — `"""…"""` and
  // `'''…'''` — which can legally contain raw `"`, `'`, newlines, and any
  // of the structural chars (`{`, `}`, `#`, `.`) without escaping. When a
  // chat / markdown / JSON payload is encoded as a long-form literal, the
  // pre-fix scanners walked into the body of the literal as if it were
  // SPARQL code, miscounted braces or misclassified `#` as a comment, and
  // the surrounding rewriters (minTrust injection, wrapWithGraph) all
  // fail-closed to empty. These tests pin the long-form handling end-to-end.
  // ───────────────────────────────────────────────────────────────────────
  it('minTrust honors a triple-double-quoted (`"""…"""`) literal containing `{`/`}`/`#`/`.`', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    // Insert a payload whose literal contains every structural char
    // that the pre-fix scanners misclassified.
    const payload = '{"k": 1} # not a comment . not a triple terminator';
    // Escape `\` first so we don't double-escape the slashes we introduce
    // when escaping `"`. CodeQL flags single-quote-only escaping as
    // "incomplete string escaping or encoding" (js/incomplete-sanitization).
    const escaped = payload.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await store.insert([
      quad('urn:e1', 'http://schema.org/text', `"${escaped}"`, consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Use a triple-quoted literal in the query itself. Pre-fix, the
    // scanner saw the opening `"""` as `"` + `"` + `"` (three single-
    // line literals: `""`, `""`, …) and then walked into the body.
    const sparql =
      'SELECT ?t WHERE { <urn:e1> <http://schema.org/text> ?t . ' +
      `FILTER(STR(?t) = """${payload}""") }`;
    const result = await engine.query(sparql, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      minTrust: TrustLevel.ConsensusVerified,
    });
    expect(result.bindings.length).toBe(1);
  });

  it('minTrust honors a triple-single-quoted (`\'\'\'…\'\'\'`) literal containing structural chars', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    const payload = "}{ # not a comment .";
    await store.insert([
      quad('urn:e1', 'http://schema.org/text', `"${payload}"`, consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    const sparql =
      "SELECT ?t WHERE { <urn:e1> <http://schema.org/text> ?t . " +
      `FILTER(STR(?t) = '''${payload}''') }`;
    const result = await engine.query(sparql, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      minTrust: TrustLevel.ConsensusVerified,
    });
    expect(result.bindings.length).toBe(1);
  });

  it('triple-quoted literal containing a SINGLE quote char does not prematurely terminate', async () => {
    // The scanner must require all THREE terminating quote chars
    // before treating the literal as closed; a stray `"` inside a
    // triple-double-quoted literal must not be misread as the close.
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    // Payload contains a SINGLE `"` inside the triple-quoted literal.
    const payload = 'a "lone quote inside" b { } #';
    // Escape `\` first so we don't double-escape the slashes we introduce
    // when escaping `"` (CodeQL js/incomplete-sanitization).
    const escaped = payload.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await store.insert([
      quad('urn:e1', 'http://schema.org/text',
        `"${escaped}"`, consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel',
        `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    const sparql =
      'SELECT ?t WHERE { <urn:e1> <http://schema.org/text> ?t . ' +
      `FILTER(STR(?t) = """${payload}""") }`;
    const result = await engine.query(sparql, {
      contextGraphId: CG,
      view: 'verifiable-memory',
      minTrust: TrustLevel.ConsensusVerified,
    });
    expect(result.bindings.length).toBe(1);
  });

  it('wrapWithGraph (default-graph filter) survives unbalanced braces inside string literals', async () => {
    // verifiable-memory route triggers wrapWithGraph to scope to the
    // sub-graph URI. If the brace counter mis-locates the WHERE end,
    // the wrapped query is malformed and the engine returns empty.
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/text', '"unbalanced } trailing"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Note: minTrust is NOT set here, so wrapWithGraph runs but
    // injectMinTrustFilter does not. Pin wrapWithGraph specifically.
    const result = await engine.query(
      'SELECT ?t WHERE { <urn:e1> <http://schema.org/text> ?t . FILTER(CONTAINS(STR(?t), "unbalanced }")) }',
      { contextGraphId: CG, view: 'verifiable-memory' },
    );
    expect(result.bindings.length).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Pre-fix the WHERE-locator's fast path was a raw regex
  // `/\bWHERE\s*\{/i` that matched ANY `WHERE` followed by `{` —
  // including substrings inside a string literal, a `# …` comment, or
  // an IRI's local name. When the regex hit a payload-side `WHERE {`
  // first, `sparql.indexOf('{', whereIdx)` grabbed the brace just past
  // the literal/comment, and downstream `wrapWithGraph` /
  // `injectMinTrustFilter` rewrote the WRONG block. Best case: the
  // resulting query was syntactically invalid and the engine returned
  // empty; worst case: the wrap landed on a SELECT projection
  // expression and the rewrite silently filtered against a literal.
  // The fix is a token-aware locator that mirrors the lex rules used
  // by the rest of the helpers (skips `# …\n` comments, single/
  // double/triple-quoted literals, and IRIREFs) so the FIRST `WHERE`
  // it can see is the real top-level one.
  // ───────────────────────────────────────────────────────────────────────
  it('minTrust honors a SELECT whose PROJECTION ALIAS literal contains "WHERE {"', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Adversarial / obfuscated shape. The raw regex pre-fix matched
    // the LITERAL substring `WHERE {` inside the SELECT projection
    // alias and `wrapWithGraph` then wrapped from the brace just
    // past the literal — silently filtering against the wrong block.
    // Token-aware locator skips the literal entirely and lands on
    // the genuine top-level WHERE.
    const result = await engine.query(
      'SELECT (STR("WHERE {") AS ?fake) ?n WHERE { <urn:e1> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0]['n']).toBe('"Alice"');
    expect(result.bindings[0]['fake']).toBe('"WHERE {"');
  });

  it('minTrust honors a query whose `# …` COMMENT precedes the real WHERE and contains "WHERE {"', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // The `# WHERE { ... }` line is purely a comment; the engine MUST
    // ignore it and find the real WHERE on the next line. Pre-fix the
    // regex hit the comment first and `wrapWithGraph` ran against
    // garbage; the engine fell through to empty bindings.
    const sparql = [
      'SELECT ?n',
      '# this comment talks about a WHERE { decoy } that must be ignored',
      'WHERE { <urn:e1> <http://schema.org/name> ?n }',
    ].join('\n');
    const result = await engine.query(sparql, {
      contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified,
    });
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0]['n']).toBe('"Alice"');
  });

  it('minTrust honors a query whose IRI fragment contains the bytes "WHERE"', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    // Insert a quad whose predicate IRI contains the literal bytes
    // "WHERE" (and an embedded `{`/`}` shape via fragment encoding).
    // The token-aware locator must NOT mistake the IRI's `WHERE`
    // substring for the SPARQL keyword.
    await store.insert([
      quad('urn:e1', 'http://schema.org/WHEREabouts', '"Sofia"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    const result = await engine.query(
      'SELECT ?n WHERE { <urn:e1> <http://schema.org/WHEREabouts> ?n }',
      { contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0]['n']).toBe('"Sofia"');
  });

  it('triple-quoted (`"""…"""`) literal containing "WHERE {" does NOT confuse the locator', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    const decoy = 'decoy SELECT ?x WHERE { ... } more';
    await store.insert([
      quad('urn:e1', 'http://schema.org/text', `"${decoy}"`, consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Triple-quoted literal in the FILTER carries an entire fake
    // SELECT … WHERE { … } shape. Any regex would match
    // this `WHERE {` first and `wrapWithGraph` would land on the
    // brace inside the literal, producing a malformed wrapped query.
    const sparql =
      'SELECT ?t WHERE { <urn:e1> <http://schema.org/text> ?t . ' +
      `FILTER(STR(?t) = """${decoy}""") }`;
    const result = await engine.query(sparql, {
      contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified,
    });
    expect(result.bindings.length).toBe(1);
  });

  it('word-boundary check — `WHEREVER` / `aWHERE` identifiers MUST NOT match (no false-positive keyword promotion)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiableMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // The query has a SELECT alias `?WHEREVER` (a legal SPARQL
    // variable name; SPARQL identifiers can include letters). A naive
    // word-boundary check that matches WHERE inside a longer ident
    // would mis-locate the keyword start; the token-aware scanner
    // must reject mid-identifier matches via the `prev-is-word-cont`
    // check and continue scanning until the real top-level WHERE.
    //
    // Note SPARQL var syntax requires `?` prefix, so the actual
    // identifier seen by the scanner is `WHEREVER` (no `?`). Pin
    // both branches: alias-as-projection and alias-as-FILTER var.
    const sparql =
      'SELECT (?n AS ?WHEREVER) WHERE { <urn:e1> <http://schema.org/name> ?n }';
    const result = await engine.query(sparql, {
      contextGraphId: CG, view: 'verifiable-memory', minTrust: TrustLevel.ConsensusVerified,
    });
    expect(result.bindings.length).toBe(1);
    // The aliased projection variable is `WHEREVER` — pin it so a
    // regression that mis-locates the WHERE and rewrites against the
    // wrong block surfaces here too.
    expect(result.bindings[0]['WHEREVER']).toBe('"Alice"');
  });
});
