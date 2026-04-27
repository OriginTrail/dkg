/**
 * packages/query — extra QA coverage for spec-gap & prod-bug findings.
 *
 * Findings covered (see .test-audit/BUGS_FOUND.md):
 *
 *   Q-1  PROD-BUG  `QueryOptions.minTrust` on `verified-memory` view is a
 *                  *graph-scope* filter, not a per-triple filter. P-13
 *                  wired the graph-scope semantics end-to-end (drop root
 *                  when `minTrust > SelfAttested`), but the spec §14
 *                  trust-gradient guarantee also implies per-triple
 *                  filtering against `dkg:trustLevel` inside the
 *                  `/_verified_memory/*` sub-graphs. Test inserts mixed-
 *                  trust quads in a single sub-graph and asserts the
 *                  engine only returns HIGH-trust quads — the test
 *                  STAYS RED until Q-1 lands. P-13 (graph-scope) is
 *                  covered separately by publisher/test/views-min-trust-*.
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
  contextGraphVerifiedMemoryUri,
  contextGraphAssertionUri,
  contextGraphSharedMemoryUri,
  TrustLevel,
} from '@origintrail-official/dkg-core';
import { DKGQueryEngine, resolveViewGraphs } from '../src/dkg-query-engine.js';
import { QueryHandler } from '../src/query-handler.js';
import type { QueryAccessConfig } from '../src/query-types.js';

const CG = 'qa-extra-cg';

function quad(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

// ─────────────────────────────────────────────────────────────────────────────
// Q-1  per-triple minTrust filtering — PROD-BUG (stays RED until engine honours
//      `dkg:trustLevel` at the quad level inside /_verified_memory/*)
// ─────────────────────────────────────────────────────────────────────────────
describe('[Q-1] DKGQueryEngine minTrust is graph-scope only — PROD-BUG', () => {
  // P-13 closed the graph-scope half of minTrust (root is dropped when
  // minTrust > SelfAttested). Q-1 is the remaining per-triple half: if a
  // writer ever stamps mixed-trust quads into a single sub-graph, the
  // graph-scope filter cannot catch it. This test pins that gap.
  it('filters out sub-threshold trust quads WITHIN a verified-memory sub-graph (EXPECTED to fail until Q-1 is fixed)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    // All quads live in a single /_verified_memory/* sub-graph so graph-
    // scope filtering cannot distinguish them. Only a per-triple filter
    // can drop the low-trust quad.
    const mixedGraph = contextGraphVerifiedMemoryUri(CG, 'mixed-trust-sub-graph');
    const rootGraph = contextGraphDataUri(CG);

    await store.insert([
      quad('urn:low', 'http://schema.org/name', '"LowTrust"', mixedGraph),
      quad('urn:low', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.SelfAttested}"`, mixedGraph),
      quad('urn:high', 'http://schema.org/name', '"HighTrust"', mixedGraph),
      quad('urn:high', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, mixedGraph),
      // Root-level quad — P-13 graph-scope filter already excludes this.
      quad('urn:unknown', 'http://schema.org/name', '"UnknownTrust"', rootGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      {
        contextGraphId: CG,
        view: 'verified-memory',
        // Endorsed is the highest tier the engine currently accepts for
        // union queries (P-13 review: `PartiallyVerified` / `ConsensusVerified`
        // are rejected at the resolver until per-graph trust tagging lands
        // under Q-1). The gap below — per-triple filtering within a
        // /_verified_memory/* sub-graph — is orthogonal and still unmet.
        minTrust: TrustLevel.Endorsed,
      },
    );

    const names = result.bindings.map((b) => b['name']);
    // Spec §14: only triples at or above the requested trust tier should survive.
    // Today, per-triple filtering inside a sub-graph is not implemented —
    // this assertion fails and documents Q-1. P-13's graph-scope filter
    // alone returns both LowTrust and HighTrust from the mixed sub-graph.
    expect(names).toEqual(['"HighTrust"']);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bot review (PR #229 follow-up, dkg-query-engine.ts:534): concrete-
  // subject queries like `SELECT ?o WHERE { <entity> <p> ?o }` are the
  // most common SPARQL shape for exact lookups and MUST honor `_minTrust`
  // (not fail closed with an empty result). The fix attaches
  // `<entity> <trustLevel> ?t . FILTER(?t >= N)` to the rewritten WHERE.
  // ─────────────────────────────────────────────────────────────────────────
  it('honors _minTrust on CONCRETE-SUBJECT queries (exact-entity lookup)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:e1', 'http://schema.org/name', '"Alice"', consensusGraph),
      quad('urn:e1', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    // Exact-entity lookup MUST succeed when the entity meets the threshold.
    const ok = await engine.query(
      'SELECT ?n WHERE { <urn:e1> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(ok.bindings.map((b) => b['n'])).toEqual(['"Alice"']);
  });

  it('fails CLOSED on a concrete-subject lookup whose entity is BELOW the trust threshold', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const selfAttestedGraph = contextGraphVerifiedMemoryUri(CG, 'self-attested');
    await store.insert([
      quad('urn:low', 'http://schema.org/name', '"Bob"', selfAttestedGraph),
      quad('urn:low', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.SelfAttested}"`, selfAttestedGraph),
    ]);

    const result = await engine.query(
      'SELECT ?n WHERE { <urn:low> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    // Below threshold → empty (the trust filter eliminates the row).
    expect(result.bindings).toEqual([]);
  });

  it('fails CLOSED on a concrete-subject lookup whose entity has NO trust metadata at all', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const verifiedGraph = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:bare', 'http://schema.org/name', '"Ghost"', verifiedGraph),
      // deliberately NO trustLevel quad for <urn:bare>
    ]);
    const result = await engine.query(
      'SELECT ?n WHERE { <urn:bare> <http://schema.org/name> ?n }',
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings).toEqual([]);
  });

  // PR #229 bot review round 7 (dkg-query-engine.ts:513) — `rdf:type` style
  // IRIs contain a `#` fragment. The prior naive `replace(/#[^\n]*/g,'')`
  // would mangle the IRI into `<http://www.w3.org/1999/02/22-rdf-syntax-ns`
  // and fail-close every such query to `[]`. Lock the happy path so the
  // fragment is preserved and the trust filter is injected correctly.
  it('honors _minTrust when the BGP contains a fragment IRI (rdf:type, xsd, rdfs)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensusGraph = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:frag', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://schema.org/Person', consensusGraph),
      quad('urn:frag', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensusGraph),
    ]);

    const result = await engine.query(
      'SELECT ?t WHERE { <urn:frag> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?t }',
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['t'])).toEqual(['http://schema.org/Person']);
  });

  it('still strips real line comments containing a fake terminator (`# … .`)', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
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
      contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified,
    });
    expect(result.bindings.map((b) => b['n'])).toEqual(['"ok"']);
  });

  // PR #229 bot review round 8 (dkg-query-engine.ts:576): the naive
  // `/\.(?=\s|$)/` split fragmented any query whose literal contained
  // a sentence-terminating dot ("hello. world", an email address
  // ending a chat message, a float "3.14 " — anything where `.` was
  // followed by whitespace inside the string). The rewrite would
  // then bail out and `_minTrust` would fail-closed to `[]` for
  // every text/chat query. These two cases pin the fix.
  it('honors _minTrust when a triple-object literal contains a dot followed by whitespace ("hello. world")', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:msg', 'http://schema.org/text', '"hello. world"', consensus),
      quad('urn:msg', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
    ]);
    const result = await engine.query(
      'SELECT ?t WHERE { <urn:msg> <http://schema.org/text> ?t }',
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
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
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:m', 'http://schema.org/text', '"ack. ok"', consensus),
      quad('urn:m', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:m', 'http://schema.org/author', '"alice"', consensus),
    ]);
    const result = await engine.query(
      'SELECT ?a WHERE { <urn:m> <http://schema.org/text> "ack. ok" . <urn:m> <http://schema.org/author> ?a }',
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['a'])).toEqual(['"alice"']);
  });

  it('honors _minTrust on MIXED concrete + variable subjects in a single BGP', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:p', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:q', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:p', 'http://schema.org/relatedTo', 'urn:q', consensus),
      quad('urn:q', 'http://schema.org/name', '"q-name"', consensus),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { <urn:p> <http://schema.org/relatedTo> ?t . ?t <http://schema.org/name> ?name }',
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['name'])).toEqual(['"q-name"']);
  });

  // PR #229 bot review round 11 (dkg-query-engine.ts:654) — before this
  // round the `_minTrust` subject matcher only accepted variables,
  // `<iri>`, blank nodes, and literals. Standard SPARQL with a
  // `PREFIX ex: <urn:> ...` header and a prefixed-name subject
  // (`ex:item`) was classified as "unsupported shape" and fail-closed
  // to `[]` — even though the exact-entity trust filter is perfectly
  // enforceable. These tests pin the fix: the rewritten WHERE accepts
  // prefixed-name subjects and attaches the trust-level clause inline.
  it('honors _minTrust when the subject is a prefixed name (PNAME_LN) — bot review r11-3', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
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
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['n'])).toEqual(['"Alice"']);
  });

  it('filters out below-threshold results for prefixed-name subjects — bot review r11-3', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:low', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.Unverified}"`, consensus),
      quad('urn:low', 'http://example.org/name', '"Bob"', consensus),
    ]);
    // ex:low has Unverified < ConsensusVerified, so the rewrite MUST
    // filter it out — not silently drop `_minTrust` and return "Bob".
    const sparql = [
      'PREFIX ex: <urn:>',
      'PREFIX s: <http://example.org/>',
      'SELECT ?n WHERE { ex:low s:name ?n }',
    ].join('\n');
    const result = await engine.query(
      sparql,
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings).toEqual([]);
  });

  it('honors _minTrust on mixed prefixed + variable subjects (multi-triple BGP) — bot review r11-3', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
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
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['name'])).toEqual(['"q-name"']);
  });

  // PR #229 bot review round 23 (r23-2, dkg-query-engine.ts). The
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
  it('honors _minTrust on a leading VALUES ?s { … } clause — bot review r23-2', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
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
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    expect(result.bindings.map((b) => b['l'])).toEqual(['"A"', '"B"']);
  });

  it('filters VALUES-bound subjects that fall below _minTrust — bot review r23-2', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:hi', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.ConsensusVerified}"`, consensus),
      quad('urn:lo', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.Unverified}"`, consensus),
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
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    // `urn:lo` is Unverified — it must be filtered out, not silently
    // returned because the rewriter bailed on VALUES.
    expect(result.bindings.map((b) => b['l'])).toEqual(['"H"']);
  });

  // ─────────────────────────────────────────────────────────────────────
  // PR #229 bot review r3131942426 (dkg-query-engine.ts:754)
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
  it('honors _minTrust on a BGP whose top-level statements include a FILTER — bot review r3131942426', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
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
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
    );
    // Only doc2 has score > 10. Pre-fix this would have returned [] —
    // not because the data didn't match but because the rewriter
    // returned null and the caller fail-closed the entire query.
    expect(result.bindings.map((b) => b['s'])).toEqual(['urn:doc2']);
  });

  it('honors _minTrust on a BGP whose top-level statements include a BIND — bot review r3131942426', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
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
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
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
    const consensus = contextGraphVerifiedMemoryUri(CG, 'consensus-verified');
    await store.insert([
      quad('urn:lo', 'http://dkg.io/ontology/trustLevel', `"${TrustLevel.Unverified}"`, consensus),
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
      { contextGraphId: CG, view: 'verified-memory', _minTrust: TrustLevel.ConsensusVerified },
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
      `did:dkg:context-graph:${CG}/assertion/${AGENT}/`,
    ]);
  });

  it('DKGQueryEngine.query(view=working-memory) returns ONLY this agent\'s assertions and ignores other agents', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const OTHER_AGENT = '0xDeAd000000000000000000000000000000000002';

    const mine = contextGraphAssertionUri(CG, AGENT, 'todo');
    const mineOther = contextGraphAssertionUri(CG, AGENT, 'note');
    const theirs = contextGraphAssertionUri(CG, OTHER_AGENT, 'leak');

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

  it('verified-memory + verifiedGraph points at exactly one _verified_memory/<id> URI', () => {
    const res = resolveViewGraphs('verified-memory', CG, { verifiedGraph: 'quorum-7' });
    expect(res.graphs).toEqual([contextGraphVerifiedMemoryUri(CG, 'quorum-7')]);
    expect(res.graphPrefixes).toEqual([]);
  });

  it('verified-memory without verifiedGraph targets root + `_verified_memory/` prefix (§16.1)', () => {
    const res = resolveViewGraphs('verified-memory', CG, {});
    expect(res.graphs).toEqual([contextGraphDataUri(CG)]);
    expect(res.graphPrefixes).toEqual([`did:dkg:context-graph:${CG}/_verified_memory/`]);
  });

  it('shared-working-memory targets exactly the SWM graph (nothing else)', () => {
    const res = resolveViewGraphs('shared-working-memory', CG);
    expect(res.graphs).toEqual([contextGraphSharedMemoryUri(CG)]);
    expect(res.graphPrefixes).toEqual([]);
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
});
