#!/usr/bin/env node
// Times the read-graph statements on one engine: at two view sizes, and for one
// triple held by many graphs. Build dkg-core and dkg-storage first.
//
//   ENGINE=oxigraph node scripts/read-graph-statements-benchmark.mjs
//   ENGINE=oxigraph-server OXIGRAPH_SERVER_URL=http://127.0.0.1:<port> node scripts/read-graph-statements-benchmark.mjs
//   ENGINE=blazegraph BLAZEGRAPH_TEST_URL=http://127.0.0.1:<port>/bigdata/namespace/kb/sparql \
//     node scripts/read-graph-statements-benchmark.mjs
//
// `oxigraph` runs in process. `oxigraph-server` and Blazegraph must be owned
// loopback test servers. The script refuses an oxigraph-server that holds any
// data before it writes, and empties it again at the end; for Blazegraph it
// creates a scratch namespace and removes it. SIZES, COPIES and RUNS override
// the defaults.
// Prints one line per measurement, then JSON.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { ADAPTER_SPARQL_TERM_POLICY } from '../dist/adapters/sparql-term-policy.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../dist/blazegraph-namespace-manager.js';
import { readGraphMembership, workingMemoryIdentityRule } from '../dist/read-graph/membership.js';
import { CURRENT_READ_GRAPH_VERSIONS, nextReadGraphState, readGraphStateCompareAndSet } from '../dist/read-graph/state.js';
import * as statements from '../dist/read-graph/statements.js';

const ENGINE = process.env.ENGINE ?? 'oxigraph';
const SIZES = (process.env.SIZES ?? '2000,20000').split(',').map(Number);
const COPIES = (process.env.COPIES ?? '100,1000,10000').split(',').map(Number);
const RUNS = Number(process.env.RUNS ?? 5);
const TRIPLES_PER_GRAPH = 20;
const CG = '0xabc/proj';
const ROOT = `did:dkg:context-graph:${CG}`;
const AUTHOR = `0x${'a'.repeat(40)}`;
const member = (i) => `${ROOT}/_verifiable_memory/${AUTHOR}/${i}`;
const identity = workingMemoryIdentityRule({});
const key = { scope: readScope(CG), layer: MemoryLayer.VerifiableMemory };
const R = readGraphIri(key);
// A registry with sub-graphs and a child, so the membership test has the shape of a real one.
const registry = { contextGraphId: CG, subGraphNames: ['code', 'docs'], childContextGraphRoots: [`${ROOT}/kid`] };
const target = { readGraph: R, membership: readGraphMembership(key, registry, identity) };
const render = ADAPTER_SPARQL_TERM_POLICY.renderer({ adapter: ENGINE === 'blazegraph' ? 'blazegraph' : 'oxigraph', operation: 'delete' }, () => {});
const results = [];

async function openEngine() {
  if (ENGINE === 'oxigraph') {
    const require = createRequire(import.meta.url);
    const oxigraph = require('oxigraph');
    const store = new oxigraph.Store();
    const rows = (result) => result.map((row) => Object.fromEntries([...row].map(([name, term]) => [name, term.value])));
    return {
      name: `oxigraph ${require('oxigraph/package.json').version} (in process)`,
      load: async (nquads) => store.load(nquads, { format: 'application/n-quads' }),
      update: async (sparql) => store.update(sparql),
      select: async (sparql) => rows(store.query(sparql)),
      ask: async (sparql) => store.query(sparql),
      close: async () => {},
    };
  }
  if (ENGINE === 'oxigraph-server') return openOxigraphServer();
  const endpoint = new URL(process.env.BLAZEGRAPH_TEST_URL ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('This benchmark creates data: use an owned loopback test server.');
  }
  const manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint.href) });
  const handles = await manager.acquireMany([`read-graph-bench-${randomUUID()}`]);
  const url = handles[0].sparqlUrl;
  const post = async (body, type, accept) => {
    const response = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': type, ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(600_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text;
  };
  const query = async (sparql) => JSON.parse(await post(sparql, 'application/sparql-query; charset=utf-8', 'application/sparql-results+json'));
  return {
    name: 'blazegraph (local server)',
    load: (nquads) => post(nquads, 'text/x-nquads; charset=utf-8'),
    update: (sparql) => post(sparql, 'application/sparql-update; charset=utf-8'),
    select: async (sparql) => (await query(sparql)).results.bindings.map((row) => Object.fromEntries(Object.entries(row).map(([name, term]) => [name, term.value]))),
    ask: async (sparql) => (await query(sparql)).boolean,
    close: () => manager.disposeAll(handles),
  };
}

