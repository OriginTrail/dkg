// The fixture namespace of the async queue contention benchmark and the per-share store-operation replay table.
// The replay stands in for the real promote body: the 43 data-plane operations of ONE bound async share (measured on the 0.5-0.8 harness:
// 5 draft reads, 2 seal CONSTRUCTs, 1 policy read, the 31 operations inside assertionPromote, 2 pointer operations and 2 gossip reads) are issued against the
// main store with the same kinds and payload sizes. The 19 queue operations around them are NOT replayed: the real queue and worker supervisor make those.
// Not modelled: the preflight's O(catalog) list leg, the readiness wait and the chain rescue (the route's preflight here is the real probe on a one-graph catalog).

export const CG_ID = 'aqc-bench-cg';
export const AGENT = '0x1234567890abcdef1234567890abcdef12345678';
export const NS_GRAPHS = 370; // "about 370 graphs" of the CG-wide aggregate; the graph count drives the listGraphs cost of the preflight
export const WM_POOL = 256;
export const PAYLOAD_TRIPLES = 128;
export const AGG_ROWS = 8;

const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CG_URI = `did:dkg:context-graph:${CG_ID}`;
export const vmGraph = (k) => `${CG_URI}/_verified_memory/vm${k}`;
export const wmPoolGraph = (i) => `${CG_URI}/_working_memory/${AGENT}/pool${i}`;
export const swmGraph = (key) => `${CG_URI}/_shared_memory/${AGENT}/${key}`;
export const snapGraph = (key) => `${CG_URI}/_shared_memory_snapshots/_/${key}/ka`;
export const metaGraph = () => `${CG_URI}/_meta`;
export const swmMetaGraph = () => `${CG_URI}/_shared_memory_meta`;
export const assetOf = (jn) => `urn:dkg:assertion:${CG_ID}:${AGENT}:asset-${jn % 16}`;
export const entityOf = (k, j) => `urn:aqc:e:${k}:${j}`;

const q = (graph, subject, predicate, object) => ({ graph, subject, predicate, object });
const lit = (s) => JSON.stringify(String(s));

/** Context graph declaration, NS_GRAPHS verified-memory graphs, the working-memory pool and the lifecycle subjects the replayed share reads. */
export async function seedMainNamespace(store, core) {
  const { DKG_ONTOLOGY: D, SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri, contextGraphMetaGraphUri } = core;
  const ontology = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  const insert = async (quads) => { for (let i = 0; i < quads.length; i += 8000) await store.insert(quads.slice(i, i + 8000), { source: 'bench.seed' }); };
  await insert([
    q(ontology, CG_URI, D.RDF_TYPE, D.DKG_CONTEXT_GRAPH), q(ontology, CG_URI, D.DKG_ACCESS_POLICY, lit('public')),
    q(contextGraphMetaGraphUri(CG_ID), contextGraphDataGraphUri(CG_ID), D.DKG_ACCESS_POLICY, lit('public')),
  ]);
  const vm = [];
  for (let k = 0; k < NS_GRAPHS; k++) {
    for (let j = 0; j < AGG_ROWS; j++) {
      const s = entityOf(k, j), g = vmGraph(k);
      vm.push(q(g, s, 'http://schema.org/name', lit(`entity-${k}-${j}`)), q(g, s, 'http://schema.org/value', lit(`v${k}-${j}`)), q(g, s, RDF_TYPE, 'urn:aqc:Thing'), q(g, s, 'urn:aqc:ref', entityOf((k + 1) % NS_GRAPHS, j)));
    }
  }
  await insert(vm);
  const wm = [];
  for (let i = 0; i < WM_POOL; i++) for (let t = 0; t < PAYLOAD_TRIPLES; t++) wm.push(q(wmPoolGraph(i), `urn:aqc:wm:${i}:${t}`, 'http://schema.org/name', lit(`Entity ${i}-${t}`)));
  await insert(wm);
  await insert(Array.from({ length: 16 }, (_, i) => q(metaGraph(), `urn:dkg:assertion:${CG_ID}:${AGENT}:asset-${i}`, `${DKG}state`, lit('finalized'))));
  return { vmQuads: vm.length, wmQuads: wm.length };
}

