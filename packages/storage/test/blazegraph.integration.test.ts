/**
 * BlazegraphStore INTEGRATION tests — run against a REAL Blazegraph server.
 *
 * These are the no-mock regression tests for the large-publish bug: publishing
 * a bigger batch (~1,800 triples / ~200 KB) to a Blazegraph node used to fail
 * with HTTP 400 "Unable to parse form content". Root cause: the adapter sent
 * SPARQL updates/queries as URL-encoded form data (`update=…` / `query=…`),
 * which Jetty's form parser caps at `maxFormContentSize` (~200 KB on a stock
 * Blazegraph image). A publish issues a single large DELETE DATA over the full
 * quad set, so any operator on the default node-setup image hit the wall. The
 * fix switches the transport to a W3C SPARQL 1.1 direct POST
 * (`application/sparql-update` / `application/sparql-query`), which is not form
 * parsed and so has no size cap.
 *
 * The unit suite (`blazegraph.unit.test.ts`) asserts the wire format with a
 * mocked fetch; this suite proves the behaviour end-to-end against a live
 * server. It is gated on BLAZEGRAPH_TEST_URL so local `pnpm test` runs skip it
 * (no Docker required); CI provisions a Blazegraph service container and sets
 * the env var (see `.github/workflows/ci.yml`, job `tornado-blazegraph`).
 *
 * BLAZEGRAPH_TEST_URL example:
 *   http://127.0.0.1:9999/bigdata/namespace/kb/sparql
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { compileRfc64SemanticAuthorCommitV1 } from '../src/rfc64-semantic-author-commit-v1.js';
import type {
  Quad,
} from '../src/triple-store.js';
import type { Rfc64SemanticAuthorCommitInputV1 } from
  '../src/rfc64-semantic-author-commit-v1.js';
import {
  MemoryLayer,
  contextGraphLayerUri,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  projectCanonicalGraphScopedAuthorSealRowsV1,
  projectRfc64SemanticRecordStoreRowsV1,
  renderRfc64SemanticStoreRowV1,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
  type CanonicalGraphScopedAuthorSealV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type Rfc64SemanticRecordV1,
} from '@origintrail-official/dkg-core';

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_TEST_URL;

// A unique graph prefix per run so repeated runs against a persistent
// namespace never collide or see stale data.
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const GRAPH = `urn:bg-int:${RUN}:graph`;
const PRED = 'urn:bg-int:prop';

// ~120-char ASCII literal so each DELETE DATA line is ~300 bytes; well under
// the per-literal MUTF-8 cap (65 535 bytes) but big enough that the whole
// batch blows past Jetty's ~200 KB form-content limit.
const PADDING = 'x'.repeat(120);

function makeQuads(n: number): Quad[] {
  const quads: Quad[] = [];
  for (let i = 0; i < n; i++) {
    quads.push({
      subject: `urn:bg-int:${RUN}:subject-${i}`,
      predicate: PRED,
      object: `"value-${i}-${PADDING}"`,
      graph: GRAPH,
    });
  }
  return quads;
}

describe.skipIf(!BLAZEGRAPH_URL)('BlazegraphStore integration (live server)', () => {
  let store: BlazegraphStore;

  beforeAll(async () => {
    store = new BlazegraphStore(BLAZEGRAPH_URL as string);
    // Start from a clean graph in case the namespace persists across runs.
    await store.dropGraph(GRAPH);
  });

  afterAll(async () => {
    if (store) await store.dropGraph(GRAPH).catch(() => {});
  });

  it('runs live requests under the configured deadline and recovers after pre-dispatch cancellation', async () => {
    const deadlineStore = new BlazegraphStore(BLAZEGRAPH_URL as string, { timeout: 5_000 });
    const controller = new AbortController();
    const reason = new Error('cancel live probe');
    controller.abort(reason);

    await expect(
      deadlineStore.query('ASK { ?s ?p ?o }', { signal: controller.signal }),
    ).rejects.toBe(reason);

    const result = await deadlineStore.query('ASK { ?s ?p ?o }');
    expect(result.type).toBe('boolean');
    await deadlineStore.close();
  });

  it(
    'honours X-BIGDATA-MAX-QUERY-MILLIS on the supported live Blazegraph image',
    async () => {
      const GRAPH_DEADLINE = `${GRAPH}:deadline`;
      const quads = makeQuads(150).map((quad) => ({ ...quad, graph: GRAPH_DEADLINE }));
      await store.insert(quads);

      try {
        // ORDER BY forces Blazegraph to buffer the complete Cartesian result,
        // so it cannot finish or commit a successful response before the tiny
        // server deadline. This direct POST deliberately has no adapter/client
        // abort: it proves the external contract the adapter relies on rather
        // than merely proving that our mock observed a header.
        const expensiveQuery = `SELECT ?s1 ?s2 ?s3 WHERE {
          GRAPH <${GRAPH_DEADLINE}> {
            ?s1 <${PRED}> ?o1 .
            ?s2 <${PRED}> ?o2 .
            ?s3 <${PRED}> ?o3 .
          }
        } ORDER BY ?s1 ?s2 ?s3`;
        const startedAt = Date.now();
        const response = await fetch(BLAZEGRAPH_URL as string, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/sparql-query; charset=utf-8',
            Accept: 'application/sparql-results+json',
            'X-BIGDATA-MAX-QUERY-MILLIS': '25',
          },
          body: expensiveQuery,
          signal: AbortSignal.timeout(5_000),
        });
        const body = await response.text();

        expect(response.ok, body.slice(0, 500)).toBe(false);
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(body).toMatch(/(?:timeout|cancel|deadline|max query)/i);
      } finally {
        await store.dropGraph(GRAPH_DEADLINE).catch(() => {});
      }
    },
    15_000,
  );

  it(
    'large DELETE DATA (publish path) succeeds — the form-content-limit regression',
    async () => {
      // 2 000 quads → a single DELETE DATA body of ~600 KB raw. Form-encoded
      // (`update=` + URL-escaping) this is >1 MB, far past Jetty's ~200 KB
      // cap — the exact shape a large publish produces.
      const quads = makeQuads(2000);

      await store.insert(quads);
      expect(await store.countQuads(GRAPH)).toBe(quads.length);

      // Sanity-check the assumption: the DELETE DATA body really is large
      // enough that the old form-encoded transport would have been rejected.
      const deleteBodyBytes = quads
        .map((q) => `GRAPH <${q.graph}> { <${q.subject}> <${q.predicate}> ${q.object} . }`)
        .join('\n').length;
      expect(deleteBodyBytes).toBeGreaterThan(200_000);

      // This is the operation that used to throw HTTP 400 on Blazegraph.
      await expect(store.delete(quads)).resolves.toBeUndefined();
      expect(await store.countQuads(GRAPH)).toBe(0);
    },
    60_000,
  );

  it(
    'large SELECT query body succeeds — the query-path form-limit regression',
    async () => {
      const quads = makeQuads(3);
      await store.insert(quads);

      // Build a SELECT whose VALUES block alone exceeds ~200 KB so the old
      // form-encoded `query=` transport would have been rejected. Includes
      // the 3 real subjects plus thousands of decoys. A non-aggregate
      // projection (`SELECT ?s`) is used deliberately — Blazegraph evaluates
      // `VALUES + COUNT(*)` without GROUP BY as a per-binding aggregate, so we
      // count the returned rows instead.
      const realIris = quads.map((q) => `<${q.subject}>`);
      const decoyIris: string[] = [];
      for (let i = 0; i < 4000; i++) {
        decoyIris.push(`<urn:bg-int:${RUN}:decoy-${i}-${PADDING}>`);
      }
      const values = [...realIris, ...decoyIris].join('\n');
      const sparql = `SELECT ?s WHERE {
        VALUES ?s { ${values} }
        GRAPH <${GRAPH}> { ?s <${PRED}> ?o }
      }`;
      expect(sparql.length).toBeGreaterThan(200_000);

      const result = await store.query(sparql);
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        const matched = new Set(result.bindings.map((b) => b.s));
        expect(matched.size).toBe(quads.length);
        for (const q of quads) expect(matched.has(q.subject)).toBe(true);
      }

      await store.delete(quads);
    },
    60_000,
  );

  it(
    'round-trips non-ASCII literals byte-identical — BMP, astral (surrogate-pair), and \\U-escape inputs',
    async () => {
      // Regression for the devnet pr1386-term-canon "astral" hazard: Blazegraph's
      // N-Quads bulk-insert parser reads the body byte-wise as ASCII, so a raw
      // UTF-8 literal (2-byte é as much as a 4-byte emoji) used to be stored as
      // U+FFFD garbage — a published KA carrying it then failed storage-ACK
      // merkle verification and the publish died. The adapter now ships an
      // ASCII-safe body (\uXXXX per UTF-16 code unit, astral chars as their
      // surrogate pair), which this proves round-trips byte-identical live.
      const GRAPH_NA = `${GRAPH}:nonascii`;
      // 🚀 U+1F680 (astral emoji), 𝔘𝔫𝔦 U+1D518/U+1D52B/U+1D526 (math fraktur),
      // 𠜎 U+2070E (CJK Ext-B, 4-byte UTF-8) — plus BMP é and a lang tag.
      const astral = '"smile\u{1F680}\u{1D518}\u{1D52B}\u{1D526}\u{2070E}"';
      const bmp = '"café"';
      const langTagged = '"emoji\u{1F600}"@en';
      const quads: Quad[] = [
        { subject: `urn:bg-int:${RUN}:na-1`, predicate: PRED, object: astral, graph: GRAPH_NA },
        { subject: `urn:bg-int:${RUN}:na-2`, predicate: PRED, object: bmp, graph: GRAPH_NA },
        { subject: `urn:bg-int:${RUN}:na-3`, predicate: PRED, object: langTagged, graph: GRAPH_NA },
      ];
      await store.insert(quads);

      // SELECT read-back must be byte-identical to the inserted term (the
      // adapter emits raw UTF-8 with minimal \ " \n \r escaping, like oxigraph).
      const readBack = async (subject: string): Promise<string> => {
        const r = await store.query(
          `SELECT ?o WHERE { GRAPH <${GRAPH_NA}> { <${subject}> <${PRED}> ?o } }`,
        );
        expect(r.type).toBe('bindings');
        if (r.type !== 'bindings') throw new Error('unreachable');
        expect(r.bindings).toHaveLength(1);
        return r.bindings[0].o;
      };
      expect(await readBack(`urn:bg-int:${RUN}:na-1`)).toBe(astral);
      expect(await readBack(`urn:bg-int:${RUN}:na-2`)).toBe(bmp);
      expect(await readBack(`urn:bg-int:${RUN}:na-3`)).toBe(langTagged);

      // A term arriving with a verbatim \UXXXXXXXX escape (which Blazegraph's
      // parser used to truncate to the low 16 bits: U+1F600 → U+F600) must
      // land on the same stored VALUE as the raw character. The adapter
      // rewrites it to the surrogate-pair \uXXXX form Blazegraph parses
      // correctly, so read-back returns the raw astral char.
      const escapedInput = '"esc\\U0001F600ape"';
      await store.insert([
        { subject: `urn:bg-int:${RUN}:na-4`, predicate: PRED, object: escapedInput, graph: GRAPH_NA },
      ]);
      expect(await readBack(`urn:bg-int:${RUN}:na-4`)).toBe('"esc\u{1F600}ape"');

      // CONSTRUCT read-back: Blazegraph emits ASCII \u-escaped N-Quads
      // (surrogate pairs as two escapes); after decoding, the value must match.
      const c = await store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${GRAPH_NA}> { ?s ?p ?o } }`,
      );
      expect(c.type).toBe('quads');
      if (c.type === 'quads') {
        const bySubject = new Map(c.quads.map((q) => [q.subject, q.object]));
        const decodeUchar = (s: string) =>
          s.replace(/\\u([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
        expect(decodeUchar(bySubject.get(`urn:bg-int:${RUN}:na-1`) ?? '')).toBe(astral);
        expect(decodeUchar(bySubject.get(`urn:bg-int:${RUN}:na-3`) ?? '')).toBe(langTagged);
      }

      // DELETE with raw non-ASCII terms (SPARQL-update path, charset=utf-8)
      // must match the stored values — silent non-matches were the old
      // ISO-8859-1 failure mode.
      await store.delete([
        ...quads,
        { subject: `urn:bg-int:${RUN}:na-4`, predicate: PRED, object: '"esc\u{1F600}ape"', graph: GRAPH_NA },
      ]);
      expect(await store.countQuads(GRAPH_NA)).toBe(0);
      await store.dropGraph(GRAPH_NA).catch(() => {});
    },
    60_000,
  );

  it(
    'round-trips data through the live server (insert → query → delete)',
    async () => {
      const quads = makeQuads(50);
      await store.insert(quads);

      const r = await store.query(
        `SELECT ?o WHERE { GRAPH <${GRAPH}> { <urn:bg-int:${RUN}:subject-7> <${PRED}> ?o } }`,
      );
      expect(r.type).toBe('bindings');
      if (r.type === 'bindings') {
        expect(r.bindings).toHaveLength(1);
        expect(r.bindings[0].o).toContain('value-7-');
      }

      await store.delete(quads);
      expect(await store.countQuads(GRAPH)).toBe(0);
    },
    60_000,
  );

  it(
    'allows exactly one of two concurrently dispatched RFC-64 author commits',
    async () => {
      const projectionGraph = `${GRAPH}:rfc64:projection`;
      const sealGraph = `${GRAPH}:rfc64:seals`;
      const headGraph = `${GRAPH}:rfc64:heads`;
      const stateGraph = `${GRAPH}:rfc64:state`;
      const author = `urn:bg-int:${RUN}:rfc64:author`;
      const seal = `urn:bg-int:${RUN}:rfc64:seal`;
      const mutation = `urn:bg-int:${RUN}:rfc64:mutation`;
      const cgMutation = `urn:bg-int:${RUN}:rfc64:cg-mutation`;
      const appliedSet = `urn:bg-int:${RUN}:rfc64:applied-set`;
      const oldHead = `urn:bg-int:${RUN}:rfc64:head:old`;
      const newHead = `urn:bg-int:${RUN}:rfc64:head:new`;
      const pValue = 'urn:bg-int:rfc64:value';
      const pHead = 'urn:bg-int:rfc64:current-head';
      const pGeneration = 'urn:bg-int:rfc64:generation';
      const graphs = [projectionGraph, sealGraph, headGraph, stateGraph];
      const input = {
        sharedProjectionGraph: projectionGraph,
        sharedProjectionQuads: [
          { subject: `${author}:ka:1`, predicate: pValue, object: '"new-1"', graph: projectionGraph },
          { subject: `${author}:ka:2`, predicate: pValue, object: '"new-2"', graph: projectionGraph },
        ],
        authorSealGraph: sealGraph,
        authorSealSubject: seal,
        authorSealQuads: [
          { subject: seal, predicate: pValue, object: '"new-seal"', graph: sealGraph },
        ],
        currentHead: {
          graphUri: headGraph,
          subject: author,
          predicate: pHead,
          expectedObject: oldHead,
          expectedQuads: [{ subject: author, predicate: pHead, object: oldHead, graph: headGraph }],
          quads: [{ subject: author, predicate: pHead, object: newHead, graph: headGraph }],
        },
        subgraphMutationGeneration: {
          graphUri: stateGraph,
          subject: mutation,
          predicate: pGeneration,
          expectedObject: '"1"',
          expectedQuads: [{ subject: mutation, predicate: pGeneration, object: '"1"', graph: stateGraph }],
          quads: [{ subject: mutation, predicate: pGeneration, object: '"2"', graph: stateGraph }],
        },
        contextGraphMutationGeneration: {
          graphUri: stateGraph,
          subject: cgMutation,
          predicate: pGeneration,
          expectedObject: '"10"',
          expectedQuads: [{ subject: cgMutation, predicate: pGeneration, object: '"10"', graph: stateGraph }],
          quads: [{ subject: cgMutation, predicate: pGeneration, object: '"11"', graph: stateGraph }],
        },
        appliedSet: {
          graphUri: stateGraph,
          subject: appliedSet,
          predicate: pValue,
          expectedObject: oldHead,
          expectedQuads: [{ subject: appliedSet, predicate: pValue, object: oldHead, graph: stateGraph }],
          quads: [{ subject: appliedSet, predicate: pValue, object: newHead, graph: stateGraph }],
        },
      };

      try {
        await store.insert([
          { subject: `${author}:ka:old`, predicate: pValue, object: '"old"', graph: projectionGraph },
          { subject: seal, predicate: pValue, object: '"old-seal"', graph: sealGraph },
          { subject: author, predicate: pHead, object: oldHead, graph: headGraph },
          { subject: mutation, predicate: pGeneration, object: '"1"', graph: stateGraph },
          { subject: cgMutation, predicate: pGeneration, object: '"10"', graph: stateGraph },
          { subject: appliedSet, predicate: pValue, object: oldHead, graph: stateGraph },
        ]);

        const competingHead = `urn:bg-int:${RUN}:rfc64:head:competing`;
        const competing = {
          ...input,
          currentHead: {
            ...input.currentHead,
            quads: [{ subject: author, predicate: pHead, object: competingHead, graph: headGraph }],
          },
          sharedProjectionQuads: [
            { subject: `${author}:ka:competing`, predicate: pValue, object: '"competing"', graph: projectionGraph },
          ],
          authorSealQuads: [
            { subject: seal, predicate: pValue, object: '"competing-seal"', graph: sealGraph },
          ],
          subgraphMutationGeneration: {
            ...input.subgraphMutationGeneration,
            quads: [{ subject: mutation, predicate: pGeneration, object: '"3"', graph: stateGraph }],
          },
          contextGraphMutationGeneration: {
            ...input.contextGraphMutationGeneration,
            quads: [{ subject: cgMutation, predicate: pGeneration, object: '"12"', graph: stateGraph }],
          },
          appliedSet: {
            ...input.appliedSet,
            quads: [{ subject: appliedSet, predicate: pValue, object: competingHead, graph: stateGraph }],
          },
        };
        const results = await Promise.all([
          store.rfc64AuthorCommitCasV1(input),
          store.rfc64AuthorCommitCasV1(competing),
        ]);
        expect(results.sort()).toEqual(['committed', 'conflict']);
        const head = await store.query(
          `SELECT ?o WHERE { GRAPH <${headGraph}> { <${author}> <${pHead}> ?o } }`,
        );
        const winner = head.type === 'bindings' ? head.bindings[0]?.o : undefined;
        expect([newHead, competingHead]).toContain(winner);
        expect(await store.countQuads(projectionGraph)).toBe(winner === newHead ? 2 : 1);
        const control = await store.query(
          `SELECT ?seal ?subgraphGeneration ?contextGraphGeneration ?applied WHERE {
            GRAPH <${sealGraph}> { <${seal}> <${pValue}> ?seal }
            GRAPH <${stateGraph}> {
              <${mutation}> <${pGeneration}> ?subgraphGeneration .
              <${cgMutation}> <${pGeneration}> ?contextGraphGeneration .
              <${appliedSet}> <${pValue}> ?applied .
            }
          }`,
        );
        expect(control.type === 'bindings' ? control.bindings : []).toEqual([
          winner === newHead
            ? {
                seal: '"new-seal"',
                subgraphGeneration: '"2"',
                contextGraphGeneration: '"11"',
                applied: newHead,
              }
            : {
                seal: '"competing-seal"',
                subgraphGeneration: '"3"',
                contextGraphGeneration: '"12"',
                applied: competingHead,
              },
        ]);
      } finally {
        await Promise.all(graphs.map((graph) => store.dropGraph(graph).catch(() => {})));
      }
    },
    60_000,
  );

  it(
    'executes compiler-shaped semantic records and rejects a same-digest different-version predecessor',
    async () => {
      const fixture = semanticAuthorCommitFixture();
      const compiled = compileRfc64SemanticAuthorCommitV1(fixture.input);
      const graphs = [...compiled.referencedGraphs];
      try {
        await store.insert([
          ...semanticRows(fixture.unexpectedHead),
          ...fixture.expectedTail.flatMap(semanticRows),
        ]);
        await expect(store.rfc64AuthorCommitCasV1(compiled)).resolves.toBe('conflict');
        expect(await store.countQuads(fixture.projectionGraph)).toBe(0);
        expect(await store.countQuads(fixture.sealGraph)).toBe(0);

        await Promise.all(graphs.map((graph) => store.dropGraph(graph).catch(() => {})));
        await store.insert([
          ...semanticRows(fixture.expectedHead),
          ...fixture.expectedTail.flatMap(semanticRows),
        ]);
        await expect(store.rfc64AuthorCommitCasV1(compiled)).resolves.toBe('committed');
        expect(await store.countQuads(fixture.projectionGraph)).toBe(1);
        expect(await store.countQuads(fixture.sealGraph)).toBe(14);
      } finally {
        await Promise.all(graphs.map((graph) => store.dropGraph(graph).catch(() => {})));
      }
    },
    60_000,
  );
});

function semanticAuthorCommitFixture(): Readonly<{
  input: Rfc64SemanticAuthorCommitInputV1;
  expectedHead: Extract<Rfc64SemanticRecordV1, { recordType: 'CurrentAuthorCatalogRefV1' }>;
  unexpectedHead: Extract<Rfc64SemanticRecordV1, { recordType: 'CurrentAuthorCatalogRefV1' }>;
  expectedTail: readonly Rfc64SemanticRecordV1[];
  projectionGraph: string;
  sealGraph: string;
}> {
  const networkId = 'otp:20430' as NetworkIdV1;
  const contextGraphId = (
    '0x0123456789abcdef0123456789abcdef01234567/99'
  ) as ContextGraphIdV1;
  const author = '0x89abcdef0123456789abcdef0123456789abcdef' as EvmAddressV1;
  const digest = (value: string) => `0x${value.repeat(64)}` as Digest32V1;
  const projectionGraph = contextGraphLayerUri(
    contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    author,
    '7',
  );
  const coordinate = Object.freeze({
    contextGraphId,
    subGraphName: null,
    authorAddress: author,
    assertionCoordinate: 'blazegraph-semantic-fixture',
  }) as CanonicalGraphScopedAuthorSealCoordinateV1;
  const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1(coordinate);
  const seal = Object.freeze({
    assertedAtChainId: '20430',
    assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
    assertionFinalizedAt: '2026-08-29T10:00:00.123Z',
    assertionMerkleRoot: digest('e'),
    assertionVersion: '1',
    authorAddress: author,
    authorAttestationR: digest('1'),
    authorAttestationVS: digest('2'),
    authorSchemeVersion: '1',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${networkId}/${author}/7`,
    privateMerkleRoot: null,
    privateTripleCount: '0',
    publicTripleCount: '1',
    reservedKaId: ((BigInt(author) << 96n) | 7n).toString(),
  }) as CanonicalGraphScopedAuthorSealV1;
  const expectedHead = semanticRecord('CurrentAuthorCatalogRefV1', {
    networkId,
    contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: author,
    catalogEra: '1',
    catalogVersion: '4',
    catalogHeadDigest: digest('a'),
  });
  const nextHead = semanticRecord('CurrentAuthorCatalogRefV1', {
    ...expectedHead.value,
    catalogVersion: '5',
    catalogHeadDigest: digest('b'),
  });
  const unexpectedHead = semanticRecord('CurrentAuthorCatalogRefV1', {
    ...expectedHead.value,
    catalogVersion: '3',
  });
  const expectedSubgraph = semanticRecord('SubgraphMutationGuardV1', {
    networkId,
    contextGraphId,
    subGraphName: null,
    generation: '4',
  });
  const nextSubgraph = semanticRecord('SubgraphMutationGuardV1', {
    ...expectedSubgraph.value,
    generation: '5',
  });
  const expectedContextGraph = semanticRecord('ContextGraphMutationGuardV1', {
    networkId,
    contextGraphId,
    generation: '8',
  });
  const nextContextGraph = semanticRecord('ContextGraphMutationGuardV1', {
    ...expectedContextGraph.value,
    generation: '9',
  });
  const expectedApplied = semanticRecord('AppliedSubgraphSetRefV1', {
    networkId,
    contextGraphId,
    generation: '8',
    subgraphIndexEra: '1',
    subgraphIndexVersion: '3',
    subgraphCount: '1',
    appliedDirectoryRootDigest: digest('c'),
  });
  const nextApplied = semanticRecord('AppliedSubgraphSetRefV1', {
    ...expectedApplied.value,
    generation: '9',
    appliedDirectoryRootDigest: digest('d'),
  });
  return Object.freeze({
    input: Object.freeze({
      sharedProjectionGraph: projectionGraph,
      sharedProjectionQuads: Object.freeze([{
        subject: 'urn:test:blazegraph-semantic',
        predicate: 'urn:test:value',
        object: '"new"',
        graph: projectionGraph,
      }]),
      authorSealGraph: placement.metaGraph,
      authorSealSubject: placement.subject,
      authorSealQuads: projectCanonicalGraphScopedAuthorSealRowsV1(seal, coordinate),
      expectedCurrentHead: expectedHead,
      nextCurrentHead: nextHead,
      expectedSubgraphMutation: expectedSubgraph,
      nextSubgraphMutation: nextSubgraph,
      expectedContextGraphMutation: expectedContextGraph,
      nextContextGraphMutation: nextContextGraph,
      expectedAppliedSet: expectedApplied,
      nextAppliedSet: nextApplied,
    }),
    expectedHead,
    unexpectedHead,
    expectedTail: Object.freeze([
      expectedSubgraph,
      expectedContextGraph,
      expectedApplied,
    ]),
    projectionGraph,
    sealGraph: placement.metaGraph,
  });
}

function semanticRows(record: Rfc64SemanticRecordV1): Quad[] {
  return projectRfc64SemanticRecordStoreRowsV1(record)
    .map(renderRfc64SemanticStoreRowV1);
}

function semanticRecord<Type extends Rfc64SemanticRecordV1['recordType']>(
  recordType: Type,
  value: Extract<Rfc64SemanticRecordV1, { recordType: Type }>['value'],
): Extract<Rfc64SemanticRecordV1, { recordType: Type }> {
  return Object.freeze({ recordType, value: Object.freeze(value) }) as Extract<
    Rfc64SemanticRecordV1,
    { recordType: Type }
  >;
}
