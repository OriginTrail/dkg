// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { type OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';

import { RECIPIENT_KEY_ROUTE_PREDICATES } from '../src/internal/recipient-key-route-fence.js';
import {
  AGENT, CG_DID, CONTROL_GRAPH, JOIN_CACHE, KA_GRAPH, KA_UAL, KEY_IRI, MEMORY_LAYER, META_GRAPH, NAME,
  PROFILE_GRAPH, SWM_META_GRAPH, quad, stack,
} from './_helpers/recipient-fence-stack.js';

// ---------------------------------------------------------------------------
// Property: whatever a wrapper operation does to the key and route facts a
// resolution reads, the fence has moved. Oracle: the set of (graph, subject,
// predicate, object) rows with an agent DID subject and a key or route
// predicate, read straight from the store.
// ---------------------------------------------------------------------------

const GRAPHS = [PROFILE_GRAPH, JOIN_CACHE, META_GRAPH, SWM_META_GRAPH, CONTROL_GRAPH, KA_GRAPH, 'urn:dkg:graph:new1', 'urn:dkg:graph:new2'];
const SUBJECTS = [AGENT, AGENT.toLowerCase(), KEY_IRI, CG_DID, 'urn:dkg:share:s1', 'urn:dkg:promote-queue:job:j1', KA_UAL, 'urn:x:other'];
const PREDICATES = [...RECIPIENT_KEY_ROUTE_PREDICATES, NAME, MEMORY_LAYER, DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'];
const IRREGULAR = ['', `<${AGENT}`, `<${AGENT}>`, 'urn:x y', 'urn:x"y'];

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

const iri = (values: readonly string[]) => fc.constantFrom(...values);
const quadIn = (graph: fc.Arbitrary<string>, subject: fc.Arbitrary<string> = iri(SUBJECTS)) =>
  fc.record({ subject, predicate: iri(PREDICATES), object: fc.constantFrom('"a"', '"b"'), graph });

type Operation = (store: TripleStore) => Promise<unknown>;

const operation: fc.Arbitrary<Operation> = fc.oneof(
  fc.array(quadIn(iri(GRAPHS)), { minLength: 1, maxLength: 3 }).map((q): Operation => (s) => s.insert(q)),
  fc.array(quadIn(iri(GRAPHS)), { minLength: 1, maxLength: 3 }).map((q): Operation => (s) => s.delete(q)),
  fc.record({ graph: fc.option(iri([...GRAPHS, ...IRREGULAR]), { nil: undefined }), subject: fc.option(iri([...SUBJECTS, ...IRREGULAR]), { nil: undefined }), predicate: fc.option(iri([...PREDICATES, ...IRREGULAR]), { nil: undefined }) })
    .map((pattern): Operation => (s) => s.deleteByPattern(pattern)),
  fc.record({ graph: fc.option(iri([...GRAPHS, ...IRREGULAR]), { nil: undefined }), subject: fc.option(iri([...SUBJECTS, ...IRREGULAR]), { nil: undefined }), predicate: fc.option(iri([...PREDICATES, ...IRREGULAR]), { nil: undefined }) })
    .map((pattern): Operation => (s) => s.deleteByPatternWithoutCount!(pattern)),
  iri(GRAPHS).map((graph): Operation => (s) => s.dropGraph(graph)),
  fc.tuple(iri(GRAPHS)).chain(([graph]) => fc.array(quadIn(fc.constant(graph)), { maxLength: 3 }).map((q): Operation => (s) => s.replaceGraph!(graph, q))),
  fc.tuple(iri(GRAPHS), iri(SUBJECTS)).chain(([graph, subject]) =>
    fc.array(quadIn(fc.constant(graph), fc.constant(subject)), { maxLength: 3 }).map((q): Operation => (s) => s.replaceSubject!(graph, subject, q))),
  fc.tuple(iri(GRAPHS), iri(SUBJECTS), fc.array(quadIn(iri(GRAPHS)), { maxLength: 2 })).map(([graph, subject, graphQuads]): Operation =>
    (s) => s.replaceGraphAndSubject!(graph, graphQuads.map((q) => ({ ...q, graph })), META_GRAPH, subject, [quad(subject, NAME, META_GRAPH), quad(subject, DKG_ONTOLOGY.DKG_PEER_ID, META_GRAPH)])),
  fc.tuple(iri(GRAPHS), iri(['urn:', 'did:dkg:agent:', 'did:dkg:agent:0xAb', 'did:dkg:', 'urn:x:'])).map(([graph, prefix]): Operation => (s) => s.deleteBySubjectPrefix(graph, prefix)),
  fc.tuple(iri(GRAPHS), iri(SUBJECTS), iri(PREDICATES)).map(([graph, subject, predicate]): Operation =>
    (s) => s.update!(`INSERT DATA { GRAPH <${graph}> { <${subject}> <${predicate}> "u" } }`)),
  iri(GRAPHS).map((graph): Operation => (s) => s.query(`DELETE WHERE { GRAPH <${graph}> { ?s ?p ?o } }`)),
);

describe('recipient key/route fence is sound over random wrapper operations (GH#3067)', () => {
  it('moves whenever an operation changes a key or route fact, whatever the order and whether the graphs were scanned', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.array(operation, { minLength: 1, maxLength: 10 }), async (scanFirst, operations) => {
        const { wrapper, store, fence } = await stack();
        try {
          if (!scanFirst) await wrapper.update!('INSERT DATA { GRAPH <urn:dkg:graph:staler> { <urn:x:s> <urn:x:p> "o" } }');
          for (const run of operations) {
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
      fc.array(harmlessQuad, { minLength: 1, maxLength: 3 }).map((q): Operation => (s) => s.insert(q)),
      fc.array(harmlessQuad, { minLength: 1, maxLength: 3 }).map((q): Operation => (s) => s.delete(q)),
      fc.record({ graph: harmlessGraph, subject: harmlessSubject }).map((p): Operation => (s) => s.deleteByPatternWithoutCount!(p)),
      fc.record({ graph: harmlessGraph, predicate: harmlessPredicate }).map((p): Operation => (s) => s.deleteByPattern(p)),
      harmlessGraph.map((g): Operation => (s) => s.dropGraph(g)),
      harmlessGraph.chain((g) => fc.array(fc.record({ subject: harmlessSubject, predicate: harmlessPredicate, object: fc.constant('"a"'), graph: fc.constant(g) }), { maxLength: 3 })
        .map((q): Operation => (s) => s.replaceGraph!(g, q))),
      fc.tuple(harmlessGraph, harmlessSubject).map(([g, subject]): Operation =>
        (s) => s.replaceSubject!(g, subject, [{ subject, predicate: NAME, object: '"a"', graph: g }])),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(harmless, { minLength: 1, maxLength: 10 }), async (operations) => {
        const { wrapper, store, fence } = await stack();
        try {
          const before = fence.revision;
          for (const run of operations) {
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
