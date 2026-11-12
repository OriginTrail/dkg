#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Report the read graphs a store holds, read from the store itself over the
// SPARQL protocol. It only reads; it changes nothing.
//
//   node scripts/read-graph-store-report.mjs --endpoint <SPARQL query URL> [--sample <n>] [--timeout-ms <ms>]
//
// The endpoint is the store's query URL: a Blazegraph namespace's `/sparql`, or
// an Oxigraph server's `/query`. For each read graph (a graph under a context
// graph's `_~read` partition, other than its state graph) it prints:
//
// - `triples`: the triples the read graph holds;
// - `copies`: for up to `--sample` of those triples (default 10000), how many
//   graphs of the same context graph outside the read-graph partition hold
//   each one, as { "<copies>": <triples> }. It counts every such graph, so it
//   is an upper bound on the copies among the read graph's member graphs.
//   A triple that no such graph holds is not counted.
//
// Output: one JSON object, { endpoint, sample, readGraphs: [...], skipped: [...] }.
//
// With `--partition-graphs` it prints instead every graph the store holds in a
// context graph's read-graph partition (its read graphs, its state graph and
// anything else under it), as { endpoint, graphs: [...] }. With
// `--member-graphs` it prints every other graph of a context graph with its
// triples, each written as one sorted N-Triples-like line, as
// { endpoint, graphs: { "<graph>": ["<s> <p> <o>", ...] } }.
//
// Exit codes: 0 when the report is complete, 1 when the store could not be read.

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
}
const endpoint = option('--endpoint');
const sample = Number(option('--sample', '10000'));
const timeoutMs = Number(option('--timeout-ms', '600000'));
const partitionGraphsOnly = args.includes('--partition-graphs');
const memberGraphsOnly = args.includes('--member-graphs');
if (!endpoint || !/^https?:\/\//.test(endpoint) || !Number.isSafeInteger(sample) || sample < 1 || !(timeoutMs > 0)) {
  console.error('usage: read-graph-store-report.mjs --endpoint <SPARQL query URL> [--sample <n>] [--timeout-ms <ms>] [--partition-graphs | --member-graphs]');
  process.exit(2);
}

// The core package's SPARQL boundary: `sparqlIri` validates and wraps an IRI, `sparqlString` escapes a literal.
const { sparqlIri, sparqlString: literal } = await import(new URL('../packages/core/dist/index.js', import.meta.url).href);

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const PARTITION = '/_~read';
/** `<iri>` for a query, or undefined for an IRI that cannot be written into one. */
function iriOrUndefined(value) {
  try { return sparqlIri(value); } catch { return undefined; }
}

async function select(query) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`the store answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  return body.results.bindings;
}

/** `did:dkg:context-graph:{cg}` for a read graph's IRI, or undefined when it is not one. */
function contextGraphRoot(readGraph) {
  if (!readGraph.startsWith(CONTEXT_GRAPH_PREFIX)) return undefined;
  const at = readGraph.indexOf(`${PARTITION}/`, CONTEXT_GRAPH_PREFIX.length);
  return at === -1 ? undefined : readGraph.slice(0, at);
}

/** Whether a graph lies in a context graph's read-graph partition: a `_~read` path segment after the ID. */
function inPartition(iri) {
  return iri.startsWith(CONTEXT_GRAPH_PREFIX) && iri.slice(CONTEXT_GRAPH_PREFIX.length).split('/').indexOf(PARTITION.slice(1), 1) !== -1;
}

async function partitionGraphs() {
  const rows = await select(`SELECT DISTINCT ?g WHERE {
    # sparql-scan-allow: R2 -- a check an operator or a drill runs by hand, off any request path, with the store idle
    GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), ${literal(PARTITION)}))
  }`);
  const graphs = rows.map((row) => row.g?.value).filter((iri) => typeof iri === 'string' && inPartition(iri)).sort();
  console.log(JSON.stringify({ endpoint, graphs }, null, 2));
}

/** A SPARQL JSON term as one N-Triples-like token. */
function term(value) {
  if (!value) return '?';
  if (value.type === 'uri') return `<${value.value}>`;
  if (value.type === 'bnode') return `_:${value.value}`;
  const text = JSON.stringify(value.value);
  if (value['xml:lang']) return `${text}@${value['xml:lang']}`;
  return value.datatype ? `${text}^^<${value.datatype}>` : text;
}

async function memberGraphs() {
  const rows = await select(`SELECT ?g ?s ?p ?o WHERE {
    # sparql-scan-allow: R2 -- a check a drill runs by hand on a devnet store with its daemon down, off any request path
    GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), ${literal(CONTEXT_GRAPH_PREFIX)}))
  }`);
  const graphs = {};
  for (const row of rows) {
    const iri = row.g?.value;
    if (typeof iri !== 'string' || inPartition(iri)) continue;
    (graphs[iri] ??= []).push(`${term(row.s)} ${term(row.p)} ${term(row.o)}`);
  }
  for (const triples of Object.values(graphs)) triples.sort();
  console.log(JSON.stringify({ endpoint, graphs }, null, 2));
}

async function main() {
  if (partitionGraphsOnly) return partitionGraphs();
  if (memberGraphsOnly) return memberGraphs();
  const graphs = await select(`SELECT DISTINCT ?g WHERE {
    # sparql-scan-allow: R2 -- a report an operator runs by hand, off any request path; it reads the read-graph names once
    GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), ${literal(`${PARTITION}/`)}))
  }`);
  const readGraphs = [];
  const skipped = [];
  for (const iri of graphs.map((row) => row.g?.value).filter(Boolean).sort()) {
    const root = contextGraphRoot(iri);
    if (!root || iri === `${root}${PARTITION}/state`) continue;
    const graph = iriOrUndefined(iri);
    const rootGraph = iriOrUndefined(root);
    if (!graph || !rootGraph) { skipped.push({ readGraph: iri, reason: 'an IRI this report does not write into a query' }); continue; }
    const [count] = await select(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH ${graph} { ?s ?p ?o } }`);
    const outside = `?g = ${rootGraph} || (STRSTARTS(STR(?g), ${literal(`${root}/`)}) && STR(?g) != ${literal(`${root}${PARTITION}`)}`
      + ` && !STRSTARTS(STR(?g), ${literal(`${root}${PARTITION}/`)}))`;
    const histogram = await select(`SELECT ?copies (COUNT(*) AS ?triples) WHERE {
      # sparql-scan-allow: R1 -- the triples come from one exact read graph, at most --sample of them
      # sparql-scan-allow: R2 -- ?s ?p ?o are bound by that sample, so GRAPH ?g looks up one bound triple at a time
      { SELECT ?s ?p ?o (COUNT(DISTINCT ?g) AS ?copies) WHERE {
          { SELECT ?s ?p ?o WHERE { GRAPH ${graph} { ?s ?p ?o } } LIMIT ${sample} }
          GRAPH ?g { ?s ?p ?o }
          FILTER(${outside})
        } GROUP BY ?s ?p ?o }
    } GROUP BY ?copies ORDER BY ?copies`);
    readGraphs.push({
      readGraph: iri,
      contextGraphId: root.slice(CONTEXT_GRAPH_PREFIX.length),
      triples: Number(count?.n?.value ?? 0),
      copies: Object.fromEntries(histogram.map((row) => [row.copies.value, Number(row.triples.value)])),
    });
  }
  console.log(JSON.stringify({ endpoint, sample, readGraphs, skipped }, null, 2));
}

main().catch((error) => {
  console.error(`read-graph-store-report: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