async function openOxigraphServer() {
  const base = new URL(process.env.OXIGRAPH_SERVER_URL ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('This benchmark creates data: use an owned loopback test server.');
  }
  const post = async (path, body, type, accept) => {
    const response = await fetch(new URL(path, base), { method: 'POST', body, headers: { 'Content-Type': type, ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(600_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text;
  };
  const query = async (sparql) => JSON.parse(await post('/query', sparql, 'application/sparql-query', 'application/sparql-results+json'));
  // The cleanup empties the whole server, so refuse one that holds data before writing anything.
  // sparql-scan-allow: R2 -- ASK stops at the first quad: it only checks that the scratch server is empty
  const holdsData = (await query('ASK { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }')).boolean;
  if (holdsData !== false) {
    throw new Error('This benchmark needs an empty oxigraph-server: this one holds data, and the cleanup would remove it.');
  }
  const version = (await (await fetch(new URL('/', base))).text()).match(/oxigraph[^<\s]*\s*v?([0-9.]+)/i)?.[1];
  return {
    name: `oxigraph-server${version ? ` ${version}` : ''} (local server)`,
    load: (nquads) => post('/store', nquads, 'application/n-quads'),
    update: (sparql) => post('/update', sparql, 'application/sparql-update'),
    select: async (sparql) => (await query(sparql)).results.bindings.map((row) => Object.fromEntries(Object.entries(row).map(([name, term]) => [name, term.value]))),
    ask: async (sparql) => (await query(sparql)).boolean,
    close: () => post('/update', 'DROP ALL', 'application/sparql-update'),
  };
}

async function time(engine, label, size, work, runs = RUNS) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    await work(i);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const result = { engine: engine.name, label, size, medianMs: round(samples[Math.floor(samples.length / 2)]), maxMs: round(samples.at(-1)), runs };
  results.push(result);
  console.log(`${String(size).padStart(6)}  ${label.padEnd(64)} median ${String(result.medianMs).padStart(9)} ms  max ${String(result.maxMs).padStart(9)} ms`);
  return result;
}

const round = (ms) => Math.round(ms * 100) / 100;
const count = async (engine, sparql) => Number((await engine.select(sparql))[0].n);
const tripleOf = (i, t) => (t % 5 === 0
  ? `<urn:s:shared:${Math.floor(i / 2)}> <urn:p:${t % 7}> <urn:o:shared:${Math.floor(i / 2)}:${t}>`
  : `<urn:s:${i % 997}> <urn:p:${t % 7}> <urn:o:${i}:${t}>`);

async function grow(engine, from, to) {
  let nquads = '';
  for (let i = from; i < to; i += 1) {
    for (let t = 0; t < TRIPLES_PER_GRAPH; t += 1) nquads += `${tripleOf(i, t)} <${member(i)}> .\n`;
    if (nquads.length > 4_000_000) { await engine.load(nquads); nquads = ''; }
  }
  if (nquads) await engine.load(nquads);
}

async function backfill(engine, from, to, fence) {
  const started = performance.now();
  for (let start = from; start < to; start += 100) {
    const graphs = Array.from({ length: Math.min(100, to - start) }, (_, offset) => member(start + offset));
    await engine.update(statements.readGraphBackfillBatch(R, fence, graphs));
  }
  return performance.now() - started;
}

async function measureSize(engine, size, row) {
  const g = (i) => member(100 + (i % 50));
  const old = (i) => Array.from({ length: TRIPLES_PER_GRAPH }, (_, t) => `${tripleOf(100 + (i % 50), t)} .`).join(' ');
  await time(engine, 'reference procedure: replace one 20-triple graph', size, (i) => engine.update([
    statements.readGraphRetraction(target, g(i), [g(i)]), `DROP SILENT GRAPH <${g(i)}>`,
    `INSERT DATA { GRAPH <${g(i)}> { ${old(i)} } }`, statements.readGraphCopy(R, g(i)),
  ].join(' ;\n')));
  await time(engine, 'existence check: retract one 20-triple graph (then copy back)', size, async (i) => {
    await engine.update(statements.readGraphRetraction(target, g(i), [g(i)]));
    await engine.update(statements.readGraphCopy(R, g(i)));
  });
  const deleted = (i) => Array.from({ length: 5 }, (_, t) => {
    const [subject, predicate, object] = tripleOf(200 + i, t + 1).split(' ').map((term) => term.slice(1, -1));
    return { subject, predicate, object, graph: member(200 + i) };
  });
  await time(engine, 'delete delta: 5 triples (then restore)', size, async (i) => {
    const quads = deleted(i);
    const data = quads.map((q) => `<${q.subject}> <${q.predicate}> <${q.object}> .`).join(' ');
    await engine.update(`DELETE DATA { GRAPH <${member(200 + i)}> { ${data} } } ;\n${statements.readGraphDeltaDelete(target, quads, render)}`);
    await engine.update(`INSERT DATA { GRAPH <${member(200 + i)}> { ${data} } GRAPH <${R}> { ${data} } }`);
  });
  await time(engine, 'pattern delta: one subject of one graph (then restore)', size, async (i) => {
    const graph = member(300 + i);
    const subject = `urn:s:${(300 + i) % 997}`;
    await engine.update(`${statements.readGraphDeltaDeleteMatching(target, graph, { subject }, render)} ;\nDELETE { GRAPH <${graph}> { <${subject}> ?p ?o } } WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } }`);
    await engine.update(`DROP SILENT GRAPH <${graph}> ;\nINSERT DATA { GRAPH <${graph}> { ${Array.from({ length: TRIPLES_PER_GRAPH }, (_, t) => `${tripleOf(300 + i, t)} .`).join(' ')} } } ;\n${statements.readGraphCopy(R, graph)}`);
  });
  await time(engine, 'subject-prefix delta: one graph (then restore)', size, async (i) => {
    const graph = member(400 + i);
    await engine.update(`${statements.readGraphDeltaDeleteBySubjectPrefix(target, graph, 'urn:s:', render)} ;\nDELETE { GRAPH <${graph}> { ?s ?p ?o } } WHERE { GRAPH <${graph}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "urn:s:")) } }`);
    await engine.update(`INSERT DATA { GRAPH <${graph}> { ${Array.from({ length: TRIPLES_PER_GRAPH }, (_, t) => `${tripleOf(400 + i, t)} .`).join(' ')} } } ;\n${statements.readGraphCopy(R, graph)}`);
  });
  await time(engine, 'subject procedure: replace one subject of one graph', size, (i) => {
    const graph = member(500 + i);
    const subject = `urn:s:${(500 + i) % 997}`;
    return engine.update([
      statements.readGraphRetraction(target, graph, [graph], { subject }),
      `DELETE { GRAPH <${graph}> { <${subject}> ?p ?o } } WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } }`,
      `INSERT DATA { GRAPH <${graph}> { <${subject}> <urn:p:new> "v${i}" } }`,
      statements.readGraphCopy(R, graph, { subject }),
    ].join(' ;\n'));
  });
  await time(engine, 'insert delta: one new 20-triple graph (then drop it)', size, async (i) => {
    const graph = `${ROOT}/_verifiable_memory/${AUTHOR}/new${i}`;
    const data = Array.from({ length: TRIPLES_PER_GRAPH }, (_, t) => `<urn:n:${i}> <urn:p:${t}> "v${t}" .`).join(' ');
    await engine.update(`INSERT DATA { GRAPH <${graph}> { ${data} } GRAPH <${R}> { ${data} } }`);
    await engine.update([statements.readGraphRetraction(target, graph, [graph]), `DROP SILENT GRAPH <${graph}>`].join(' ;\n'));
  });
  await time(engine, 'backfill batch: 100 graphs, fenced', size, (i) => engine.update(
    statements.readGraphBackfillBatch(R, row, Array.from({ length: 100 }, (_, offset) => member(600 + i * 100 + offset)))));
  await time(engine, 'check direction 2: one graph', size, (i) => engine.ask(statements.readGraphMissingTripleAsk(R, member(700 + i))));
  await time(engine, 'check direction 1, count: one graph', size, (i) => engine.select(statements.readGraphFirstHolderCountQuery(target, member(800 + i))));
  await time(engine, 'check direction 1, probe: one subject', size, (i) => engine.ask(statements.readGraphUnheldSubjectAsk(target, `urn:s:${i}`)));
  await time(engine, 'merged read: one selective pattern', size, () => engine.select(`SELECT ?s FROM <${R}> WHERE { ?s <urn:p:3> <urn:o:150:3> }`));
  await time(engine, 'merged read: two-pattern join, LIMIT 10', size, () => engine.select(`SELECT ?s ?o FROM <${R}> WHERE { ?s <urn:p:3> ?o . ?s <urn:p:4> ?o2 } LIMIT 10`));
  await time(engine, 'size of the read graph (grows with the view)', size, () => engine.select(statements.readGraphSizeQuery(R)), 3);
  // Every measurement above went through maintenance: the read graph must still equal the union of its members.
  const result = await compareWithUnion(engine);
  if (!result.equal) throw new Error(`read graph differs from the union of its members: ${JSON.stringify(result)}`);
  // The comparison must catch a swapped triple, which leaves both counts equal.
  const removed = tripleOf(0, 1);
  const stale = '<urn:bench:stale> <urn:bench:stale> <urn:bench:stale>';
  await engine.update(`DELETE DATA { GRAPH <${R}> { ${removed} } } ;\nINSERT DATA { GRAPH <${R}> { ${stale} } }`);
  const swapped = await compareWithUnion(engine);
  await engine.update(`DELETE DATA { GRAPH <${R}> { ${stale} } } ;\nINSERT DATA { GRAPH <${R}> { ${removed} } }`);
  if (swapped.equal || !swapped.missing || !swapped.extra || swapped.union !== swapped.held) {
    throw new Error(`the comparison missed a swapped triple: ${JSON.stringify(swapped)}`);
  }
  if (!(await compareWithUnion(engine)).equal) throw new Error('the read graph did not return to the union of its members');
  console.log(`${String(size).padStart(6)}  read graph equals the union of its members: ${result.held} triples; a swapped triple is caught`);
}

// Whether the read graph equals the union of its members: no member triple missing from it, no triple in it
// that no member holds, and the same number of distinct triples.
async function compareWithUnion(engine) {
  const isMember = statements.renderGraphNameTest(target.membership, '?g');
  // sparql-scan-allow: R2 -- benchmark verification over its own scratch store, once per size
  const union = await count(engine, `SELECT (COUNT(*) AS ?n) WHERE { SELECT DISTINCT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(${isMember}) } }`);
  const held = await count(engine, statements.readGraphSizeQuery(R));
  // sparql-scan-allow: R2 -- benchmark verification over its own scratch store, once per size
  const missing = await engine.ask(`ASK { GRAPH ?g { ?s ?p ?o } FILTER(${isMember}) FILTER NOT EXISTS { GRAPH <${R}> { ?s ?p ?o } } }`);
  // sparql-scan-allow: R2 -- benchmark verification over its own scratch store, once per size
  const extra = await engine.ask(`ASK { GRAPH <${R}> { ?s ?p ?o } FILTER NOT EXISTS { GRAPH ?g { ?s ?p ?o } FILTER(${isMember}) } }`);
  return { union, held, missing, extra, equal: union === held && !missing && !extra };
}

async function measureCopies(engine, copies) {
  // One triple held by many graphs, in three placements.
  const survivor = (n, i) => `${ROOT}/_verifiable_memory/${AUTHOR}/copy${n}-${i}`;
  const outside = (n, i) => `did:dkg:context-graph:0xdef/other/_verifiable_memory/${AUTHOR}/copy${n}-${i}`;
  const unregistered = (n, i) => `${ROOT}/unregistered/_verifiable_memory/${AUTHOR}/copy${n}-${i}`;
  for (const [id, placement, graphOf, survives] of [
    [1, 'surviving members in the view', survivor, true],
    [2, 'copies outside the view (another context graph)', outside, false],
    [3, 'copies outside the scope (an unregistered sub-graph)', unregistered, false],
  ]) {
    const triple = `<urn:copy:${id}:${copies}> <urn:p> <urn:o>`;
    const touched = `${ROOT}/_verifiable_memory/${AUTHOR}/touched-${id}-${copies}`;
    let nquads = `${triple} <${touched}> .\n`;
    for (let i = 0; i < copies; i += 1) nquads += `${triple} <${graphOf(copies, i)}> .\n`;
    await engine.load(nquads);
    await engine.update(`INSERT DATA { GRAPH <${R}> { ${triple} } }`);
    await time(engine, `existence check, ${placement}`, copies, async () => {
      await engine.update(statements.readGraphRetraction(target, touched, [touched]));
      const kept = await engine.ask(`ASK { GRAPH <${R}> { ${triple} } }`);
      if (kept !== survives) throw new Error(`existence check gave ${kept} for ${placement}`);
      await engine.update(statements.readGraphCopy(R, touched));
    });
  }
}

const engine = await openEngine();
console.log(`engine: ${engine.name}; view sizes ${SIZES.join(', ')} graphs x ${TRIPLES_PER_GRAPH} triples; copies ${COPIES.join(', ')}; ${RUNS} runs`);
try {
  let row = { readGraph: R, state: 'building', generation: 1, ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion, builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion };
  await engine.update(readGraphStateCompareAndSet(undefined, row));
  let loaded = 0;
  for (const size of SIZES) {
    const started = performance.now();
    await grow(engine, loaded, size);
    const loadMs = performance.now() - started;
    const backfillMs = await backfill(engine, loaded, size, row);
    loaded = size;
    // sparql-scan-allow: R2 -- benchmark report: counts every quad of its own scratch store once per size
    const quads = await count(engine, 'SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }');
    const readGraphTriples = await count(engine, statements.readGraphSizeQuery(R));
    results.push({ engine: engine.name, label: 'store', size, quads, readGraphTriples, loadMs: round(loadMs), backfillMs: round(backfillMs) });
    console.log(`${String(size).padStart(6)}  store: ${quads} quads, read graph ${readGraphTriples} triples; load ${round(loadMs)} ms, fenced backfill ${round(backfillMs)} ms`);
    await time(engine, 'state compare-and-set: building -> dirty -> rebuilding', size, async () => {
      const dirty = nextReadGraphState(row, { kind: 'mark-dirty' });
      await engine.update(readGraphStateCompareAndSet(row, dirty));
      const rebuilding = nextReadGraphState(dirty, { kind: 'start-rebuild', versions: CURRENT_READ_GRAPH_VERSIONS });
      await engine.update(readGraphStateCompareAndSet(dirty, rebuilding));
      row = rebuilding;
    });
    await measureSize(engine, size, row);
  }
  for (const copies of COPIES) await measureCopies(engine, copies);
  const held = await count(engine, statements.readGraphSizeQuery(R));
  let batches = 0;
  await time(engine, `fenced drop of the read graph (${held} triples), in batches of 10,000`, loaded, async () => {
    while (await count(engine, statements.readGraphSizeQuery(R)) > 0) {
      await time(engine, 'fenced drop: one batch of 10,000 triples', loaded, () => engine.update(statements.readGraphFencedDrop(R, row, { limit: 10_000 })), 1);
      batches += 1;
    }
  }, 1);
  console.log(`${String(loaded).padStart(6)}  fenced drop took ${batches} batches`);
} finally {
  await engine.close();
}
console.log(JSON.stringify(results));
