import { canonicalizeObjectTermForHash, formatSparqlTerm } from '@origintrail-official/dkg-core';
import { canonicalizeRdfObjectTerm } from '@origintrail-official/dkg-rdf-utils';
import { buildGraphAndSubjectPublication, type AtomicGraphAndSubjectReplaceUpdate } from '../atomic-graph-replace.js';
import type { Quad } from '../triple-store.js';
import { readResponseTextBounded } from '../http-response-limit.js';
import { toBlazegraphAsciiSafeNQuads } from './blazegraph-nquads.js';
import { SPARQL_QUERY_CONTENT_TYPE, SPARQL_UPDATE_CONTENT_TYPE } from './sparql-content-types.js';

/** Bound the extra staging buffer; larger inputs use the existing atomic path. */
export const BULK_ATOMIC_INGEST_MAX_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface BulkAtomicIngestPlan extends AtomicGraphAndSubjectReplaceUpdate {
  readonly nquads: string;
  readonly receiptQuery: string;
}

/**
 * An optimization of one graph + one metadata subject, not a cross-asset
 * transaction. All validation/serialization finishes before the first upload.
 * Backend-ambiguous value aliases conservatively retain the SPARQL path.
 */
export function buildBulkAtomicIngestPlan(
  graph: string, data: readonly Quad[], metaGraph: string, subject: string,
  metadata: readonly Quad[], format: 'n-quads' | 'blazegraph-n-quads',
): BulkAtomicIngestPlan | null {
  if (data.length === 0 || graph === metaGraph) return null;
  const plan = buildGraphAndSubjectPublication(graph, data, metaGraph, subject, metadata);
  const lines: string[] = [];
  const counts: number[] = [];
  let bytes = 0;
  for (const [index, quads] of [data, metadata].entries()) {
    const triples = new Set<string>();
    const valueTriples = new Set<string>();
    for (const quad of quads) {
      const s = formatSparqlTerm(quad.subject, { position: 'subject' });
      const p = formatSparqlTerm(quad.predicate, { position: 'predicate' });
      const o = formatSparqlTerm(quad.object, { position: 'object' });
      // RDF sets identify plain literals and xsd:string, escape variants, and
      // language tags. Case/value aliases below conservatively use SPARQL.
      triples.add(`${s} ${p} ${canonicalizeRdfObjectTerm(o)}`);
      valueTriples.add(`${s} ${p} ${canonicalizeObjectTermForHash(o)}`);
      const line = `${s} ${p} ${o} <${plan.stagingGraphs[index]}> .\n`;
      const wire = format === 'blazegraph-n-quads' ? toBlazegraphAsciiSafeNQuads(line) : line;
      bytes += Buffer.byteLength(wire);
      if (bytes > BULK_ATOMIC_INGEST_MAX_BYTES) return null;
      lines.push(wire);
    }
    // Numeric/date value-space folding varies by backend. If aliases could
    // coalesce, choose the legacy path BEFORE any staging mutation, not after
    // an ambiguous write failure. Never normalize the user's stored payload.
    if (valueTriples.size !== triples.size) return null;
    counts.push(triples.size);
  }
  const [dataStage, metaStage] = plan.stagingGraphs;
  const count = (g: string, variable: string) =>
    `{ SELECT (COUNT(*) AS ?${variable}) WHERE { GRAPH <${g}> { ?s ?p ?o } } }`;
  // A single guarded DELETE/INSERT publishes the assertion, metadata AND a
  // receipt. Do not rely on MOVE raising an error for an absent source graph:
  // some engines acknowledge that as a successful no-op even without SILENT.
  // UNION branches avoid a cross-product between old and new assertion rows.
  const update = `DELETE { GRAPH ?oldGraph { ?oldS ?oldP ?oldO } }
INSERT { GRAPH ?newGraph { ?newS ?newP ?newO } }
WHERE {
  ${count(dataStage, 'dataCount')}
  ${count(metaStage, 'metaCount')}
  FILTER(?dataCount = ${counts[0]} && ?metaCount = ${counts[1]})
  {
    { GRAPH <${graph}> { ?oldS ?oldP ?oldO } BIND(<${graph}> AS ?oldGraph) }
    UNION { GRAPH <${metaGraph}> { <${subject}> ?oldP ?oldO } BIND(<${subject}> AS ?oldS) BIND(<${metaGraph}> AS ?oldGraph) }
    UNION { GRAPH <${dataStage}> { ?newS ?newP ?newO } BIND(<${graph}> AS ?newGraph) }
    UNION { GRAPH <${metaStage}> { ?newS ?newP ?newO } BIND(<${metaGraph}> AS ?newGraph) }
    UNION { BIND(<${metaStage}> AS ?newGraph) BIND(<${dataStage}> AS ?newS) BIND(<urn:dkg:bulk-atomic:committed> AS ?newP) BIND(true AS ?newO) }
  }
}`;
  const receiptQuery = `ASK { GRAPH <${metaStage}> { <${dataStage}> <urn:dkg:bulk-atomic:committed> true } }`;
  return { ...plan, update, nquads: lines.join(''), receiptQuery };
}

interface BulkIngestHttpContext {
  updateEndpoint: string;
  queryEndpoint: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  responseError: (status: number, text: string) => Error;
}

/** Runs INSIDE the adapter's one admitted mutation, deadline and write scope. */
export async function stageBulkAtomicIngest(
  plan: BulkAtomicIngestPlan,
  context: BulkIngestHttpContext,
): Promise<void> {
  const { signal, headers, responseError } = context;
  signal.throwIfAborted();
  const upload = await fetch(context.updateEndpoint, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/n-quads' },
    body: plan.nquads, signal, redirect: 'error',
  });
  const uploadText = await readResponseTextBounded(upload, MAX_RESPONSE_BYTES);
  if (upload.status !== 200 && upload.status !== 204) {
    throw responseError(upload.status, uploadText.slice(0, 300));
  }
  signal.throwIfAborted();
  // The stage counts are checked inside the publication transaction itself.
}

/** Read the transaction's unique receipt before cleanup or a commit ACK. */
export async function completeBulkAtomicIngest(
  plan: BulkAtomicIngestPlan,
  context: BulkIngestHttpContext,
): Promise<void> {
  const { signal, headers, responseError } = context;
  signal.throwIfAborted();
  const response = await fetch(context.queryEndpoint, {
    method: 'POST', signal, redirect: 'error',
    headers: { ...headers, 'Content-Type': SPARQL_QUERY_CONTENT_TYPE, Accept: 'application/sparql-results+json' },
    body: plan.receiptQuery,
  });
  const text = await readResponseTextBounded(response, MAX_RESPONSE_BYTES);
  if (response.status !== 200) throw responseError(response.status, text.slice(0, 300));
  const result = JSON.parse(text) as { boolean?: unknown };
  if (result?.boolean !== true) {
    throw new Error('Bulk atomic ingestion receipt missing: staging counts changed or publication did not commit');
  }
  signal.throwIfAborted();
  const cleanup = await fetch(context.updateEndpoint, {
    method: 'POST', signal, redirect: 'error',
    headers: { ...headers, 'Content-Type': SPARQL_UPDATE_CONTENT_TYPE }, body: plan.cleanup,
  });
  const cleanupText = await readResponseTextBounded(cleanup, MAX_RESPONSE_BYTES);
  if (cleanup.status !== 200 && cleanup.status !== 204) {
    throw responseError(cleanup.status, cleanupText.slice(0, 300));
  }
}
