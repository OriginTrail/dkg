// SPDX-License-Identifier: Apache-2.0

/**
 * The statements that keep a read graph equal to the union of its member
 * graphs, and the statements that check it.
 *
 * - The reference procedure, for a request that touches member graphs T of a
 *   read graph R: before the change, retract from R every triple of a graph
 *   in T that no member outside T holds ({@link readGraphRetraction}); after
 *   it, copy into R every triple of a graph in T that is still a member
 *   ({@link readGraphCopy}). The two stay separate operations of one request.
 * - The delta forms, which give the same result for one kind of write:
 *   {@link readGraphInsertQuads}, {@link readGraphDeltaDelete},
 *   {@link readGraphDeltaDeleteMatching} and
 *   {@link readGraphDeltaDeleteBySubjectPrefix}. A form that cannot carry a
 *   write, because of a blank node, throws {@link ReadGraphDeltaFormError};
 *   the write then takes the reference procedure.
 * - Backfill and repair batches and the drop (whole, or in batches), each
 *   fenced by the read graph's state and generation in its own `WHERE`, so a
 *   stale one changes nothing.
 * - Both directions of the check: every triple of a member graph is in R
 *   ({@link readGraphMissingTripleAsk}), and R holds no triple that no member
 *   holds, by counting ({@link readGraphSizeQuery} against the sum of
 *   {@link readGraphFirstHolderCountQuery} over the members) or by probing the
 *   subjects of a sample ({@link readGraphUnheldSubjectAsk}).
 *
 * A removed triple stays in R while another member still holds it. That is an
 * existence probe per triple: `GRAPH ?h { s p o }` with the membership test of
 * R on `?h` and the touched graphs excluded as constants. R itself is never a
 * member, so R never keeps its own triples alive. The touched graphs are read
 * one at a time, as constants, so no operation scans an unbound graph.
 *
 * Every function returns one SPARQL UPDATE operation without a trailing `;`,
 * or one query. Graph names are checked with `assertSafeIri`; the terms of a
 * write are rendered with the adapter's own renderer, so a delta form names
 * the same stored terms as the write it follows. A delta form restates terms
 * in SPARQL text, so it shares the engine's limits on literal syntax with the
 * write it follows, and a request it cannot carry fails before it commits.
 * The reference procedure copies on the server and restates no term.
 */

import {
  assertSafeIri,
  canonicalKnowledgeAssetAgentAddress,
  escapeSparqlLiteral,
  isReadGraphPartitionIri,
} from '@origintrail-official/dkg-core';
import type { SparqlTermRenderer } from '../adapters/sparql-term-policy.js';
import type { Quad } from '../triple-store.js';
import type { GraphNameTest } from './membership.js';
import { readGraphStateFencePattern, type ReadGraphState } from './state.js';

/** A read graph and the membership test of its current members. */
export interface ReadGraphTarget {
  readonly readGraph: string;
  readonly membership: GraphNameTest;
}

/** The state and generation an operation was issued for. */
export interface ReadGraphFence {
  readonly state: ReadGraphState;
  readonly generation: number;
}

/** A delta form cannot carry this write; use the reference procedure. */
export class ReadGraphDeltaFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadGraphDeltaFormError';
  }
}

const HOLDER = '?readGraphHolder';
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

