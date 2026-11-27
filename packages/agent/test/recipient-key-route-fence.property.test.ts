// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphCatalogUri,
  contextGraphDataGraphUri,
} from '@origintrail-official/dkg-core';
import { type OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

import { RECIPIENT_KEY_ROUTE_PREDICATES } from '../src/internal/recipient-key-route-fence.js';
import {
  AGENT, CG_DID, CONTROL_GRAPH, JOIN_CACHE, KA_GRAPH, KA_UAL, KEY_IRI, MEMORY_LAYER, META_GRAPH, NAME,
  PROFILE_GRAPH, SWM_META_GRAPH, quad, stack,
} from './_helpers/recipient-fence-stack.js';

type Operation = (store: TripleStore) => Promise<unknown>;

interface Universe {
  readonly graphs: readonly string[];
  readonly subjects: readonly string[];
  readonly predicates: readonly string[];
  readonly irregular: readonly string[];
  readonly prefixes: readonly string[];
  /** The graph and quads of a replace of a graph together with a metadata subject. */
  readonly metaGraph: string;
}

const iri = (values: readonly string[]) => fc.constantFrom(...values);

/** Names an operation by its arguments, so that a counterexample reads as what it did. */
const named = (label: string, args: unknown, run: Operation): Operation =>
  Object.assign(run, { toString: () => `${label}(${JSON.stringify(args)})` });

/** Every operation the store wrapper can see, over the terms of one universe, including malformed ones. */
function operations(u: Universe): fc.Arbitrary<Operation> {
  const quadIn = (graph: fc.Arbitrary<string>, subject: fc.Arbitrary<string> = iri(u.subjects)): fc.Arbitrary<Quad> =>
    fc.record({ subject, predicate: iri(u.predicates), object: fc.constantFrom('"a"', '"b"'), graph });
  const pattern = fc.record({
    graph: fc.option(iri([...u.graphs, ...u.irregular]), { nil: undefined }),
    subject: fc.option(iri([...u.subjects, ...u.irregular]), { nil: undefined }),
    predicate: fc.option(iri([...u.predicates, ...u.irregular]), { nil: undefined }),
  });
  return fc.oneof(
    fc.array(quadIn(iri(u.graphs)), { minLength: 1, maxLength: 3 }).map((q): Operation => named('insert', q, (s) => s.insert(q))),
    fc.array(quadIn(iri(u.graphs)), { minLength: 1, maxLength: 3 }).map((q): Operation => named('delete', q, (s) => s.delete(q))),
    fc.array(quadIn(iri(u.graphs), fc.constant('_:b0')), { minLength: 1, maxLength: 2 }).map((q): Operation => named('deleteBlank', q, (s) => s.delete(q))),
    pattern.map((p): Operation => named('deleteByPattern', p, (s) => s.deleteByPattern(p))),
    pattern.map((p): Operation => named('deleteByPatternWithoutCount', p, (s) => s.deleteByPatternWithoutCount!(p))),
    iri(u.graphs).map((graph): Operation => named('dropGraph', graph, (s) => s.dropGraph(graph))),
    iri(u.graphs).chain((graph) => fc.array(quadIn(fc.constant(graph)), { maxLength: 3 })
      .map((q): Operation => named('replaceGraph', [graph, q], (s) => s.replaceGraph!(graph, q)))),
    fc.tuple(iri(u.graphs), iri(u.subjects)).chain(([graph, subject]) =>
      fc.array(quadIn(fc.constant(graph), fc.constant(subject)), { maxLength: 3 })
        .map((q): Operation => named('replaceSubject', [graph, subject, q], (s) => s.replaceSubject!(graph, subject, q)))),
    fc.tuple(iri(u.graphs), iri(u.subjects), fc.array(quadIn(iri(u.graphs)), { maxLength: 2 })).map(
      ([graph, subject, graphQuads]): Operation => named('replaceGraphAndSubject', [graph, subject, graphQuads], (s) => s.replaceGraphAndSubject!(
        graph,
        graphQuads.map((q) => ({ ...q, graph })),
        u.metaGraph,
        subject,
        [quad(subject, NAME, u.metaGraph), quad(subject, u.predicates[0]!, u.metaGraph)],
      )),
    ),
    fc.tuple(iri(u.graphs), iri(u.prefixes)).map(([graph, prefix]): Operation =>
      named('deleteBySubjectPrefix', [graph, prefix], (s) => s.deleteBySubjectPrefix(graph, prefix))),
    fc.tuple(iri(u.graphs), iri(u.subjects), iri(u.predicates)).map(([graph, subject, predicate]): Operation =>
      named('insertDataUpdate', [graph, subject, predicate], (s) =>
        s.update!(`INSERT DATA { GRAPH <${graph}> { <${subject}> <${predicate}> "u" } }`))),
    iri(u.graphs).map((graph): Operation =>
      named('deleteWhereQuery', graph, (s) => s.query(`DELETE WHERE { GRAPH <${graph}> { ?s ?p ?o } }`))),
  );
}

// ---------------------------------------------------------------------------
// Property: whatever a wrapper operation does to the key and route facts a
// resolution reads, the fence has moved. Oracle: the set of (graph, subject,
// predicate, object) rows with an agent DID subject and a key or route
// predicate, read straight from the store.
// ---------------------------------------------------------------------------

const KEY_UNIVERSE: Universe = {
  graphs: [PROFILE_GRAPH, JOIN_CACHE, META_GRAPH, SWM_META_GRAPH, CONTROL_GRAPH, KA_GRAPH, 'urn:dkg:graph:new1', 'urn:dkg:graph:new2'],
  subjects: [AGENT, AGENT.toLowerCase(), KEY_IRI, CG_DID, 'urn:dkg:share:s1', 'urn:dkg:promote-queue:job:j1', KA_UAL, 'urn:x:other'],
  predicates: [...RECIPIENT_KEY_ROUTE_PREDICATES, NAME, MEMORY_LAYER, DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'],
  irregular: ['', `<${AGENT}`, `<${AGENT}>`, 'urn:x y', 'urn:x"y'],
  prefixes: ['urn:', 'did:dkg:agent:', 'did:dkg:agent:0xAb', 'did:dkg:', 'urn:x:'],
  metaGraph: META_GRAPH,
};

const ORACLE = `SELECT ?g ?s ?p ?o WHERE {
  VALUES ?p { ${[...RECIPIENT_KEY_ROUTE_PREDICATES].map((p) => `<${p}>`).join(' ')} }
  GRAPH ?g { ?s ?p ?o }
  FILTER(STRSTARTS(STR(?s), "did:dkg:agent:"))
}`;

async function relevantFacts(store: OxigraphStore): Promise<string> {
  const result = await store.query(ORACLE);
  if (result.type !== 'bindings') throw new Error('oracle returned no bindings');
  return JSON.stringify(result.bindings.map((row) => [row['g'], row['s'], row['p'], row['o']].join(' ')).sort());
}

describe('recipient key/route fence is sound over random wrapper operations (GH#3067)', () => {
  it('moves whenever an operation changes a key or route fact, whatever the order and whether the graphs were scanned', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.array(operations(KEY_UNIVERSE), { minLength: 1, maxLength: 10 }), async (scanFirst, ops) => {
        const { wrapper, store, fence } = await stack();
        try {
          if (!scanFirst) await wrapper.update!('INSERT DATA { GRAPH <urn:dkg:graph:staler> { <urn:x:s> <urn:x:p> "o" } }');
          for (const run of ops) {
            const factsBefore = await relevantFacts(store);
            const revisionBefore = fence.revision;
            try { await run(wrapper); } catch { /* a refused or failed operation may have changed nothing, or something */ }
            const factsAfter = await relevantFacts(store);
            if (factsAfter !== factsBefore && fence.revision === revisionBefore) {
              throw new Error(`fence did not move although key facts changed\nbefore: ${factsBefore}\nafter: ${factsAfter}`);
            }
          }
        } finally {
          await store.close();
        }
      }),
      { numRuns: 150 },
    );
  }, 120_000);

  it('does not move for operations built only from harmless graphs, subjects, predicates and payloads', async () => {
    const harmlessGraph = iri([META_GRAPH, SWM_META_GRAPH, CONTROL_GRAPH, KA_GRAPH, 'urn:dkg:graph:new1']);
    const harmlessSubject = iri(['urn:dkg:share:s1', 'urn:dkg:promote-queue:job:j1', KA_UAL, 'urn:x:other', CG_DID]);
    const harmlessPredicate = iri([NAME, MEMORY_LAYER, DKG_ONTOLOGY.DKG_ACCESS_POLICY]);
    const harmlessQuad = fc.record({ subject: harmlessSubject, predicate: harmlessPredicate, object: fc.constant('"a"'), graph: harmlessGraph });
    const harmless: fc.Arbitrary<Operation> = fc.oneof(
      fc.array(harmlessQuad, { minLength: 1, maxLength: 3 }).map((q): Operation => named('insert', q, (s) => s.insert(q))),
      fc.array(harmlessQuad, { minLength: 1, maxLength: 3 }).map((q): Operation => named('delete', q, (s) => s.delete(q))),
      fc.record({ graph: harmlessGraph, subject: harmlessSubject }).map((p): Operation =>
        named('deleteByPatternWithoutCount', p, (s) => s.deleteByPatternWithoutCount!(p))),
      fc.record({ graph: harmlessGraph, predicate: harmlessPredicate }).map((p): Operation =>
        named('deleteByPattern', p, (s) => s.deleteByPattern(p))),
      harmlessGraph.map((g): Operation => named('dropGraph', g, (s) => s.dropGraph(g))),
      harmlessGraph.chain((g) => fc.array(fc.record({ subject: harmlessSubject, predicate: harmlessPredicate, object: fc.constant('"a"'), graph: fc.constant(g) }), { maxLength: 3 })
        .map((q): Operation => named('replaceGraph', [g, q], (s) => s.replaceGraph!(g, q)))),
      fc.tuple(harmlessGraph, harmlessSubject).map(([g, subject]): Operation =>
        named('replaceSubject', [g, subject], (s) => s.replaceSubject!(g, subject, [{ subject, predicate: NAME, object: '"a"', graph: g }]))),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(harmless, { minLength: 1, maxLength: 10 }), async (ops) => {
        const { wrapper, store, fence } = await stack();
        try {
          const before = fence.revision;
          for (const run of ops) {
            try { await run(wrapper); } catch { /* ignore */ }
          }
          expect(fence.revision).toBe(before);
        } finally {
          await store.close();
        }
      }),
      { numRuns: 100 },
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Property: whatever a wrapper operation does to the peer allowlist a context
// graph's projection builds, its peer gate revision has moved. Oracle: the
// allowlist the projection rebuilds from the store before and after.
// ---------------------------------------------------------------------------

const GATE_CG = '0xabc/proj';
const GATE_UNIVERSE: Universe = {
  graphs: [
    META_GRAPH, contextGraphCatalogUri(GATE_CG), contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS),
    contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY), SWM_META_GRAPH, KA_GRAPH, CONTROL_GRAPH,
  ],
  subjects: [CG_DID, `${CG_DID}/sub`, `did:dkg:agent-delegation:${GATE_CG}:d1`, KA_UAL, AGENT, 'urn:x:other', 'urn:dkg:assertion:a1'],
  predicates: [DKG_ONTOLOGY.DKG_ALLOWED_PEER, DKG_ONTOLOGY.DKG_ACCESS_POLICY, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, MEMORY_LAYER, NAME, DKG_ONTOLOGY.DKG_PEER_ID],
  irregular: ['', `<${CG_DID}`, 'urn:x y', 'relative-name'],
  prefixes: ['urn:', 'did:dkg:', 'did:dkg:context-graph:', 'did:dkg:agent-delegation:'],
  metaGraph: META_GRAPH,
};

describe('peer gate revision is sound over random wrapper operations (GH#3067)', () => {
  it('moves whenever an operation changes the allowlist the projection builds', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(operations(GATE_UNIVERSE), { minLength: 1, maxLength: 10 }), async (ops) => {
        const { wrapper, store, projection } = await stack();
        const allowlist = async (): Promise<string> => {
          projection.requireFreshRead(GATE_CG);
          return JSON.stringify([...(await projection.get(GATE_CG)).allowedPeers].sort());
        };
        try {
          await wrapper.insert([
            quad(CG_DID, DKG_ONTOLOGY.DKG_ALLOWED_PEER, META_GRAPH),
            { ...quad(CG_DID, DKG_ONTOLOGY.DKG_ALLOWED_PEER, META_GRAPH), object: '"peer-b"' },
          ]);
          for (const run of ops) {
            const before = await allowlist();
            const revisionBefore = projection.peerGateRevision.read(GATE_CG);
            try { await run(wrapper); } catch { /* a refused or failed operation may have changed nothing, or something */ }
            const after = await allowlist();
            if (after !== before && projection.peerGateRevision.read(GATE_CG) === revisionBefore) {
              throw new Error(`peer gate revision did not move although the allowlist changed\nbefore: ${before}\nafter: ${after}`);
            }
          }
        } finally {
          await store.close();
        }
      }),
      { numRuns: 150 },
    );
  }, 120_000);
});