/**
 * The replay table. Row = [source, 'r' | 'w', (store, c, options) => promise]; c = { jn, key, a (asset), privG, wmG } of one share.
 * deleteByPattern is storage's deleteByPatternWithoutCount (the product's way of deleting without counting).
 */
export function replayOps(deleteByPattern) {
  const sel = (source, text) => [source, 'r', (s, c, o) => s.query(text(c), o)];
  const del = (source, spec) => [source, 'w', (s, c, o) => deleteByPattern(s, spec(c), o)];
  const ins = (source, quads) => [source, 'w', (s, c, o) => s.insert(quads(c), o)];
  const payload = (graph, c) => Array.from({ length: PAYLOAD_TRIPLES }, (_, t) => q(graph, `urn:aqc:job:${c.jn}:${t}`, 'http://schema.org/name', lit(`Entity ${c.jn}-${t}`)));
  const seal = (tag) => sel(`sealEvidence.${tag}`, (c) => `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${metaGraph()}> { VALUES ?s { <${c.a}> } ?s ?p ?o } }`); // sparql-scan-allow: R4 -- fixture meta graph holds 16 subjects, bound by VALUES
  return {
    draft: [
      sel('draft.lifecycle', (c) => `SELECT ?state WHERE { GRAPH <${metaGraph()}> { <${c.a}> <${DKG}state> ?state } }`),
      sel('draft.private', (c) => `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${c.privG}> { ?s ?p ?o } }`),
      ['draft.listGraphs', 'r', (s, c, o) => s.listGraphs(o)],
      ['draft.hasGraph', 'r', (s, c, o) => s.hasGraph(c.wmG, o)],
      sel('draft.wmConstruct', (c) => `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${c.wmG}> { ?s ?p ?o } }`),
    ],
    sealPrepare: seal('prepare'),
    sealAdmit: seal('admit'),
    policy: sel('policy', (c) => `SELECT ?v WHERE { GRAPH <${metaGraph()}> { <${c.a}> <${DKG}accessPolicy> ?v } }`),
    body: [ // the 31 operations of publisher.assertionPromote, in the measured order
      seal('promote'),
      sel('scope', (c) => `SELECT ?scope WHERE { GRAPH <${metaGraph()}> { <${c.a}> <${DKG}state> ?scope } }`),
      sel('privCount1', (c) => `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${c.privG}> { ?s ?p ?o } }`),
      sel('privSelect', (c) => `SELECT ?s ?p ?o WHERE { GRAPH <${c.privG}> { ?s ?p ?o } } LIMIT 256`),
      sel('privCount2', (c) => `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${c.privG}> { ?s ?p ?o } }`),
      ['promote.listGraphs1', 'r', (s, c, o) => s.listGraphs(o)],
      ['promote.hasGraph', 'r', (s, c, o) => s.hasGraph(c.wmG, o)],
      sel('wmConstruct', (c) => `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${c.wmG}> { ?s ?p ?o } }`),
      sel('askShareComplete', (c) => `ASK { GRAPH <${metaGraph()}> { <${c.a}> <${DKG}swmShareComplete> ?v } }`),
      del('markerDelete', (c) => ({ graph: metaGraph(), subject: c.a, predicate: `${DKG}swmShareComplete` })),
      ins('opIntentInsert', (c) => [q(metaGraph(), c.a, `${DKG}shareOperationId`, lit(c.key)), q(metaGraph(), c.a, `${DKG}promoteOperationIntent`, lit('{"v":1}'))]),
      sel('readOpId', (c) => `SELECT ?id WHERE { GRAPH <${metaGraph()}> { <${c.a}> <${DKG}shareOperationId> ?id } }`),
      sel('readIntent', (c) => `SELECT ?intent WHERE { GRAPH <${metaGraph()}> { <${c.a}> <${DKG}promoteOperationIntent> ?intent } }`),
      ['swmReplaceGraph', 'w', (s, c, o) => s.replaceGraph(swmGraph(c.key), payload(swmGraph(c.key), c), o)], // payload write 1
      del('witnessInvalidate', (c) => ({ graph: 'urn:dkg:local:swm-materialization-witness', subject: swmGraph(c.key) })),
      del('lifecycleLayerDelete', (c) => ({ graph: metaGraph(), subject: c.wmG, predicate: `${DKG}memoryLayer` })),
      ins('lifecycleLayerInsert', (c) => [q(metaGraph(), c.wmG, `${DKG}memoryLayer`, lit('SWM'))]),
      del('rootEntityDelete', (c) => ({ graph: metaGraph(), subject: c.a, predicate: `${DKG}rootEntity` })),
      del('entityDelete', (c) => ({ graph: metaGraph(), subject: c.a, predicate: `${DKG}entity` })),
      ['lifecycleStateDelete', 'w', (s, c, o) => s.delete([q(metaGraph(), c.a, `${DKG}state`, lit('finalized')), q(metaGraph(), c.a, `${DKG}memoryLayer`, lit('WM')), q(metaGraph(), c.a, `${DKG}assertionGraph`, c.wmG)], o)],
      ins('provenanceInsert', (c) => ['state', 'memoryLayer', 'assertionGraph', 'shareOperationId', 'type', 'startedAtTime', 'p7', 'p8', 'p9'].map((p, i) => q(metaGraph(), c.a, `${DKG}${p}`, lit(`v${i}-${c.key}`)))),
      ['snapshotDrop', 'w', (s, c, o) => s.dropGraph(snapGraph(c.key), o)],
      ['snapshotInsert', 'w', (s, c, o) => s.insert(payload(snapGraph(c.key), c), o)], // payload write 2
      del('shareMetaDelete', (c) => ({ graph: swmMetaGraph(), subject: `urn:dkg:share:${CG_ID}:${c.key}` })),
      ins('shareMetaInsert', (c) => Array.from({ length: 14 }, (_, i) => q(swmMetaGraph(), `urn:dkg:share:${CG_ID}:${c.key}`, `${DKG}p${i}`, lit(`v${i}`)))),
      del('headDelete', (c) => ({ graph: swmMetaGraph(), subject: `urn:dkg:head:${CG_ID}:${c.key}` })),
      ins('headInsert', (c) => Array.from({ length: 5 }, (_, i) => q(swmMetaGraph(), `urn:dkg:head:${CG_ID}:${c.key}`, `${DKG}h${i}`, lit(`v${i}`)))),
      ['promote.listGraphs2', 'r', (s, c, o) => s.listGraphs(o)],
      ['wmDrop', 'w', (s, c, o) => s.dropGraph(wmPoolGraph(WM_POOL + c.jn), o)],
      del('wmMetaDelete', (c) => ({ graph: metaGraph(), subject: c.a, predicate: `${DKG}swmShareComplete` })),
      ins('shareCompleteInsert', (c) => [q(metaGraph(), c.a, `${DKG}swmShareComplete`, lit(c.key))]),
    ],
    tail: [ // agent-level pointer stamp and gossip planning
      sel('pointer.construct', (c) => `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${metaGraph()}> { <${c.a}> ?p ?o . BIND(<${c.a}> AS ?s) } } LIMIT 64`),
      del('pointer.delete', (c) => ({ graph: metaGraph(), subject: `${c.a}#pointer` })),
      sel('gossip.isPrivate', (c) => `ASK { GRAPH <${metaGraph()}> { <${c.a}> <${DKG}accessPolicy> "private" } }`),
      sel('gossip.allowedPeers', (c) => `SELECT ?p WHERE { GRAPH <${metaGraph()}> { <${c.a}> <${DKG}allowedPeer> ?p } }`),
    ],
  };
}