/** A membership test as a SPARQL expression on `variable`, with the same answer for every graph name. */
export function renderGraphNameTest(test: GraphNameTest, variable: string): string {
  if (!/^\?[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error(`Unsafe SPARQL variable: ${variable}`);
  const name = `STR(${variable})`;
  switch (test.kind) {
    case 'equals': return `(${name} = ${literal(test.iri)})`;
    case 'prefix': return `STRSTARTS(${name}, ${literal(test.prefix)})`;
    case 'contains': return `CONTAINS(${name}, ${literal(test.text)})`;
    case 'segment': return `CONTAINS(CONCAT(${name}, "/"), ${literal(`/${test.segment}/`)})`;
    case 'one-segment-after': {
      const rest = `STRAFTER(${name}, ${literal(test.prefix)})`;
      return `(STRSTARTS(${name}, ${literal(test.prefix)}) && STRLEN(${rest}) > 0 && !CONTAINS(${rest}, "/"))`;
    }
    case 'address-after': {
      const address = `STRBEFORE(STRAFTER(${name}, ${literal(test.prefix)}), "/")`;
      const matches = test.addresses.map((candidate) => {
        const canonical = canonicalKnowledgeAssetAgentAddress(candidate);
        // An EVM address matches in any letter case; any other address matches exactly.
        return EVM_ADDRESS.test(canonical)
          ? `(STRSTARTS(${address}, "0x") && LCASE(${address}) = ${literal(canonical)})`
          : `(${address} = ${literal(canonical)})`;
      });
      return `(STRSTARTS(${name}, ${literal(test.prefix)}) && STRLEN(${address}) > 0 && ${disjunction(matches)})`;
    }
    case 'not': return `(!${renderGraphNameTest(test.test, variable)})`;
    case 'all': return test.tests.length === 0 ? 'true' : `(${test.tests.map((inner) => renderGraphNameTest(inner, variable)).join(' && ')})`;
    case 'any': return disjunction(test.tests.map((inner) => renderGraphNameTest(inner, variable)));
  }
}

/**
 * Step 1 of the reference procedure for one touched graph: remove from R
 * every triple `graph` holds unless a member of R outside `touched` holds it.
 * Runs before the change, while `graph` still has its old contents. With
 * `subject`, only that subject's triples; with `fence`, only for that state
 * and generation of R.
 */
export function readGraphRetraction(
  target: ReadGraphTarget,
  graph: string,
  touched: readonly string[],
  options: { readonly subject?: string; readonly fence?: ReadGraphFence; readonly render?: SparqlTermRenderer } = {},
): string {
  const readGraph = checkedReadGraph(target.readGraph);
  const source = checkedGraph(graph);
  if (!touched.includes(graph)) throw new Error('A retracted graph must be one of the touched graphs');
  const s = options.subject === undefined ? '?s' : subjectTerm(options.subject, options.render);
  return `DELETE { GRAPH <${readGraph}> { ${s} ?p ?o } }\nWHERE {\n${fenceLines(readGraph, options.fence)}`
    + `  GRAPH <${source}> { ${s} ?p ?o }\n`
    + `  FILTER NOT EXISTS { GRAPH ${HOLDER} { ${s} ?p ?o } FILTER(${notIn(touched)} && ${renderGraphNameTest(target.membership, HOLDER)}) }\n}`;
}

/**
 * Step 3 of the reference procedure, and one graph of a backfill or a join
 * repair: copy every triple of `graph` into R, on the server, so a blank node
 * keeps its identity. With `subject`, only that subject's triples; with
 * `fence`, only for that state and generation of R.
 */
export function readGraphCopy(
  readGraph: string,
  graph: string,
  options: { readonly subject?: string; readonly fence?: ReadGraphFence; readonly render?: SparqlTermRenderer } = {},
): string {
  const target = checkedReadGraph(readGraph);
  const source = checkedGraph(graph);
  const s = options.subject === undefined ? '?s' : subjectTerm(options.subject, options.render);
  return `INSERT { GRAPH <${target}> { ${s} ?p ?o } }\nWHERE {\n${fenceLines(target, options.fence)}  GRAPH <${source}> { ${s} ?p ?o }\n}`;
}

/**
 * The reference procedure for one read graph: the retractions of every
 * touched member graph before the change, and the copies of the touched
 * graphs that are still members after it.
 */
export function readGraphReferenceProcedure(
  target: ReadGraphTarget,
  touched: readonly string[],
  stillMembers: readonly string[],
  options: { readonly subject?: string; readonly render?: SparqlTermRenderer } = {},
): { before: string[]; after: string[] } {
  const graphs = [...new Set(touched)];
  for (const graph of stillMembers) {
    if (!graphs.includes(graph)) throw new Error('A copied graph must be one of the touched graphs');
  }
  return {
    before: graphs.map((graph) => readGraphRetraction(target, graph, graphs, options)),
    after: [...new Set(stillMembers)].map((graph) => readGraphCopy(target.readGraph, graph, options)),
  };
}

/** The insert delta: the quads of an insert, restated for R, to add to the same insert call. */
export function readGraphInsertQuads(readGraph: string, quads: readonly Quad[]): Quad[] {
  const target = checkedReadGraph(readGraph);
  return quads.map((quad) => ({ subject: quad.subject, predicate: quad.predicate, object: quad.object, graph: target }));
}

/**
 * The delete delta, after the delete: each deleted triple leaves R unless a
 * member still holds it. `undefined` when there is nothing to delete. Throws
 * {@link ReadGraphDeltaFormError} for a blank node, which a restated triple
 * cannot name.
 */
export function readGraphDeltaDelete(
  target: ReadGraphTarget,
  quads: readonly Quad[],
  render: SparqlTermRenderer,
): string | undefined {
  const readGraph = checkedReadGraph(target.readGraph);
  const rows = new Set<string>();
  for (const quad of quads) {
    if (isBlankNode(quad.subject) || isBlankNode(quad.object)) {
      throw new ReadGraphDeltaFormError('A deleted triple with a blank node needs the reference procedure');
    }
    rows.add(`(${render.rdf(quad.subject, 'subject', 'reject')} ${render.iri(quad.predicate, 'predicate')} ${render.rdf(quad.object, 'object', 'reject')})`);
  }
  if (rows.size === 0) return undefined;
  return `DELETE { GRAPH <${readGraph}> { ?s ?p ?o } }\nWHERE {\n`
    + `  VALUES (?s ?p ?o) { ${[...rows].join(' ')} }\n`
    + `  FILTER NOT EXISTS { GRAPH ${HOLDER} { ?s ?p ?o } FILTER(${renderGraphNameTest(target.membership, HOLDER)}) }\n}`;
}

/**
 * The pattern-delete delta for a delete scoped to `graph`, before the delete:
 * the matching triples leave R unless a member other than `graph` holds them.
 * Renders the pattern as the adapters do, so it matches the same triples.
 */
export function readGraphDeltaDeleteMatching(
  target: ReadGraphTarget,
  graph: string,
  pattern: Readonly<Pick<Partial<Quad>, 'subject' | 'predicate' | 'object'>>,
  render: SparqlTermRenderer,
): string {
  const readGraph = checkedReadGraph(target.readGraph);
  const source = checkedGraph(graph);
  if ((pattern.subject && isBlankNode(pattern.subject)) || (pattern.object && isBlankNode(pattern.object))) {
    throw new ReadGraphDeltaFormError('A pattern with a blank node needs the reference procedure');
  }
  const s = pattern.subject ? render.iri(pattern.subject, 'subject') : '?s';
  const p = pattern.predicate ? render.iri(pattern.predicate, 'predicate') : '?p';
  const o = pattern.object ? render.rdf(pattern.object, 'object', 'reject') : '?o';
  const triple = `${s} ${p} ${o}`;
  return `DELETE { GRAPH <${readGraph}> { ${triple} } }\nWHERE {\n  GRAPH <${source}> { ${triple} }\n`
    + `  FILTER NOT EXISTS { GRAPH ${HOLDER} { ${triple} } FILTER(${notIn([graph])} && ${renderGraphNameTest(target.membership, HOLDER)}) }\n}`;
}

/**
 * The subject-prefix delta for `deleteBySubjectPrefix(graph, prefix)`, before
 * the delete, selecting subjects the way the adapters' statement does.
 */
export function readGraphDeltaDeleteBySubjectPrefix(
  target: ReadGraphTarget,
  graph: string,
  prefix: string,
  render: SparqlTermRenderer,
): string {
  const readGraph = checkedReadGraph(target.readGraph);
  const source = checkedGraph(graph);
  return `DELETE { GRAPH <${readGraph}> { ?s ?p ?o } }\nWHERE {\n`
    + `  GRAPH <${source}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), ${render.prefix(prefix)})) }\n`
    + `  FILTER NOT EXISTS { GRAPH ${HOLDER} { ?s ?p ?o } FILTER(${notIn([graph])} && ${renderGraphNameTest(target.membership, HOLDER)}) }\n}`;
}

/**
 * One backfill batch, or the copies of a repair for graphs that joined: one
 * fenced operation that copies every listed member graph, read through a
 * `VALUES` list of the graphs. One operation per batch keeps the cost per
 * graph low on engines that pay per operation.
 */
export function readGraphBackfillBatch(readGraph: string, fence: ReadGraphFence, graphs: readonly string[]): string {
  const target = checkedReadGraph(readGraph);
  const sources = [...new Set(graphs)].map((graph) => `<${checkedGraph(graph)}>`);
  if (sources.length === 0) throw new Error('A backfill batch needs at least one graph');
  // sparql-scan-allow: R2 -- ?g is bound by a finite VALUES list of member graph IRIs
  return `INSERT { GRAPH <${target}> { ?s ?p ?o } }
WHERE {
${fenceLines(target, fence)}  VALUES ?g { ${sources.join(' ')} }
  GRAPH ?g { ?s ?p ?o }
}`;
}

/**
 * The retractions of a repair for intact graphs that left the read graph:
 * fenced, checked against the membership after the change, which no longer
 * holds the leaving graphs.
 */
export function readGraphRepairLeave(target: ReadGraphTarget, fence: ReadGraphFence, leaving: readonly string[]): string[] {
  const graphs = [...new Set(leaving)];
  return graphs.map((graph) => readGraphRetraction(target, graph, graphs, { fence }));
}

/**
 * Empty R, fenced: the first step of a rebuild and of a removal. With `limit`,
 * one batch that removes at most that many triples; send batches until
 * {@link readGraphHoldsTripleAsk} answers `false`, so a large read graph never
 * holds the store's writer for long.
 */
export function readGraphFencedDrop(readGraph: string, fence: ReadGraphFence, options: { readonly limit?: number } = {}): string {
  const target = checkedReadGraph(readGraph);
  if (options.limit === undefined) {
    return `DELETE { GRAPH <${target}> { ?s ?p ?o } }\nWHERE {\n${fenceLines(target, fence)}  GRAPH <${target}> { ?s ?p ?o }\n}`;
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error(`Invalid drop batch size: ${options.limit}`);
  return `DELETE { GRAPH <${target}> { ?s ?p ?o } }\nWHERE {\n${fenceLines(target, fence)}`
    + `  { SELECT ?s ?p ?o WHERE { GRAPH <${target}> { ?s ?p ?o } } LIMIT ${options.limit} }\n}`;
}

/** Check direction 2 for one member graph: `true` when `graph` holds a triple that R lacks. */
export function readGraphMissingTripleAsk(readGraph: string, graph: string): string {
  const target = checkedReadGraph(readGraph);
  return `ASK {\n  GRAPH <${checkedGraph(graph)}> { ?s ?p ?o }\n  FILTER NOT EXISTS { GRAPH <${target}> { ?s ?p ?o } }\n}`;
}

/** `true` while R holds a triple: the end test of a drop in batches, which no engine answers by counting. */
export function readGraphHoldsTripleAsk(readGraph: string): string {
  return `ASK { GRAPH <${checkedReadGraph(readGraph)}> { ?s ?p ?o } }`;
}

/** The number of triples in R, as `?n`. */
export function readGraphSizeQuery(readGraph: string): string {
  return `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${checkedReadGraph(readGraph)}> { ?s ?p ?o } }`;
}

/**
 * Check direction 1 by counting, for one member graph: the number of its
 * triples that no member earlier in code-point order holds, as `?n`. Summed
 * over every member, it is the number of distinct member triples; R is right
 * when that sum equals {@link readGraphSizeQuery} and direction 2 holds.
 */
export function readGraphFirstHolderCountQuery(target: ReadGraphTarget, graph: string): string {
  const source = checkedGraph(graph);
  return `SELECT (COUNT(*) AS ?n) WHERE {\n  GRAPH <${source}> { ?s ?p ?o }\n`
    + `  FILTER NOT EXISTS { GRAPH ${HOLDER} { ?s ?p ?o } FILTER(STR(${HOLDER}) < ${literal(source)} && ${renderGraphNameTest(target.membership, HOLDER)}) }\n}`;
}

/** Check direction 1 for one subject of a sample: `true` when R holds a triple of it that no member holds. */
export function readGraphUnheldSubjectAsk(target: ReadGraphTarget, subject: string, render?: SparqlTermRenderer): string {
  const readGraph = checkedReadGraph(target.readGraph);
  const s = subjectTerm(subject, render);
  return `ASK {\n  GRAPH <${readGraph}> { ${s} ?p ?o }\n`
    + `  FILTER NOT EXISTS { GRAPH ${HOLDER} { ${s} ?p ?o } FILTER(${renderGraphNameTest(target.membership, HOLDER)}) }\n}`;
}

function fenceLines(readGraph: string, fence: ReadGraphFence | undefined): string {
  return fence === undefined ? '' : `${readGraphStateFencePattern(readGraph, fence.state, fence.generation)}\n`;
}

function notIn(graphs: readonly string[]): string {
  return `${HOLDER} NOT IN (${graphs.map((graph) => `<${checkedGraph(graph)}>`).join(', ')})`;
}

function disjunction(terms: readonly string[]): string {
  return terms.length === 0 ? 'false' : `(${terms.join(' || ')})`;
}

function literal(value: string): string {
  return `"${escapeSparqlLiteral(value)}"`;
}

function subjectTerm(subject: string, render: SparqlTermRenderer | undefined): string {
  if (isBlankNode(subject)) throw new ReadGraphDeltaFormError('A subject form cannot name a blank node');
  return render ? render.iri(subject, 'subject') : `<${assertSafeIri(subject)}>`;
}

function isBlankNode(term: string): boolean {
  return term.startsWith('_:');
}

function checkedGraph(graph: string): string {
  return assertSafeIri(graph);
}

function checkedReadGraph(readGraph: string): string {
  if (!isReadGraphPartitionIri(readGraph)) throw new Error(`Not a read graph: ${readGraph}`);
  return assertSafeIri(readGraph);
}
